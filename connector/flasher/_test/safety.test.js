'use strict';
/* Pure unit test for the "never the wrong drive" predicates. No hardware. Run: node flasher/_test/safety.test.js */
const assert = require('assert');
const { isEligible, assertStillEligible, eligibleDrives } = require('../safety');

let pass = 0; const fail = [];
const t = (name, fn) => { try { fn(); pass++; } catch (e) { fail.push(name + ' :: ' + e.message); } };

// --- synthetic drivelist rows -------------------------------------------------------------------------------
const SYSTEM_DISK = { raw: '\\\\.\\PhysicalDrive0', description: 'Samsung SSD 970', size: 512 * 1e9, isSystem: true, isReadOnly: false, isRemovable: false, isUSB: false, isCard: false, mountpoints: [{ path: 'C:\\' }] };
const EXTERNAL_HDD = { raw: '\\\\.\\PhysicalDrive2', description: 'WD My Passport', size: 1000 * 1e9, isSystem: false, isReadOnly: false, isRemovable: true, isUSB: true, isCard: false, mountpoints: [{ path: 'D:\\' }] }; // removable+USB but WAY too big -> reject on size
const GOOD_SD = { raw: '\\\\.\\PhysicalDrive3', description: 'SanDisk Ultra', size: 31.9 * 1e9, isSystem: false, isReadOnly: false, isRemovable: true, isUSB: true, isCard: true, mountpoints: [{ path: 'E:\\' }] };
const GOOD_SD_64 = { raw: '\\\\.\\PhysicalDrive4', description: 'Samsung EVO', size: 64 * 1e9, isSystem: false, isReadOnly: false, isRemovable: true, isCard: true, mountpoints: [{ path: 'F:\\' }] };
const TINY_USB = { raw: '\\\\.\\PhysicalDrive5', description: 'Tiny 2GB stick', size: 2 * 1e9, isSystem: false, isRemovable: true, isUSB: true, mountpoints: [] };
const READONLY_SD = { raw: '\\\\.\\PhysicalDrive6', description: 'Locked card', size: 32 * 1e9, isSystem: false, isReadOnly: true, isRemovable: true, isCard: true, mountpoints: [] };
const VIRTUAL = { raw: '\\\\.\\PhysicalDrive7', description: 'VeraCrypt volume', size: 32 * 1e9, isVirtual: true, isRemovable: true };
const FIXED_INTERNAL = { raw: '\\\\.\\PhysicalDrive1', description: 'Second internal SSD', size: 240 * 1e9, isSystem: false, isReadOnly: false, isRemovable: false, isUSB: false, isCard: false, mountpoints: [{ path: 'G:\\' }] };
const SD_ON_C = { raw: '\\\\.\\PhysicalDrive8', description: 'weird', size: 32 * 1e9, isRemovable: true, isCard: true, mountpoints: [{ path: 'C:\\' }] }; // lies + mounted at C: -> reject

// --- REJECTS (the whole point) ------------------------------------------------------------------------------
t('reject system disk', () => assert.strictEqual(isEligible(SYSTEM_DISK), false));
t('reject external HDD (too big)', () => assert.strictEqual(isEligible(EXTERNAL_HDD), false));
t('reject tiny <4GB', () => assert.strictEqual(isEligible(TINY_USB), false));
t('reject read-only', () => assert.strictEqual(isEligible(READONLY_SD), false));
t('reject virtual', () => assert.strictEqual(isEligible(VIRTUAL), false));
t('reject fixed internal (no removable signal)', () => assert.strictEqual(isEligible(FIXED_INTERNAL), false));
t('reject anything mounted at C:', () => assert.strictEqual(isEligible(SD_ON_C), false));
t('reject null/garbage', () => { assert.strictEqual(isEligible(null), false); assert.strictEqual(isEligible({}), false); assert.strictEqual(isEligible(undefined), false); });

// --- ACCEPTS ------------------------------------------------------------------------------------------------
t('accept 32GB SD', () => assert.strictEqual(isEligible(GOOD_SD), true));
t('accept 64GB SD', () => assert.strictEqual(isEligible(GOOD_SD_64), true));

// --- eligibleDrives filters a mixed scan to ONLY the two good cards -----------------------------------------
t('eligibleDrives keeps only the 2 SD cards', () => {
  const got = eligibleDrives([SYSTEM_DISK, EXTERNAL_HDD, GOOD_SD, TINY_USB, READONLY_SD, VIRTUAL, FIXED_INTERNAL, GOOD_SD_64, SD_ON_C]);
  assert.strictEqual(got.length, 2);
  assert.deepStrictEqual(got.map((d) => d.raw).sort(), [GOOD_SD.raw, GOOD_SD_64.raw].sort());
});

// --- assertStillEligible: the same-tick / cross-boundary re-check --------------------------------------------
t('re-check passes for an unchanged card', () => assert.strictEqual(assertStillEligible(GOOD_SD, GOOD_SD).ok, true));
t('re-check FAILS if the device vanished', () => assert.strictEqual(assertStillEligible(null, GOOD_SD).ok, false));
t('re-check FAILS if a different-size device took the same path (hot-swap race)', () => {
  const swapped = { ...GOOD_SD, size: 128 * 1e9 };
  assert.strictEqual(assertStillEligible(swapped, GOOD_SD).ok, false);
});
t('re-check FAILS if the target became a system disk', () => {
  assert.strictEqual(assertStillEligible({ ...GOOD_SD, isSystem: true }, GOOD_SD).ok, false);
});
t('re-check FAILS if raw path changed', () => {
  assert.strictEqual(assertStillEligible({ ...GOOD_SD, raw: '\\\\.\\PhysicalDrive9' }, GOOD_SD).ok, false);
});

// --- report -------------------------------------------------------------------------------------------------
console.log(`safety.test: ${pass} passed, ${fail.length} failed`);
if (fail.length) { fail.forEach((f) => console.log('  FAIL ' + f)); process.exit(1); }
