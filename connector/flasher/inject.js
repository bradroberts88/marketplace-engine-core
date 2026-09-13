'use strict';
/*
 * flasher/inject.js — render the EXACT files dropped onto the Pi card's FAT boot partition (bootfs, /boot/firmware
 * on the Pi). PURE: no I/O. Windows can only touch this FAT partition, so everything the VA configures lands here.
 *
 * Two consumers, both verified against the real repo:
 *   - autopost-claim.env  -> deploy/pi/autopost-claim.service (EnvironmentFile=/boot/firmware/autopost-claim.env,
 *                            keys CLAIM_URL + CLAIM_CODE, ExecStart node claim.js ${CLAIM_URL} ${CLAIM_CODE} ...).
 *   - firstrun.sh + a cmdline.txt one-shot hook -> the Raspberry Pi Imager first-boot mechanism that STOCK Pi OS
 *     Lite (Trixie/NetworkManager) runs on first boot. It WRITES NetworkManager keyfiles directly (NOT nmcli —
 *     the NM daemon is down that early, which is why the old nmcli version left the Pi on 127.0.1.1), so WiFi
 *     auto-joins on the real boot with no login and no commands. Self-deletes after.
 *
 * firstrun.sh ALSO enables the USB Ethernet gadget + sshd (see the USB block below), so a flashed card is
 * SSH-reachable over the USB cable at a fixed IP — that is the difference between testing a change in seconds and
 * reflashing the card for 45 minutes to try one command.
 *
 * All content is LF-terminated (a CRLF in autopost-claim.env would break the systemd EnvironmentFile parse).
 */

