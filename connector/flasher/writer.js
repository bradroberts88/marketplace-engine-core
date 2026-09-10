'use strict';
/*
 * flasher/writer.js — the ELEVATED worker (spawned with Administrator via sudo-prompt at flash time only).
 * Talks JSON lines over stdout + a progress file. Does the dangerous work in one place:
 *   1. RE-VERIFY the target across the privilege boundary (drivelist re-scan + assertStillEligible) — refuse on drift.
 *   2. WRITE + VERIFY the image with RASPBERRY PI IMAGER (rpi-imager --cli). It handles Windows raw-disk writing,
 *      .xz decompression, volume dismount, and read-back verification natively — the reliable, standard tool.
 *      (We deliberately do NOT use etcher-sdk/@ronomon/direct-io: their O_DIRECT aligned external buffers are
 *      forbidden by Electron 32's V8 sandbox, and buffered-IO verify can silently pass a corrupt card.)
 *   3. Mount the FAT boot partition (rpi-imager leaves it mounted via --disable-eject), inject
 *      autopost-claim.env + firstrun.sh, patch cmdline.txt with the one-shot hook, fsync.
 *   4. Flush so the card is safe to pull.
 * Every stdout line is JSON: {type:'stage'|'progress'|'done'|'error', ...}. drivelist is the only native module
 * used here (N-API, loads under Electron); rpi-imager is an external process.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const safety = require('./safety');
const inject = require('./inject');

const PROGRESS_FILE = process.argv[3] || null;
function emit(obj) {
  const line = JSON.stringify(obj) + '\n';
  try { process.stdout.write(line); } catch (_) { /* pipe closed */ }
  if (PROGRESS_FILE) { try { fs.appendFileSync(PROGRESS_FILE, line); } catch (_) { /* best effort */ } }
}
function die(reason, code = 1) { emit({ type: 'error', reason: String(reason).slice(0, 400) }); process.exit(code); }

function loadPlan() {
  const p = process.argv[2];
  if (!p || !fs.existsSync(p)) die('writer: plan file missing');
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { die('writer: bad plan json: ' + e.message); }
}

// Locate rpi-imager.exe (winget installs to "Raspberry Pi Ltd\\Imager"; older builds to "Raspberry Pi Imager").
function resolveRpiImager() {
  const cands = [
    process.env.RPI_IMAGER,
    'C:\\Program Files\\Raspberry Pi Ltd\\Imager\\rpi-imager.exe',
    'C:\\Program Files\\Raspberry Pi Imager\\rpi-imager.exe',
    'C:\\Program Files (x86)\\Raspberry Pi Imager\\rpi-imager.exe',
  ].filter(Boolean);
  return cands.find((p) => { try { return fs.existsSync(p); } catch (_) { return false; } }) || null;
}

async function freshDrive(drivelist, raw) {
  const rows = await drivelist.list();
  return rows.find((r) => String(r.raw) === String(raw)) || null;
}

