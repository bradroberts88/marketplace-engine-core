'use strict';
/* Golden-file unit test for the boot-partition file rendering. No hardware. Run: node flasher/_test/inject.test.js */
const assert = require('assert');
const inject = require('../inject');  // namespace binding for the wired-mode block below
const { claimEnv, firstRunScript, userconfTxt, cmdlinePatched, configTxtPatched, sq, USB, USB_CMDLINE, USB_DTOVERLAY } = require('../inject');

const H = '$6$abcd1234$Zzk8IXAYIetnFhoDt8le6zlfCXpYDtun7rXH19cegAohPUgwOK7kF1KMrclUbm/BOQ29Ytx77jnwVPIH.XfI0'; // sample $6$ hash

let pass = 0; const fail = [];
const t = (name, fn) => { try { fn(); pass++; } catch (e) { fail.push(name + ' :: ' + e.message); } };

// ── claim.env: EXACT bytes the systemd EnvironmentFile expects ──────────────────────────────────────────────
t('claimEnv exact bytes (LF, two keys, trailing newline)', () => {
  const out = claimEnv({ claimUrl: 'https://marketplaceautopost.com/claim', claimCode: 'ABC123XYZ' });
  assert.strictEqual(out, 'CLAIM_URL=https://marketplaceautopost.com/claim\nCLAIM_CODE=ABC123XYZ\n');
  assert.ok(!/\r/.test(out), 'must be LF only (a CRLF breaks EnvironmentFile parsing)');
});
t('claimEnv rejects missing fields', () => {
  assert.throws(() => claimEnv({ claimUrl: 'x' }));
  assert.throws(() => claimEnv({ claimCode: 'x' }));
});
t('claimEnv rejects a code with whitespace/newlines', () => {
  assert.throws(() => claimEnv({ claimUrl: 'x', claimCode: 'has space' }));
  assert.throws(() => claimEnv({ claimUrl: 'x', claimCode: 'two\nlines' }));
});

// ── firstrun.sh: shell-injection safety + correct NM keyfiles ────────────────────────────────────────────────
t('firstRunScript escapes a malicious SSID/password (no shell injection)', () => {
  const evil = firstRunScript({ networks: [{ ssid: "evil'; rm -rf / #", pass: "p@ss'`$(whoami)`" }] });
  // The dangerous chars land inside a POSIX-escaped single-quoted string: ' -> '\''. So the literal
  // "evil'" becomes "evil'\''". Presence of the escaped form (and bash -n below) proves it can't break out.
  assert.ok(evil.includes("'evil'\\''; rm -rf / #'"), 'SSID single-quotes must be escaped');
  assert.ok(evil.includes("$(whoami)"), 'the password is passed literally (inside quotes), not expanded');
  assert.ok(evil.startsWith('#!/bin/bash'));
});
t('firstRunScript: primary gets higher priority than backup', () => {
  const s = firstRunScript({ networks: [{ ssid: 'Primary', pass: 'a' }, { ssid: 'Hotspot', pass: 'b' }] });
  assert.ok(s.includes("write_nmconn 'autopost-primary-0' 'Primary' 10 0 '' 'a'"), 'primary prio 10');
  assert.ok(s.includes("write_nmconn 'autopost-hotspot-1' 'Hotspot' 9 0 '' 'b'"), 'backup prio 9');
});
t('firstRunScript: hidden flag + enterprise user render', () => {
  const s = firstRunScript({ networks: [{ ssid: 'CorpNet', pass: 'pw', hidden: true, enterpriseUser: 'device01' }] });
  assert.ok(s.includes("write_nmconn 'autopost-corpnet-0' 'CorpNet' 10 1 'device01' 'pw'"), 'hidden=1 + eap user present');
  assert.ok(s.includes('key-mgmt=wpa-eap'), 'enterprise keyfile path present');
  assert.ok(s.includes('key-mgmt=wpa-psk'), 'psk keyfile path present');
});
t('firstRunScript self-deletes the hook + itself', () => {
  const s = firstRunScript({ networks: [{ ssid: 'N', pass: 'p' }] });
  assert.ok(s.includes('rm -f /boot/firmware/firstrun.sh'), 'removes itself');
  assert.ok(s.includes("sed -i 's| systemd.run=[^ ]*||g"), 'strips the cmdline hook');
});
t('firstRunScript requires at least one network', () => assert.throws(() => firstRunScript({ networks: [] })));