// POSIX single-quote escaping: wrap in single quotes and turn every ' into '\'' — makes a WiFi SSID/password
// that contains quotes, $, spaces, ; etc. inert inside the bash script (no shell injection, no breakage).
function sq(v) { return `'${String(v == null ? '' : v).replace(/'/g, `'\\''`)}'`; }

function slug(s) { return String(s || 'net').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'net'; }

// ── USB gadget SSH (the "stop reflashing for every change" path) ────────────────────────────────────────────
// The Pi presents ITSELF as a USB Ethernet adapter to whatever laptop is plugged into its USB DATA port, on a
// fixed private /24, with sshd on. That turns a 45-minute reflash-per-change loop into an SSH round-trip: flash
// once, then iterate live on the box.
//
// Everything here is configured through the FAT BOOT PARTITION (config.txt + cmdline.txt) plus ONE NetworkManager
// keyfile. That is deliberate: the boot partition is the only place on the card that is always writable and always
// survives, and the NM keyfile dir is symlinked onto AUTOPOST-DATA by the golden image — so the whole feature also
// survives the read-only rootfs overlay when that gets switched on. Nothing that has to persist is written to the
// rootfs.
//
// FIXED MACs are not cosmetic. g_ether randomises BOTH ends' MAC on every boot by default, and Windows keys a
// network adapter (and therefore its saved static IP) off the MAC — so random MACs make Windows enumerate a
// brand-new "Ethernet N" adapter on every boot and orphan the address you configured. Pinning them is what makes
// the link come back at the same IP after a reboot instead of needing to be set up again. Both are
// locally-administered unicast addresses (0x02 in the first octet), so they can never collide with a real NIC.
const USB = {
  PI_IP: '10.55.0.1',              // the Pi's usb0 — what you SSH to
  PC_IP: '10.55.0.2',              // what the laptop side gets set to
  PREFIX: 24,
  DEV_MAC: '02:1a:11:00:00:01',    // Pi-side  (g_ether dev_addr)
  HOST_MAC: '02:1a:11:00:00:02',   // PC-side  (g_ether host_addr)
  CON: 'autopost-usb0',
};
// cmdline.txt token: just make sure the dwc2 driver is up. The gadget itself is built by libcomposite at boot
// (see usbGadgetScriptLines) - the legacy g_ether module this used to name no longer exists on current Pi OS
// kernels, and the MACs are now set in configfs rather than as module parameters.
const USB_CMDLINE = 'modules-load=dwc2';
// config.txt: put the dwc2 controller in PERIPHERAL (device) mode. Correct for every model this flasher writes —
// Pi Zero W / Zero 2 W (the micro-USB port marked "USB", NOT "PWR IN") and Pi 4 (the USB-C port). dr_mode is
// pinned rather than left at otg so the port can never come up in host mode and silently give you no usb0.
const USB_DTOVERLAY = 'dtoverlay=dwc2,dr_mode=peripheral';

// ── WIRED MODE ─────────────────────────────────────────────────────────────────────────────────────────────
// The same physical port, used the other way round. In wired mode the card ships with NO dwc2 overlay and NO
// `modules-load=dwc2`, which leaves the Zero W / Zero 2 W micro-USB DATA port on the stock `dwc_otg` driver in
// HOST mode - the way a bare Pi Zero hosts a keyboard or a hub. A USB-ethernet adapter then enumerates as an
// ordinary wired NIC and the box takes its uplink from the dealership's network instead of their WiFi.
//
// Done by ABSENCE rather than by writing `dtoverlay=dwc2,dr_mode=host`: dwc2 in host mode is a driver swap on a
// platform where dwc_otg is what Raspberry Pi actually ships and tests for host duty. The wired path has to be
// the boring one.
//
// Why it is worth having: a wired box cannot be given the wrong WiFi password, so the whole class of failure
// this rescue system exists for stops applying to it. WiFi stays available as a RESCUE - the setup AP still
// comes up if the wired link is dead - it just stops being the uplink.
const ETH = {
  CON: 'autopost-eth0',
  // The SERVICE address, carried IN ADDITION to whatever DHCP hands out, so the box is reachable at a known
  // address even on a bench with no DHCP server: plug the adapter's RJ45 straight into a laptop (modern NICs
  // auto-MDIX, so an ordinary patch cable is fine) and SSH to it. Same address as the old USB gadget on
  // purpose - USB-SSH.cmd, verify-pi.ps1, the rescue portal's bind and every doc keep working unchanged.
  SVC_IP: USB.PI_IP,
  PREFIX: USB.PREFIX,
  // Above the WiFi profiles the flasher writes (primary 10, backups 9..1), so on a box that has both, the wire
  // wins and WiFi is only used if the wired link is genuinely absent.
  PRIORITY: 30,
};
// Deliberately NOT pinned to `interface-name=eth0`. A USB-ethernet adapter enumerates under whatever name
// systemd's predictable naming gives it (`enx<mac>` on many builds), which `eth0` would never match - and a
// profile that silently matches nothing is precisely the failure mode this project keeps getting bitten by.
// A type=ethernet profile with no interface-name matches whichever wired device actually turns up, and in wired
// mode there is no usb0 for it to collide with.
const NETWORK_MODES = ['wifi', 'wired'];
function normalizeNetworkMode(m) {
  const v = String(m == null ? '' : m).toLowerCase();
  return NETWORK_MODES.includes(v) ? v : 'wifi';
}

// Remove any previously-added USB gadget tokens from a cmdline.txt line, so patching stays idempotent.
// Order matters: the legacy `modules-load=dwc2,g_ether` form must go BEFORE the bare `modules-load=dwc2`
// pattern, or the bare one matches its prefix and leaves a dangling ",g_ether" on the kernel command line.
// The g_ether tokens are still stripped even though we no longer write them, so re-flashing over a card made
// by the older build cleans them up instead of accumulating dead parameters.
function stripUsbTokens(line) {
  return String(line)
    .replace(/\s*modules-load=dwc2,g_ether/g, '')
    .replace(/\s*g_ether\.(dev|host)_addr=\S+/g, '')
    .replace(/\s*modules-load=dwc2(?![\w,.-])/g, '');
}

// ── autopost-claim.env ─────────────────────────────────────────────────────────────────────────────────────
function claimEnv({ claimUrl, claimCode }) {
  if (!claimUrl || !claimCode) throw new Error('claimEnv: claimUrl and claimCode are required');
  if (/[\r\n]/.test(claimCode) || /\s/.test(String(claimCode))) throw new Error('claimEnv: claimCode must be a single token');
  // exact keys, LF endings, trailing newline. NOTHING else (the service reads only these two).
  return `CLAIM_URL=${claimUrl}\nCLAIM_CODE=${claimCode}\n`;
}

// ── autopost-tailscale.env ─────────────────────────────────────────────────────────────────────────────────
// Consumed by deploy/pi/autopost-tailscale.service (EnvironmentFile), which runs `tailscale up --ssh` ONCE on the
// real boot so the box joins the tailnet UNATTENDED — the dealership never types a command, they just plug it in.
// The node state is persisted on AUTOPOST-DATA by the golden image, so it stays joined across reboots + the
// read-only overlay. TS_HOSTNAME is the per-device name it shows up as on the tailnet (autopost-<dealership>).
function tailscaleEnv({ tsAuthKey, tsHostname }) {
  if (!tsAuthKey) throw new Error('tailscaleEnv: tsAuthKey is required');
  if (/[\r\n\s]/.test(String(tsAuthKey))) throw new Error('tailscaleEnv: tsAuthKey must be a single token (no spaces/newlines)');
  const host = String(tsHostname || '').replace(/[^a-zA-Z0-9-]/g, '').replace(/^-+|-+$/g, '').slice(0, 63);
  return `TS_AUTHKEY=${tsAuthKey}\nTS_HOSTNAME=${host}\n`;
}

// The gadget bring-up script, dropped onto the FAT boot partition and run by a systemd unit on every boot.
// Kept as its own function so the test suite can shell-check it in isolation from the firstrun wrapper.
function usbGadgetScriptLines() {
  return [
    '#!/bin/bash',
    '# AutoPost USB ethernet gadget - RNDIS via libcomposite/configfs. Runs on every boot.',
    '# Editable directly on the card from Windows: this file is on the FAT boot partition.',
    'set +e',
    'G=/sys/kernel/config/usb_gadget/autopost',
    `DEV_MAC=${USB.DEV_MAC}`,
    `HOST_MAC=${USB.HOST_MAC}`,
    `PI_IP=${USB.PI_IP}`,
    `PREFIX=${USB.PREFIX}`,
    '',
    'modprobe libcomposite 2>/dev/null',
    'mountpoint -q /sys/kernel/config || mount -t configfs none /sys/kernel/config 2>/dev/null',
    '',
    '# Wait for a UDC. Its absence means dwc2 is not in peripheral mode (config.txt), not that we are early.',
    'UDC=""',
    'for i in $(seq 1 30); do',
    '  UDC="$(ls /sys/class/udc 2>/dev/null | head -n1)"',
    '  [ -n "$UDC" ] && break',
    '  sleep 1',
    'done',
    '[ -n "$UDC" ] || { echo "autopost-usb-gadget: no UDC - is dtoverlay=dwc2,dr_mode=peripheral set?"; exit 0; }',
    '',
    "# Release whatever owns the UDC (Pi OS's serial console gadget). Only ONE gadget may be bound at a time -",
    '# this is the step whose absence left the Pi presenting a serial port instead of a network adapter.',
    'for g in /sys/kernel/config/usb_gadget/*; do',
    '  [ -d "$g" ] || continue',
    '  [ "$g" = "$G" ] && continue',
    '  echo "" > "$g/UDC" 2>/dev/null',
    'done',
    '',
    '[ -d "$G" ] && echo "" > "$G/UDC" 2>/dev/null   # idempotent: unbind ours so we can re-bind cleanly',
    'mkdir -p "$G" || exit 0',
    'cd "$G" || exit 0',
    '',
    'echo 0x1d6b > idVendor          # Linux Foundation',
    'echo 0x0104 > idProduct         # Multifunction Composite Gadget',
    'echo 0x0100 > bcdDevice',
    'echo 0x0200 > bcdUSB',
    '# Misc/IAD device class - required for Windows to accept a composite RNDIS gadget.',
    'echo 0xEF > bDeviceClass',
    'echo 0x02 > bDeviceSubClass',
    'echo 0x01 > bDeviceProtocol',
    '',
    'mkdir -p strings/0x409',
    'echo "autopost0001" > strings/0x409/serialnumber',
    'echo "AutoPost"     > strings/0x409/manufacturer',
    'echo "AutoPost Pi"  > strings/0x409/product',
    '',
    '# Microsoft OS descriptors: this is what makes Windows load its RNDIS driver automatically instead of',
    '# showing an unknown device that needs a manual driver pick on every PC.',
    'mkdir -p os_desc',
    'echo 1       > os_desc/use',
    'echo 0xcd    > os_desc/b_vendor_code',
    'echo MSFT100 > os_desc/qw_sign',
    '',
    'mkdir -p configs/c.1/strings/0x409',
    'echo "RNDIS" > configs/c.1/strings/0x409/configuration',
    'echo 250     > configs/c.1/MaxPower',
    '',
    '# Pinned MACs: g_ether-style randomisation makes Windows enumerate a NEW adapter every boot and orphan the',
    '# static IP. Both are locally-administered unicast, so they cannot collide with a real vendor NIC.',
    'mkdir -p functions/rndis.usb0',
    'echo "$DEV_MAC"  > functions/rndis.usb0/dev_addr',
    'echo "$HOST_MAC" > functions/rndis.usb0/host_addr',
    'echo RNDIS   > functions/rndis.usb0/os_desc/interface.rndis/compatible_id',
    'echo 5162001 > functions/rndis.usb0/os_desc/interface.rndis/sub_compatible_id',
    '',
    'ln -sf functions/rndis.usb0 configs/c.1/ 2>/dev/null',
    'ln -sf configs/c.1 os_desc/ 2>/dev/null',
    '',
    'echo "$UDC" > UDC || { echo "autopost-usb-gadget: bind to $UDC FAILED"; exit 0; }',
    'echo "autopost-usb-gadget: bound to $UDC"',
    '',
    '# Belt-and-braces addressing. NetworkManager has an autopost-usb0 profile, but it marks the interface',
    '# unmanaged in some boot orderings - setting the address directly means the link works either way.',
    'for i in $(seq 1 15); do [ -d /sys/class/net/usb0 ] && break; sleep 1; done',
    'if [ -d /sys/class/net/usb0 ]; then',
    '  ip link set usb0 up 2>/dev/null',
    '  ip addr show dev usb0 2>/dev/null | grep -q "$PI_IP" || ip addr add "$PI_IP/$PREFIX" dev usb0 2>/dev/null',
    '  echo "autopost-usb-gadget: usb0 up at $PI_IP/$PREFIX"',
    'fi',
    'exit 0',
  ];
}

// ── USB gadget block for firstrun.sh ───────────────────────────────────────────────────────────────────────
// Emitted into firstrun.sh (boot 1, kernel-command-line.target). It only touches the boot partition + the NM
// keyfile dir, so it works in exactly the same daemon-down conditions the WiFi block was rewritten for: no nmcli,
// no timedatectl, no D-Bus. The dwc2 overlay is read by the FIRMWARE at boot, so the gadget appears on the REAL
// boot — the one `systemd.run_success_action=reboot` already triggers — not on this one.
//
// devSshPubKey is still accepted so existing callers keep working, but it is IGNORED here: sshSteps() owns the
// key + sshd now (see the note there). Passing it changes nothing.
function usbGadgetSteps({ devSshPubKey = '' } = {}) { // eslint-disable-line no-unused-vars
  return [
    '',
    '# --- USB gadget SSH: make the Pi show up as a USB Ethernet adapter on a laptop plugged into its USB DATA',
    `#     port, at a FIXED address (${USB.PI_IP}), so a code change can be tested over SSH in seconds instead of a`,
    '#     45-minute reflash. Boot-partition-only config: nothing here depends on the rootfs staying writable.',
    'for BOOTDIR in /boot/firmware /boot; do',
    '  [ -d "$BOOTDIR" ] || continue',
    '  # config.txt - dwc2 in PERIPHERAL mode. Appended under an explicit [all] header so it applies no matter',
    '  # which conditional section ([pi4], [cm4], [all]) the stock file happened to end in. ASCII only: config.txt',
    '  # is parsed by the VideoCore firmware long before Linux, so nothing here relies on it handling UTF-8.',
    '  # The guard matches OUR EXACT line, not any dwc2 line. Stock Pi OS config.txt already ships',
    '  #   [cm5]',
    '  #   dtoverlay=dwc2,dr_mode=host',
    '  # at column 0. A "^dtoverlay=dwc2" guard matches THAT, concludes the overlay is already configured, and',
    '  # skips the append - which is exactly the bug that shipped a card with g_ether on the cmdline and the',
    '  # controller still in host mode, so no usb0 ever appeared. That line is [cm5]-scoped (irrelevant on a',
    '  # Zero W / Pi 4) AND the opposite dr_mode, so it must never satisfy this check. -F = literal, no regex.',
    `  if [ -f "$BOOTDIR/config.txt" ] && ! grep -qF "${USB_DTOVERLAY}" "$BOOTDIR/config.txt" 2>/dev/null; then`,
    `    printf '\\n[all]\\n# AutoPost: USB gadget (SSH over the USB cable)\\n${USB_DTOVERLAY}\\n' >> "$BOOTDIR/config.txt"`,
    '  fi',
    '  # cmdline.txt - make sure the dwc2 driver is loaded. Same append-to-end-of-line form the regdom patch',
    '  # above uses; the self-delete at the bottom only strips systemd.* tokens, so this survives it.',
    `  if [ -f "$BOOTDIR/cmdline.txt" ] && ! grep -qF "${USB_CMDLINE}" "$BOOTDIR/cmdline.txt" 2>/dev/null; then`,
    `    sed -i "s|\\$| ${USB_CMDLINE}|" "$BOOTDIR/cmdline.txt" 2>/dev/null || true`,
    '  fi',
    'done',
    '',
    '# --- the gadget itself, via libcomposite/configfs.',
    '#',
    '# NOT the legacy `g_ether` module: current Raspberry Pi OS kernels have DROPPED it, so `modules-load=dwc2,g_ether`',
    '# loads nothing at all and Pi OS\'s own CDC-ACM serial gadget keeps the USB device controller instead. Confirmed on',
    '# hardware 2026-08-14 on a Zero W: the Pi enumerated as VID_2E8A/PID_0013, Class_02 SubClass_02 Prot_FF, ONE',
    '# function, no ethernet interface anywhere - and Windows could not even open the COM port it did expose.',
    '#',
    '# RNDIS (not CDC-ECM) because Windows binds RNDIS natively. The Microsoft OS descriptors below are what make it',
    '# do so with NO manual "Update driver" step - without them Windows shows an unknown device and a human has to go',
    '# into Device Manager on every PC that ever touches a Pi.',
    '#',
    '# The script lives on the FAT boot partition on purpose: it is then editable from any Windows machine with the',
    '# card in a reader, with no booting and no shell - which is exactly the position you are in when the gadget is',
    '# what is broken. Only the tiny unit file has to sit on the rootfs.',
    'for BOOTDIR in /boot/firmware /boot; do',
    '  [ -d "$BOOTDIR" ] || continue',
    "  cat > \"$BOOTDIR/autopost-usb-gadget.sh\" <<'AUTOPOST_GADGET_EOF'",
    ...usbGadgetScriptLines(),
    'AUTOPOST_GADGET_EOF',
    '  chmod 755 "$BOOTDIR/autopost-usb-gadget.sh" 2>/dev/null || true',
    '  GADGET_SH="$BOOTDIR/autopost-usb-gadget.sh"',
    'done',
    '',
    '# The unit runs it LATE and takes the controller over. Deliberately not early: Pi OS creates its own serial',
    '# gadget during boot and whichever binds LAST owns the UDC, so we must follow it rather than race it.',
    'mkdir -p /etc/systemd/system',
    "cat > /etc/systemd/system/autopost-usb-gadget.service <<UNIT_EOF",
    '[Unit]',
    'Description=AutoPost USB ethernet gadget (SSH over the USB cable)',
    'After=NetworkManager.service systemd-modules-load.service',
    'Wants=NetworkManager.service',
    '',
    '[Service]',
    'Type=oneshot',
    'RemainAfterExit=yes',
    'ExecStart=/bin/bash ${GADGET_SH}',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    'UNIT_EOF',
    '# create the wants symlink directly - `systemctl enable` is not reliable this early (same reason the golden',
    '# image build does it by hand).',
    'mkdir -p /etc/systemd/system/multi-user.target.wants',
    'ln -sf /etc/systemd/system/autopost-usb-gadget.service \\',
    '       /etc/systemd/system/multi-user.target.wants/autopost-usb-gadget.service',
    'mkdir -p /etc/modules-load.d',
    'echo libcomposite > /etc/modules-load.d/autopost-usb-gadget.conf',
    '',
    '# usb0 address: a static NM keyfile. never-default=true + NO gateway is the important part - without it the',
    '# USB link can win the default route and cut the Pi off from the internet (and from Tailscale) the moment a',
    '# laptop is plugged in. may-fail=true keeps boot from waiting on a cable that is not there.',
    'write_usb0_nmconn() (',
    '  umask 077',
    '  mkdir -p /etc/NetworkManager/system-connections',
    `  FILE="/etc/NetworkManager/system-connections/${USB.CON}.nmconnection"`,
    '  UUID="$(cat /proc/sys/kernel/random/uuid 2>/dev/null)"',
    '  {',
    "    printf '[connection]\\n'",
    `    printf 'id=%s\\n' ${sq(USB.CON)}`,
    '    [ -n "$UUID" ] && printf \'uuid=%s\\n\' "$UUID"',
    "    printf 'type=ethernet\\n'",
    "    printf 'interface-name=usb0\\n'",
    "    printf 'autoconnect=true\\n'",
    "    printf 'autoconnect-priority=20\\n'",
    "    printf 'autoconnect-retries=0\\n'",
    "    printf '\\n[ethernet]\\n'",
    "    printf '\\n[ipv4]\\nmethod=manual\\n'",
    `    printf 'address1=${USB.PI_IP}/${USB.PREFIX}\\n'`,
    "    printf 'never-default=true\\n'",
    "    printf 'may-fail=true\\n'",
    "    printf '\\n[ipv6]\\naddr-gen-mode=default\\nmethod=ignore\\n'",
    "    printf '\\n[proxy]\\n'",
    '  } > "$FILE"',
    '  chmod 600 "$FILE"',
    '  chown root:root "$FILE" 2>/dev/null || true',
    ')',
    'write_usb0_nmconn',
  ];
}

