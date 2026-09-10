#!/bin/bash
#
# QConnect first-run installer.
# Runs ONCE as root on first boot (invoked via systemd.run on the kernel
# command line), installs the QConnect agent into the rootfs, then self-removes
# and reboots into normal operation.

set +e
exec >/var/log/qconnect-firstrun.log 2>&1
echo "QConnect firstrun starting: $(date)"

# Bookworm mounts the boot partition at /boot/firmware; older at /boot.
BOOTDIR=/boot/firmware
[ -d "$BOOTDIR/qconnect" ] || BOOTDIR=/boot
SRC="$BOOTDIR/qconnect"

install -d -m 755 /opt/qconnect /opt/qconnect/state
install -d -m 700 /opt/qconnect/etc

install -m 755 "$SRC/qconnect-setup.sh"      /opt/qconnect/qconnect-setup.sh
install -m 755 "$SRC/qconnect-portal.py"     /opt/qconnect/qconnect-portal.py
install -m 755 "$SRC/qconnect-heartbeat.sh"  /opt/qconnect/qconnect-heartbeat.sh
install -m 600 "$SRC/provision.json"     /opt/qconnect/etc/provision.json

install -m 644 "$SRC/qconnect-setup.service"     /etc/systemd/system/qconnect-setup.service
install -m 644 "$SRC/qconnect-heartbeat.service" /etc/systemd/system/qconnect-heartbeat.service
install -m 644 "$SRC/qconnect-heartbeat.timer"   /etc/systemd/system/qconnect-heartbeat.timer

# Set hostname to the device id (lowercased) so it is recognizable on the tailnet.
DEVICE_ID=$(python3 -c "import json;print(json.load(open('/opt/qconnect/etc/provision.json'))['device_id'].lower())" 2>/dev/null)
if [ -n "$DEVICE_ID" ]; then
  echo "$DEVICE_ID" > /etc/hostname
  sed -i "s/127.0.1.1.*/127.0.1.1\t$DEVICE_ID/" /etc/hosts
fi

# Set Wi-Fi regulatory domain and make sure radio is unblocked.
COUNTRY=$(python3 -c "import json;print(json.load(open('/opt/qconnect/etc/provision.json')).get('wifi_country','US'))" 2>/dev/null)
raspi-config nonint do_wifi_country "${COUNTRY:-US}" 2>/dev/null || true
rfkill unblock wifi 2>/dev/null || true

# Captive-portal DNS wildcard for the fallback hotspot (NetworkManager's
# shared-mode dnsmasq): every DNS name resolves to the QConnect so phones pop
# the setup page automatically.
install -d /etc/NetworkManager/dnsmasq-shared.d
echo "address=/#/10.42.0.1" > /etc/NetworkManager/dnsmasq-shared.d/qconnect-portal.conf

# Baked dealer Wi-Fi profile (if provided). autoconnect with retries.
python3 <<'PYEOF'
import json, subprocess
p = json.load(open('/opt/qconnect/etc/provision.json'))
ssid, psk = p.get('wifi_ssid') or '', p.get('wifi_pass') or ''
if ssid:
    cmd = ['nmcli', 'connection', 'add', 'type', 'wifi', 'ifname', 'wlan0',
           'con-name', 'qconnect-dealer-wifi', 'ssid', ssid,
           'connection.autoconnect', 'yes',
           'connection.autoconnect-retries', '0']  # 0 = retry forever
    if psk:
        cmd += ['wifi-sec.key-mgmt', 'wpa-psk', 'wifi-sec.psk', psk]
    subprocess.run(cmd, check=False)
PYEOF

systemctl daemon-reload
systemctl enable qconnect-setup.service
systemctl enable qconnect-heartbeat.timer

# Remove secrets + firstrun hook from the boot partition.
rm -f "$SRC/provision.json"
sed -i 's| systemd.run=[^ ]*||g; s| systemd.run_success_action=[^ ]*||g; s| systemd.unit=kernel-command-line.target||g' "$BOOTDIR/cmdline.txt"
rm -f "$BOOTDIR/cmdline.txt.qconnect-bak"

echo "QConnect firstrun complete: $(date)"
exit 0