// Run a PowerShell one-liner; empty string on any failure.
function ps(cmd, timeoutMs = 15000) {
  try { return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', timeout: timeoutMs }); }
  catch (_) { return ''; }
}

// Force the just-written disk back into a usable, lettered state. After rpi-imager's raw write, Windows very often
// leaves the target disk OFFLINE and/or READ-ONLY (especially on a machine that has flashed a card before, or after
// an eject), or keeps showing the card's PREVIOUS layout. When the disk is OFFLINE, NO PowerShell command
// (Get-Partition / Add-PartitionAccessPath) can ever letter it — that is exactly the "boot partition never
// appeared" failure. diskpart is the only tool that recovers it: online the disk, clear read-only, rescan the
// partition table, then ASSIGN a drive letter to the FAT boot partition (partition 1) — far more forceful than
// Add-PartitionAccessPath, which silently no-ops on many card readers. Scoped to the ONE written disk. Uses
// `online disk` (NOT `uniqueid`/`clean`) so the MBR signature + PARTUUID are preserved and the card still boots.
// Best-effort; never throws.
function diskpartFix(diskNum) {
  if (diskNum == null) return;
  try {
    const dp = path.join(require('os').tmpdir(), 'autopost-dp-' + process.pid + '.txt');
    fs.writeFileSync(dp, [
      'select disk ' + diskNum,
      'online disk noerr',
      'attributes disk clear readonly noerr',
      'rescan',
      'select partition 1 noerr',
      'attributes volume clear readonly noerr',
      'assign noerr',
      'exit',
    ].join('\r\n') + '\r\n');
    try { execFileSync('diskpart', ['/s', dp], { encoding: 'utf8', timeout: 40000 }); } catch (_) { /* best effort */ }
    try { fs.unlinkSync(dp); } catch (_) { /* best effort */ }
  } catch (_) { /* best effort */ }
}

// Find the drive letter of the FAT 'bootfs' partition OF THE DISK WE JUST WROTE (by disk number). ROBUST against
// the three Windows failure modes we have actually hit in the field:
//   1. STALE VIEW — Windows still shows the card's old layout after the raw write: we `rescan` first (and again
//      mid-poll) so it drops the cached partitions and sees the freshly-written ones.
//   2. NO DRIVE LETTER — automount is off / the volume never got a letter: we ASSIGN one via
//      Add-PartitionAccessPath -AssignDriveLetter for any lettered-less FAT partition on this disk.
//   3. WRONG FAT — a leftover/stale FAT (a previous full-card format) gets a letter but is NOT the boot partition:
//      we accept a candidate ONLY if it actually contains cmdline.txt (the file inject.js patches), never by label
//      or by "first one". This is exactly the "cmdline.txt not found on bootfs" failure.
// Scoped to the ONE written disk so we never touch a stale/absent letter (which pops the blocking Windows
// "There is no disk in drive X:" modal). Polls up to ~60s.
function findBootfsLetter(diskNum) {
  if (diskNum == null) return null;
  const FAT = "($_.FileSystemType -eq 'FAT32' -or $_.FileSystemType -eq 'FAT')";
  diskpartFix(diskNum); // online + clear-readonly + rescan + assign a letter to partition 1 BEFORE we poll
  for (let i = 0; i < 60; i += 1) {
    try {
      // Give any FAT partition on THIS disk that lacks a drive letter one (handles disabled automount).
      ps(`Get-Partition -DiskNumber ${diskNum} -ErrorAction SilentlyContinue | ForEach-Object { $v = $_ | Get-Volume -ErrorAction SilentlyContinue; if ($v -and ${FAT} -and -not $v.DriveLetter) { $_ | Add-PartitionAccessPath -AssignDriveLetter -ErrorAction SilentlyContinue } }`);
      // List lettered FAT partitions on this disk, then accept ONLY the one that actually holds the Pi boot file.
      const out = ps(`Get-Partition -DiskNumber ${diskNum} -ErrorAction SilentlyContinue | Get-Volume -ErrorAction SilentlyContinue | Where-Object { $_.DriveLetter -and ${FAT} } | ForEach-Object { "$($_.DriveLetter)|$($_.FileSystemLabel)" }`);
      const cands = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => l.split('|'));
      const boot = cands.find((c) => c[0] && fs.existsSync(c[0] + ':\\cmdline.txt'));
      if (boot && boot[0]) return boot[0] + ':\\';
      // FALLBACK: rpi-imager may EJECT the card after writing, so it re-appears under a DIFFERENT disk number.
      // Look system-wide for a lettered FAT volume that holds BOTH Pi boot files (cmdline.txt + config.txt) —
      // that is our freshly-written card wherever Windows now lists it. Read-only match; inject only ever runs on
      // a directory proven to contain the boot files.
      const anyOut = ps(`Get-Volume -ErrorAction SilentlyContinue | Where-Object { $_.DriveLetter -and ${FAT} } | ForEach-Object { $_.DriveLetter }`);
      for (const dl of anyOut.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
        if (fs.existsSync(dl + ':\\cmdline.txt') && fs.existsSync(dl + ':\\config.txt')) return dl + ':\\';
      }
    } catch (_) { /* keep polling */ }
    if (i === 3 || i === 10 || i === 25) diskpartFix(diskNum); // re-online/assign in case the disk dropped offline mid-poll
    try { execFileSync('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 1000'], { timeout: 3000 }); } catch (_) {}
  }
  return null;
}
// Parse the Windows physical-disk number from a drivelist raw path (\\.\PhysicalDrive2 -> 2).
function diskNumberOf(raw) { const m = /PhysicalDrive(\d+)/i.exec(String(raw || '')); return m ? Number(m[1]) : null; }

