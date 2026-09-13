#!/bin/bash
#
# QConnect first-run installer.
# Runs ONCE as root on first boot (invoked via systemd.run on the kernel
# command line), installs the QConnect agent into the rootfs, then self-removes
# and reboots into normal operation.
#
# Unlike v1 it refuses to half-install: a missing payload or an OS without
# NetworkManager is reported loudly to the log AND the console instead of
# producing a box that boots, looks healthy, and never connects.

set +e
exec > >(tee -a /var/log/qconnect-firstrun.log) 2>&1
echo "QConnect firstrun starting: $(date)"

die() {
  echo "QCONNECT FATAL: $*"
  # Put it where a human with an HDMI cable will actually see it.
  echo "QCONNECT FATAL: $*" > /etc/issue.d/qconnect.issue 2>/dev/null
  echo "QCONNECT FATAL: $*" > /dev/console 2>/dev/null
  exit 1
}

# Bookworm mounts the boot partition at /boot/firmware; older at /boot.
BOOTDIR=""
for d in /boot/firmware /boot; do
  [ -d "$d/qconnect" ] && { BOOTDIR="$d"; break; }
done
[ -n "$BOOTDIR" ] || die "no qconnect payload found on the boot partition"
SRC="$BOOTDIR/qconnect"
[ -s "$SRC/provision.json" ] || die "provision.json missing - this card was written incorrectly"

# --- hard requirement: NetworkManager --------------------------------------
# Every network action in this kit is nmcli. On a legacy dhcpcd/wpa_supplicant
# image they all fail silently, which is the single most confusing failure mode
# there is. Refuse to pretend.
command -v nmcli >/dev/null 2>&1 || \
  die "NetworkManager (nmcli) is not installed - flash Raspberry Pi OS Bookworm or newer"
systemctl is-enabled NetworkManager >/dev/null 2>&1 || systemctl enable NetworkManager
systemctl is-active NetworkManager >/dev/null 2>&1 || systemctl start NetworkManager
systemctl is-active NetworkManager >/dev/null 2>&1 || \
  die "NetworkManager is installed but will not start"

install -d -m 755 /opt/qconnect /opt/qconnect/state
install -d -m 700 /opt/qconnect/etc

# qconnect-steps.sh is SOURCED by qconnect-setup.sh, and the update/command
# scripts are what let a box be fixed remotely. A card missing any of them
# boots, looks alive and never finishes setting itself up.
for f in qconnect-setup.sh qconnect-netmanager.sh qconnect-steps.sh qconnect-portal.py \
         qconnect-heartbeat.sh; do
  install -m 755 "$SRC/$f" "/opt/qconnect/$f" || die "could not install $f"
done
# Optional on older cards; required for remote repair on new ones.
for f in qconnect-agent-update.sh qconnect-command-exec.sh; do
  [ -f "$SRC/$f" ] && install -m 755 "$SRC/$f" "/opt/qconnect/$f"
done
install -m 600 "$SRC/provision.json" /opt/qconnect/etc/provision.json || die "could not install provision.json"
[ -f "$SRC/VERSION" ] && install -m 644 "$SRC/VERSION" /opt/qconnect/VERSION

for u in qconnect-setup.service qconnect-heartbeat.service qconnect-heartbeat.timer \
         qconnect-netwatch.service; do
  install -m 644 "$SRC/$u" "/etc/systemd/system/$u" || die "could not install $u"
done

# Set hostname to the device id (lowercased) so it is recognizable on the tailnet.
DEVICE_ID=$(python3 -c "import json;print(json.load(open('/opt/qconnect/etc/provision.json'))['device_id'].lower())" 2>/dev/null)
if [ -n "$DEVICE_ID" ]; then
  echo "$DEVICE_ID" > /etc/hostname
  sed -i "s/127.0.1.1.*/127.0.1.1\t$DEVICE_ID/" /etc/hosts
fi

