'use strict';
/* Pure unit test for Pi-model image resolution (defaultImagePath/imageIsShippable/PI_MODELS). No hardware.
   Run: node flasher/_test/pi-model.test.js */
const assert = require('assert');
const path = require('path');
const { defaultImagePath, imageIsShippable, PI_MODELS, DEFAULT_PI_MODEL } = require('../main-flasher');

let pass = 0; const fail = [];
const t = (name, fn) => { try { fn(); pass++; } catch (e) { fail.push(name + ' :: ' + e.message); } };
const withEnv = (vars, fn) => {
  const saved = {}; Object.keys(vars).forEach((k) => { saved[k] = process.env[k]; if (vars[k] == null) delete process.env[k]; else process.env[k] = vars[k]; });
  try { fn(); } finally { Object.keys(saved).forEach((k) => { if (saved[k] == null) delete process.env[k]; else process.env[k] = saved[k]; }); }
};

// --- both models exist and have distinct, correctly-shaped filenames -----------------------------------------
t('pi4 and zerow are distinct models with distinct filenames', () => {
  assert.strictEqual(PI_MODELS.pi4.filename, 'autopost-golden.img.xz');
  assert.strictEqual(PI_MODELS.zerow.filename, 'autopost-golden-zerow.img.xz');
  assert.notStrictEqual(PI_MODELS.pi4.filename, PI_MODELS.zerow.filename);
});

// --- AUTOPOST_PI_IMAGE (generic) wins over EVERYTHING, for either model -----------------------------------------
t('generic AUTOPOST_PI_IMAGE overrides both models', () => {
  withEnv({ AUTOPOST_PI_IMAGE: 'C:\\testing\\pinned.img.xz', AUTOPOST_PI_IMAGE_PI4: null, AUTOPOST_PI_IMAGE_ZEROW: null }, () => {
    assert.strictEqual(defaultImagePath('pi4'), 'C:\\testing\\pinned.img.xz');
    assert.strictEqual(defaultImagePath('zerow'), 'C:\\testing\\pinned.img.xz');
  });
});

// --- per-model env vars are independent, and don't leak into the other model -----------------------------------
t('per-model env override only affects its own model', () => {
  withEnv({ AUTOPOST_PI_IMAGE: null, AUTOPOST_PI_IMAGE_PI4: 'C:\\imgs\\pi4.img.xz', AUTOPOST_PI_IMAGE_ZEROW: null }, () => {
    assert.strictEqual(defaultImagePath('pi4'), 'C:\\imgs\\pi4.img.xz');
    assert.notStrictEqual(defaultImagePath('zerow'), 'C:\\imgs\\pi4.img.xz');
  });
  withEnv({ AUTOPOST_PI_IMAGE: null, AUTOPOST_PI_IMAGE_PI4: null, AUTOPOST_PI_IMAGE_ZEROW: 'C:\\imgs\\zerow.img.xz' }, () => {
    assert.strictEqual(defaultImagePath('zerow'), 'C:\\imgs\\zerow.img.xz');
    assert.notStrictEqual(defaultImagePath('pi4'), 'C:\\imgs\\zerow.img.xz');
  });
});

// --- unknown/missing model falls back to the FLEET DEFAULT (zerow), never throws ----------------------------
// zerow is deliberately the fallback rather than pi4: the 32-bit ARMv6 image boots on EVERY Pi including the 4,
// while the 64-bit pi4 image does not boot at all on an original Zero W. So a garbage/missing model value
// degrades to the universally-bootable card instead of a brick.
t('unknown piModel falls back to the fleet default model, does not throw', () => {
  withEnv({ AUTOPOST_PI_IMAGE: null, AUTOPOST_PI_IMAGE_PI4: null, AUTOPOST_PI_IMAGE_ZEROW: null }, () => {
    const a = defaultImagePath(undefined);
    const b = defaultImagePath('not-a-real-model');
    const c = defaultImagePath(DEFAULT_PI_MODEL);
    assert.strictEqual(path.basename(a), path.basename(c));
    assert.strictEqual(path.basename(b), path.basename(c));
    assert.strictEqual(path.basename(a), PI_MODELS[DEFAULT_PI_MODEL].filename);
  });
});

t('the shipped default model is the original Zero W', () => {
  assert.strictEqual(DEFAULT_PI_MODEL, 'zerow');
  assert.ok(PI_MODELS[DEFAULT_PI_MODEL], 'DEFAULT_PI_MODEL must name a real model');
});

// --- imageIsShippable accepts BOTH golden filenames, rejects stock/arbitrary files ---------------------------
t('imageIsShippable accepts both golden variants', () => {
  withEnv({ AUTOPOST_PI_IMAGE: null, AUTOPOST_ALLOW_STOCK: null }, () => {
    assert.strictEqual(imageIsShippable('C:\\x\\autopost-golden.img.xz'), true);
    assert.strictEqual(imageIsShippable('C:\\x\\autopost-golden-zerow.img.xz'), true);
    assert.strictEqual(imageIsShippable('C:\\x\\raspios-lite.img.xz'), false);
    assert.strictEqual(imageIsShippable('C:\\x\\some-other-file.img.xz'), false);
  });
});

console.log(`pi-model.test: ${pass} passed, ${fail.length} failed`);
if (fail.length) { fail.forEach((f) => console.error('  FAIL: ' + f)); process.exit(1); }