// ── firstrun.sh: writes NM KEYFILES directly (NOT nmcli — the kernel-command-line.target daemon-down bug) ──────
t('firstRunScript writes NM keyfiles directly, never nmcli/timedatectl (the 127.0.1.1 root cause)', () => {
  const s = firstRunScript({ networks: [{ ssid: 'Net', pass: 'pw' }], country: 'CA' });
  assert.ok(!/nmcli connection/.test(s), 'no nmcli connection commands (its daemon is DOWN this early — the WiFi-never-saved bug)');
  assert.ok(!/^add_net\b|\badd_net /.test(s), 'the old nmcli add_net helper is gone');
  assert.ok(!/timedatectl /.test(s), 'no timedatectl command (systemd-timedated/D-Bus down this early)');
  assert.ok(s.includes('/etc/NetworkManager/system-connections'), 'writes to the NM keyfile dir');
  assert.ok(s.includes('.nmconnection'), 'writes a .nmconnection keyfile NM ingests on the real boot');
  assert.ok(s.includes('key-mgmt=wpa-psk') && s.includes('pmf=2'), 'WPA2/WPA3-transitional (iPhone hotspot) via PMF optional');
  assert.ok(s.includes('chmod 600'), 'keyfile MUST be 0600 or NM silently ignores it');
});
t('firstRunScript sets the WiFi country daemon-free so the radio is not rfkill-soft-blocked', () => {
  const s = firstRunScript({ networks: [{ ssid: 'Net', pass: 'pw' }], country: 'CA' });
  assert.ok(s.includes('ieee80211_regdom'), 'persists the regdomain (modprobe.d + cmdline) so it survives reboot');
  assert.ok(s.includes('rfkill unblock'), 'unblocks the radio');
});
t('firstRunScript escapes a backslash inside the KEYFILE value (DOMAIN\\user + psk with a backslash)', () => {
  // NM UNESCAPES backslash sequences on read, so a raw backslash silently corrupts the psk/identity ("abc\\sdef"
  // -> NM reads "abc def" -> wrong key -> no association). kfval doubles it so NM reads back the exact bytes.
  const s = firstRunScript({ networks: [{ ssid: 'Corp', pass: 'a\\b', enterpriseUser: 'CORP\\jsmith' }] });
  assert.ok(s.includes("'CORP\\\\jsmith'"), 'enterprise identity backslash doubled for the keyfile layer');
  assert.ok(s.includes("'a\\\\b'"), 'psk backslash doubled for the keyfile layer');
});

// ── cmdline.txt patch: single line, idempotent ─────────────────────────────────────────────────────────────
t('cmdlinePatched appends the hook once', () => {
  const base = 'console=serial0,115200 console=tty1 root=PARTUUID=xxxx-02 rootfstype=ext4 fsck.repair=yes rootwait';
  const out = cmdlinePatched(base);
  assert.ok(out.endsWith('systemd.unit=kernel-command-line.target\n'));
  assert.ok(!/\n.*\n/.test(out.replace(/\n$/, '')), 'stays a single line');
  // idempotent: patching an already-patched line does not double-append
  const twice = cmdlinePatched(out);
  assert.strictEqual((twice.match(/systemd\.run=/g) || []).length, 1, 'hook appears exactly once after re-patch');
});

// ── userconf.txt: RPi-native no-wizard file (username:crypt-hash) ────────────────────────────────────────────
t('userconfTxt renders "user:hash\\n" and never plaintext', () => {
  assert.strictEqual(userconfTxt({ piUser: 'admin', piPassHash: H }), 'admin:' + H + '\n');
});
t('userconfTxt rejects a non-crypt (plaintext) password', () => {
  assert.throws(() => userconfTxt({ piUser: 'admin', piPassHash: 'hunter2' }));
});
t('userconfTxt rejects a bad/root username', () => {
  assert.throws(() => userconfTxt({ piUser: 'root', piPassHash: H }));
  assert.throws(() => userconfTxt({ piUser: 'Admin', piPassHash: H }));   // uppercase not allowed
  assert.throws(() => userconfTxt({ piUser: '1bad', piPassHash: H }));    // must start with a letter
});