// ── WIRED ethernet block for firstrun.sh ───────────────────────────────────────────────────────────────────
// The wired-mode counterpart of usbGadgetSteps. Writes NO overlay and NO gadget - the ABSENCE of the dwc2
// tokens is what leaves the port in host mode (see ETH above) - and instead drops one NetworkManager keyfile
// that claims whichever wired device turns up.
function wiredEthernetSteps() {
  return [
    '',
    '# --- WIRED MODE: this card takes its uplink from a USB-ethernet adapter on the Pi\'s USB DATA port, not from',
    '#     WiFi. Nothing here enables the USB gadget: with no dwc2 overlay and no modules-load=dwc2 the port stays',
    '#     on the stock dwc_otg driver in HOST mode, which is what lets it power and enumerate the adapter.',
    '#     Belt-and-braces, strip the gadget tokens in case this card was previously flashed as a gadget card and',
    '#     something left them behind - a leftover dr_mode=peripheral would silently give the adapter no power.',
    'for BOOTDIR in /boot/firmware /boot; do',
    '  [ -d "$BOOTDIR" ] || continue',
    '  # Strip only what would select DEVICE mode: our own dr_mode=peripheral line, and a bare dtoverlay=dwc2',
    '  # (which defaults to otg). A line that already says dr_mode=host is exactly what wired mode wants - stock',
    '  # Pi OS ships one under [cm5] - so deleting it to fix our own problem would be gratuitous.',
    '  if [ -f "$BOOTDIR/config.txt" ]; then',
    '    sed -i "/^[[:space:]]*dtoverlay=dwc2,dr_mode=peripheral/d" "$BOOTDIR/config.txt" 2>/dev/null || true',
    '    sed -i "/^[[:space:]]*dtoverlay=dwc2[[:space:]]*$/d" "$BOOTDIR/config.txt" 2>/dev/null || true',
    '  fi',
    '  [ -f "$BOOTDIR/cmdline.txt" ] && sed -i "s| modules-load=dwc2[^ ]*||g" "$BOOTDIR/cmdline.txt" 2>/dev/null || true',
    'done',
    'rm -f /etc/systemd/system/multi-user.target.wants/autopost-usb-gadget.service 2>/dev/null || true',
    'rm -f /etc/modules-load.d/autopost-usb-gadget.conf 2>/dev/null || true',
    `rm -f /etc/NetworkManager/system-connections/${USB.CON}.nmconnection 2>/dev/null || true`,
    '',
    '# The wired profile. Two addressing modes at once, on purpose:',
    '#   method=auto  -> DHCP from the dealership network. This is the real uplink.',
    `#   address1     -> a FIXED service address (${ETH.SVC_IP}) carried alongside the lease, so the box is still`,
    '#                   reachable at a known address on a bench with no DHCP server at all: run a patch cable from',
    '#                   the adapter straight into a laptop and SSH to it. This is what replaces "SSH over the USB',
    '#                   cable"; the address is unchanged so every existing tool and document still applies.',
    '# may-fail=true keeps boot from stalling on a cable that is not plugged in yet.',
    '# NO never-default here (unlike the old usb0 profile): the wire IS the way out, so it must be allowed to own',
    '# the default route. That is the whole difference between a service link and an uplink.',
    'write_eth_nmconn() (',
    '  umask 077',
    '  mkdir -p /etc/NetworkManager/system-connections',
    `  FILE="/etc/NetworkManager/system-connections/${ETH.CON}.nmconnection"`,
    '  UUID="$(cat /proc/sys/kernel/random/uuid 2>/dev/null)"',
    '  {',
    "    printf '[connection]\\n'",
    `    printf 'id=%s\\n' ${sq(ETH.CON)}`,
    '    [ -n "$UUID" ] && printf \'uuid=%s\\n\' "$UUID"',
    "    printf 'type=ethernet\\n'",
    "    printf 'autoconnect=true\\n'",
    `    printf 'autoconnect-priority=${String(ETH.PRIORITY)}\\n'`,
    "    printf 'autoconnect-retries=0\\n'",
    "    printf '\\n[ethernet]\\n'",
    "    printf '\\n[ipv4]\\nmethod=auto\\n'",
    `    printf 'address1=${ETH.SVC_IP}/${String(ETH.PREFIX)}\\n'`,
    "    printf 'may-fail=true\\n'",
    "    printf '\\n[ipv6]\\naddr-gen-mode=default\\nmethod=auto\\nmay-fail=true\\n'",
    "    printf '\\n[proxy]\\n'",
    '  } > "$FILE"',
    '  chmod 600 "$FILE"',
    '  chown root:root "$FILE" 2>/dev/null || true',
    ')',
    'write_eth_nmconn',
  ];
}

