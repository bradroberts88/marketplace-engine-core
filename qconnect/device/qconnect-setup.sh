#!/bin/bash
#
# QConnect setup state machine.
# Runs at every boot until provisioning succeeds, then exits immediately
# on later boots (guarded by /opt/qconnect/state/provisioned).
#
# Flow:
#   1. Ask the connection manager for internet by ANY path it can find
#      (ethernet -> Wi-Fi -> cellular -> saved phone hotspot).
#   2. If nothing works, raise the setup hotspot + captive portal so staff can
#      fix it from a phone. Then go back to (1). Loop forever.
#   3. Once online: join Tailscale with the baked pre-auth key.
#   4. Self-register with Supabase (device id + dealer id + device token).
#   5. Mark provisioned, redact the Tailscale key, hand over to the heartbeat.
#
# Every step writes a "stuck_step" beacon, so a box that HAS internet but is
# failing a later step reports itself instead of looking dead.

set -u
QCONNECT=/opt/qconnect
STATE=$QCONNECT/state
PROV=$QCONNECT/etc/provision.json
LOG=/var/log/qconnect-setup.log
AP_WINDOW=600        # seconds to keep the setup hotspot up per fallback cycle

exec >>"$LOG" 2>&1
log() { echo "[$(date '+%F %T')] $*"; }

[ -f "$STATE/provisioned" ] && { log "Already provisioned. Exiting."; exit 0; }
[ -f "$PROV" ] || { log "FATAL: $PROV missing"; exit 1; }

mkdir -p "$STATE"
# shellcheck source=qconnect-netmanager.sh
. "$QCONNECT/qconnect-netmanager.sh"
# shellcheck source=qconnect-steps.sh
. "$QCONNECT/qconnect-steps.sh"

# The beacon the heartbeat picks up: which step are we stuck on right now.
step() { echo "$1" > "$STATE/stuck_step"; log "--- step: $1"; }

jget() { python3 -c "import json;print(json.load(open('$PROV')).get('$1',''))"; }
DEVICE_ID=$(jget device_id)
DEALER_ID=$(jget dealer_id)
DEVICE_TOKEN=$(jget device_token)
TS_KEY=$(jget tailscale_authkey)
SB_URL=$(jget supabase_url); SB_URL=${SB_URL%/}
SB_KEY=$(jget supabase_anon_key)

# --- setup hotspot + captive portal ----------------------------------------
# SSID is capped at 32 bytes; over that, nmcli silently refuses to create the AP
# and staff never see a setup network at all.
ap_ssid() {
  local s="QConnect-Setup-${DEVICE_ID}"
  [ "${#s}" -le 32 ] && { echo "$s"; return; }
  echo "QConnect-${DEVICE_ID: -8}"
}

start_ap() {
  local ssid; ssid=$(ap_ssid)
  local dev; dev=$(wifi_device)
  [ -n "$dev" ] || { log "No Wi-Fi radio; cannot raise a setup hotspot."; return 1; }

  # brcmfmac (Zero 2 W, Pi 3) cannot scan while hosting an AP. Scan FIRST and
  # cache the result so the portal shows a real list instead of "found nothing".
  nmcli -t -f SSID,SIGNAL device wifi list --rescan yes 2>/dev/null > "$STATE/scan-cache.txt"

  log "Starting fallback hotspot: $ssid"
  nmcli connection delete qconnect-hotspot >/dev/null 2>&1
  # WPA2-protected: some phones (iOS especially) drop off an open network with
  # no internet before the captive portal ever opens.
  nmcli connection add type wifi ifname "$dev" con-name qconnect-hotspot \
        ssid "$ssid" \
        802-11-wireless.mode ap 802-11-wireless.band bg \
        wifi-sec.key-mgmt wpa-psk wifi-sec.psk "qconnect123" \
        ipv4.method shared ipv4.addresses 10.42.0.1/24 \
        connection.autoconnect no >/dev/null 2>&1
  nmcli connection up qconnect-hotspot >/dev/null 2>&1
  python3 $QCONNECT/qconnect-portal.py &
  PORTAL_PID=$!
  log "Portal running (pid $PORTAL_PID). Password qconnect123. Window: ${AP_WINDOW}s."
}

stop_ap() {
  [ -n "${PORTAL_PID:-}" ] && kill "$PORTAL_PID" 2>/dev/null
  nmcli connection down qconnect-hotspot >/dev/null 2>&1
  nmcli connection delete qconnect-hotspot >/dev/null 2>&1
  log "Hotspot stopped."
}

# The portal writes credentials here; we verify them and report the result BACK
# to the portal so staff get "wrong password, try again" instead of silence.
apply_new_wifi() {
  local ssid pass hidden reason
  ssid=$(python3 -c "import json;print(json.load(open('$STATE/new-wifi.json'))['ssid'])")
  pass=$(python3 -c "import json;print(json.load(open('$STATE/new-wifi.json')).get('pass',''))")
  hidden=$(python3 -c "import json;print(json.load(open('$STATE/new-wifi.json')).get('hidden','no'))")
  rm -f "$STATE/new-wifi.json"
  log "Applying new Wi-Fi credentials for SSID: $ssid"
  upsert_wifi_profile qconnect-dealer-wifi "$ssid" "$pass" "$hidden" 100
  reason=$(verify_wifi qconnect-dealer-wifi "$ssid")
  echo "$reason" > "$STATE/wifi-result"
  [ "$reason" = "ok" ] && return 0
  log "New credentials did not work: $reason"
  return 1
}