// ── firstrun.sh: RENAME the stock pi user (not useradd) + kill the wizard ─────────────────────────────────────
t('firstRunScript renames the uid-1000 user instead of adding a parallel one', () => {
  const s = firstRunScript({ networks: [{ ssid: 'N', pass: 'p' }], piUser: 'admin' });
  assert.ok(s.includes('getent passwd 1000'), 'looks up the stock uid-1000 user');
  assert.ok(s.includes('usermod  -l "$NEWUSER"'), 'renames it (keeps uid 1000)');
  assert.ok(s.includes('usermod -s /bin/bash "$NEWUSER"'), 'resets the nologin shell');
  assert.ok(!/useradd -m -s \/bin\/bash/.test(s), 'no unconditional useradd of a uid-1001 parallel user');
});
t('firstRunScript FALLBACK (no hash) masks the wizard AND mirrors cancel-rename cleanup (console + SSH)', () => {
  const s = firstRunScript({ networks: [{ ssid: 'N', pass: 'p' }] }); // no piPassHash -> fallback path
  assert.ok(s.includes('systemctl mask    userconfig.service'), 'masks the wizard unit');
  assert.ok(s.includes('rm -f /etc/systemd/system/multi-user.target.wants/userconfig.service'), 'unlinks the enable symlink');
  assert.ok(s.includes('systemctl enable getty@tty1'), 're-enables the console (cancel-rename never runs on this path)');
  assert.ok(s.includes('rm -f /etc/ssh/sshd_config.d/rename_user.conf'), 'drops the SSH set-up-a-user banner');
});
t('firstRunScript PRIMARY (hash present) defers user+wizard to userconf.txt; leaves the service + file alone', () => {
  const s = firstRunScript({ networks: [{ ssid: 'N', pass: 'p' }], piPassHash: H });
  assert.ok(!/userconfig\.service/.test(s), 'does NOT touch the service — the OS consumes userconf.txt + runs cancel-rename cleanup');
  assert.ok(!/chpasswd/.test(s), 'no chpasswd — userconf.txt sets the password');
  assert.ok(!/rm -f [^\n]*userconf\.txt/.test(s), 'does NOT delete userconf.txt (the OS needs it)');
  assert.ok(/write_nmconn/.test(s), 'still sets up WiFi');
});
t('firstRunScript with no hash still kills the wizard (locked account, no plaintext)', () => {
  const s = firstRunScript({ networks: [{ ssid: 'N', pass: 'p' }] });
  assert.ok(!s.includes('chpasswd'), 'no password line when no hash given');
  assert.ok(s.includes('systemctl disable userconfig.service'), 'wizard still disabled');
});

// ── cmdline.txt: second-prompt guard + still-idempotent ───────────────────────────────────────────────────────
t('cmdlinePatched adds systemd.firstboot=off and still ends with the run-target', () => {
  const base = 'console=serial0,115200 console=tty1 root=PARTUUID=xxxx-02 rootfstype=ext4 fsck.repair=yes rootwait';
  const out = cmdlinePatched(base);
  assert.ok(out.includes('systemd.firstboot=off'), 'disables the systemd-firstboot prompt');
  assert.ok(out.endsWith('systemd.unit=kernel-command-line.target\n'), 'hook stays last');
  const twice = cmdlinePatched(out);
  assert.strictEqual((twice.match(/systemd\.firstboot=/g) || []).length, 1, 'firstboot token appears once after re-patch');
  assert.strictEqual((twice.match(/systemd\.run=/g) || []).length, 1, 'hook appears once after re-patch');
  assert.ok(!/\n.*\n/.test(twice.replace(/\n$/, '')), 'stays a single line');
});

// ── USB gadget SSH: the "test a change in seconds instead of a 45-minute reflash" path ───────────────────────
const N = [{ ssid: 'N', pass: 'p' }];