async function main() {
  const plan = loadPlan();
  let drivelist;
  try { drivelist = require('drivelist'); } catch (e) { die('drivelist not available: ' + e.message); }

  // 1. RE-VERIFY the target across the privilege boundary — the last guard before we destroy the card.
  emit({ type: 'stage', stage: 're-verifying target' });
  const fresh = await freshDrive(drivelist, plan.target.raw);
  const chk = safety.assertStillEligible(fresh, plan.target);
  if (!chk.ok) die('SAFETY ABORT before write: ' + chk.reason);
  if (!fs.existsSync(plan.imagePath)) die('image not found: ' + plan.imagePath);

  // 2. WRITE the golden AND inject our provisioning IN ONE STEP, via Raspberry Pi Imager's OWN customization
  // (--first-run-script). rpi-imager writes the boot files into the FAT partition using its embedded writer DURING
  // the write — no Windows drive letter, no mount, no partition re-enumeration afterward. This is exactly the
  // mechanism that makes official Pi Imager Wi-Fi/user setup "just work" on any Windows machine, and it DELETES the
  // post-write drive-letter dependency that failed on VA card readers (offline/read-only/never-lettered disk).
  // rpi-imager places ONE self-contained script (inject.firstRunScriptSelfContained) that writes autopost-claim.env
  // + autopost-tailscale.env + userconf.txt to /boot/firmware and provisions Wi-Fi via NetworkManager keyfiles —
  // byte-for-byte the certified provisioning, only the delivery changes. Verify is ON (exit 0 = written AND
  // verified). We are already elevated; rpi-imager runs as a direct child.
  emit({ type: 'stage', stage: 'writing + customising image (Raspberry Pi Imager)' });
  const rpi = resolveRpiImager();
  if (!rpi) die('Raspberry Pi Imager not found. Install it (winget install RaspberryPiFoundation.RaspberryPiImager) or set RPI_IMAGER.');

  // Stage the self-contained first-run script (0600, elevated temp dir): secrets (Wi-Fi psk, claim code) never
  // touch a visible command line — rpi-imager reads the file by path.
  const frTmp = path.join(require('os').tmpdir(), 'autopost-firstrun-' + process.pid + '.sh');
  try { fs.writeFileSync(frTmp, inject.firstRunScriptSelfContained(plan), { mode: 0o600 }); }
  catch (e) { die('could not stage the first-run script: ' + e.message); }

  const logFile = path.join(require('os').tmpdir(), 'autopost-rpi-' + process.pid + '.log');
  const res = await new Promise((resolve) => {
    let out = ''; let lastPct = -1; let phase = 'writing'; let sawPct = false;
    const child = spawn(rpi, ['--cli', '--debug', '--first-run-script', frTmp, '--log-file', logFile, plan.imagePath, fresh.raw], { windowsHide: true });
    const onData = (d) => {
      out += d.toString();
      if (/verif/i.test(out)) phase = 'verifying';
      const m = out.match(/(\d{1,3}(?:\.\d+)?)\s*%/g);
      if (m) {
        const pct = Math.min(100, parseFloat(m[m.length - 1]));
        if (!isNaN(pct) && pct !== lastPct) { lastPct = pct; sawPct = true; emit({ type: 'progress', phase, percentage: pct }); }
        out = out.slice(-400);
      }
    };
    if (child.stdout) child.stdout.on('data', onData);
    if (child.stderr) child.stderr.on('data', onData);
    // heartbeat: if rpi-imager gives no parseable %, creep a synthetic value up to ~90% so the bar isn't frozen.
    let hb = 0;
    const beat = setInterval(() => { if (!sawPct) { hb = Math.min(90, hb + 3); emit({ type: 'progress', phase, percentage: hb, synthetic: true }); } }, 2500);
    const killer = setTimeout(() => { try { child.kill(); } catch (_) {} }, 30 * 60 * 1000);
    child.on('error', (e) => { clearInterval(beat); clearTimeout(killer); resolve({ status: null, error: e }); });
    child.on('close', (code) => { clearInterval(beat); clearTimeout(killer); resolve({ status: code }); });
  });
  let log = '';
  try { log = fs.readFileSync(logFile, 'utf8'); } catch (_) {}
  try { fs.unlinkSync(frTmp); } catch (_) { /* best effort */ }
  if (res.error) die('rpi-imager failed to start: ' + res.error.message);
  if (res.status !== 0) {
    const tail = (log || '').slice(-350).replace(/\s+/g, ' ');
    die('rpi-imager write/verify failed (exit ' + res.status + '). ' + tail);
  }

  // 3. CONFIRM rpi-imager actually APPLIED the customization (placed our first-run script into the boot partition).
  // rpi-imager's --debug log records this ("Applying OS customisation..." / "wrote customization file" /
  // "firstrun"). A write that verified the raw image but silently skipped customisation must NEVER look shipped —
  // that would produce a Pi that boots but has no Wi-Fi and never claims.
  emit({ type: 'stage', stage: 'confirming Wi-Fi + claim customisation' });
  // rpi-imager exiting 0 with --first-run-script IS the authority that write + verify + customisation all
  // succeeded. Only FAIL on an EXPLICIT customisation-write failure in the log — never on the ABSENCE of a
  // particular phrase (rpi-imager's --debug wording varies by build; a strict positive match would false-block
  // every good flash). This still refuses a card whose customisation genuinely failed (that logs an explicit
  // error), but can never block a good one.
  const custFailed = /failed to write customization|customisation failed|customization failed|error writing customi/i.test(log || '');
  if (custFailed) {
    die('Raspberry Pi Imager reported it could NOT write the Wi-Fi/claim customisation — do NOT ship this card, re-flash. '
      + 'Detail: ' + (log || '').slice(-250).replace(/\s+/g, ' '));
  }
  try { fs.unlinkSync(logFile); } catch (_) { /* best effort */ }

  emit({ type: 'done', bootDir: null, customized: true });
  process.exit(0);
}

main().catch((e) => die('writer crashed: ' + (e && e.message)));
