'use strict';
// Does Node mangle the \\.\PhysicalDriveN device path, and does a Buffer path bypass it?
// Uses a NONEXISTENT drive so no elevation/card is needed — we only care about the path Node echoes back.
const fs = require('fs');
const target = '\\\\.\\PhysicalDrive99';
console.log('input string   :', JSON.stringify(target));
for (const [name, p] of [['string', target], ['buffer', Buffer.from(target, 'utf8')]]) {
  try { const fd = fs.openSync(p, 'r'); fs.closeSync(fd); console.log(name.padEnd(7), '-> OPENED (unexpected)'); }
  catch (e) { console.log(name.padEnd(7), '->', e.code, JSON.stringify(e.message)); }
}