t('firstRunScript enables the USB ethernet gadget in config.txt AND cmdline.txt', () => {
  const s = firstRunScript({ networks: N });
  assert.ok(s.includes(USB_DTOVERLAY), 'config.txt gets dwc2 in peripheral mode');
  assert.ok(s.includes('[all]'), 'the overlay is appended under an explicit [all] (not swallowed by [pi4]/[cm4])');
  assert.ok(s.includes('modules-load=dwc2'), 'cmdline.txt loads the dwc2 driver');
});

// REGRESSION (hardware-confirmed 2026-08-14, Pi Zero W): the legacy `g_ether` gadget module has been REMOVED from
// current Raspberry Pi OS kernels. `modules-load=dwc2,g_ether` therefore loaded nothing, and Pi OS's own CDC-ACM
// serial gadget kept the UDC - the Pi enumerated as a COM port (Class_02/SubClass_02/Prot_FF, one function, no
// ethernet interface) that Windows could not even open. The gadget MUST be built with libcomposite/configfs.
t('the gadget is built with libcomposite/configfs, NEVER the dead g_ether module', () => {
  const s = firstRunScript({ networks: N });
  // Strip comments first: the block deliberately EXPLAINS why g_ether is gone, and that prose must not trip
  // this check. What matters is that no executable line still tries to use it.
  const code = s.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  assert.ok(!/g_ether/.test(code), 'no executable line may reference g_ether - it does not exist on current Pi OS kernels');
  assert.ok(s.includes('libcomposite'), 'uses libcomposite');
  assert.ok(s.includes('/sys/kernel/config/usb_gadget'), 'builds the gadget through configfs');
  assert.ok(s.includes('functions/rndis.usb0'), 'RNDIS function (the one Windows binds natively)');
});
t('the gadget releases whatever already owns the UDC (only one gadget may bind)', () => {
  const s = firstRunScript({ networks: N });
  assert.ok(/for g in \/sys\/kernel\/config\/usb_gadget\/\*/.test(s), 'enumerates existing gadgets');
  assert.ok(/echo "" > "\$g\/UDC"/.test(s), 'unbinds them - without this Pi OS\'s serial gadget keeps the controller');
});
t('Microsoft OS descriptors are present so Windows binds RNDIS with no manual driver pick', () => {
  const s = firstRunScript({ networks: N });
  assert.ok(s.includes('MSFT100'), 'MS OS string descriptor');
  assert.ok(s.includes('b_vendor_code'), 'MS vendor code');
  assert.ok(s.includes('compatible_id'), 'RNDIS compatible id');
  assert.ok(s.includes('5162001'), 'RNDIS sub-compatible id (the value Windows matches on)');
  assert.ok(s.includes('0xEF'), 'Misc/IAD device class - Windows rejects composite RNDIS without it');
});
t('USB gadget pins BOTH MACs in configfs (random MACs make Windows enumerate a new adapter every boot)', () => {
  const s = firstRunScript({ networks: N });
  assert.ok(s.includes('DEV_MAC=' + USB.DEV_MAC), 'Pi-side MAC pinned');
  assert.ok(s.includes('HOST_MAC=' + USB.HOST_MAC), 'PC-side MAC pinned');
  assert.ok(s.includes('functions/rndis.usb0/dev_addr'), 'written to the configfs function, not a module param');
  // locally-administered unicast on both ends -> can never collide with a real vendor NIC
  [USB.DEV_MAC, USB.HOST_MAC].forEach((m) => {
    const first = parseInt(m.split(':')[0], 16);
    assert.strictEqual(first & 0x02, 0x02, m + ' must be locally administered');
    assert.strictEqual(first & 0x01, 0x00, m + ' must be unicast');
  });
});
t('the gadget script + unit are installed and enabled for EVERY boot, not just the first', () => {
  const s = firstRunScript({ networks: N });
  assert.ok(s.includes('autopost-usb-gadget.sh'), 'bring-up script written');
  assert.ok(s.includes('/etc/systemd/system/autopost-usb-gadget.service'), 'unit written');
  assert.ok(/multi-user\.target\.wants\/autopost-usb-gadget\.service/.test(s), 'enabled via a direct wants symlink');
  assert.ok(/After=NetworkManager\.service/.test(s), 'runs AFTER NM so it takes the UDC over rather than racing it');
  assert.ok(s.includes('/etc/modules-load.d/autopost-usb-gadget.conf'), 'libcomposite loaded at boot');
});
t('the gadget script lives on the FAT boot partition so it is editable from a card reader', () => {
  const s = firstRunScript({ networks: N });
  assert.ok(/cat > "\$BOOTDIR\/autopost-usb-gadget\.sh"/.test(s), 'written to the boot partition, not the rootfs');
  assert.ok(/ExecStart=\/bin\/bash \$\{GADGET_SH\}/.test(s), 'invoked via bash so it never depends on a FAT exec bit');
});

