'use strict';
/*
 * confirmBatch() — the ONE dialog that covers a whole batch.
 *
 * This exists because of a shipped bug: confirmBatch built its "these cards are WIRED" note from a `form`
 * variable that does not exist in its scope (it receives (win, targets); only buildPlan/flash take a form).
 * Every batch died with "ReferenceError: form is not defined" at the confirm dialog, before a single card was
 * written — the flasher was completely unusable, and nothing caught it:
 *
 *   - ui-batch.test.js STUBS window.flasher.confirmBatch, so the real function never runs.
 *   - batch.test.js only mints tokens "the way confirmBatch does", and is itself SKIPPED unless
 *     source/node_modules/electron exists, which the consolidated tree deliberately omits.
 *
 * So this test drives the REAL function, and needs no electron install: 'electron' and 'drivelist' are stubbed
 * through Module._load before main-flasher is required. That keeps it in the default RUN-TESTS run, which is
 * the only place a regression would actually be noticed.
 *
 * Run: node flasher/_test/confirm-batch.test.js
 */
const assert = require('assert');
const Module = require('module');

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); pass += 1; console.log('  ok   ' + name); }
  catch (e) { fail += 1; console.log('  FAIL ' + name + ' — ' + e.message); }
};

// ── stub the two deps main-flasher pulls in that we cannot have here ─────────────────────────────────────────
const handlers = new Map();
let lastDialog = null;
let dialogResponse = 1;                     // 1 = the "ERASE + FLASH" button; 0 = Cancel

const fakeElectron = {
  ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
  dialog: {
    showMessageBox: async (_win, opts) => { lastDialog = opts; return { response: dialogResponse }; },
  },
};

let fakeDrives = [];
const fakeDrivelist = { list: async () => fakeDrives };

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return fakeElectron;
  if (request === 'drivelist') return fakeDrivelist;
  return origLoad.apply(this, arguments);
};
const flasher = require('../main-flasher');
// Deliberately NOT restoring Module._load here: scanDrives() does require('drivelist') lazily, INSIDE the
// call, so restoring the loader after the initial require makes it resolve the real (absent) module and every
// target comes back "card no longer present". The stub has to outlive the requires it is standing in for.

flasher.register({});                        // registers the ipcMain handlers into our fake
const confirmBatch = (targets) => handlers.get('flasher:confirmBatch')(null, targets);

// A drive shaped so safety.isEligible() accepts it: removable, not system, plausible SD size.
const drive = (raw, letter) => ({
  raw, device: raw, description: 'SanDisk Ultra', size: 32 * 1e9,
  isRemovable: true, isCard: true, isUSB: true, isSystem: false, isReadOnly: false, isVirtual: false,
  mountpoints: letter ? [{ path: letter }] : [],
});

const RAW1 = '\\\\.\\PHYSICALDRIVE2';
const RAW2 = '\\\\.\\PHYSICALDRIVE3';

// Node's test runner here is synchronous; each case awaits inside an async IIFE and reports at the end.
(async () => {
  // ── the regression itself ─────────────────────────────────────────────────────────────────────────────────
  fakeDrives = [drive(RAW1, 'E:')];
  let res, threw = null;
  try {
    res = await confirmBatch([{ raw: RAW1, noWifi: false, networkMode: 'wifi', label: 'Acme — card 1' }]);
  } catch (e) { threw = e; }

  check('a wifi batch does not throw (the ReferenceError regression)', () => {
    assert.strictEqual(threw, null, threw ? threw.message : '');
  });
  check('a wifi batch is confirmed', () => {
    assert.ok(res && res.ok === true, 'expected ok, got ' + JSON.stringify(res));
  });
  check('a wifi batch says nothing about being WIRED', () => {
    assert.ok(!/WIRED/.test(lastDialog.message), 'wired note leaked into a wifi batch');
  });

  // ── wired mode actually produces the note ─────────────────────────────────────────────────────────────────
  fakeDrives = [drive(RAW1, 'E:'), drive(RAW2, 'F:')];
  threw = null;
  try {
    res = await confirmBatch([
      { raw: RAW1, noWifi: false, networkMode: 'wired', label: 'Acme — card 1' },
      { raw: RAW2, noWifi: false, networkMode: 'wired', label: 'Acme — card 2' },
    ]);
  } catch (e) { threw = e; }

  check('a wired batch does not throw', () => {
    assert.strictEqual(threw, null, threw ? threw.message : '');
  });
  check('a wired batch warns that no WiFi is written', () => {
    assert.ok(/These cards are WIRED/.test(lastDialog.message), lastDialog.message.slice(-260));
  });
  check('the wired note tells the operator how to reach the Pi', () => {
    assert.ok(/10\.55\.0\.1/.test(lastDialog.message), 'service address missing from the wired note');
  });

  // ── plural/singular, because the note is read by a human under time pressure ───────────────────────────────
  fakeDrives = [drive(RAW1, 'E:')];
  await confirmBatch([{ raw: RAW1, noWifi: false, networkMode: 'wired', label: 'Acme — one card' }]);
  check('a single wired card reads "This card is WIRED"', () => {
    assert.ok(/This card is WIRED/.test(lastDialog.message), lastDialog.message.slice(-260));
  });

  fakeDrives = [drive(RAW1, 'E:'), drive(RAW2, 'F:')];
  await confirmBatch([
    { raw: RAW1, noWifi: false, networkMode: 'wired', label: 'Acme — card 1' },
    { raw: RAW2, noWifi: false, networkMode: 'wifi', label: 'Acme — card 2' },
  ]);
  check('a mixed batch counts only the wired ones', () => {
    assert.ok(/1 of these cards are WIRED/.test(lastDialog.message), lastDialog.message.slice(-260));
  });

  // ── an absent networkMode must behave as wifi, never crash ────────────────────────────────────────────────
  // The renderer used to send only {raw,noWifi,label}. An older renderer against a newer main must degrade to
  // the safe default rather than throwing or falsely warning.
  delete process.env.AUTOPOST_NETWORK_MODE;
  fakeDrives = [drive(RAW1, 'E:')];
  threw = null;
  try { res = await confirmBatch([{ raw: RAW1, noWifi: false, label: 'Acme — legacy payload' }]); }
  catch (e) { threw = e; }
  check('a target with no networkMode is treated as wifi', () => {
    assert.strictEqual(threw, null, threw ? threw.message : '');
    assert.ok(!/WIRED/.test(lastDialog.message), 'a legacy payload must not claim to be wired');
  });

  // ── cancelling must mint nothing ──────────────────────────────────────────────────────────────────────────
  dialogResponse = 0;
  res = await confirmBatch([{ raw: RAW1, noWifi: false, networkMode: 'wifi', label: 'Acme — cancelled' }]);
  check('cancelling returns not-ok and no token', () => {
    assert.ok(res && res.ok === false, 'expected ok:false');
    assert.ok(!res.token, 'a cancelled batch must not mint a token');
  });
  dialogResponse = 1;

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
