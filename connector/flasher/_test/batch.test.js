'use strict';
/* Pure unit test for BATCH flashing: the one-dialog-many-cards consent token, the per-device write lock, and the
   per-lane job id. No hardware, no Electron window.  Run: node flasher/_test/batch.test.js

   Why these are worth testing: the batch feature replaces a per-card native confirmation dialog with a single one
   covering N cards. That is a real reduction in friction AND a real reduction in the number of times the operator
   is asked "are you sure" before something is permanently erased, so the token that carries that consent has to be
   exactly as narrow as the dialog the operator actually saw: these cards, once each, not forever. */
const assert = require('assert');
const { buildPlan, fleetDefaults, _confirm } = require('../main-flasher');
const { confirmTokens, consumeConfirm, activeTargets, CONFIRM_TTL_MS } = _confirm;

let pass = 0; const fail = [];
const t = (name, fn) => { try { fn(); pass++; } catch (e) { fail.push(name + ' :: ' + e.message); } };
const withEnv = (vars, fn) => {
  const saved = {}; Object.keys(vars).forEach((k) => { saved[k] = process.env[k]; if (vars[k] == null) delete process.env[k]; else process.env[k] = vars[k]; });
  try { fn(); } finally { Object.keys(saved).forEach((k) => { if (saved[k] == null) delete process.env[k]; else process.env[k] = saved[k]; }); }
};
// Mint a token the way confirmBatch() does, without needing a real dialog.
const mint = (raws, ttl = CONFIRM_TTL_MS) => {
  const tok = 'tok-' + Math.random().toString(16).slice(2);
  confirmTokens.set(tok, { raws: new Set(raws), expires: Date.now() + ttl });
  return tok;
};
const D1 = '\\\\.\\PhysicalDrive2';
const D2 = '\\\\.\\PhysicalDrive3';
const D3 = '\\\\.\\PhysicalDrive9';

// --- the token authorises exactly the cards the operator saw listed ------------------------------------------
t('a valid token authorises each of its own cards once', () => {
  const tok = mint([D1, D2]);
  assert.strictEqual(consumeConfirm(tok, D1), true, 'first card should be authorised');
  assert.strictEqual(consumeConfirm(tok, D2), true, 'second card should be authorised');
});

t('a card is single-use: the same token cannot authorise it twice', () => {
  const tok = mint([D1, D2]);
  assert.strictEqual(consumeConfirm(tok, D1), true);
  assert.strictEqual(consumeConfirm(tok, D1), false, 'replay of the same card must be refused');
  // the OTHER card in the same batch is unaffected
  assert.strictEqual(consumeConfirm(tok, D2), true);
});

t('a token cannot authorise a card that was not in the dialog', () => {
  const tok = mint([D1, D2]);
  assert.strictEqual(consumeConfirm(tok, D3), false, 'a card swapped in after the dialog must NOT be covered');
  // and the refusal did not quietly burn the real entries
  assert.strictEqual(consumeConfirm(tok, D1), true);
});

t('an unknown / absent / empty token authorises nothing', () => {
  assert.strictEqual(consumeConfirm('no-such-token', D1), false);
  assert.strictEqual(consumeConfirm('', D1), false);
  assert.strictEqual(consumeConfirm(undefined, D1), false);
  assert.strictEqual(consumeConfirm(null, D1), false);
});

t('an expired token authorises nothing', () => {
  const tok = mint([D1], -1000); // already past its expiry
  assert.strictEqual(consumeConfirm(tok, D1), false, 'a stale consent must not be redeemable');
});

t('a fully-consumed token is dropped, not left redeemable', () => {
  const tok = mint([D1]);
  assert.strictEqual(consumeConfirm(tok, D1), true);
  assert.strictEqual(confirmTokens.has(tok), false, 'token should be gone once every card is used');
  assert.strictEqual(consumeConfirm(tok, D1), false);
});

t('tokens are independent — one batch cannot redeem another batch\'s card', () => {
  const a = mint([D1]);
  const b = mint([D2]);
  assert.strictEqual(consumeConfirm(a, D2), false);
  assert.strictEqual(consumeConfirm(b, D1), false);
  assert.strictEqual(consumeConfirm(a, D1), true);
  assert.strictEqual(consumeConfirm(b, D2), true);
});