// REGRESSION: golden images built before 2026-08-14 ship a wifi-recovery.js that cannot raise the rescue AP on a
// Zero W (missing wifi-sec.pmf -> NM negotiates WPA-PSK-SHA256 -> BCM43430 rejects the key in AP mode).
t('firstrun hot-patches the rescue-AP PMF bug in an OLD golden image, safely and idempotently', () => {
  const s = firstRunScript({ networks: N });
  assert.ok(s.includes('/opt/autopost/connector/src/wifi-recovery.js'), 'targets the installed recovery script');
  assert.ok(s.includes("wifi-sec.pmf"), 'inserts the PMF pin');
  assert.ok(/! grep -q "wifi-sec.pmf"/.test(s), 'no-op once the golden is rebuilt with the fix');
  assert.ok(/node --check/.test(s), 'validates the patched file parses');
  assert.ok(/cp "\$WR.prepmf" "\$WR"/.test(s), 'restores the original if the edit broke it - never ship a dead service');
});
t('usb0 keyfile is static, never-default, and cannot steal the default route', () => {
  const s = firstRunScript({ networks: N });
  assert.ok(s.includes(USB.CON + '.nmconnection'), 'writes the usb0 keyfile');
  assert.ok(s.includes(`address1=${USB.PI_IP}/${USB.PREFIX}`), 'static address on usb0');
  assert.ok(s.includes('never-default=true'), 'MUST NOT become the default route (would cut off WiFi/Tailscale)');
  assert.ok(s.includes('may-fail=true'), 'a missing cable must not delay boot');
  assert.ok(!/gateway=/.test(s), 'no gateway on the USB link');
  assert.ok(s.includes('interface-name=usb0'), 'bound to usb0 only');
});
t('USB gadget block turns sshd on without fighting Debian 13 socket activation', () => {
  const s = firstRunScript({ networks: N });
  assert.ok(/: > "\$BOOTDIR\/ssh"/.test(s), 'drops the stock /boot/firmware/ssh flag file');
  assert.ok(s.includes('is-enabled ssh.socket'), 'checks socket activation before enabling anything itself');
  assert.ok(s.includes('is-enabled ssh.service'), 'checks the service form too');
  // enabling BOTH would leave the two fighting over port 22
  assert.ok(!/systemctl enable ssh\.socket/.test(s), 'never force-enables the socket unit');
});
t('USB gadget is opt-OUT and renders nothing when disabled', () => {
  const off = firstRunScript({ networks: N, usbGadget: false });
  assert.ok(!off.includes('libcomposite'), 'no gadget setup');
  assert.ok(!off.includes('dwc2'), 'no dwc2 overlay');
  assert.ok(!off.includes('usb0'), 'no usb0 keyfile');
  assert.ok(!off.includes('autopost-usb-gadget'), 'no gadget script or unit');
  assert.ok(off.includes('write_nmconn'), 'the rest of provisioning is untouched');
});
t('dev SSH key is installed against UID 1000 (the account userconf.txt renames later), or not at all', () => {
  const none = firstRunScript({ networks: N });
  assert.ok(!none.includes('authorized_keys'), 'no key -> no authorized_keys block at all');
  const k = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyBytesHere dev@laptop';
  const s = firstRunScript({ networks: N, devSshPubKey: k });
  assert.ok(s.includes('getent passwd 1000'), 'resolves the home dir by UID, not by a name that changes on boot 2');
  assert.ok(s.includes(sq(k)), 'the key is shell-escaped, never interpolated raw');
  assert.ok(s.includes('chmod 600 "$DEVHOME/.ssh/authorized_keys"'), 'sshd ignores a group/world-writable key file');
});
t('the self-delete strips ONLY the systemd one-shot tokens — the USB gadget must survive boot 1', () => {
  const s = firstRunScript({ networks: N });
  const sed = s.split('\n').filter((l) => l.includes('sed -i') && l.includes('systemd.run=')).join('\n');
  assert.ok(sed, 'the self-delete sed is present');
  assert.ok(!/modules-load/.test(sed), 'the self-delete must not strip modules-load');
  assert.ok(!/g_ether/.test(sed), 'the self-delete must not strip the gadget MAC params');
});

