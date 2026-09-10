#!/bin/bash
# pi-verify.sh - production bench acceptance test. Runs ON the Pi, over the USB link, driven by VERIFY-PI.cmd.
#
# Prints one machine-readable line per check:   PASS <id> | FAIL <id> :: <reason> | WARN <id> :: <reason>
# and finishes with                             VERDICT: PASS | VERDICT: FAIL
#
# Design rules, because this gates SHIPPING:
#   * Every check states WHY it matters in its FAIL text, so whoever is boxing units does not need this file.
#   * FAIL only for things that make a unit unfit to ship. Anything cosmetic or environment-dependent is WARN.
#   * Read-only by default. The one mutating check (the rescue-AP smoke test) restores state afterwards and is
#     opt-in via --ap.
#
# Usage: sudo bash pi-verify.sh [--ap] [--expect-ssid "Dealership WiFi"]
set +e
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

DO_AP=0
EXPECT_SSID=""
while [ $# -gt 0 ]; do
  case "$1" in
    --ap) DO_AP=1 ;;
    --expect-ssid) shift; EXPECT_SSID="$1" ;;
  esac
  shift
done

FAILED=0
pass() { echo "PASS $1"; }
fail() { echo "FAIL $1 :: $2"; FAILED=1; }
warn() { echo "WARN $1 :: $2"; }

# ---------------------------------------------------------------- identity
HOSTN="$(hostname 2>/dev/null)"
SERIAL="$(sed -n 's/^Serial\s*:\s*//p' /proc/cpuinfo 2>/dev/null | tail -1)"
MODEL="$(tr -d '\0' < /proc/device-tree/model 2>/dev/null)"
echo "INFO hostname=${HOSTN}"
echo "INFO serial=${SERIAL}"
echo "INFO model=${MODEL}"

# ---------------------------------------------------------------- services that MUST be enabled to ship
for svc in autopost-connector autopost-wifi-recovery autopost-ble-setup autopost-tailscale tailscaled; do
  if systemctl is-enabled "$svc" >/dev/null 2>&1; then
    pass "svc-enabled:${svc}"
  else
    fail "svc-enabled:${svc}" "not enabled - this unit will boot and never start ${svc}"
  fi
done

# wifi-recovery must also be RUNNING: it is the only on-site rescue if the WiFi was mis-typed.
if systemctl is-active autopost-wifi-recovery >/dev/null 2>&1; then
  pass "svc-active:autopost-wifi-recovery"
else
  fail "svc-active:autopost-wifi-recovery" "not running - a wrong-WiFi unit would be unrecoverable without a truck roll"
fi

# ---------------------------------------------------------------- the PMF fix (the 2026-08-14 AP bug)
WR=/opt/autopost/connector/src/wifi-recovery.js
if [ -f "$WR" ]; then
  if grep -q "wifi-sec.pmf" "$WR"; then
    pass "rescue-ap-pmf-fix"
  else
    fail "rescue-ap-pmf-fix" "startAp() does not pin wifi-sec.pmf - on a Zero W the rescue AP will NEVER come up (NM negotiates WPA-PSK-SHA256, which BCM43430 cannot do in AP mode)"
  fi
else
  fail "rescue-ap-pmf-fix" "wifi-recovery.js missing from ${WR} - connector not installed?"
fi

# ---------------------------------------------------------------- persistence partition
if mountpoint -q /var/lib/autopost; then
  pass "data-partition-mounted"
else
  fail "data-partition-mounted" "/var/lib/autopost is not a mount - claim identity and WiFi would be lost on a power cut once the read-only overlay is enabled"
fi

# ---------------------------------------------------------------- WiFi profiles
PROFILES="$(nmcli -t -f NAME,TYPE connection show 2>/dev/null | grep '802-11-wireless' | cut -d: -f1)"
NPROF="$(echo "$PROFILES" | grep -c '^autopost-')"
if [ "$NPROF" -ge 1 ]; then
  pass "wifi-profile-count:${NPROF}"
else
  fail "wifi-profile-count" "no autopost-* WiFi profile written - this unit can never join a network"
