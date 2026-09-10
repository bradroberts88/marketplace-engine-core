#!/usr/bin/env bash
# Add / change a WiFi network on the box. MULTIPLE networks can be saved at once (e.g. the dealership WiFi AND a
# phone hotspot): NetworkManager auto-joins whichever is in RANGE, prefers the HIGHEST priority when both are, and
# auto-fails-over when one drops — so the box rides out a dead dealership router with nobody on site (operator
# 2026-07-15, after Roger's network proved unreliable). Ethernet, if plugged in, still wins over all WiFi.
#
#   add/update:  sudo bash set-wifi.sh "<SSID>" "<password>" [priority]   (higher priority = preferred; default 10)
#   list:        sudo bash set-wifi.sh --list
#   remove:      sudo bash set-wifi.sh --remove "<SSID>"
#   prefer:      sudo bash set-wifi.sh --prefer "<SSID>"                  (make this one win + switch to it now)
set -euo pipefail

# Autodetect the wifi interface — never hardcode wlan0 (a USB adapter or a CM4 can name it differently).
IFACE="$(nmcli -t -f DEVICE,TYPE device 2>/dev/null | awk -F: '$2=="wifi"{print $1; exit}')"
IFACE="${IFACE:-wlan0}"

# ONE connection profile PER SSID, so adding a second network never clobbers the first.
con_name_for() { echo "autopost-wifi-$(printf '%s' "$1" | tr -c '[:alnum:]' '-' | cut -c1-40)"; }

if [ "${1:-}" = "--list" ]; then
  echo "saved AutoPost networks (higher priority wins when both are in range):"
  nmcli -t -f NAME,TYPE connection show 2>/dev/null | awk -F: '$2=="802-11-wireless"{print $1}' | while read -r n; do
    case "$n" in autopost-wifi-*) ;; *) continue ;; esac
    ssid="$(nmcli -g 802-11-wireless.ssid connection show "$n" 2>/dev/null || true)"
    prio="$(nmcli -g connection.autoconnect-priority connection show "$n" 2>/dev/null || echo 0)"
    live=""; nmcli -t -f NAME connection show --active 2>/dev/null | grep -Fxq "$n" && live="   <-- CONNECTED NOW"
    echo "  ${ssid:-?}  (priority ${prio:-0})${live}"
  done
  exit 0
fi

if [ "${1:-}" = "--remove" ]; then
  SSID="${2:?usage: set-wifi.sh --remove <SSID>}"
  CON="$(con_name_for "$SSID")"
  if nmcli connection delete "$CON" >/dev/null 2>&1; then echo "removed '$SSID'"; else echo "no saved network '$SSID'"; fi
  exit 0
fi

if [ "${1:-}" = "--prefer" ]; then
  SSID="${2:?usage: set-wifi.sh --prefer <SSID>}"
  CON="$(con_name_for "$SSID")"
  nmcli connection modify "$CON" connection.autoconnect-priority 99 >/dev/null 2>&1 || { echo "no saved network '$SSID'"; exit 1; }
  if nmcli -t -f SSID device wifi list --rescan yes 2>/dev/null | grep -Fxq "$SSID"; then
    nmcli connection up "$CON" >/dev/null 2>&1 && echo "switched to '$SSID' now" || echo "'$SSID' preferred, but the join failed — autoconnect will retry"
  else
    echo "'$SSID' preferred (priority 99) — not in range now; the box switches to it automatically when it appears"
  fi
  exit 0
fi

SSID="${1:?usage: set-wifi.sh <SSID> <password> [priority] [--hidden] [--enterprise-user <identity>]}"
PASS="${2:?usage: set-wifi.sh <SSID> <password> [priority] [--hidden] [--enterprise-user <identity>]}"
shift 2
PRIO=10; HIDDEN=0; EAP_USER=""
while [ $# -gt 0 ]; do
  case "$1" in
    --hidden)          HIDDEN=1 ;;
    --enterprise-user) EAP_USER="${2:?--enterprise-user needs an identity}"; shift ;;
    *)                 PRIO="$1" ;;
  esac
  shift
done
CON="$(con_name_for "$SSID")"

# Re-using a PER-SSID profile name means a re-run UPDATES just that network (e.g. fixing a typo'd password) and
# leaves every OTHER saved network intact — that is exactly what lets WiFi + hotspot coexist and fail over.
nmcli connection delete "$CON" >/dev/null 2>&1 || true
nmcli connection add type wifi con-name "$CON" ifname "$IFACE" ssid "$SSID" \
  connection.autoconnect yes connection.autoconnect-priority "$PRIO" >/dev/null

# HIDDEN SSID: a non-broadcasting network never appears in a scan, so NM must be told to actively probe for it or
# the box will NEVER join. Dealerships "hide" their WiFi for security surprisingly often.
if [ "$HIDDEN" = 1 ]; then nmcli connection modify "$CON" 802-11-wireless.hidden yes >/dev/null; fi

if [ -n "$EAP_USER" ]; then
  # WPA-ENTERPRISE (802.1x, PEAP/MSCHAPv2): corporate WiFi where each user has a USERNAME + PASSWORD instead of one
  # shared key. Common at dealerships — and without this the box simply cannot join their network at all.
  nmcli connection modify "$CON" \
    wifi-sec.key-mgmt wpa-eap \
    802-1x.eap peap \
    802-1x.phase2-auth mschapv2 \
    802-1x.identity "$EAP_USER" \
    802-1x.password "$PASS" >/dev/null
  # Corporate RADIUS usually presents a private-CA cert we have no way to ship. Don't validate it: this is an
  # outbound-only appliance on the dealership's own LAN, and failing the handshake would just strand the box.
  nmcli connection modify "$CON" 802-1x.system-ca-certs no >/dev/null 2>&1 || true
  MODE="enterprise ($EAP_USER)"
else
  nmcli connection modify "$CON" wifi-sec.key-mgmt wpa-psk wifi-sec.psk "$PASS" >/dev/null
  MODE="wpa-psk"
fi
[ "$HIDDEN" = 1 ] && MODE="$MODE, hidden"

# CRITICAL: only switch to it NOW if the SSID is actually in range. Onboarding pre-loads a dealership's WiFi that
# is NOT in range yet (the box is still at our office) — forcing `nmcli up` on an absent network drops the current
# connection and can strand the device. Save-only when absent; autoconnect joins it on arrival.
# A HIDDEN network never shows in a scan, so skip the range check for it and let autoconnect do the probing.
if [ "$HIDDEN" = 0 ] && nmcli -t -f SSID device wifi list --rescan yes 2>/dev/null | grep -Fxq "$SSID"; then
  nmcli connection up "$CON" >/dev/null 2>&1 \
    && echo "saved + connected to '$SSID' (priority $PRIO, $MODE)" \
    || echo "saved '$SSID' (priority $PRIO, $MODE) — in range but the join failed (check the credentials); autoconnect will retry"
else
  echo "saved '$SSID' (priority $PRIO, $MODE) — not in range now (or hidden); the box auto-joins it when it arrives"
fi