t('cmdlinePatched carries the USB tokens, keeps the hook last, stays one line, and is idempotent', () => {
  const base = 'console=serial0,115200 console=tty1 root=PARTUUID=xxxx-02 rootfstype=ext4 fsck.repair=yes rootwait';
  const out = cmdlinePatched(base);
  assert.ok(out.includes(USB_CMDLINE), 'USB tokens present');
  assert.ok(out.endsWith('systemd.unit=kernel-command-line.target\n'), 'hook still last');
  assert.ok(!/\n.*\n/.test(out.replace(/\n$/, '')), 'stays a single line');
  const twice = cmdlinePatched(out);
  assert.strictEqual((twice.match(/modules-load=dwc2/g) || []).length, 1, 'no double-append on re-flash');
  assert.ok(!cmdlinePatched(base, { usbGadget: false }).includes('modules-load=dwc2'), 'opt-out honoured');
  // A card written by the OLDER build carries dead g_ether parameters. Re-flashing must clean them up rather
  // than accumulate them - and must not leave a dangling ",g_ether" by matching only the bare prefix.
  const legacy = base + ' modules-load=dwc2,g_ether g_ether.dev_addr=02:1a:11:00:00:01 g_ether.host_addr=02:1a:11:00:00:02';
  const cleaned = cmdlinePatched(legacy);
  assert.ok(!/g_ether/.test(cleaned), 'legacy g_ether tokens are stripped on re-flash');
  assert.strictEqual((cleaned.match(/modules-load=dwc2/g) || []).length, 1, 'exactly one modules-load token survives');
  assert.ok(!/,\s|,$/.test(cleaned.replace(/\n$/, '')), 'no dangling comma left behind');
});
t('configTxtPatched appends under [all], is idempotent, and honours opt-out', () => {
  const base = '# stock\ndtparam=audio=on\n[pi4]\narm_boost=1\n';
  const out = configTxtPatched(base);
  assert.ok(out.includes('[all]\n# AutoPost: USB gadget (SSH over the USB cable)\n' + USB_DTOVERLAY),
    'overlay lands under an explicit [all] so the trailing [pi4] section cannot swallow it');
  assert.ok(out.startsWith(base.replace(/\s*$/, '')), 'existing content preserved verbatim');
  assert.strictEqual(configTxtPatched(out), out, 'idempotent — a second patch is a no-op');
  assert.strictEqual(configTxtPatched(base, { usbGadget: false }), base, 'opt-out returns the file untouched');
  // config.txt is parsed by the VideoCore firmware before Linux exists — keep every byte we add ASCII.
  assert.ok(!/[^\x00-\x7F]/.test(out.slice(base.length)), 'appended config.txt bytes must be pure ASCII');
});
// REGRESSION (hardware-confirmed 2026-08-14, Pi Zero W): stock Pi OS config.txt already contains
// `dtoverlay=dwc2,dr_mode=host` at column 0 under [cm5]. The original guard was `^dtoverlay=dwc2`, which matched
// that line, decided the overlay was already configured, and skipped the append entirely. The card shipped with
// g_ether on the kernel cmdline but the controller still in HOST mode -> no usb0 -> nothing enumerated on USB.
// The [cm5] line is irrelevant on a Zero W and is the OPPOSITE dr_mode, so it must never satisfy the check.
const STOCK_CONFIG_TXT = [
  'dtparam=audio=on', 'camera_auto_detect=1', 'auto_initramfs=1', 'dtoverlay=vc4-kms-v3d', 'arm_boost=1',
  '', '[cm4]', 'otg_mode=1',
  '', '[cm5]', 'dtoverlay=dwc2,dr_mode=host',
  '', '[pi5]', 'dtoverlay=nospi10',
  '', '[all]', '',
].join('\n');