fi
if [ -n "$EXPECT_SSID" ]; then
  FOUND=0
  for p in $PROFILES; do
    S="$(nmcli -g 802-11-wireless.ssid connection show "$p" 2>/dev/null)"
    [ "$S" = "$EXPECT_SSID" ] && FOUND=1
  done
  if [ "$FOUND" = 1 ]; then
    pass "wifi-ssid-matches"
  else
    fail "wifi-ssid-matches" "no profile for the expected dealership SSID '${EXPECT_SSID}' - wrong card for this dealership?"
  fi
fi

# ---------------------------------------------------------------- claim (the real end-to-end proof)
if [ -f /var/lib/autopost/config.json ]; then
  pass "claimed"
else
  fail "claimed" "no /var/lib/autopost/config.json - the unit never reached the hub and redeemed its setup code; it will ship inactive and invisible"
fi

# ---------------------------------------------------------------- tailscale (remote recall path)
# Do NOT truncate the JSON: BackendState sits well past the first few hundred bytes once the tailnet has peers,
# and a `head -c` here produced a FALSE FAIL on a unit that was demonstrably joined. Grep the whole document, and
# take the self address as a second, independent confirmation.
TS_STATE="$(tailscale status --json 2>/dev/null | tr -d ' \n' | grep -o '"BackendState":"[^"]*"' | head -1 | sed 's/.*:"//; s/"//')"
TS_SELF="$(tailscale ip -4 2>/dev/null | head -1)"
if [ "$TS_STATE" = "Running" ] && [ -n "$TS_SELF" ]; then
  pass "tailscale-joined:${TS_SELF}"
elif [ "$TS_STATE" = "NeedsLogin" ] || [ "$TS_STATE" = "Stopped" ]; then
  fail "tailscale-joined" "tailscaled is up but not joined (state=${TS_STATE}) - you would have no off-LAN way to reach this unit after it ships"
elif [ -n "$TS_STATE" ]; then
  fail "tailscale-joined" "tailscale state=${TS_STATE}, self=${TS_SELF:-none} - not confirmed joined"
else
  fail "tailscale-joined" "tailscale not responding - no remote recall path"
fi

# ---------------------------------------------------------------- USB gadget (kept on shipped units by choice)
if systemctl is-enabled autopost-usb-gadget >/dev/null 2>&1; then
  pass "usb-gadget-enabled"
else
  warn "usb-gadget-enabled" "USB gadget service not enabled - this unit will not be reachable over a USB cable"
fi
if systemctl is-enabled ssh >/dev/null 2>&1 || systemctl is-enabled ssh.socket >/dev/null 2>&1; then
  pass "sshd-enabled"
else
  warn "sshd-enabled" "sshd not enabled"
fi

# ---------------------------------------------------------------- WiFi country / radio
REG="$(iw reg get 2>/dev/null | sed -n 's/^country \([A-Z][A-Z]\).*/\1/p' | head -1)"
if [ -n "$REG" ] && [ "$REG" != "00" ]; then
  pass "wifi-regdomain:${REG}"
else
  fail "wifi-regdomain" "regulatory domain is unset/world (00) - the radio can be soft-blocked and fail to associate"
fi
if rfkill list 2>/dev/null | grep -A2 -i 'wireless' | grep -qi 'Soft blocked: yes'; then
  fail "wifi-not-rfkilled" "wlan radio is soft-blocked"
else
  pass "wifi-not-rfkilled"
fi

# ---------------------------------------------------------------- OPTIONAL: prove the rescue AP actually raises
# This is the check that would have caught the shipped-and-broken state. Mutating, so it restores afterwards.
if [ "$DO_AP" = 1 ]; then
  ACTIVE_WIFI="$(nmcli -t -f NAME,TYPE,ACTIVE connection show --active 2>/dev/null | grep '802-11-wireless' | cut -d: -f1 | head -1)"
  nmcli connection delete verify-ap >/dev/null 2>&1
  nmcli connection add type wifi ifname wlan0 con-name verify-ap autoconnect no \
    ssid VERIFY-AP-SMOKETEST 802-11-wireless.mode ap 802-11-wireless.band bg \
    ipv4.method shared ipv6.method ignore >/dev/null 2>&1
  nmcli connection modify verify-ap wifi-sec.key-mgmt wpa-psk wifi-sec.psk "verifyap12345" wifi-sec.pmf 1 >/dev/null 2>&1
  nmcli --wait 35 connection up verify-ap >/dev/null 2>&1
  UP=$?
  GW=0
  for i in $(seq 1 12); do
    nmcli -g IP4.ADDRESS device show wlan0 2>/dev/null | grep -q '10.42.0.1' && { GW=1; break; }
    sleep 1
  done
  if [ "$UP" = 0 ] && [ "$GW" = 1 ]; then
    pass "rescue-ap-raises"
  else
    fail "rescue-ap-raises" "the rescue AP did not come up (activate=${UP} gateway=${GW}) - a wrong-WiFi unit would be unrecoverable on site"
  fi
  nmcli connection down verify-ap >/dev/null 2>&1
  nmcli connection delete verify-ap >/dev/null 2>&1
  # restore whatever wifi profile was active, and make sure nothing is left with autoconnect off
  for p in $(nmcli -t -f NAME,TYPE connection show 2>/dev/null | grep '802-11-wireless' | cut -d: -f1 | grep '^autopost-'); do
    nmcli connection modify "$p" connection.autoconnect yes >/dev/null 2>&1
  done
  [ -n "$ACTIVE_WIFI" ] && nmcli --wait 20 connection up "$ACTIVE_WIFI" >/dev/null 2>&1
fi

# ---------------------------------------------------------------- network mode: does the card match its intent
# firstrun.sh records which mode the card was PROVISIONED in. Checking the recorded intent against what the card
# actually has is the point: a card asked for wired but built as a gadget looks completely normal on the bench
# (it has a usb0, it answers SSH) and then arrives at a dealership with a dead adapter and no uplink.
NETMODE="$(cat /boot/firmware/autopost-network-mode 2>/dev/null || cat /boot/autopost-network-mode 2>/dev/null || echo wifi)"
NETMODE="$(printf '%s' "$NETMODE" | tr -d '[:space:]')"
echo "INFO network-mode=${NETMODE}"

DWC2=0
for CFG in /boot/firmware/config.txt /boot/config.txt; do
  [ -f "$CFG" ] || continue
  grep -qE '^[[:space:]]*dtoverlay=dwc2' "$CFG" 2>/dev/null && DWC2=1
done

if [ "$NETMODE" = wired ]; then
  # The port must be in HOST mode, which on this platform means the dwc2 overlay is ABSENT. A leftover
  # dr_mode=peripheral line leaves the adapter unpowered, with nothing on the box to explain why.
  if [ "$DWC2" = 0 ]; then
    pass "wired-port-host-mode"
  else
    fail "wired-port-host-mode" "config.txt still enables the dwc2 gadget overlay - the USB port stays in DEVICE mode and cannot power a USB-ethernet adapter. This card was built wired but will have no uplink."
  fi
  # A wired card that also carries WiFi profiles was built from a stale form. Not fatal, but it means the card is
  # not what the operator was told it is.
  ls /etc/NetworkManager/system-connections/autopost-*.nmconnection >/dev/null 2>&1     && grep -lqE '^type[[:space:]]*=[[:space:]]*wifi' /etc/NetworkManager/system-connections/autopost-*.nmconnection 2>/dev/null     && warn "wired-card-has-wifi" "this wired card also carries WiFi credentials - harmless, but it is not the card the operator was told they were shipping"
  [ -f /etc/NetworkManager/system-connections/autopost-eth0.nmconnection ] && pass "wired-profile-present"     || fail "wired-profile-present" "the autopost-eth0 profile is missing - the adapter will only work if the dealership network happens to hand out DHCP to an unconfigured device, and there is no service address"
  # The whole reason the wired card is reachable on a bench with no DHCP server.
  if ip -4 addr show 2>/dev/null | grep -q '10\.55\.0\.1'; then
    pass "wired-service-address"
  else
    warn "wired-service-address" "10.55.0.1 is not up yet - plug the USB-ethernet adapter in and re-check; without it this card can only be reached where there is DHCP"
  fi
  # Wired boxes are SSH-reached over the wire, so sshd is not optional on them.
  systemctl is-enabled ssh.socket >/dev/null 2>&1 || systemctl is-enabled ssh.service >/dev/null 2>&1     && pass "wired-sshd-enabled"     || fail "wired-sshd-enabled" "sshd is not enabled - a wired card has no other way in on a bench"
else
  [ "$DWC2" = 1 ] && pass "gadget-port-device-mode"     || warn "gadget-port-device-mode" "config.txt has no dwc2 overlay, so USB SSH will not come up on this card"
fi

# ---------------------------------------------------------------- SHIP BLOCKER: WiFi left disabled on disk
# THE bug that made bench-tested cards fail on arrival. While the rescue AP is up the daemon pauses station
# autoconnect so NetworkManager cannot grab the radio back; if that pause reaches the keyfile and the card is
# then unplugged, it ships with the customer's own network marked autoconnect=false and will not so much as
# attempt it on arrival - however perfect the credentials are. The pause is --temporary now, so this must never
# be true again; a card that still shows it was written by an older build and must not go in a box.
DISABLED=""
for f in /etc/NetworkManager/system-connections/autopost-*.nmconnection; do
  [ -f "$f" ] || continue
  grep -qE '^autoconnect[[:space:]]*=[[:space:]]*(false|0)' "$f" 2>/dev/null && DISABLED="$DISABLED $(basename "$f")"
done
if [ -n "$DISABLED" ]; then
  fail "wifi-autoconnect-on-disk" "profile(s)$DISABLED have autoconnect=false - this unit will NOT join the customer WiFi on arrival. Reboot the Pi (the rescue service repairs it on startup) and re-run."
else
  pass "wifi-autoconnect-on-disk"
fi

# A leftover rescue-AP profile means the last session was interrupted rather than closed. Harmless (startAp
# deletes it before re-adding) but it is a reliable tell that the card was unplugged mid-rescue, which is worth
# knowing before it goes out.
[ -f /etc/NetworkManager/system-connections/autopost-setup-ap.nmconnection ] \
  && warn "rescue-ap-profile-left-behind" "a previous rescue session was interrupted; not harmful, but this card was unplugged with the setup AP up"

# ---------------------------------------------------------------- the Bluetooth rescue channel
# The redundant way in. The WiFi rescue needs the WiFi radio and the Pi has exactly one, so there are always
# windows where the setup network is not in the air; Bluetooth is a separate controller and stays reachable
# through all of them. A unit shipping without it has one way home, not two.
if systemctl is-active autopost-ble-setup >/dev/null 2>&1; then
  pass "svc-active:autopost-ble-setup"
else
  fail "svc-active:autopost-ble-setup" "not running - this unit ships with only ONE rescue channel"
fi
if command -v hciconfig >/dev/null 2>&1 && hciconfig hci0 >/dev/null 2>&1; then
  hciconfig hci0 2>/dev/null | grep -q 'UP RUNNING' && pass "bt-adapter-up" \
    || fail "bt-adapter-up" "the Bluetooth adapter exists but is not up - the BLE rescue cannot advertise"
elif [ -d /sys/class/bluetooth/hci0 ]; then
  pass "bt-adapter-present"
else
  fail "bt-adapter-present" "no Bluetooth adapter - check config.txt for dtoverlay=disable-bt, and that hciuart is enabled"
fi
for pkg in bluez python3-dbus python3-gi; do
  dpkg -s "$pkg" >/dev/null 2>&1 && pass "bt-pkg:${pkg}" \
    || fail "bt-pkg:${pkg}" "missing - the BLE rescue channel cannot start"
done
[ -f /etc/dbus-1/system.d/60-autopost-bluez.conf ] && pass "bt-dbus-policy" \
  || fail "bt-dbus-policy" "the BlueZ D-Bus policy is missing - the unprivileged service cannot register its GATT app"
# Proof it actually registered, not merely that the unit is running. The service logs this line once BlueZ has
# accepted the application, which is the only evidence that the whole chain works on this board.
if journalctl -u autopost-ble-setup --no-pager -n 200 2>/dev/null | grep -q 'GATT application registered'; then
  pass "bt-gatt-registered"
else
  warn "bt-gatt-registered" "no 'GATT application registered' line yet - give it 30s after boot and re-check, or read: journalctl -u autopost-ble-setup"
fi

# ---------------------------------------------------------------- the diagnostic log
# Not a ship blocker, but its absence means a returned unit cannot say what it tried, which is how the field
# failures stayed undiagnosed for so long.
[ -f /var/lib/autopost/runtime/recovery-log.txt ] && pass "diag-log-present" \
  || warn "diag-log-present" "no rolling diagnostic log yet (normal on a box that has been up for under a minute)"

echo
if [ "$FAILED" = 0 ]; then echo "VERDICT: PASS"; else echo "VERDICT: FAIL"; fi
exit 0
