'use strict';
/*
 * Electron load + live-safety test. Run headlessly:  electron flasher/_test/electron-load-test.js
 * Proves, under the REAL Electron runtime (not node): (1) drivelist + etcher-sdk load (native ABI matches),
 * (2) the API symbols writer.js needs exist, (3) safety.js correctly classifies THIS machine's actual drives —
 * the system disk must be rejected, a removable SD accepted. Writes JSON to LOADTEST_OUT (or ./loadtest-result.json).
 */
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const out = { electron: process.versions.electron, node: process.versions.node, chrome: process.versions.chrome };

  // drivelist under Electron
  let drives = [];
  try {
    const drivelist = require('drivelist');
    drives = await drivelist.list();
    out.drivelist = {
      ok: true, count: drives.length,
      drives: drives.map((d) => ({ raw: d.raw, description: d.description, size: d.size, isSystem: d.isSystem, isRemovable: d.isRemovable, isUSB: d.isUSB, isCard: d.isCard, isReadOnly: d.isReadOnly, isVirtual: d.isVirtual, mountpoints: (d.mountpoints || []).map((m) => m.path || m) })),
    };
  } catch (e) { out.drivelist = { ok: false, err: e.message }; }

  // etcher-sdk under Electron + the exact symbols writer.js uses
  try {
    const sdk = require('etcher-sdk');
    out.etcherSdk = {
      ok: true,
      hasFile: !!(sdk.sourceDestination && sdk.sourceDestination.File),
      hasBlockDevice: !!(sdk.sourceDestination && sdk.sourceDestination.BlockDevice),
      hasPipe: !!(sdk.multiWrite && sdk.multiWrite.pipeSourceToDestinations),
    };
  } catch (e) { out.etcherSdk = { ok: false, err: e.message }; }

  // safety.js against REAL drives — the live "never the wrong drive" proof
  try {
    const safety = require(path.join(__dirname, '..', 'safety'));
    const eligible = safety.eligibleDrives(drives);
    const systemDisks = drives.filter((d) => d.isSystem || (d.mountpoints || []).some((m) => /^C:/i.test(m.path || m || '')));
    out.safety = {
      ok: true,
      eligibleCount: eligible.length,
      eligible: eligible.map((d) => safety.humanLabel(d)),
      systemDiskCount: systemDisks.length,
      anySystemDiskEligible: systemDisks.some((d) => safety.isEligible(d)), // MUST be false
    };
  } catch (e) { out.safety = { ok: false, err: e.message }; }

  const outFile = process.env.LOADTEST_OUT || path.join(process.cwd(), 'loadtest-result.json');
  try { fs.writeFileSync(outFile, JSON.stringify(out, null, 2)); } catch (_) {}
  console.log('LOADTEST_JSON ' + JSON.stringify(out));
  app.quit();
});
app.on('window-all-closed', () => app.quit());
