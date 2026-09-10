'use strict';
/*
 * flasher/safety.js — the "NEVER flash the wrong drive" core. PURE: no I/O, no hardware, fully unit-testable.
 *
 * A raw disk write ERASES the whole target. Flashing the VA's system disk or an external HDD would destroy it.
 * These predicates are ONE of seven defense layers (see the flash flow); they are the layer that decides which
 * drives the VA is even allowed to see + pick. Mirrors balenaEtcher's isDriveValid contract, tuned for "this is
 * a 32GB SD card for a Pi, nothing else".
 *
 * A drive is a `drivelist`/`etcher-sdk` descriptor: { device, raw, description, size, isSystem, isReadOnly,
 * isRemovable, isVirtual, isCard, isUSB, isSCSI, busType, mountpoints:[{path}] }.
 */

const MIN_SD_BYTES = 4 * 1e9;   // reject anything under 4GB (not a usable Pi card)
const MAX_SD_BYTES = 256 * 1e9; // reject anything over 256GB — a big drive is almost certainly NOT an SD card

// Windows system-volume letters we must never treat as a flashable card even if a descriptor lies about it.
const OS_VOLUME_RE = /^[A-Za-z]:[\\/]?$/;
function isLikelyOsVolume(d) {
  const mps = Array.isArray(d.mountpoints) ? d.mountpoints : [];
  // The boot/system drive is typically C:. Never flash a device mounted at the OS drive.
  return mps.some((m) => {
    const p = String((m && (m.path || m)) || '').trim();
    return /^C:[\\/]?$/i.test(p) || (OS_VOLUME_RE.test(p) && (process.env.SystemDrive && p.toUpperCase().startsWith(String(process.env.SystemDrive).toUpperCase())));
  });
}

/*
 * isEligible(drive) — true ONLY for a removable SD/USB card of plausible size. Every clause is a REJECT gate; a
 * missing/ambiguous field fails closed (we would rather refuse a real card than risk a wrong one).
 */
function isEligible(d) {
  if (!d || typeof d !== 'object') return false;
  if (d.isSystem === true) return false;                 // the OS/system disk — NEVER
  if (d.isReadOnly === true) return false;               // can't write it anyway
  if (d.isVirtual === true) return false;                // loopback / VM disk
  if (isLikelyOsVolume(d)) return false;                 // mounted at C:/system drive
  // Must positively look like removable media. Require at least one of the removable signals to be TRUE — a
  // fixed internal disk has all of these false/undefined and is rejected here (fail-closed).
  const removable = d.isRemovable === true || d.isCard === true || d.isUSB === true;
  if (!removable) return false;
  const size = Number(d.size);
  if (!Number.isFinite(size) || size < MIN_SD_BYTES || size > MAX_SD_BYTES) return false;
  return true;
}

/*
 * assertStillEligible(fresh, pinned) — called in the SAME tick immediately before the write, and again across
 * the privilege boundary in the elevated writer. `pinned` is the descriptor the VA confirmed; `fresh` is a
 * re-scan of the same raw path RIGHT NOW. Any drift (size changed, no longer removable, gone, became system,
 * different device swapped into the same letter) ABORTS. Defeats hot-swap and drive-letter-reassignment races.
 * Returns { ok:true } or { ok:false, reason }.
 */
function assertStillEligible(fresh, pinned) {
  if (!pinned || !pinned.raw) return { ok: false, reason: 'no pinned target' };
  if (!fresh) return { ok: false, reason: 'target device is gone (removed?)' };
  if (String(fresh.raw) !== String(pinned.raw)) return { ok: false, reason: 'target raw path changed' };
  if (!isEligible(fresh)) return { ok: false, reason: 'target is no longer a removable card' };
  // Size must not have changed — a different card/disk swapped into the same path is the classic race. Tolerate a
  // TINY reporting flap (some readers round the reported size differently on a re-scan): a genuinely different-
  // capacity card (16 vs 32GB, etc.) still differs by far more than this and correctly aborts, while a few-MB
  // wobble on the SAME card no longer false-aborts a legitimate flash.
  const drift = Math.abs(Number(fresh.size) - Number(pinned.size));
  if (!Number.isFinite(drift) || drift > Math.max(64 * 1e6, Number(pinned.size) * 0.01)) {
    return { ok: false, reason: `target size changed ${pinned.size}->${fresh.size} (different device?)` };
  }
  if (fresh.isSystem === true) return { ok: false, reason: 'target became a system disk' };
  return { ok: true };
}

// Filter a raw scan to only the drives the VA may pick.
function eligibleDrives(drives) {
  return (Array.isArray(drives) ? drives : []).filter(isEligible);
}

// A compact, human descriptor for the confirm dialog: "SanDisk Ultra — 29.7 GB — E:".
function humanLabel(d) {
  const gb = Number(d.size) ? (Number(d.size) / 1e9).toFixed(1) + ' GB' : '?';
  const letter = (Array.isArray(d.mountpoints) && d.mountpoints[0] && (d.mountpoints[0].path || d.mountpoints[0])) || d.device || '';
  return `${(d.description || 'Removable device').trim()} — ${gb}${letter ? ' — ' + String(letter).replace(/[\\/]+$/, '') : ''}`;
}

module.exports = { isEligible, assertStillEligible, eligibleDrives, humanLabel, MIN_SD_BYTES, MAX_SD_BYTES };
