'use strict';
/*
 * flasher/sha512crypt.js — SHA-512 crypt ($6$) in pure Node, no external binary.
 *
 * WHY THIS EXISTS: the Pi's console/SSH password has to reach the card as a $6$ crypt hash (that is what
 * /boot/firmware/userconf.txt + `chpasswd -e` consume). We used to shell out to `openssl passwd -6`. Windows does
 * NOT ship openssl — on the machines where this was developed it was only present because Git for Windows had
 * been installed. On a clean PC that lookup fails, hashUnixPassword returns null, and the card is written with NO
 * console password AT ALL while the UI still reports "fleet password applied". Silent, and exactly the sort of
 * thing that only shows up when someone is standing at a dealership unable to log in.
 *
 * This is NOT hand-rolled cryptography. SHA-512-crypt is a fixed, published sequence of SHA-512 digests
 * (Drepper's specification, as implemented by glibc); the only primitive is SHA-512, which comes from Node's
 * crypto. The implementation is checked against the specification's own published test vectors in
 * _test/sha512crypt.test.js — if any step were wrong, not one vector would match.
 */
const crypto = require('crypto');

const B64 = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const ROUNDS_DEFAULT = 5000;
const ROUNDS_MIN = 1000;
const ROUNDS_MAX = 999999999;

const sha512 = (...bufs) => {
  const h = crypto.createHash('sha512');
  for (const b of bufs) h.update(b);
  return h.digest();
};

// Repeat `src` to exactly `len` bytes (the spec's "sequence of bytes" step).
function repeatTo(src, len) {
  const out = Buffer.alloc(len);
  for (let i = 0; i < len; i += src.length) src.copy(out, i, 0, Math.min(src.length, len - i));
  return out;
}

// glibc's b64_from_24bit: little-endian 6-bit groups out of a 24-bit big-endian word.
function b64From24(b2, b1, b0, n) {
  let w = ((b2 & 0xff) << 16) | ((b1 & 0xff) << 8) | (b0 & 0xff);
  let s = '';
  for (let i = 0; i < n; i += 1) { s += B64[w & 0x3f]; w >>= 6; }
  return s;
}

// The byte-interleaving order the SHA-512 variant uses for its final output. Straight from the reference
// implementation — the digest bytes are NOT emitted in order.
const ORDER = [
  [0, 21, 42], [22, 43, 1], [44, 2, 23], [3, 24, 45], [25, 46, 4], [47, 5, 26], [6, 27, 48],
  [28, 49, 7], [50, 8, 29], [9, 30, 51], [31, 52, 10], [53, 11, 32], [12, 33, 54], [34, 55, 13],
  [56, 14, 35], [15, 36, 57], [37, 58, 16], [59, 17, 38], [18, 39, 60], [40, 61, 19], [62, 20, 41],
];

/**
 * @param {string|Buffer} password  plaintext
 * @param {string} [salt]           up to 16 chars; may carry a "rounds=N$" prefix. Random if omitted.
 * @param {number} [rounds]         explicit round count (overrides any prefix in `salt`)
 * @returns {string} "$6$[rounds=N$]<salt>$<hash>"
 */
function sha512crypt(password, salt, rounds) {
  const pw = Buffer.isBuffer(password) ? password : Buffer.from(String(password), 'utf8');

  let saltStr = salt == null ? null : String(salt);
  let explicitRounds = false;
  let r = ROUNDS_DEFAULT;

  if (saltStr != null) {
    saltStr = saltStr.replace(/^\$6\$/, '');
    const m = /^rounds=(\d+)\$(.*)$/.exec(saltStr);
    if (m) { r = parseInt(m[1], 10); explicitRounds = true; saltStr = m[2]; }
    saltStr = saltStr.split('$')[0];
  } else {
    // 16 chars from the crypt alphabet, drawn from a CSPRNG with rejection sampling so every char is uniform.
    let s = '';
    while (s.length < 16) {
      for (const b of crypto.randomBytes(32)) { if (b < 192 && s.length < 16) s += B64[b % 64]; }
    }
    saltStr = s;
  }
  if (typeof rounds === 'number' && Number.isFinite(rounds)) { r = rounds; explicitRounds = true; }
  r = Math.max(ROUNDS_MIN, Math.min(ROUNDS_MAX, Math.floor(r)));

  const saltBuf = Buffer.from(saltStr, 'utf8').slice(0, 16);
  const saltUsed = saltBuf.toString('utf8');

  // 1-3: digest B over password+salt+password
  const B = sha512(pw, saltBuf, pw);

  // 4-8: digest A
  const aParts = [pw, saltBuf, repeatTo(B, pw.length)];
  for (let n = pw.length; n > 0; n >>= 1) aParts.push((n & 1) ? B : pw);
  const A = sha512(...aParts);

  // 9-12: DP -> P sequence
  const dpParts = [];
  for (let i = 0; i < pw.length; i += 1) dpParts.push(pw);
  const P = repeatTo(sha512(...dpParts), pw.length);

  // 13-15: DS -> S sequence (note: 16 + first byte of A repetitions)
  const dsParts = [];
  const dsCount = 16 + A[0];
  for (let i = 0; i < dsCount; i += 1) dsParts.push(saltBuf);
  const S = repeatTo(sha512(...dsParts), saltBuf.length);

  // 16-21: the stretching loop
  let C = A;
  for (let i = 0; i < r; i += 1) {
    const parts = [];
    parts.push((i & 1) ? P : C);
    if (i % 3) parts.push(S);
    if (i % 7) parts.push(P);
    parts.push((i & 1) ? C : P);
    C = sha512(...parts);
  }

  // 22: interleaved base64
  let out = '';
  for (const [x, y, z] of ORDER) out += b64From24(C[x], C[y], C[z], 4);
  out += b64From24(0, 0, C[63], 2);

  return '$6$' + (explicitRounds ? 'rounds=' + r + '$' : '') + saltUsed + '$' + out;
}

module.exports = { sha512crypt, _b64: B64 };
