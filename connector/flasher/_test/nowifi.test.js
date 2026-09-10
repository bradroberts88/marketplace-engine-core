'use strict';
/*
 * "Capture WiFi on first boot" — a card is deliberately flashed with NO network profiles so the Pi raises its
 * own "AutoPost-Setup" AP immediately and takes credentials from whoever is on site.
 *
 * Run: node flasher/_test/nowifi.test.js
 */
const assert = require('assert');
const inject = require('../inject');

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); pass += 1; console.log('  ok   ' + name); }
  catch (e) { fail += 1; console.log('  FAIL ' + name + ' — ' + e.message); }
};

const base = {
  claimUrl: 'https://example.test/claim', claimCode: 'K7QP3M2R',
  country: 'US', tz: 'America/New_York', piUser: 'admin',
  piPassHash: '$6$abc$def', hostname: 'autopost-test', tsAuthKey: 'tskey-auth-TEST',
};

console.log('capture-wifi-on-boot');

check('a normal card still refuses to build with no networks', () => {
  assert.throws(() => inject.firstRunScript({ networks: [] }), /at least one WiFi network/);
});

check('capture mode builds a script with no networks', () => {
  const s = inject.firstRunScriptSelfContained({ ...base, networks: [], captureWifiOnBoot: true });
  assert.ok(typeof s === 'string' && s.length > 500, 'expected a real script');
});

check('capture mode writes NO wifi keyfiles', () => {
  const s = inject.firstRunScriptSelfContained({ ...base, networks: [], captureWifiOnBoot: true });
  assert.ok(!/write_nmconn /.test(s), 'a write_nmconn call leaked into a no-WiFi card');
});

check('a normal card DOES write wifi keyfiles (control)', () => {
  const s = inject.firstRunScriptSelfContained({ ...base, networks: [{ ssid: 'Shop', pass: 'secret123' }] });
  assert.ok(/write_nmconn /.test(s), 'expected the normal path to write a profile');
});

check('capture mode still writes the claim code', () => {
  const s = inject.firstRunScriptSelfContained({ ...base, networks: [], captureWifiOnBoot: true });
  assert.ok(s.includes('K7QP3M2R'), 'claim code missing — the card could never claim');
});

check('capture mode still writes the Tailscale key (remote recall)', () => {
  const s = inject.firstRunScriptSelfContained({ ...base, networks: [], captureWifiOnBoot: true });
  assert.ok(s.includes('tskey-auth-TEST'), 'tailscale key missing');
});

check('capture mode still sets the login password', () => {
  const s = inject.firstRunScriptSelfContained({ ...base, networks: [], captureWifiOnBoot: true });
  assert.ok(s.includes('$6$abc$def'), 'password hash missing');
});

check('no credentials leak into a capture-mode card', () => {
  const s = inject.firstRunScriptSelfContained({
    ...base, networks: [{ ssid: 'ShouldBeDropped', pass: 'leaked-psk-value' }], captureWifiOnBoot: true,
  });
  assert.ok(!s.includes('leaked-psk-value'), 'a WiFi password survived into a no-WiFi card');
  assert.ok(!s.includes('ShouldBeDropped'), 'an SSID survived into a no-WiFi card');
});

// DRY RUN. The "Dry run" box is TICKED BY DEFAULT in the UI, so this is the first thing an operator hits after
// ticking "No WiFi yet" -- and bootFilesFor() is a SECOND, separate call path into firstRunScript that originally
// did not forward the flag, so a no-WiFi card threw "at least one WiFi network (ssid) is required" before it
// could even be previewed.
check('dry run / bootFilesFor works for a no-WiFi card', () => {
  const files = inject.bootFilesFor({ ...base, networks: [], captureWifiOnBoot: true });
  const fr = files.find((f) => f.path === 'firstrun.sh');
  assert.ok(fr && fr.content.length > 500, 'firstrun.sh missing from the preview');
  assert.ok(!/write_nmconn /.test(fr.content), 'preview must show no WiFi profiles');
});
check('dry run still refuses a NORMAL card with no WiFi (the guard is not blanket-disabled)', () => {
  assert.throws(() => inject.bootFilesFor({ ...base, networks: [] }), /at least one WiFi network/);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
