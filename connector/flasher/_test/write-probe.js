'use strict';
/*
 * write-probe.js — PROVE the Buffer-path fix opens the raw disk. Runs ELEVATED. Opens/closes only, WRITES NO
 * DATA. 8s timeout per test, incremental flush. Output -> PROBE_OUT. Target = safety-eligible removable card.
 */
const fs = require('fs');
const path = require('path');
const OUT = process.env.PROBE_OUT || 'probe-result.json';
const out = { node: process.versions.node, electron: process.versions.electron, tests: {} };
function flush() { try { fs.writeFileSync(OUT, JSON.stringify(out, null, 2)); } catch (_) {} }
function withTimeout(p, ms) { return Promise.race([Promise.resolve().then(() => p), new Promise((_, r) => setTimeout(() => r(new Error('TIMEOUT ' + ms + 'ms')), ms))]); }
async function rec(name, fn) { try { const v = await withTimeout(fn(), 8000); out.tests[name] = { ok: true, info: v }; } catch (e) { out.tests[name] = { ok: false, code: e.code, errno: e.errno, msg: e.message }; } flush(); }

// SAME patch as writer.js: Buffer-ize raw device paths so Electron's Node doesn't append a trailing backslash.
const _open = fs.promises.open;
fs.promises.open = function (p, ...rest) { if (typeof p === 'string' && /^\\\\[.?]\\PhysicalDrive\d+$/i.test(p)) p = Buffer.from(p, 'utf8'); return _open.call(fs.promises, p, ...rest); };

(async () => {
  let sdk, drivelist, dio, safety;
  try { drivelist = require('drivelist'); } catch (e) { out.fatal = 'drivelist: ' + e.message; }
  try { sdk = require('etcher-sdk'); } catch (e) { out.fatal = (out.fatal || '') + ' etcher-sdk: ' + e.message; }
  try { dio = require('@ronomon/direct-io'); } catch (e) {}
  try { safety = require(path.join(__dirname, '..', 'safety')); } catch (e) {}
  flush();

  const rows = drivelist ? await drivelist.list() : [];
  const drive = (safety ? safety.eligibleDrives(rows) : [])[0] || null;
  if (!drive) { out.error = 'no eligible removable card found'; flush(); process.exit(0); }
  const RAW = drive.raw;
  out.drive = { raw: drive.raw, device: drive.device, blockSize: drive.blockSize, size: drive.size, mountpoints: (drive.mountpoints || []).map((m) => m.path || m) };
  flush();

  // A) raw fs open with a BUFFER path, read-write (the low-level proof)
  await rec('A_fs_buffer_rdwr', async () => { const fd = fs.openSync(Buffer.from(RAW, 'utf8'), fs.constants.O_RDWR | (dio ? dio.O_EXLOCK : 0)); fs.closeSync(fd); return 'ok'; });
  // B) raw fs open with a STRING path (should still FAIL — confirms the bug is real)
  await rec('B_fs_string_rdwr', async () => { const fd = fs.openSync(RAW, fs.constants.O_RDWR); fs.closeSync(fd); return 'ok (unexpected)'; });
  // C) etcher BlockDevice WITH the fs.promises.open patch active (the real proof the writer will work)
  if (sdk) await rec('C_blockdevice_patched', async () => { const bd = new sdk.sourceDestination.BlockDevice({ drive, write: true, direct: true, unmountOnSuccess: false }); await bd.open(); await bd.close(); return 'open+close ok'; });

  out.done = true; flush(); process.exit(0);
})().catch((e) => { out.crash = e.message; flush(); process.exit(1); });