// --- the per-device write lock --------------------------------------------------------------------------------
// Two writers aimed at one PhysicalDrive would interleave raw sectors and produce two corrupt cards that BOTH
// report success, so the lock is the only thing standing between a mis-click and silently-bad shipped hardware.
t('activeTargets starts clean and is keyed by raw device path', () => {
  activeTargets.clear();
  assert.strictEqual(activeTargets.has(D1), false);
  activeTargets.set(D1, 'job-1');
  assert.strictEqual(activeTargets.has(D1), true, 'a claimed device must read as busy');
  assert.strictEqual(activeTargets.has(D2), false, 'claiming one device must not lock the others');
  activeTargets.delete(D1);
  assert.strictEqual(activeTargets.has(D1), false, 'the claim must be released when the write ends');
  activeTargets.clear();
});

// --- per-lane job id ------------------------------------------------------------------------------------------
// Without this, N concurrent writers would all drive whichever progress bar happened to render last.
t('buildPlan carries the lane jobId through', () => {
  assert.strictEqual(buildPlan({ jobId: 'job-7-123' }).jobId, 'job-7-123');
  assert.strictEqual(buildPlan({}).jobId, null, 'no lane id -> null, never undefined/garbage');
  assert.strictEqual(buildPlan({ jobId: 12 }).jobId, '12', 'coerced to a string for a stable Map key');
});

// --- each card must carry its OWN one-time code ---------------------------------------------------------------
// Codes are burned on first claim. Two cards sharing one code means the second Pi never claims and ships dead.
t('each lane produces its own normalised claim code', () => {
  const a = buildPlan({ claimCode: 'k7qp-3m2r', primary: { ssid: 'x', pass: 'y' } });
  const b = buildPlan({ claimCode: 'QB1C1YVD', primary: { ssid: 'x', pass: 'y' } });
  assert.strictEqual(a.claimCode, 'K7QP3M2R', 'dashes stripped + uppercased for the /claim endpoint');
  assert.notStrictEqual(a.claimCode, b.claimCode);
});

// --- fleet defaults reach the renderer WITHOUT leaking the password -------------------------------------------
// The public key is prefilled into the form on purpose; the password is not a thing the renderer ever needs.
t('fleetDefaults exposes the public key but never the fleet password', () => {
  withEnv({
    AUTOPOST_DEV_SSH_PUBKEY: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAATESTKEY tester@bench',
    AUTOPOST_PI_PASS: 'Test-Fake-Pass-0000',
  }, () => {
    const d = fleetDefaults();
    assert.strictEqual(d.hasFleetKey, true);
    assert.ok(d.fleetKey.startsWith('ssh-ed25519 '), 'the public key IS handed over, to prefill the field');
    assert.strictEqual(d.hasFleetPass, true, 'the UI is told a fleet password exists');
    assert.strictEqual(d.fleetPassWeak, false);
    const blob = JSON.stringify(d);
    assert.ok(!blob.includes('Test-Fake-Pass-0000'), 'the fleet PASSWORD must never cross into the renderer');
  });
});

t('fleetDefaults rejects a malformed key instead of prefilling junk', () => {
  withEnv({ AUTOPOST_DEV_SSH_PUBKEY: '-----BEGIN OPENSSH PRIVATE KEY-----', AUTOPOST_PI_PASS: null }, () => {
    const d = fleetDefaults();
    assert.strictEqual(d.hasFleetKey, false);
    assert.strictEqual(d.fleetKey, '', 'a private key / garbage must not be prefilled into the form');
  });
});

t('fleetDefaults flags a too-short fleet password', () => {
  withEnv({ AUTOPOST_PI_PASS: '1234567890' }, () => {
    assert.strictEqual(fleetDefaults().fleetPassWeak, true, 'sshd is on the dealership LAN — short passwords must warn');
  });
});

console.log(`batch.test: ${pass} passed, ${fail.length} failed`);
if (fail.length) { fail.forEach((f) => console.error('  FAIL: ' + f)); process.exit(1); }
