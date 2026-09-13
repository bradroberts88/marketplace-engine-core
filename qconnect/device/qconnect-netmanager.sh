#!/bin/bash
# QConnect connection manager.
#
# Sourced by qconnect-setup.sh (and usable standalone: `qconnect-netmanager.sh once`).
# One job: get this box online by whatever means are physically present, in this order:
#
#   1. ethernet  - built-in port (Pi 4) or a USB ethernet adapter (Pi Zero 2 W)
#   2. wifi      - the bench-baked dealer network, then any other saved profile
#   3. cellular  - any USB/hat modem ModemManager can see (hardware-agnostic)
#   4. hotspot   - a bench-saved phone hotspot, last resort before asking a human
#
# "Online" means real internet: the probe must return 204. A dealer guest portal
# answers 200/302 and is explicitly NOT online.
#
# Everything it learns is written to $STATE/net-state.json so the heartbeat and the
# setup portal can both report the same truth instead of guessing.

set -u

QCONNECT=${QCONNECT:-/opt/qconnect}
STATE=${STATE:-$QCONNECT/state}
PROV=${PROV:-$QCONNECT/etc/provision.json}
NET_STATE="$STATE/net-state.json"

PROBE_URL=${PROBE_URL:-http://connectivitycheck.gstatic.com/generate_204}
PROBE_TIMEOUT=${PROBE_TIMEOUT:-8}

nm_log() { echo "[$(date '+%F %T')] [net] $*"; }

pj() { python3 -c "import json,sys;print(json.load(open('$PROV')).get(sys.argv[1],'') or '')" "$1" 2>/dev/null; }

# ---------------------------------------------------------------- state file
# connection_path: ethernet | wifi | cellular | hotspot | none
# stuck_step: the step we are currently failing at, so a box with internet but a
#             broken later step is distinguishable from a box with no internet.
write_net_state() {
  local path="$1" detail="$2" reason="${3:-}"
  mkdir -p "$STATE"
  QN_PATH="$path" QN_DETAIL="$detail" QN_REASON="$reason" \
  QN_MODEL="$(pi_model)" QN_LINK="$(link_quality "$path")" \
  python3 - "$NET_STATE" <<'PYEOF'
import json, os, sys, tempfile, datetime
doc = {
    "connection_path": os.environ.get("QN_PATH", "none"),
    "connection_detail": os.environ.get("QN_DETAIL", "") or None,
    "last_error": os.environ.get("QN_REASON", "") or None,
    "pi_model": os.environ.get("QN_MODEL", "") or None,
    "link_quality": (lambda v: int(v) if v.lstrip("-").isdigit() else None)(
        os.environ.get("QN_LINK", "")),
    "updated_at": datetime.datetime.now(datetime.timezone.utc)
        .strftime("%Y-%m-%dT%H:%M:%SZ"),
}
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(sys.argv[1]))
with os.fdopen(fd, "w") as f:
    json.dump(doc, f)
os.replace(tmp, sys.argv[1])
PYEOF
}

pi_model() { tr -d '\0' < /proc/device-tree/model 2>/dev/null || echo unknown; }

# 2.4 GHz-only radios (Zero W, Zero 2 W, Pi 3) simply cannot see a 5 GHz SSID.
# Knowing this on the server side turns "this one card won't connect" into a
# one-line answer.
radio_is_dual_band() {
  iw phy 2>/dev/null | grep -q '5[0-9][0-9][0-9] MHz' && return 0
  return 1
}

link_quality() {
  case "$1" in
    wifi|hotspot)
      nmcli -t -f IN-USE,SIGNAL device wifi list 2>/dev/null |
        awk -F: '$1=="*"{print $2; exit}'
      ;;
    cellular) mmcli -m any 2>/dev/null | awk -F"'" '/signal quality/{print $2; exit}' ;;
    ethernet) echo 100 ;;
    *) echo "" ;;
  esac
}

# ------------------------------------------------------------ online probing
online() {
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time "$PROBE_TIMEOUT" "$PROBE_URL" 2>/dev/null)
  case "$code" in
    204) return 0 ;;
    200|302|303) echo captive_portal > "$STATE/last_block_reason"; return 1 ;;
    *) return 1 ;;
  esac
}

# Which interface is actually carrying the default route right now.
active_path() {
  local dev type
  dev=$(ip route show default 2>/dev/null | awk '{print $5; exit}')
  [ -n "$dev" ] || { echo "none:"; return; }
  type=$(nmcli -t -f DEVICE,TYPE device status 2>/dev/null | awk -F: -v d="$dev" '$1==d{print $2}')
  case "$type" in
    ethernet) echo "ethernet:$dev" ;;
    gsm|cdma|wwan) echo "cellular:$dev" ;;
    wifi)
      local ssid hotspot
      ssid=$(nmcli -t -f ACTIVE,SSID device wifi 2>/dev/null | awk -F: '$1=="yes"{print $2; exit}')
      hotspot=$(pj hotspot_ssid)
      if [ -n "$hotspot" ] && [ "$ssid" = "$hotspot" ]; then echo "hotspot:$ssid"
      else echo "wifi:$ssid"; fi
      ;;
    *) echo "wifi:$dev" ;;
  esac
}

