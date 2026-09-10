'use strict';
// Inject the boot-partition files into an already-flashed, mounted bootfs (rpi-imager left it at BOOTDIR).
// Pure fs + inject.js (no natives). Run: PLAN=<plan.json> BOOTDIR="F:\\" node do-inject.js
const fs = require('fs');
const path = require('path');
const inject = require(path.join(__dirname, '..', 'inject'));
const plan = require(process.env.PLAN);
const bootDir = process.env.BOOTDIR;
if (!bootDir) { console.error('BOOTDIR required'); process.exit(1); }
for (const f of inject.bootFilesFor(plan)) {
  const dest = path.join(bootDir, f.path);
  const fd = fs.openSync(dest, 'w');
  fs.writeSync(fd, Buffer.from(f.content, 'utf8'));
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  console.log('WROTE', dest, '(' + f.content.length + ' bytes)');
}
const cmdPath = path.join(bootDir, 'cmdline.txt');
if (fs.existsSync(cmdPath)) {
  const existing = fs.readFileSync(cmdPath, 'utf8');
  const fd = fs.openSync(cmdPath, 'w');
  fs.writeSync(fd, Buffer.from(inject.cmdlinePatched(existing), 'utf8'));
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  console.log('PATCHED', cmdPath, '(cmdline hook appended)');
} else {
  console.log('NOTE: no cmdline.txt on bootfs (Pi Imager may use a different first-run mechanism)');
}
console.log('INJECT DONE');
