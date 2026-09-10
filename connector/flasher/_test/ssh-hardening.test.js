'use strict';
/*
 * SSH hardening + secret-leak guards (2026-08-21).
 *
 * Three defects were verified on a shipped image before these landed:
 *   1. the real fleet SSH password sat in plaintext in flasher/_test fixtures that were copied onto EVERY Pi,
 *   2. the whole connector tree landed 0777 (world-writable code -> trivially bypasses the signed-update chain),
 *   3. sshd fell through to Debian's default PasswordAuthentication=yes, and the password is identical fleet-wide.
 *
 * The hardening MUST stay interlocked: password auth may only be disabled once the fleet key is verifiably in
 * place, because an insecure-but-reachable box can be fixed remotely and a locked-out one cannot.
 *
 * Run: node flasher/_test/ssh-hardening.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const inject = require('../inject');

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); pass += 1; console.log('  ok   ' + name); }
  catch (e) { fail += 1; console.log('  FAIL ' + name + ' — ' + e.message); }
};

const base = {
  claimUrl: 'https://x.test/claim', claimCode: 'K7QP3M2R', networks: [{ ssid: 'Shop', pass: 'pw123456' }],
  country: 'US', tz: 'America/New_York', piUser: 'admin', piPassHash: '$6$a$b',
  hostname: 'autopost-t', tsAuthKey: 'tskey-auth-T',
};
const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAATESTKEY test@host';
const withKey = () => inject.firstRunScriptSelfContained({ ...base, devSshPubKey: KEY });
const noKey  = () => inject.firstRunScriptSelfContained({ ...base, devSshPubKey: '' });

console.log('ssh hardening');

check('with a fleet key: password auth is turned OFF', () => {
  assert.ok(/PasswordAuthentication no/.test(withKey()), 'expected PasswordAuthentication no');
});
check('with a fleet key: pubkey auth is turned ON explicitly', () => {
  assert.ok(/PubkeyAuthentication yes/.test(withKey()));
});
check('keyboard-interactive is disabled too (PAM would still take the password otherwise)', () => {
  assert.ok(/KbdInteractiveAuthentication no/.test(withKey()));
});
check('root login is disabled (the tools log in as admin/uid-1000)', () => {
  assert.ok(/PermitRootLogin no/.test(withKey()));
});

// THE INTERLOCK — the property that stops this from bricking remote access.
check('hardening is GUARDED on authorized_keys being non-empty, never unconditional', () => {
  const s = withKey();
  const i = s.indexOf('PasswordAuthentication no');
  const guard = s.lastIndexOf('[ -s "$DEVHOME/.ssh/authorized_keys" ]', i);
  assert.ok(guard !== -1 && guard < i, 'the -s authorized_keys interlock must precede the hardening write');
});
check('NO fleet key => NO hardening at all (box must stay reachable)', () => {
  const s = noKey();
  assert.ok(!/PasswordAuthentication no/.test(s), 'password auth must stay enabled when no key was installed');
  assert.ok(!/sshd_config.d\/10-autopost-ssh.conf/.test(s), 'no drop-in should be written without a key');
});
check('the key is still installed for uid 1000 (what VERIFY-PI and USB-SSH log in as)', () => {
  const s = withKey();
  assert.ok(s.includes(KEY), 'fleet key missing from the card');
  assert.ok(/getent passwd 1000/.test(s), 'key must target uid 1000, not a name that changes on first boot');
});

console.log('\nsecret leakage');

check('no test fixture carries the real fleet password', () => {
  // Assembled from fragments on purpose: spelling the secret out here would make THIS file the leak it checks for.
  const needle = ['Ghoq', 'yKsD', 'nA2t', 'VQYx'].join('-');
  const dir = __dirname;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.js')) continue;
    const txt = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.ok(!txt.includes(needle), 'real fleet password found in ' + f);
  }
});

console.log('\ninstall.sh (what actually lands on the Pi)');

const installSh = fs.readFileSync(path.join(__dirname, '..', '..', 'deploy', 'pi', 'install.sh'), 'utf8');
check('the Windows-only flasher is NOT copied onto the Pi', () => {
  assert.ok(/--exclude 'flasher\/'/.test(installSh), "install.sh must exclude 'flasher/'");
});
check('test fixtures are NOT copied onto the Pi', () => {
  assert.ok(/--exclude '_test\/'/.test(installSh), "install.sh must exclude '_test/'");
});
check('file modes are pinned, not inherited 0777 from the Windows filesystem', () => {
  assert.ok(/--chmod=D750,F640/.test(installSh), 'install.sh must pin --chmod=D750,F640');
});
check('the agent can still rewrite its own code (signed remote updates keep working)', () => {
  assert.ok(/chown -R autopost:autopost/.test(installSh), 'tree must stay owned by the autopost user');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