t('configTxtPatched is NOT fooled by the stock [cm5] dtoverlay=dwc2,dr_mode=host line', () => {
  assert.ok(/^dtoverlay=dwc2/m.test(STOCK_CONFIG_TXT), 'precondition: the stock file really does match the old guard');
  const out = configTxtPatched(STOCK_CONFIG_TXT);
  assert.ok(out.includes(USB_DTOVERLAY), 'the peripheral-mode overlay MUST still be appended');
  assert.ok(out.includes('dr_mode=host'), 'the stock [cm5] line is left alone, not rewritten');
  assert.strictEqual(configTxtPatched(out), out, 'still idempotent against a file we already patched');
});
t('the firstrun config.txt guard is a LITERAL match on our own line, not any dwc2 line', () => {
  const s = firstRunScript({ networks: N });
  const guard = s.split('\n').find((l) => l.includes('grep') && l.includes('config.txt'));
  assert.ok(guard, 'the config.txt guard line exists');
  assert.ok(/grep -qF/.test(guard), 'must be a FIXED-string grep (-F), not a regex that can match the stock line');
  assert.ok(guard.includes(USB_DTOVERLAY), 'must test for our exact peripheral-mode line');
  assert.ok(!/"\^dtoverlay=dwc2"/.test(guard), 'the old ^dtoverlay=dwc2 guard must never come back');
});
t('nothing the firstrun script writes INTO config.txt is non-ASCII', () => {
  const s = firstRunScript({ networks: N });
  const line = s.split('\n').find((l) => l.includes('>> "$BOOTDIR/config.txt"'));
  assert.ok(line, 'the config.txt append is present');
  assert.ok(!/[^\x00-\x7F]/.test(line), 'the appended config.txt content must be pure ASCII');
});


// ── WIRED MODE ──────────────────────────────────────────────────────────────────────────────────────────────
// The same physical port, used the other way round: no dwc2 overlay, so the Zero's USB DATA port stays on the
// stock host-capable driver and can power a USB-ethernet adapter. These assert the things that are invisible on
// a bench and fatal at a dealership.
const WBASE = { country: 'US', tz: 'America/New_York', piUser: 'admin', piPassHash: '$6$a$b', hostname: 'autopost-x' };
const wiredRun = inject.firstRunScript(Object.assign({}, WBASE, {
  networkMode: 'wired', networks: [{ ssid: 'LeftInTheForm', pass: 'stale' }],
}));
const wifiRun = inject.firstRunScript(Object.assign({}, WBASE, { networks: [{ ssid: 'Dealer', pass: 'pw' }] }));