ap_fallback_cycle() {
  start_ap || return 1
  local deadline=$(( $(date +%s) + AP_WINDOW ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if [ -f "$STATE/new-wifi.json" ]; then
      # Keep the portal up while we test, so the phone can show the verdict.
      if apply_new_wifi; then stop_ap; return 0; fi
      start_ap   # re-raise the AP (joining the dealer network tore it down)
      deadline=$(( $(date +%s) + AP_WINDOW ))
    fi
    sleep 5
  done
  stop_ap
  return 1
}

# --- Tailscale -------------------------------------------------------------
join_tailnet() {
  if ! command -v tailscale >/dev/null 2>&1; then
    log "Installing Tailscale..."
    curl -fsSL https://tailscale.com/install.sh | sh || return 1
  fi
  systemctl enable --now tailscaled
  local host err
  host=$(echo "$DEVICE_ID" | tr '[:upper:]' '[:lower:]')
  # Capture stderr: "key is already used" vs "no internet" must not look alike.
  err=$(tailscale up --authkey="$TS_KEY" --hostname="$host" \
        --ssh --accept-dns=false 2>&1) || {
    log "tailscale up failed: $err"
    echo "tailscale: ${err:0:200}" > "$STATE/last_error"
    return 1
  }
  log "Joined tailnet as $host ($(tailscale ip -4 2>/dev/null | head -1))"
  return 0
}

# --- Supabase registration -------------------------------------------------
register_device() {
  local ts_ip payload code body path detail model
  ts_ip=$(tailscale ip -4 2>/dev/null | head -1)
  # Record how this box got online at the moment it registers, so the very
  # first fleet row already answers "cable, Wi-Fi or mobile data?".
  path=$(python3 -c "import json;print(json.load(open('$STATE/net-state.json')).get('connection_path',''))" 2>/dev/null)
  detail=$(python3 -c "import json;print(json.load(open('$STATE/net-state.json')).get('connection_detail',''))" 2>/dev/null)
  model=$(tr -d '\0' < /proc/device-tree/model 2>/dev/null)
  payload=$(python3 - "$DEVICE_ID" "$DEALER_ID" "$DEVICE_TOKEN" "$ts_ip" "$path" "$detail" "$model" <<'PYEOF'
import json, sys
a = sys.argv
print(json.dumps({"p_device_id": a[1], "p_dealer_id": a[2],
                  "p_device_token": a[3], "p_tailscale_ip": a[4],
                  "p_connection_path": a[5], "p_connection_detail": a[6],
                  "p_pi_model": a[7]}))
PYEOF
)
  code=$(curl -s -o /tmp/qconnect-reg.out -w '%{http_code}' --max-time 20 \
    -X POST "$SB_URL/rest/v1/rpc/qconnect_register" \
    -H "apikey: $SB_KEY" -H "Authorization: Bearer $SB_KEY" \
    -H "Content-Type: application/json" -d "$payload")
  if [ "$code" = "200" ] || [ "$code" = "204" ]; then
    log "Registered with Supabase."
    rm -f "$STATE/last_error"
    return 0
  fi
  body=$(head -c 300 /tmp/qconnect-reg.out)
  log "Supabase registration failed (HTTP $code): $body"
  # "registration rejected" here almost always means the card was never
  # pre-registered at the bench - say so in plain words.
  case "$body" in
    *"registration rejected"*)
      echo "register: card was never pre-registered (HTTP $code)" > "$STATE/last_error" ;;
    *) echo "register: HTTP $code ${body:0:160}" > "$STATE/last_error" ;;
  esac
  return 1
}

# --- main loop --------------------------------------------------------------
log "=== QConnect setup starting (device=$DEVICE_ID dealer=$DEALER_ID model=$(pi_model)) ==="
radio_is_dual_band || log "NOTE: this radio is 2.4 GHz only - a 5 GHz-only SSID will never be seen."

# The card is awake and its scripts are in place: that is step one of the
# checklist the server is timing us against.
report_step_once power_on "$(pi_model)"

step network
until connect_any; do
  log "No path online (last: $(cat "$STATE/last_block_reason" 2>/dev/null || echo unknown)). Asking a human."
  report_step network_up fail "$(cat "$STATE/last_block_reason" 2>/dev/null || echo 'no path online')"
  ap_fallback_cycle || log "AP window closed with no working credentials. Retrying all paths."
done
log "Network is up via $(active_path)."
report_step network_up ok "$(active_path)"

step tailscale
until join_tailnet; do
  report_step tunnel_up fail "$(cat "$STATE/last_error" 2>/dev/null || echo 'tailscale join failed')"
  log "Tailscale join failed. Retrying in 60s."
  connect_any >/dev/null 2>&1   # a dropped path must not look like a Tailscale fault
  sleep 60
done
report_step tunnel_up ok "$(tailscale ip -4 2>/dev/null | head -1)"

step register
until register_device; do
  log "Registration failed. Retrying in 60s."
  connect_any >/dev/null 2>&1
  sleep 60
done

report_step registered ok "$(active_path)"

date -u +%FT%TZ > "$STATE/provisioned"
rm -f "$STATE/stuck_step"

# Only now is the single-use key safe to destroy. Redacting before registration
# succeeded meant a box powered off between the two steps could never recover.
python3 - <<'PYEOF'
import json
p = json.load(open('/opt/qconnect/etc/provision.json'))
p['tailscale_authkey'] = 'REDACTED-AFTER-JOIN'
json.dump(p, open('/opt/qconnect/etc/provision.json','w'), indent=2)
PYEOF

systemctl start qconnect-heartbeat.service 2>/dev/null
systemctl start qconnect-netwatch.service 2>/dev/null
log "=== Provisioning complete. ==="
exit 0
