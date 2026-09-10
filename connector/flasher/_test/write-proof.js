'use strict';
/*
 * write-proof.js — prove the REAL write path (etcher pipeSourceToDestinations + verify) works on the card with
 * direct:false, avoiding the @ronomon/direct-io external-buffer assertion. Runs ELEVATED. Writes a SMALL 8MB test
 * source to the START of the card (harmless — the card is about to be reflashed) and verifies it. Output -> PROOF_OUT.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const OUT = process.env.PROOF_OUT || 'proof-result.json';
const out = { node: process.versions.node, electron: process.versions.electron };
function flush() { try { fs.writeFileSync(OUT, JSON.stringify(out, null, 2)); } catch (_) {} }

// SAME device-path Buffer patch as writer.js.
const _open = fs.promises.open;
fs.promises.open = function (p, ...rest) { if (typeof p === 'string' && /^\\\\[.?]\\PhysicalDrive\d+$/i.test(p)) p = Buffer.from(p, 'utf8'); return _open.call(fs.promises, p, ...rest); };

// Replace @ronomon/direct-io's getAlignedBuffer (napi_create_external_buffer -> asserts under Electron's V8
// sandbox) with a plain Buffer. Safe with direct:false (buffered IO does not require aligned buffer memory).
const dio = require('@ronomon/direct-io');
dio.getAlignedBuffer = function (size) { return Buffer.alloc(size); };

(async () => {
  const sdk = require('etcher-sdk');
  const drivelist = require('drivelist');
  const safety = require(path.join(__dirname, '..', 'safety'));
  const drive = safety.eligibleDrives(await drivelist.list())[0];
  if (!drive) { out.error = 'no eligible card'; flush(); process.exit(0); }
  out.drive = { raw: drive.raw, size: drive.size, blockSize: drive.blockSize };
  flush();

  // 8MB aligned test image (multiple of 1MB) written to a temp file, then flashed to the card start.
  const img = path.join(os.tmpdir(), 'autopost-writeproof-8mb.img');
  const buf = Buffer.alloc(8 * 1024 * 1024);
  for (let i = 0; i < buf.length; i += 4) buf.writeUInt32LE((i * 2654435761) >>> 0, i); // deterministic pattern
  fs.writeFileSync(img, buf);

  const source = new sdk.sourceDestination.File({ path: img });
  const dest = new sdk.sourceDestination.BlockDevice({ drive, write: true, direct: false, unmountOnSuccess: false });
  try {
    const res = await sdk.multiWrite.pipeSourceToDestinations({
      source, destinations: [dest], verify: true, numBuffers: 8,
      onFail: (_d, e) => { out.onFail = (out.onFail || '') + '; ' + (e && e.message); },
      onProgress: () => {},
    });
    out.bytesWritten = res.bytesWritten;
    out.failures = res.failures ? res.failures.size : 0;
    out.ok = (res.failures ? res.failures.size : 0) === 0 && !out.onFail;
  } catch (e) { out.ok = false; out.crash = e.message; }
  try { fs.unlinkSync(img); } catch (_) {}
  out.done = true; flush(); process.exit(0);
})().catch((e) => { out.crash = e.message; out.done = true; flush(); process.exit(1); });