t('wired: the port is left in HOST mode (no dwc2 overlay is written)', () => {
  // "Written" means a line that would APPEND the overlay to config.txt — a printf or a redirect. Naming it in a
  // comment or a sed pattern is not writing it, and an assertion that cannot tell those apart breaks the moment
  // somebody documents the code.
  const written = wiredRun.split('\n').filter((l) => /dtoverlay=dwc2/.test(l)
    && (/printf/.test(l) || />>/.test(l)));
  assert.deepStrictEqual(written, [], 'a dwc2 overlay puts the port in DEVICE mode and starves the adapter');
  assert.ok(!/modules-load=dwc2/.test(inject.cmdlinePatched('console=serial0 rootwait', { networkMode: 'wired' })),
    'and the cmdline must not load dwc2 either');
});
t('wired: a leftover gadget overlay from an earlier flash is actively removed', () => {
  assert.ok(/sed -i .*dtoverlay=dwc2.*config\.txt/.test(wiredRun), 'firstrun must strip it on the Pi');
  const cleaned = inject.configTxtPatched('arm_64bit=1\ndtoverlay=dwc2,dr_mode=peripheral\ndtparam=audio=on\n', { networkMode: 'wired' });
  assert.ok(!/dwc2/.test(cleaned), 'and the writer must strip it on the card');
  assert.ok(/dtparam=audio=on/.test(cleaned), 'without eating unrelated lines');
});
t('wired: WiFi credentials are DISCARDED even when the form still holds them', () => {
  assert.ok(!/LeftInTheForm/.test(wiredRun), 'a card the operator was told is wired must not ship WiFi secrets');
  assert.ok(!/write_nmconn '/.test(wiredRun), 'and no WiFi keyfile is written at all');
});
t('wired: no WiFi is not an error (the guard still protects every other caller)', () => {
  assert.doesNotThrow(() => inject.firstRunScript(Object.assign({}, WBASE, { networkMode: 'wired' })));
  assert.throws(() => inject.firstRunScript(Object.assign({}, WBASE, { networks: [] })),
    /at least one WiFi network/, 'a plain card with no WiFi is still an accident, not a mode');
});
t('wired: the ethernet profile takes DHCP AND keeps a fixed service address', () => {
  assert.ok(/write_eth_nmconn/.test(wiredRun));
  assert.ok(/method=auto/.test(wiredRun), 'DHCP from the dealership network is the uplink');
  assert.ok(wiredRun.includes('address1=' + inject.ETH.SVC_IP + '/' + inject.ETH.PREFIX),
    'plus a known address so a bench with no DHCP server can still reach it');
  assert.strictEqual(inject.ETH.SVC_IP, inject.USB.PI_IP,
    'the service address must not move, or every existing tool and document silently breaks');
});
t('wired: the wire is allowed to own the default route', () => {
  const keyfile = wiredRun.split('write_eth_nmconn() (')[1].split('\n)')[0];
  assert.ok(!/printf 'never-default/.test(keyfile),
    'never-default is right for a service link and wrong for an uplink');
  assert.ok(keyfile.includes('autoconnect-priority=' + inject.ETH.PRIORITY), 'and it outranks the WiFi profiles');
});
t('wired: the ethernet profile is not pinned to an interface name', () => {
  const keyfile = wiredRun.split('write_eth_nmconn() (')[1].split('\n)')[0];
  assert.ok(!/interface-name/.test(keyfile),
    'a USB adapter enumerates as enx<mac> on many builds; pinning eth0 would match nothing at all');
});
t('SSH is provisioned in BOTH modes (it used to be nested inside the gadget block)', () => {
  [['wired', wiredRun], ['wifi', wifiRun]].forEach(([label, script]) => {
    assert.ok(/\/boot\/firmware\/ssh/.test(script) || /BOOTDIR\/ssh/.test(script), label + ': sshd must be enabled');
  });
  const keyed = inject.firstRunScript(Object.assign({}, WBASE, { networkMode: 'wired', devSshPubKey: 'ssh-ed25519 AAAAB3 test' }));
  assert.ok(/DEVKEY=/.test(keyed) && /PasswordAuthentication no/.test(keyed),
    'wired mode is reached by SSH over the wire, so the key path has to work there');
});
t('wired: the mode is recorded on the card so the bench can catch a mismatch', () => {
  assert.ok(/autopost-network-mode/.test(wiredRun) && /'wired'/.test(wiredRun));
  assert.ok(/'wifi'/.test(wifiRun), 'and a wifi card says so rather than saying nothing');
});
t('an unknown or missing network mode falls back to wifi, never to something new', () => {
  assert.strictEqual(inject.normalizeNetworkMode(undefined), 'wifi');
  assert.strictEqual(inject.normalizeNetworkMode('WIRED'), 'wired');
  assert.strictEqual(inject.normalizeNetworkMode('ethernet'), 'wifi');
  assert.strictEqual(inject.normalizeNetworkMode(null), 'wifi');
});
t('the WiFi card is unchanged by any of this', () => {
  assert.ok(wifiRun.includes(inject.USB_DTOVERLAY), 'still pins peripheral mode');
  assert.ok(/libcomposite/.test(wifiRun) && /write_usb0_nmconn/.test(wifiRun), 'still builds the usb0 gadget');
  assert.ok(/Dealer/.test(wifiRun), 'still writes the WiFi keyfile');
  assert.ok(/modules-load=dwc2/.test(inject.cmdlinePatched('console=serial0 rootwait', {})), 'still loads dwc2');
});

console.log(`inject.test: ${pass} passed, ${fail.length} failed`);
if (fail.length) { fail.forEach((f) => console.log('  FAIL ' + f)); process.exit(1); }
