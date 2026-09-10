'use strict';
// Build a real plan.json (same shape main-flasher produces) targeting the eligible card, for a direct
// end-to-end run of the production writer.js. Run under electron-as-node (native ABI). Non-elevated (list only).
const fs = require('fs');
const os = require('os');
const path = require('path');
const drivelist = require('drivelist');
const safety = require(path.join(__dirname, '..', 'safety'));
(async () => {
  const drive = safety.eligibleDrives(await drivelist.list())[0];
  if (!drive) { console.error('NO eligible card'); process.exit(1); }
  const imagePath = path.join(os.homedir(), 'AppData', 'Local', 'AutoPost', 'images', 'raspios-lite.img.xz');
  const plan = {
    dealership: 'WRITER-DIRECT-TEST',
    claimUrl: 'https://marketplaceautopost.com/claim',
    claimCode: 'TEST0042',
    networks: [{ ssid: 'TestNet', pass: 'test-wifi-pass', hidden: false }],
    country: 'CA', tz: 'America/Toronto',
    imagePath,
    target: drive,
  };
  fs.writeFileSync(process.env.PLAN_OUT, JSON.stringify(plan, null, 2));
  console.log('PLAN OK target=' + drive.raw + ' size=' + drive.size + ' imageExists=' + fs.existsSync(imagePath));
})().catch((e) => { console.error('build-plan crash: ' + e.message); process.exit(1); });