# ----------------------------------------------------------------- ethernet
# Nothing to configure: NetworkManager brings a cable up on its own. All we do is
# notice the carrier and give DHCP a moment. Works identically for a USB adapter.
have_ethernet_carrier() {
  local dev
  for dev in $(nmcli -t -f DEVICE,TYPE device status 2>/dev/null | awk -F: '$2=="ethernet"{print $1}'); do
    [ "$(cat "/sys/class/net/$dev/carrier" 2>/dev/null)" = "1" ] && return 0
  done
  return 1
}

try_ethernet() {
  have_ethernet_carrier || return 1
  nm_log "Ethernet cable detected; waiting for DHCP."
  local i
  for i in $(seq 1 12); do
    online && { nm_log "Online over ethernet."; return 0; }
    sleep 5
  done
  nm_log "Ethernet cable is in but there is no internet behind it."
  return 1
}

# --------------------------------------------------------------------- wifi
wifi_device() { nmcli -t -f DEVICE,TYPE device status 2>/dev/null | awk -F: '$2=="wifi"{print $1; exit}'; }

# Create/refresh a wifi profile. Hidden networks need 802-11-wireless.hidden,
# without which nmcli never associates at all.
upsert_wifi_profile() {
  local name="$1" ssid="$2" psk="$3" hidden="$4" priority="$5" dev
  dev=$(wifi_device); [ -n "$dev" ] || return 1
  nmcli connection delete "$name" >/dev/null 2>&1
  local args=(connection add type wifi ifname "$dev" con-name "$name" ssid "$ssid"
              connection.autoconnect yes
              connection.autoconnect-retries 0
              connection.autoconnect-priority "$priority")
  [ "$hidden" = "yes" ] && args+=(802-11-wireless.hidden yes)
  if [ -n "$psk" ]; then args+=(wifi-sec.key-mgmt wpa-psk wifi-sec.psk "$psk"); fi
  nmcli "${args[@]}" >/dev/null 2>&1
}

# Association success is NOT the same as "the password was right": nmcli can
# return 0 on an activation attempt. We verify the profile is really ACTIVATED.
wifi_profile_activated() {
  nmcli -t -f NAME,STATE connection show --active 2>/dev/null |
    grep -q "^$1:activated$"
}

activate_wifi() {
  local name="$1"
  nmcli connection up "$name" >/dev/null 2>&1
  local i
  for i in $(seq 1 10); do
    wifi_profile_activated "$name" && return 0
    sleep 3
  done
  return 1
}

# Distinguishes the three failures staff actually hit: out of range, wrong
# password, and associated-but-no-internet. Echoes a machine-readable reason.
verify_wifi() {
  local name="$1" ssid="$2"
  if ! activate_wifi "$name"; then
    if ! ssid_in_range "$ssid"; then
      if ! radio_is_dual_band; then
        echo "ssid_not_in_range_2g_radio"
      else
        echo "ssid_not_in_range"
      fi
    else
      echo "wrong_password"
    fi
    return 1
  fi
  local i
  for i in $(seq 1 6); do
    online && { echo ok; return 0; }
    sleep 5
  done
  echo "joined_but_no_internet"
  return 1
}

ssid_in_range() {
  nmcli -t -f SSID device wifi list --rescan auto 2>/dev/null |
    grep -Fxq "$1"
}

try_wifi() {
  local ssid psk hidden name reason
  ssid=$(pj wifi_ssid)
  if [ -n "$ssid" ]; then
    psk=$(pj wifi_pass); hidden=$(pj wifi_hidden)
    name=qconnect-dealer-wifi
    nmcli -t -f NAME connection show 2>/dev/null | grep -Fxq "$name" ||
      upsert_wifi_profile "$name" "$ssid" "$psk" "${hidden:-no}" 100
    reason=$(verify_wifi "$name" "$ssid")
    if [ "$reason" = "ok" ]; then nm_log "Online over Wi-Fi ($ssid)."; return 0; fi
    nm_log "Wi-Fi '$ssid' failed: $reason"
    echo "$reason" > "$STATE/last_block_reason"
  fi
  # Any other saved network (a previous rescue, a second site SSID).
  local other
  for other in $(nmcli -t -f NAME,TYPE connection show 2>/dev/null |
                 awk -F: '$2=="802-11-wireless"{print $1}' |
                 grep -v '^qconnect-hotspot$' | grep -v '^qconnect-dealer-wifi$'); do
    activate_wifi "$other" || continue
    online && { nm_log "Online over saved Wi-Fi ($other)."; return 0; }
  done
  return 1
}

