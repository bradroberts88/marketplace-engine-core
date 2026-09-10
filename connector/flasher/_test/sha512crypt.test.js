'use strict';
/* SHA-512-crypt ($6$) — checked against the PUBLISHED test vectors from Ulrich Drepper's specification, the same
   ones glibc validates against. Run: node flasher/_test/sha512crypt.test.js

   These vectors are the whole point of this file. The implementation is a fixed sequence of SHA-512 digests with
   a very particular byte-interleaving at the end; any single step being wrong — a swapped operand, an off-by-one
   in the repeat loops, the wrong output order — produces a completely different string. Matching all of them
   byte-for-byte is strong evidence the implementation is correct, which is what lets us drop the openssl
   dependency instead of shipping cards with no console password on machines that lack it. */
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const { sha512crypt } = require('../sha512crypt');

let pass = 0; const fail = [];
const t = (name, fn) => { try { fn(); pass++; } catch (e) { fail.push(name + ' :: ' + e.message); } };

// ── the specification's own vectors ───────────────────────────────────────────────────────────────────────────
// PROVENANCE: every expected value below was re-generated on 2026-08-14 by calling glibc's own crypt(3) directly
// (a small C program linked against -lcrypt, run under WSL Ubuntu) — an implementation completely independent of
// this one. Do NOT "fix" a failing vector by pasting in whatever this module currently outputs; that turns the
// test into a mirror and it stops proving anything. Regenerate against glibc instead.
//   Note on the last entry: glibc's MODERN libxcrypt refuses rounds<1000 outright (returns "*0"), while the
//   original specification clamps to the 1000 minimum. We clamp, so that row is verified against an explicit
//   rounds=1000 run of glibc, which produced exactly the string below.
const VECTORS = [
  ['$6$saltstring', 'Hello world!',
    '$6$saltstring$svn8UoSVapNtMuq1ukKS4tPQd8iKwSMHWjl/O817G3uBnIFNjnQJuesI68u4OTLiBFdcbYEdFCoEOfaS35inz1'],
  ['$6$rounds=10000$saltstringsaltstring', 'Hello world!',
    '$6$rounds=10000$saltstringsaltst$OW1/O6BYHV6BcXZu8QVeXbDWra3Oeqh0sbHbbMCVNSnCM/UrjmM0Dp8vOuZeHBy/YTBmSK6H9qs/y3RnOaw5v.'],
  ['$6$rounds=5000$toolongsaltstring', 'This is just a test',
    '$6$rounds=5000$toolongsaltstrin$lQ8jolhgVRVhY4b5pZKaysCLi0QBxGoNeKQzQ3glMhwllF7oGDZxUhx1yxdYcz/e1JSbq3y6JMxxl8audkUEm0'],
  ['$6$rounds=1400$anotherlongsaltstring', 'a very much longer text to encrypt.  This one even stretches over morethan one line.',
    '$6$rounds=1400$anotherlongsalts$POfYwTEok97VWcjxIiSOjiykti.o/pQs.wPvMxQ6Fm7I6IoYN3CmLs66x9t0oSwbtEW7o7UmJEiDwGqd8p4ur1'],
  ['$6$rounds=77777$short', 'we have a short salt string but not a short password',
    '$6$rounds=77777$short$WuQyW2YR.hBNpjjRhpYD/ifIw05xdfeEyQoMxIXbkvr0gge1a1x3yRULJ5CCaUeOxFmtlcGZelFl5CxtgfiAc0'],
  ['$6$rounds=123456$asaltof16chars..', 'a short string',
    '$6$rounds=123456$asaltof16chars..$BtCwjqMJGx5hrJhZywWvt0RLE8uZ4oPwcelCjmw2kSYu.Ec6ycULevoBK25fs2xXgMNrCzIMVcgEJAstJeonj1'],
  // rounds below the minimum must be CLAMPED to 1000, not honoured
  ['$6$rounds=10$roundstoolow', 'the minimum number is still observed',
    '$6$rounds=1000$roundstoolow$kUMsbe306n21p9R.FRkW3IGn.S9NPN0x50YhH1xhLsPuWGsUSklZt58jaTfF4ZEQpyUNGc0dqbpBYYBaHHrsX.'],
];