# --- Wi-Fi regulatory domain, three ways -----------------------------------
# raspi-config is absent on minimal/third-party images, and without a regdomain
# the radio can stay soft-blocked. Belt, braces and a second belt.
COUNTRY=$(python3 -c "import json;print(json.load(open('/opt/qconnect/etc/provision.json')).get('wifi_country','US'))" 2>/dev/null)
COUNTRY=${COUNTRY:-US}
command -v raspi-config >/dev/null 2>&1 && raspi-config nonint do_wifi_country "$COUNTRY"
echo "options cfg80211 ieee80211_regdom=$COUNTRY" > /etc/modprobe.d/qconnect-regdom.conf
mkdir -p /etc/default && sed -i '/^REGDOMAIN=/d' /etc/default/crda 2>/dev/null
echo "REGDOMAIN=$COUNTRY" >> /etc/default/crda 2>/dev/null
iw reg set "$COUNTRY" 2>/dev/null
rfkill unblock wifi 2>/dev/null
rfkill unblock all 2>/dev/null

# Cellular: ModemManager is what makes any USB/hat modem "just appear". Enable
# it when present; a box with no modem is unaffected.
if systemctl list-unit-files 2>/dev/null | grep -q '^ModemManager.service'; then
  systemctl enable --now ModemManager 2>/dev/null
else
  echo "NOTE: ModemManager is not installed; cellular fallback will be skipped."
fi

# Captive-portal DNS wildcard for the fallback hotspot (NetworkManager's
# shared-mode dnsmasq): every DNS name resolves to the QConnect so phones pop
# the setup page automatically.
install -d /etc/NetworkManager/dnsmasq-shared.d
echo "address=/#/10.42.0.1" > /etc/NetworkManager/dnsmasq-shared.d/qconnect-portal.conf

# Baked dealer Wi-Fi profile (if provided). Highest autoconnect priority after
# ethernet, retries forever, supports hidden SSIDs.
python3 <<'PYEOF'
import json, subprocess
p = json.load(open('/opt/qconnect/etc/provision.json'))
ssid, psk = p.get('wifi_ssid') or '', p.get('wifi_pass') or ''
if ssid:
    cmd = ['nmcli', 'connection', 'add', 'type', 'wifi', 'ifname', 'wlan0',
           'con-name', 'qconnect-dealer-wifi', 'ssid', ssid,
           'connection.autoconnect', 'yes',
           'connection.autoconnect-retries', '0',
           'connection.autoconnect-priority', '100']
    if str(p.get('wifi_hidden', '')).lower() in ('yes', 'true', '1'):
        cmd += ['802-11-wireless.hidden', 'yes']
    if psk:
        cmd += ['wifi-sec.key-mgmt', 'wpa-psk', 'wifi-sec.psk', psk]
    subprocess.run(cmd, check=False)

# Optional bench-saved phone hotspot: the last automatic resort.
h_ssid, h_pass = p.get('hotspot_ssid') or '', p.get('hotspot_pass') or ''
if h_ssid:
    cmd = ['nmcli', 'connection', 'add', 'type', 'wifi', 'ifname', 'wlan0',
           'con-name', 'qconnect-phone-hotspot', 'ssid', h_ssid,
           'connection.autoconnect', 'yes',
           'connection.autoconnect-retries', '0',
           'connection.autoconnect-priority', '10']
    if h_pass:
        cmd += ['wifi-sec.key-mgmt', 'wpa-psk', 'wifi-sec.psk', h_pass]
    subprocess.run(cmd, check=False)
PYEOF

# If a modem is fitted and no APN was set at the bench, default to the AT&T
# consumer/IoT APN so the box has a fighting chance out of the box.
python3 <<'PYEOF'
import json
p = json.load(open('/opt/qconnect/etc/provision.json'))
if not p.get('cellular_apn') and (p.get('cellular_modem') or p.get('cellular_apn') == ''):
    p['cellular_apn'] = 'broadband'
    json.dump(p, open('/opt/qconnect/etc/provision.json','w'), indent=2)
PYEOF

# Wired always wins when a cable is present: highest priority of all.
nmcli connection modify "Wired connection 1" connection.autoconnect-priority 200 2>/dev/null

systemctl daemon-reload
systemctl enable qconnect-setup.service
systemctl enable qconnect-heartbeat.timer
systemctl enable qconnect-netwatch.service

# Remove secrets + firstrun hook from the boot partition.
rm -f "$SRC/provision.json"
sed -i 's| systemd.run=[^ ]*||g; s| systemd.run_success_action=[^ ]*||g; s| systemd.unit=[^ ]*||g' "$BOOTDIR/cmdline.txt"
rm -f "$BOOTDIR/cmdline.txt.qconnect-bak"

echo "QConnect firstrun complete: $(date)"
exit 0