// ── sshd + the dev key, for BOTH modes ─────────────────────────────────────────────────────────────────────
// HOISTED out of usbGadgetSteps, where it used to live. That nesting meant unticking the USB-SSH option shipped
// a card with no sshd enabled and no key installed at all - which nothing announced, and which makes wired-mode
// SSH impossible by construction. Both modes need the real SSH server: the golden also ships Tailscale SSH, but
// that is a DIFFERENT server and it does not listen on a local-only service link.
function sshSteps({ devSshPubKey = '' } = {}) {
  return [
    '',
    '# --- sshd. Primary mechanism is the stock /boot/firmware/ssh flag file (raspberrypi-sys-mods turns it into',
    "#     an enable on the next boot). Only fall back to enabling a unit ourselves if the OS has neither form",
    '#     enabled - Debian 13 ships ssh.socket, and enabling BOTH socket and service fights over :22.',
    'for BOOTDIR in /boot/firmware /boot; do [ -d "$BOOTDIR" ] && : > "$BOOTDIR/ssh"; done',
    'if ! systemctl is-enabled ssh.socket >/dev/null 2>&1 && ! systemctl is-enabled ssh.service >/dev/null 2>&1; then',
    '  systemctl enable ssh >/dev/null 2>&1 || {',
    '    mkdir -p /etc/systemd/system/multi-user.target.wants',
    '    for U in /usr/lib/systemd/system/ssh.service /lib/systemd/system/ssh.service; do',
    '      [ -f "$U" ] && ln -sf "$U" /etc/systemd/system/multi-user.target.wants/ssh.service && break',
    '    done',
    '  }',
    'fi',
    '# the stock rename-user banner refuses SSH logins until a user is configured - drop it on both paths',
    'rm -f /etc/ssh/sshd_config.d/rename_user.conf 2>/dev/null || true',
    ...(devSshPubKey ? [
      '',
      '# --- dev SSH key. Installed against the UID-1000 account by NUMBER, not by name: on the userconf.txt path',
      "#     that account is still called 'pi' right now and gets renamed on the next boot, and usermod -m carries",
      '#     .ssh across with the home directory. Looking it up by uid is correct on both paths.',
      `DEVKEY=${sq(devSshPubKey)}`,
      'DEVHOME="$(getent passwd 1000 | cut -d: -f6)"',
      'if [ -n "$DEVKEY" ] && [ -n "$DEVHOME" ]; then',
      '  mkdir -p "$DEVHOME/.ssh"',
      '  printf \'%s\\n\' "$DEVKEY" >> "$DEVHOME/.ssh/authorized_keys"',
      '  sort -u "$DEVHOME/.ssh/authorized_keys" -o "$DEVHOME/.ssh/authorized_keys" 2>/dev/null || true',
      '  chmod 700 "$DEVHOME/.ssh"; chmod 600 "$DEVHOME/.ssh/authorized_keys"',
      '  chown -R 1000:1000 "$DEVHOME/.ssh" 2>/dev/null || true',
      'fi',
      '',
      '# KEY-ONLY SSH, with an INTERLOCK. Debian ships PasswordAuthentication=yes by default, and the fleet',
      '# password is identical on every unit, so one leaked password reaches every Pi ever shipped. Turning that',
      '# off is only safe if this box can still be reached by key -- so the drop-in is written ONLY when',
      '# authorized_keys actually exists and is non-empty. If the key install failed for any reason we leave',
      '# password auth ON and say so: an insecure-but-reachable box can be fixed remotely, a locked-out one',
      '# cannot. KbdInteractive is disabled too, or PAM would still accept the password interactively.',
      'if [ -s "$DEVHOME/.ssh/authorized_keys" ]; then',
      '  mkdir -p /etc/ssh/sshd_config.d',
      "  printf '%s\n' '# AutoPost: key-only SSH (written only after the fleet key was confirmed installed).' \\",
      "    'PubkeyAuthentication yes' 'PasswordAuthentication no' 'KbdInteractiveAuthentication no' \\",
      "    'PermitRootLogin no' > /etc/ssh/sshd_config.d/10-autopost-ssh.conf",
      '  chmod 0644 /etc/ssh/sshd_config.d/10-autopost-ssh.conf',
      '  echo "[firstrun] SSH hardened: key-only (password auth disabled)"',
      'else',
      '  echo "[firstrun] WARNING: no authorized_keys installed - leaving password SSH ENABLED so this box stays reachable"',
      'fi',
    ] : []),
  ];
}