VECTORS.forEach(([salt, pw, expected], i) => {
  t('spec vector ' + (i + 1) + ' (' + salt.slice(0, 28) + ')', () => {
    assert.strictEqual(sha512crypt(pw, salt), expected);
  });
});

// ── shape / behaviour ─────────────────────────────────────────────────────────────────────────────────────────
t('a generated salt yields a valid, verifiable $6$ hash', () => {
  const h = sha512crypt('Test-Fake-Pass-0000');
  assert.ok(/^\$6\$[./0-9A-Za-z]{16}\$[./0-9A-Za-z]{86}$/.test(h), 'unexpected shape: ' + h);
  // re-hashing with the SAME salt must reproduce it exactly — that is what `chpasswd -e` relies on
  const salt = h.split('$')[2];
  assert.strictEqual(sha512crypt('Test-Fake-Pass-0000', salt), h);
});
t('salts are random per call, so two cards never share one', () => {
  const a = sha512crypt('same-password');
  const b = sha512crypt('same-password');
  assert.notStrictEqual(a, b, 'two hashes of one password must differ (unique salt)');
  assert.notStrictEqual(a.split('$')[2], b.split('$')[2]);
});
t('a wrong password does not collide', () => {
  const h = sha512crypt('correct-horse', 'saltsalt');
  assert.notStrictEqual(sha512crypt('correct-hors', 'saltsalt'), h);
  assert.notStrictEqual(sha512crypt('Correct-horse', 'saltsalt'), h);
});
t('salts longer than 16 chars are truncated, matching crypt(3)', () => {
  assert.strictEqual(sha512crypt('x', 'saltstringsaltstringEXTRA').split('$')[2], 'saltstringsaltst');
});
t('non-ASCII passwords are handled as UTF-8 bytes', () => {
  const h = sha512crypt('pässwörd–ü', 'saltstring');
  assert.ok(/^\$6\$saltstring\$[./0-9A-Za-z]{86}$/.test(h));
  assert.strictEqual(sha512crypt('pässwörd–ü', 'saltstring'), h, 'deterministic');
});

// ── cross-check against the real openssl, when one happens to be available ────────────────────────────────────
// Not required to pass (a clean Windows box has no openssl — the entire reason this module exists), but when a
// binary IS present it is the strongest possible confirmation: an independent implementation agreeing on output.
(function crossCheck() {
  const cands = ['openssl', 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe', '/usr/bin/openssl'];
  let bin = null;
  for (const c of cands) {
    try { execFileSync(c, ['version'], { stdio: 'ignore', timeout: 5000 }); bin = c; break; } catch (_) { /* next */ }
  }
  if (!bin) { console.log('  (no openssl on this machine — cross-check skipped, which is exactly the case this module fixes)'); return; }
  t('agrees with the system openssl on a real fleet password', () => {
    const pw = 'Test-Fake-Pass-0000';
    const out = execFileSync(bin, ['passwd', '-6', '-salt', 'abcdefghijklmnop', '-stdin'], { input: pw, encoding: 'utf8', timeout: 8000 }).trim();
    assert.strictEqual(sha512crypt(pw, 'abcdefghijklmnop'), out, 'pure-JS output must match openssl byte for byte');
  });
  t('agrees with the system openssl on a password with shell-hostile characters', () => {
    const pw = 'a"b\'c$d`e|f;g&h!i';
    const out = execFileSync(bin, ['passwd', '-6', '-salt', 'ZZZZZZZZZZZZZZZZ', '-stdin'], { input: pw, encoding: 'utf8', timeout: 8000 }).trim();
    assert.strictEqual(sha512crypt(pw, 'ZZZZZZZZZZZZZZZZ'), out);
  });
})();

console.log(`sha512crypt.test: ${pass} passed, ${fail.length} failed`);
if (fail.length) { fail.forEach((f) => console.error('  FAIL: ' + f)); process.exit(1); }
