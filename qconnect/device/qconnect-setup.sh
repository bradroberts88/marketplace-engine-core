#!/bin/bash
#
# QConnect setup state machine.
# Runs at every boot until provisioning succeeds, then exits immediately
# on later boots (guarded by /opt/qconnect/state/provisioned).
#
# Flow:
#   1. Wait up to WIFI_WAIT seconds for the baked dealer Wi-Fi to come online
#      (real internet, not a captive portal).
#   2. If not online, start AP fallback: hotspot "QConnect-Setup-<id>" + captive
#      portal. Staff joins with a phone, picks the dealer SSID, enters the
#      password. Retry. Loop between (1) and (2) forever until online.
#   3. Once online: join Tailscale with the baked pre-auth key.
#   4. Self-register with Supabase (device id + dealer id + device token).
#   5. Mark provisioned. Heartbeat timer takes over from here.

set -u
QCONNECT=/opt/qconnect
STATE=$QCONNECT/state
PROV=$QCONNECT/etc/provision.json
LOG=/var/log/qconnect-setup.log
WIFI_WAIT=180        # seconds to wait for dealer Wi-Fi before AP fallback
AP_WINDOW=600        # seconds to keep the hotspot up per fallback cycle

exec >>"$LOG" 2>&1
log() { echo "[$(date '+%F %T')] $*"; }

[ -f "$STATE/provisioned" ] && { log "Already provisioned. Exiting."; exit 0; }
[ -f "$PROV" ] || { log "FATAL: $PROV missing"; exit 1; }

jget() { python3 -c "import json;print(json.load(open('$PROV')).get('$1',''))"; }
DEVICE_ID=$(jget device_id)
DEALER_ID=$(jget dealer_id)
DEVICE_TOKEN=$(jget device_token)
TS_KEY=$(jget tailscale_authkey)
SB_URL=$(jget supabase_url)
SB_KEY=$(jget supabase_anon_key)

# --- connectivity check with captive-portal detection ---------------------
# Real internet must return HTTP 204 from the probe. A captive portal
# intercepts and returns 200/302 with a login page instead.
online() {
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 \
         http://connectivitycheck.gstatic.com/generate_204 2>/dev/null)
  if [ "$code" = "204" ]; then return 0; fi
  if [ "$code" = "200" ] || [ "$code" = "302" ] || [ "$code" = "303" ]; then
    log "Captive portal suspected (probe returned $code)."
    echo "captive_portal" > "$STATE/last_block_reason"
  fi
  return 1
}

wait_for_wifi() {
  local deadline=$(( $(date +%s) + WIFI_WAIT ))
  log "Waiting up to ${WIFI_WAIT}s for dealer Wi-Fi..."
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if online; then log "Online via Wi-Fi."; return 0; fi
    sleep 10
  done
  return 1
}

# --- AP fallback -----------------------------------------------------------
start_ap() {
  local ap_ssid="QConnect-Setup-${DEVICE_ID}"
  log "Starting fallback hotspot: $ap_ssid"
  nmcli connection delete qconnect-hotspot >/dev/null 2>&1
  nmcli connection add type wifi ifname wlan0 con-name qconnect-hotspot \
        ssid "$ap_ssid" \
        802-11-wireless.mode ap 802-11-wireless.band bg \
        ipv4.method shared ipv4.addresses 10.42.0.1/24 \
        connection.autoconnect no >/dev/null 2>&1
  nmcli connection up qconnect-hotspot >/dev/null 2>&1
  python3 $QCONNECT/qconnect-portal.py &
  PORTAL_PID=$!
  log "Portal running (pid $PORTAL_PID). Window: ${AP_WINDOW}s."
}

stop_ap() {
  [ -n "${PORTAL_PID:-}" ] && kill "$PORTAL_PID" 2>/dev/null
  nmcli connection down qconnect-hotspot >/dev/null 2>&1
  nmcli connection delete qconnect-hotspot >/dev/null 2>&1
  log "Hotspot stopped."
}