# ----------------------------------------------------------------- cellular
# Deliberately hardware-agnostic: anything ModemManager enumerates works, so the
# exact USB stick or hat can be chosen later without touching this code.
#
# AT&T SIM cards are the fleet default. If no APN is configured, the manager
# falls back to "broadband" (AT&T consumer/IoT data). Other common AT&T APNs:
#   - m2m.com.attz  : AT&T IoT/M2M plans
#   - att.mvno      : AT&T MVNO/reseller plans
#   - broadband     : generic AT&T data (default used here)
modem_present() { command -v mmcli >/dev/null 2>&1 && mmcli -L 2>/dev/null | grep -q Modem; }

# The SIM must be present and the modem registered to a tower before a PDP
# context can even be attempted. This is the fastest way to distinguish
# "no SIM" / "no coverage" from "wrong APN".
modem_registration_state() {
  mmcli -m any 2>/dev/null | awk -F: '/state/ {gsub(/^[ \t]+|[ \t]+$/,""); print tolower($2); exit}'
}

att_default_apn() {
  local configured; configured=$(pj cellular_apn)
  [ -n "$configured" ] && echo "$configured" || echo "broadband"
}

try_cellular() {
  modem_present || return 1
  local apn user pass name reg
  apn=$(att_default_apn)
  user=$(pj cellular_user); pass=$(pj cellular_pass); name=qconnect-cellular

  reg=$(modem_registration_state)
  case "$reg" in
    *locked*)   nm_log "SIM is PIN-locked."; echo cellular_sim_locked > "$STATE/last_block_reason"; return 1 ;;
    *failed*)   nm_log "Modem failed to register to a tower."; echo cellular_no_tower > "$STATE/last_block_reason"; return 1 ;;
    *disabled*) nm_log "SIM/RF disabled."; echo cellular_sim_disabled > "$STATE/last_block_reason"; return 1 ;;
  esac

  nm_log "Modem detected; bringing up cellular (APN $apn)."
  if ! nmcli -t -f NAME connection show 2>/dev/null | grep -Fxq "$name"; then
    local args=(connection add type gsm ifname '*' con-name "$name" apn "$apn"
                connection.autoconnect yes
                connection.autoconnect-retries 0
                connection.autoconnect-priority 50
                gsm.number '*99#'
                gsm.home-only no
                ipv4.method auto
                ipv6.method auto
                gsm.network-type prefer-4g-or-3g)
    [ -n "$user" ] && args+=(gsm.username "$user")
    [ -n "$pass" ] && args+=(gsm.password "$pass")
    nmcli "${args[@]}" >/dev/null 2>&1
  fi
  nmcli connection up "$name" >/dev/null 2>&1
  local i
  for i in $(seq 1 12); do
    online && { nm_log "Online over cellular."; return 0; }
    sleep 5
  done
  nm_log "Cellular did not come up (SIM, APN or coverage)."
  echo cellular_failed > "$STATE/last_block_reason"
  return 1
}

# ------------------------------------------------------------- phone hotspot
try_hotspot() {
  local ssid psk
  ssid=$(pj hotspot_ssid); [ -n "$ssid" ] || return 1
  psk=$(pj hotspot_pass)
  upsert_wifi_profile qconnect-phone-hotspot "$ssid" "$psk" no 10
  if [ "$(verify_wifi qconnect-phone-hotspot "$ssid")" = "ok" ]; then
    nm_log "Online over the saved phone hotspot."
    return 0
  fi
  return 1
}

# ------------------------------------------------------------------ the loop
# Tries every path that is physically present, cheapest first. Returns 0 the
# moment anything works; returns 1 only when all of them are exhausted, which is
# the signal for the caller to raise the setup hotspot and ask a human.
connect_any() {
  local p
  if online; then
    p=$(active_path)
    write_net_state "${p%%:*}" "${p#*:}"
    return 0
  fi
  for attempt in ethernet wifi cellular hotspot; do
    case "$attempt" in
      ethernet) try_ethernet ;;
      wifi)     try_wifi ;;
      cellular) try_cellular ;;
      hotspot)  try_hotspot ;;
    esac
    if [ $? -eq 0 ]; then
      p=$(active_path)
      write_net_state "${p%%:*}" "${p#*:}"
      return 0
    fi
  done
  write_net_state none "" "$(cat "$STATE/last_block_reason" 2>/dev/null || echo no_path)"
  return 1
}

# Standalone mode: `qconnect-netmanager.sh once` for bench testing and for the
# watchdog that re-runs it if the working path later drops.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  case "${1:-once}" in
    once) connect_any; exit $? ;;
    state) cat "$NET_STATE" 2>/dev/null; exit 0 ;;
    watch)
      while true; do
        online || { nm_log "Lost connectivity; falling back down the list."; connect_any; }
        sleep 60
      done
      ;;
  esac
fi