// ── firstrun.sh ────────────────────────────────────────────────────────────────────────────────────────────
// networks: [{ ssid, pass, hidden?, enterpriseUser? }] in PRIORITY order (first = primary). country e.g. 'US',
// tz e.g. 'America/New_York'.
//
// WiFi is provisioned by WRITING NetworkManager keyfiles (/etc/NetworkManager/system-connections/<id>.nmconnection),
// NOT by calling nmcli. This script runs on boot 1 under `systemd.unit=kernel-command-line.target`, where the
// NetworkManager DAEMON is NOT running (NetworkManager.service is WantedBy=multi-user.target, which this minimal
// target never reaches), so EVERY nmcli call failed with "NetworkManager is not running" and no profile was saved
// -> the confirmed bug (Pi came up with no WiFi, IP 127.0.1.1). Dropping keyfiles is exactly what the official
// Raspberry Pi Imager path (raspberrypi-sys-mods `imager_custom set_wlan`) does; NM ingests them on the REAL boot
// that `systemd.run_success_action=reboot` triggers. Country/radio-unblock/timezone are done file-first too (no
// nmcli / timedatectl / D-Bus dependency, all of which are down in this target).
function firstRunScript({ networks, country = 'US', tz = 'America/New_York', piUser = 'admin', piPassHash = '', hostname = '', preSteps = [], usbGadget = true, devSshPubKey = '', captureWifiOnBoot = false, networkMode = 'wifi' }) {
  const mode = normalizeNetworkMode(networkMode);
  const wired = mode === 'wired';
  // WIRED cards carry no WiFi at all. Same AUTHORITATIVE discard as captureWifiOnBoot below, and for a stronger
  // reason: the operator has been told this card takes its network from a cable, so quietly baking in whatever
  // was left in the WiFi form would put credentials on a card nobody believes has any.
  // captureWifiOnBoot is AUTHORITATIVE, not merely permissive: it DISCARDS any networks handed in rather than
  // just tolerating an empty list. A caller that sets the flag and also passes credentials (a stale form value,
  // a copied lane) must not quietly ship those credentials on a card the operator was told carries none.
  const nets = (captureWifiOnBoot || wired) ? [] : (networks || []).filter((n) => n && n.ssid);
  // captureWifiOnBoot: deliberately ship the card with NO WiFi keyfiles, for a site whose network is not known
  // in advance. The box then has nothing to associate with, which wifi-recovery.js detects (noSavedWifi) and
  // answers by raising the "AutoPost-Setup" AP immediately on first boot so someone on site can type the real
  // credentials into the captive portal. Everything else on the card -- claim code, password, SSH key, Tailscale
  // key, timezone -- is written exactly as normal; only the network profiles are withheld.
  // The empty-networks guard stays for every OTHER caller: shipping a card with no WiFi by ACCIDENT produces a
  // box that silently never joins anything, which is the bug this check was added for. Wired cards are exempt
  // for the same reason captureWifiOnBoot cards are - having no WiFi is the stated intent, not an accident.
  if (!nets.length && !captureWifiOnBoot && !wired) throw new Error('firstRunScript: at least one WiFi network (ssid) is required');
  // primary priority 10, each backup one lower (higher autoconnect-priority wins; primary = 10).
  const withPrio = nets.map((n, i) => ({ ...n, priority: Math.max(1, 10 - i) }));

  // GKeyFile-VALUE escaper. NM reads keyfile string properties through GLib g_key_file_get_string, which UNESCAPES
  // backslash sequences on read. So a RAW backslash in an SSID/psk/identity corrupts silently:
  //   "abc\sdef" -> NM reads "abc def" (wrong PSK -> association fails); "CORP\jsmith" -> invalid escape -> the
  //   identity is rejected (breaks the standard DOMAIN\user PEAP form). sq()/printf keeps the value shell-literal,
  //   but the KEYFILE layer still needs backslash+tab+leading-space escaped so NM reads back the exact bytes.
  //   Order matters: double backslashes FIRST, then \t, then leading space -> \s (interior/trailing spaces stay raw,
  //   matching NM's own writer). CR/LF are stripped outright (a newline would inject a bogus INI key/section).
  const kfval = (v) => String(v == null ? '' : v)
    .replace(/[\r\n]/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/\t/g, '\\t')
    .replace(/^ /, '\\s');

  const uname = piUser || 'admin';
  // User handling — UNCHANGED (userconf.txt path stays correct; see bootFilesFor/userconfTxt).
  const userBlock = piPassHash ? [
    '# login user + first-boot wizard are handled by /boot/firmware/userconf.txt (the stock OS mechanism + cleanup)',
  ] : [
    '# --- no userconf.txt: fall back to renaming the stock uid-1000 "pi" + masking the wizard -------',
    `NEWUSER=${sq(uname)}`,
    'DEFUSER="$(getent passwd 1000 | cut -d: -f1)"',
    'if [ -n "$DEFUSER" ] && [ "$DEFUSER" != "$NEWUSER" ]; then',
    '  pkill -u "$DEFUSER" 2>/dev/null || true',
    '  usermod  -l "$NEWUSER" -d "/home/$NEWUSER" -m "$NEWUSER" "$DEFUSER" 2>/dev/null || true',
    '  groupmod -n "$NEWUSER" "$DEFUSER" 2>/dev/null || true',
    'fi',
    'id "$NEWUSER" >/dev/null 2>&1 || useradd -m "$NEWUSER"',
    'usermod -s /bin/bash "$NEWUSER" 2>/dev/null || true',
    'usermod -aG sudo,adm,dialout,audio,video,plugdev,netdev,gpio,i2c,spi "$NEWUSER" 2>/dev/null || true',
    'systemctl mask    userconfig.service >/dev/null 2>&1 || true',
    'systemctl disable userconfig.service >/dev/null 2>&1 || true',
    'rm -f /etc/systemd/system/multi-user.target.wants/userconfig.service 2>/dev/null || true',
    '# cancel-rename never runs on this path, so mirror its cleanup: restore the console + drop the SSH banner',
    'systemctl enable getty@tty1 >/dev/null 2>&1 || true',
    'rm -f /etc/ssh/sshd_config.d/rename_user.conf 2>/dev/null || true',
  ];

  // one `write_nmconn` call per network (all escaping/branching lives in the shell function below). Values are
  // kfval()-escaped for the KEYFILE layer, then sq()-escaped for the SHELL; write_nmconn emits them LITERALLY via
  // printf '%s' (no re-quoting) so the keyfile gets the intended bytes and NM reads them back exactly.
  const body = withPrio.map((n, i) => {
    const con = `autopost-${slug(n.ssid)}-${i}`;
    return `write_nmconn ${sq(con)} ${sq(kfval(n.ssid))} ${String(n.priority)} ${n.hidden ? 1 : 0} ${sq(kfval(n.enterpriseUser || ''))} ${sq(kfval(n.pass || ''))}`;
  }).join('\n');

  return [
    '#!/bin/bash',
    '# AutoPost first-boot provisioning (auto-generated). Runs ONCE on stock Pi OS Lite (Trixie/NetworkManager) via the',
    '# cmdline systemd.run hook, then deletes itself. WiFi is written as NetworkManager KEYFILES (NOT nmcli: the NM daemon',
    '# is down under kernel-command-line.target). Supports primary+backup priority, hidden SSID, WPA-Enterprise',
    '# PEAP/MSCHAPv2, WPA2-PSK, and WPA2/WPA3-transitional (PMF optional). NM ingests the keyfiles on the real reboot.',
    'set +e',
    'export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    `COUNTRY=${sq(country)}`,
    // normalize to an uppercase ISO-3166 alpha-2; a bad/lowercase/3-letter code makes cfg80211 reject the hint and
    // fall back to the world domain (00), which can leave the radio regulatory-blocked. Default to US on anything odd.
    "COUNTRY=\"$(printf '%s' \"$COUNTRY\" | tr 'a-z' 'A-Z')\"",
    'case "$COUNTRY" in [A-Z][A-Z]) : ;; *) COUNTRY=US ;; esac',
    `ZONE=${sq(tz)}`,
    '',
    // Files the flasher USED to drop directly onto the FAT via a Windows drive letter. In the mount-free flow
    // (rpi-imager --first-run-script) rpi-imager places only THIS script, so it writes those files itself on the
    // first boot — /boot/firmware is mounted by the time this hook runs (proven: this same script patches
    // /boot/firmware/cmdline.txt below), and the golden's baked services + stock userconfig read them on the
    // reboot this script triggers. No-op (empty) in the legacy drive-letter flow.
    ...preSteps,
    '# --- persistence: mount the AUTOPOST-DATA partition BEFORE writing WiFi, so the golden image (which symlinks',
    "#     /etc/NetworkManager/system-connections onto that partition) lands the first-boot WiFi on the partition and",
    '#     it SURVIVES the read-only overlay + power cuts. On a non-golden card (no such partition) this is a harmless',
    '#     no-op and WiFi stays on the writable rootfs. Runs this early because keyfiles are written next.',
    'if [ -e /dev/disk/by-label/AUTOPOST-DATA ]; then',
    '  mkdir -p /var/lib/autopost',
    '  mountpoint -q /var/lib/autopost || mount /dev/disk/by-label/AUTOPOST-DATA /var/lib/autopost 2>/dev/null || true',
    'fi',
    '',
    '# --- WiFi: write one NetworkManager keyfile per network (device-agnostic; NM loads them on the REAL boot) ------',
    '# NM SILENTLY IGNORES any keyfile here that is not mode 0600 + owner root:root, or not named *.nmconnection.',
    'mkdir -p /etc/NetworkManager/system-connections',
    '# sweep our OWN stale profiles first so a re-provision that RENAMED an SSID cannot leave an orphaned autoconnect.',
    'rm -f /etc/NetworkManager/system-connections/autopost-*.nmconnection 2>/dev/null || true',
    'write_nmconn() (',
    '  umask 077',
    '  CON="$1"; SSID="$2"; PRIO="$3"; HIDDEN="$4"; EAP_USER="$5"; PASS="$6"',
    '  FILE="/etc/NetworkManager/system-connections/${CON}.nmconnection"',
    '  UUID="$(cat /proc/sys/kernel/random/uuid 2>/dev/null)"',
    '  {',
    "    printf '[connection]\\n'",
    "    printf 'id=%s\\n' \"$CON\"",
    "    [ -n \"$UUID\" ] && printf 'uuid=%s\\n' \"$UUID\"",
    "    printf 'type=wifi\\n'",
    "    printf 'autoconnect=true\\n'",
    "    printf 'autoconnect-priority=%s\\n' \"$PRIO\"",
    "    printf 'autoconnect-retries=0\\n'",
    "    printf '\\n[wifi]\\n'",
    "    printf 'mode=infrastructure\\n'",
    "    printf 'ssid=%s\\n' \"$SSID\"",
    "    [ \"$HIDDEN\" = 1 ] && printf 'hidden=true\\n'",
    '    if [ -n "$EAP_USER" ]; then',
    "      printf '\\n[wifi-security]\\nkey-mgmt=wpa-eap\\n'",
    "      printf '\\n[802-1x]\\n'",
    "      printf 'eap=peap;\\n'",
    "      printf 'phase2-auth=mschapv2\\n'",
    "      printf 'identity=%s\\n' \"$EAP_USER\"",
    "      printf 'password=%s\\n' \"$PASS\"",
    "      printf 'system-ca-certs=false\\n'",
    '    elif [ -n "$PASS" ]; then',
    "      printf '\\n[wifi-security]\\nkey-mgmt=wpa-psk\\n'",
    "      printf 'psk=%s\\n' \"$PASS\"",
    "      printf 'pmf=2\\n'",
    '    fi',
    "    printf '\\n[ipv4]\\nmethod=auto\\n'",
    "    printf '\\n[ipv6]\\naddr-gen-mode=default\\nmethod=auto\\n'",
    "    printf '\\n[proxy]\\n'",
    '  } > "$FILE"',
    '  chmod 600 "$FILE"',
    '  chown root:root "$FILE" 2>/dev/null || true',
    ')',
    body,
    '',
    '# --- WiFi regulatory country + radio unblock (daemon-free; nmcli/NM are down under kernel-command-line.target) -',
    'mkdir -p /etc/modprobe.d',
    "printf 'options cfg80211 ieee80211_regdom=%s\\n' \"$COUNTRY\" > /etc/modprobe.d/cfg80211.conf",
    '# belt-and-suspenders: also pin the regdomain on the kernel cmdline so it applies even if cfg80211 is built-in',
    '# (modprobe.d options are ignored for a built-in). Guarded/idempotent; the self-delete below only strips the hook.',
    'for CMD in /boot/firmware/cmdline.txt /boot/cmdline.txt; do',
    '  [ -f "$CMD" ] || continue',
    '  grep -q "cfg80211.ieee80211_regdom=" "$CMD" 2>/dev/null || sed -i "s|\\$| cfg80211.ieee80211_regdom=$COUNTRY|" "$CMD" 2>/dev/null || true',
    'done',
    'install -d -m 0755 /var/lib/NetworkManager',
    "printf '[main]\\nNetworkingEnabled=true\\nWirelessEnabled=true\\nWWANEnabled=true\\n' > /var/lib/NetworkManager/NetworkManager.state",
    'command -v raspi-config >/dev/null 2>&1 && raspi-config nonint do_wifi_country "$COUNTRY" >/dev/null 2>&1 || true',
    'iw reg set "$COUNTRY" 2>/dev/null || true',
    'rfkill unblock wifi 2>/dev/null || true',
    'rfkill unblock all  2>/dev/null || true',
    "for f in /var/lib/systemd/rfkill/*:wlan ; do [ -e \"$f\" ] && printf '0\\n' > \"$f\" 2>/dev/null || true ; done",
    '',
    '# --- timezone (file method; systemd-timedated/D-Bus is not reliably up in this minimal target) --------------',
    'if [ -e "/usr/share/zoneinfo/$ZONE" ]; then',
    '  ln -sf "/usr/share/zoneinfo/$ZONE" /etc/localtime',
    "  printf '%s\\n' \"$ZONE\" > /etc/timezone",
    'fi',
    '',
    '# --- hostname (per-device identity: the Tailscale node name + the Connectors "Host" column). File method so it',
    '#     applies with no hostnamectl/D-Bus (down in this target). Keep 127.0.1.1 in sync so sudo/hostname -f are quiet.',
    `HOST=${sq(hostname)}`,
    'if [ -n "$HOST" ]; then',
    '  printf \'%s\\n\' "$HOST" > /etc/hostname',
    '  if grep -q "^127.0.1.1" /etc/hosts 2>/dev/null; then',
    '    sed -i "s/^127.0.1.1.*/127.0.1.1\\t$HOST/" /etc/hosts 2>/dev/null || true',
    '  else',
    '    printf \'127.0.1.1\\t%s\\n\' "$HOST" >> /etc/hosts',
    '  fi',
    'fi',
    '',
    ...userBlock,
    '',
    '# --- GOLDEN-IMAGE HOTFIX: rescue-AP PMF. -------------------------------------------------------------',
    '# The golden .img.xz ships a wifi-recovery.js whose startAp() sets wifi-sec.key-mgmt WITHOUT pinning PMF.',
    '# NetworkManager then defaults to PMF-optional and offers key_mgmt "WPA-PSK WPA-PSK-SHA256", which the Pi',
    '# Zero W\'s BCM43430 firmware cannot do IN AP MODE: the kernel rejects the key ("nl80211: kernel reports:',
    '# key setting validation failed"), wpa_supplicant fails to bring the AP interface up, NM times out after',
    '# ~25s, and startAp() rolls back. Net effect on a wrong-WiFi box: the captive-portal rescue NEVER appears,',
    '# while the recovery service itself looks perfectly healthy (active, NRestarts=0, Result=success).',
    '# Diagnosed and fixed on hardware 2026-08-14; src/wifi-recovery.js is corrected, but every golden image',
    '# built before that still carries the bug. This patches the installed copy on first boot so cards flashed',
    '# from an OLD image are correct too. Self-limiting: once the golden is rebuilt the grep matches and this',
    '# is a no-op, so it is safe to leave in permanently.',
    'WR=/opt/autopost/connector/src/wifi-recovery.js',
    'if [ -f "$WR" ] && ! grep -q "wifi-sec.pmf" "$WR"; then',
    '  cp -n "$WR" "$WR.prepmf" 2>/dev/null || true',
    '  sed -i "s/\'wifi-sec.key-mgmt\', \'wpa-psk\', \'wifi-sec.psk\', cfg.apPassword\\]/\'wifi-sec.key-mgmt\', \'wpa-psk\', \'wifi-sec.psk\', cfg.apPassword, \'wifi-sec.pmf\', \'1\']/" "$WR" 2>/dev/null || true',
    '  # only keep the edit if node still parses the file - never ship a recovery service that cannot start',
    '  if command -v node >/dev/null 2>&1 && ! node --check "$WR" >/dev/null 2>&1; then',
    '    [ -f "$WR.prepmf" ] && cp "$WR.prepmf" "$WR"',
    '  fi',
    'fi',
    // The network-port block goes AFTER the user block on purpose: on the no-hash fallback path the uid-1000
    // account has just been renamed and its home MOVED by `usermod -m`, so a dev key installed by sshSteps()
    // below lands in the FINAL home directory.
    //
    // WIRED and GADGET are mutually exclusive by construction - they are two uses of the same physical port, and
    // the port is either a device or a host. Wired wins if both are somehow set, because a card whose operator
    // was told it takes a cable must not come up as a USB device that cannot power the adapter.
    ...(wired ? wiredEthernetSteps() : (usbGadget ? usbGadgetSteps() : [])),
    // sshd is emitted in BOTH modes. It used to live inside the gadget block, so turning the gadget off shipped
    // a card with no SSH server and no key - silently, and fatally for wired mode, whose whole service story is
    // SSH over the wire.
    ...sshSteps({ devSshPubKey }),
    '',
    '# --- record which mode this card was provisioned in, where anything on the box (and anyone with the card in',
    '#     a laptop) can read it. pi-verify.sh compares this against what the card ACTUALLY has, so a card that',
    '#     was asked for one mode and built in the other is caught on the bench instead of at a dealership.',
    `for BOOTDIR in /boot/firmware /boot; do [ -d "$BOOTDIR" ] && printf '%s\\n' ${sq(mode)} > "$BOOTDIR/autopost-network-mode"; done`,
    '',
    '# self-delete the one-shot hook so this never runs again (leaves cfg80211.ieee80211_regdom + the USB gadget',
    '# tokens in place — only the systemd.* one-shot tokens are stripped)',
    "sed -i 's| systemd.run=[^ ]*||g; s| systemd.run_success_action=reboot||; s| systemd.unit=kernel-command-line.target||' /boot/firmware/cmdline.txt 2>/dev/null || \\",
    "sed -i 's| systemd.run=[^ ]*||g; s| systemd.run_success_action=reboot||; s| systemd.unit=kernel-command-line.target||' /boot/cmdline.txt 2>/dev/null",
    'rm -f /boot/firmware/firstrun.sh /boot/firstrun.sh 2>/dev/null',
    'exit 0',
    '',
  ].join('\n');
}