apply_new_wifi() {
  # Portal drops credentials at $STATE/new-wifi.json
  local ssid pass
  ssid=$(python3 -c "import json;print(json.load(open('$STATE/new-wifi.json'))['ssid'])")
  pass=$(python3 -c "import json;print(json.load(open('$STATE/new-wifi.json')).get('pass',''))")
  rm -f "$STATE/new-wifi.json"
  log "Applying new Wi-Fi credentials for SSID: $ssid"
  nmcli connection delete qconnect-dealer-wifi >/dev/null 2>&1
  if [ -n "$pass" ]; then
    nmcli connection add type wifi ifname wlan0 con-name qconnect-dealer-wifi \
          ssid "$ssid" wifi-sec.key-mgmt wpa-psk wifi-sec.psk "$pass" \
          connection.autoconnect yes connection.autoconnect-retries 0 >/dev/null 2>&1
  else
    nmcli connection add type wifi ifname wlan0 con-name qconnect-dealer-wifi \
          ssid "$ssid" \
          connection.autoconnect yes connection.autoconnect-retries 0 >/dev/null 2>&1
  fi
  nmcli connection up qconnect-dealer-wifi >/dev/null 2>&1
}

ap_fallback_cycle() {
  start_ap
  local deadline=$(( $(date +%s) + AP_WINDOW ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if [ -f "$STATE/new-wifi.json" ]; then
      stop_ap
      apply_new_wifi
      return 0
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
  local host
  host=$(echo "$DEVICE_ID" | tr '[:upper:]' '[:lower:]')
  tailscale up --authkey="$TS_KEY" --hostname="$host" \
    --ssh --accept-dns=false || return 1
  log "Joined tailnet as $host ($(tailscale ip -4 2>/dev/null | head -1))"
  # Security: the pre-auth key is single-use for this box. Strip it from
  # disk so a stolen SD card cannot be used to join the tailnet elsewhere.
  python3 - <<'PYEOF'
import json
p = json.load(open('/opt/qconnect/etc/provision.json'))
p['tailscale_authkey'] = 'REDACTED-AFTER-JOIN'
json.dump(p, open('/opt/qconnect/etc/provision.json','w'), indent=2)
PYEOF
  return 0
}

# --- Supabase registration -------------------------------------------------
register_device() {
  local ts_ip payload code
  ts_ip=$(tailscale ip -4 2>/dev/null | head -1)
  payload=$(python3 - "$DEVICE_ID" "$DEALER_ID" "$DEVICE_TOKEN" "$ts_ip" <<'PYEOF'
import json, sys
print(json.dumps({"p_device_id": sys.argv[1], "p_dealer_id": sys.argv[2],
                  "p_device_token": sys.argv[3], "p_tailscale_ip": sys.argv[4]}))
PYEOF
)
  code=$(curl -s -o /tmp/qconnect-reg.out -w '%{http_code}' --max-time 20 \
    -X POST "$SB_URL/rest/v1/rpc/qconnect_register" \
    -H "apikey: $SB_KEY" -H "Authorization: Bearer $SB_KEY" \
    -H "Content-Type: application/json" -d "$payload")
  if [ "$code" = "200" ] || [ "$code" = "204" ]; then
    log "Registered with Supabase."
    return 0
  fi
  log "Supabase registration failed (HTTP $code): $(cat /tmp/qconnect-reg.out)"
  return 1
}

# --- main loop --------------------------------------------------------------
log "=== QConnect setup starting (device=$DEVICE_ID dealer=$DEALER_ID) ==="

until online; do
  wait_for_wifi && break
  ap_fallback_cycle || log "AP window closed with no credentials. Retrying Wi-Fi."
done
log "Network is up."

until join_tailnet; do log "Tailscale join failed. Retrying in 60s."; sleep 60; done

until register_device; do log "Registration failed. Retrying in 60s."; sleep 60; done

date -u +%FT%TZ > "$STATE/provisioned"
systemctl start qconnect-heartbeat.service 2>/dev/null
log "=== Provisioning complete. ==="
exit 0