// The SINGLE self-contained first-run script for the MOUNT-FREE flow (rpi-imager --first-run-script). rpi-imager
// places exactly ONE script into the FAT boot partition during the write (no Windows drive letter needed), so this
// folds in EVERY file the legacy drive-letter flow dropped separately: it writes autopost-claim.env,
// autopost-tailscale.env and userconf.txt onto /boot/firmware FIRST, then runs the proven WiFi/user/country body.
// The golden's baked autopost-claim.service + autopost-tailscale.service + the stock userconfig.service consume
// those files on the reboot this script triggers. Byte-for-byte identical PROVISIONING to the certified drive-
// letter flow; only the DELIVERY (rpi-imager writes it during the write, not Windows afterward) changes.
function firstRunScriptSelfContained(plan) {
  const p = plan || {};
  const pre = ['mkdir -p /boot/firmware 2>/dev/null || true'];
  const claim = claimEnv({ claimUrl: p.claimUrl, claimCode: p.claimCode }); // 'CLAIM_URL=..\nCLAIM_CODE=..\n'
  pre.push(`printf '%s' ${sq(claim)} > /boot/firmware/autopost-claim.env`);
  pre.push('chmod 600 /boot/firmware/autopost-claim.env 2>/dev/null || true');
  if (p.tsAuthKey) {
    const ts = tailscaleEnv({ tsAuthKey: p.tsAuthKey, tsHostname: p.tsHostname || p.hostname });
    pre.push(`printf '%s' ${sq(ts)} > /boot/firmware/autopost-tailscale.env`);
    pre.push('chmod 600 /boot/firmware/autopost-tailscale.env 2>/dev/null || true');
  }
  if (p.piPassHash) {
    const uc = userconfTxt({ piUser: p.piUser, piPassHash: p.piPassHash }); // 'user:hash\n'
    pre.push(`printf '%s' ${sq(uc)} > /boot/firmware/userconf.txt`);
    pre.push('chmod 600 /boot/firmware/userconf.txt 2>/dev/null || true');
  }
  // QConnect: the card recipe. When a plan carries one, the card gets the
  // QConnect scripts, units and its own provision.json, and provisions itself
  // on first power-up (cable -> Wi-Fi -> AT&T cellular -> saved hotspot, then
  // the setup hotspot if a human is needed). Plans without it are unchanged.
  if (p.qconnect) {
    pre.push(...require('./qconnect-payload').qconnectSteps(p.qconnect));
  }
  return firstRunScript({
    networks: p.networks, country: p.country, tz: p.tz, piUser: p.piUser,
    piPassHash: p.piPassHash, hostname: p.hostname, preSteps: pre,
    // opt-OUT (usbGadget === false), so a plan built by an older caller still gets the testing path
    usbGadget: p.usbGadget !== false, devSshPubKey: p.devSshPubKey || '',
    // Ship with no WiFi profiles so the box raises its setup AP on first boot (see firstRunScript).
    captureWifiOnBoot: !!p.captureWifiOnBoot,
    // Absent -> 'wifi', so every plan built before wired mode existed produces byte-identical output.
    networkMode: p.networkMode,
  });
}

// ── /boot/firmware/userconf.txt (Raspberry Pi's OWN, version-stable no-wizard mechanism) ────────────────────
// One line "user:crypt-hash", LF-terminated. On a normal multi-user boot the stock userconfig.service reads it,
// sets INTERACTIVE=False, and NON-interactively RENAMES the baked-in uid-1000 user (pi -> user) + sets the
// password, then deletes the file. This is exactly what Raspberry Pi Imager writes, so it is our PRIMARY
// suppressor: it works even if the firstrun.sh hook never fires (its consumer is the stock service, not our
// script). firstrun.sh (belt-and-suspenders) configures the same user itself and deletes this file in the
// normal path. Requires a crypt(3) hash ($6$=SHA-512, $5$=SHA-256, $y$=yescrypt) — NEVER plaintext.
function userconfTxt({ piUser = 'admin', piPassHash }) {
  const u = String(piUser || 'admin').trim();
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(u)) throw new Error('userconfTxt: username must match ^[a-z][a-z0-9-]{0,31}$');
  if (u === 'root') throw new Error('userconfTxt: username must not be root');
  if (!piPassHash || !/^\$(6|5|y|2[aby]?)\$/.test(String(piPassHash))) throw new Error('userconfTxt: piPassHash must be a crypt(3) hash (e.g. $6$...)');
  if (/[\r\n:]/.test(String(piPassHash))) throw new Error('userconfTxt: hash must not contain CR, LF or colon');
  return `${u}:${piPassHash}\n`;
}

// ── cmdline.txt one-shot hook ──────────────────────────────────────────────────────────────────────────────
// cmdline.txt is a SINGLE line. Append the systemd.run hook (idempotent — never double-append), and
// systemd.firstboot=off to disable the SECOND, latent first-boot prompt: systemd-firstboot.service
// (--prompt-locale/keymap/timezone/ROOT-PASSWORD, ConditionFirstBoot=yes) which runs on boot 1 BEFORE our hook
// and cannot be reached by firstrun.sh. It is silent on THIS seeded image but would block a headless Pi on any
// future variant that ships one of those values unset. The token makes systemd skip all first-boot queries.
const HOOK = 'systemd.run=/boot/firmware/firstrun.sh systemd.run_success_action=reboot systemd.unit=kernel-command-line.target';
const FIRSTBOOT_OFF = 'systemd.firstboot=off';
function cmdlinePatched(existing, { usbGadget = true, networkMode = 'wifi' } = {}) {
  // Wired mode must never carry the dwc2 token: loading dwc2 is what takes the port off the stock host-capable
  // driver. stripUsbTokens below already removes any that were there, and this stops a new one going in.
  if (normalizeNetworkMode(networkMode) === 'wired') usbGadget = false; // eslint-disable-line no-param-reassign
  let line = String(existing || '').replace(/[\r\n]+$/, '').trim();
  // strip any prior hook + firstboot token + USB tokens first (idempotent re-flash)
  line = stripUsbTokens(line)
    .replace(/\s*systemd\.run=\S+/g, '')
    .replace(/\s*systemd\.run_success_action=reboot/g, '')
    .replace(/\s*systemd\.unit=kernel-command-line\.target/g, '')
    .replace(/\s*systemd\.firstboot=\S+/g, '')
    .trim();
  // USB tokens go BEFORE the hook: HOOK stays LAST so the line still ends with
  // systemd.unit=kernel-command-line.target.
  const usb = usbGadget ? ` ${USB_CMDLINE}` : '';
  return `${line}${usb} ${FIRSTBOOT_OFF} ${HOOK}\n`;
}

// ── config.txt patch ───────────────────────────────────────────────────────────────────────────────────────
// Only needed by the LEGACY drive-letter flow (the mount-free rpi-imager flow has firstrun.sh do this on the Pi,
// where /boot/firmware is already mounted). Appends under an explicit [all] so the overlay is not swallowed by
// whatever conditional section the stock config.txt ends in. Idempotent: a file that already enables dwc2 is
// returned untouched.
function configTxtPatched(existing, { usbGadget = true, networkMode = 'wifi' } = {}) {
  const text = String(existing == null ? '' : existing);
  // Wired mode STRIPS rather than merely skipping. Leaving a dr_mode=peripheral line behind on a re-flashed card
  // would put the port back in device mode, and the adapter would get no power - with nothing to explain why.
  // Only DEVICE-mode lines go: our own peripheral line, and a bare dtoverlay=dwc2 (otg by default). An explicit
  // dr_mode=host line is what wired mode wants, and stock Pi OS ships one under [cm5], so it is left alone.
  if (normalizeNetworkMode(networkMode) === 'wired') {
    return text.split(/\r?\n/)
      .filter((l) => !/^\s*dtoverlay=dwc2\s*,\s*dr_mode=peripheral/.test(l)
                  && !/^\s*dtoverlay=dwc2\s*$/.test(l))
      .join('\n');
  }
  if (!usbGadget) return text;
  // Match OUR EXACT line, never just "a dwc2 overlay": stock Pi OS config.txt ships `dtoverlay=dwc2,dr_mode=host`
  // under [cm5] at column 0, and treating that as "already configured" is what left a card with no usb0.
  if (text.includes(USB_DTOVERLAY)) return text;
  const base = text.replace(/\s*$/, '');
  // ASCII only — config.txt is read by the VideoCore firmware before Linux exists.
  return `${base}\n\n[all]\n# AutoPost: USB gadget (SSH over the USB cable)\n${USB_DTOVERLAY}\n`;
}

// The full set of files to write to bootfs for a plan. paths are relative to the FAT boot partition root.
function bootFilesFor(plan) {
  const files = [
    { path: 'autopost-claim.env', content: claimEnv({ claimUrl: plan.claimUrl, claimCode: plan.claimCode }), mode: 0o600 },
    // captureWifiOnBoot MUST be forwarded here too: this is the dry-run/preview view of the same card, and
    // without it a no-WiFi card throws 'at least one WiFi network is required' instead of previewing.
    { path: 'firstrun.sh', content: firstRunScript({ networks: plan.networks, country: plan.country, tz: plan.tz, piUser: plan.piUser, piPassHash: plan.piPassHash, hostname: plan.hostname, usbGadget: plan.usbGadget !== false, devSshPubKey: plan.devSshPubKey || '', captureWifiOnBoot: !!plan.captureWifiOnBoot, networkMode: plan.networkMode }), mode: 0o755 },
  ];
  // PRIMARY wizard suppressor — only when we have a password hash (see userconfTxt). With no hash we rely solely
  // on firstrun.sh's mask/disable (still sufficient to stop the stall; the admin account is just left locked).
  if (plan.piPassHash) {
    files.push({ path: 'userconf.txt', content: userconfTxt({ piUser: plan.piUser, piPassHash: plan.piPassHash }), mode: 0o600 });
  }
  // UNATTENDED Tailscale join — so a shipped box is SSH-reachable off-LAN with zero commands at the dealership.
  // Only when a key is provided (a reusable, tagged Tailscale key configured in the flasher).
  if (plan.tsAuthKey) {
    files.push({ path: 'autopost-tailscale.env', content: tailscaleEnv({ tsAuthKey: plan.tsAuthKey, tsHostname: plan.tsHostname || plan.hostname }), mode: 0o600 });
  }
  return files; // cmdline.txt + config.txt are PATCHED in place by the writer (read existing -> *Patched -> write)
}

module.exports = {
  claimEnv, tailscaleEnv, firstRunScript, firstRunScriptSelfContained, userconfTxt,
  cmdlinePatched, configTxtPatched, bootFilesFor, usbGadgetSteps, usbGadgetScriptLines, stripUsbTokens,
  wiredEthernetSteps, sshSteps, normalizeNetworkMode,
  sq, slug, HOOK, FIRSTBOOT_OFF, USB, USB_CMDLINE, USB_DTOVERLAY, ETH, NETWORK_MODES,
};
