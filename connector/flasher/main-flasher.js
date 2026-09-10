'use strict';
/*
 * flasher/main-flasher.js — the Electron MAIN-process side of the SD-card flasher. Registers IPC handlers the
 * preload bridge exposes. Runs UNELEVATED: it enumerates drives + applies the safety filter + renders the
 * dry-run, and only spawns the elevated flasher/writer.js (single UAC) when the VA confirms a flash.
 *
 * Wire from electron-main.js in FLASHER_MODE:  require('./flasher/main-flasher').register(win)
 */
const { ipcMain, dialog } = require('electron');
const { execFileSync, spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const safety = require('./safety');
const inject = require('./inject');
const hub = require('./hub');
const { sha512crypt } = require('./sha512crypt');

const CLAIM_URL = process.env.AUTOPOST_CLAIM_URL || 'https://marketplaceautopost.com/claim';

// Which Pi model the picker starts on. The fleet ships original Zero W hardware, so that is the default; a shop
// standardising on Pi 4 / Zero 2 W sets AUTOPOST_PI_MODEL=pi4 in START-HERE.cmd rather than retraining the VA to
// change the dropdown on every card (the #1 way a batch gets written with the wrong-architecture image).
const DEFAULT_PI_MODEL = (process.env.AUTOPOST_PI_MODEL || 'zerow').toLowerCase();

// Are we ALREADY running as Administrator? START-HERE.cmd elevates itself before launching the app, so normally yes.
// It matters because the elevated writer can then be spawned DIRECTLY (plain child_process) instead of through
// sudo-prompt: no UAC dialog, and — the reason this exists — several writers can run AT THE SAME TIME. sudo-prompt
// pops one consent dialog per invocation, which makes concurrent flashing unusable. Read-only check, cached.
let _elevated = null;
function isElevated() {
  if (_elevated !== null) return _elevated;
  if (process.platform !== 'win32') { _elevated = (typeof process.getuid === 'function' && process.getuid() === 0); return _elevated; }
  // High (S-1-16-12288) or System (S-1-16-16384) integrity level == elevated. Called by ABSOLUTE path: a machine
  // with Git-Bash/MSYS ahead of System32 on PATH resolves a coreutils `whoami` that rejects /groups outright.
  const sysWhoami = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'whoami.exe');
  for (const bin of [sysWhoami, 'whoami']) {
    try {
      const out = execFileSync(bin, ['/groups'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
      if (/S-1-16-(12288|16384)/.test(out)) { _elevated = true; return _elevated; }
      if (/S-1-16-8192/.test(out)) { _elevated = false; return _elevated; } // Medium == definitely NOT elevated
    } catch (_) { /* try the next probe */ }
  }
  // Fallback 1: `net session` needs admin — but it also fails when the Server service is stopped (common on Home),
  // so a failure here is not conclusive on its own.
  try { execFileSync('net', ['session'], { stdio: 'ignore', timeout: 8000, windowsHide: true }); _elevated = true; return _elevated; }
  catch (_) { /* inconclusive — fall through */ }
  // Fallback 2 (definitive): opening a raw physical disk handle requires Administrator. Read-only, opens nothing
  // else, changes nothing — and it tests the exact privilege the writer actually needs.
  try { const fd = fs.openSync('\\\\.\\PhysicalDrive0', 'r'); fs.closeSync(fd); _elevated = true; }
  catch (_) { _elevated = false; }
  return _elevated;
}

// Locate an openssl to make the Pi login password (Electron's PATH may not include git-bash's bin).
function resolveOpenssl() {
  const cands = [
    process.env.OPENSSL,
    'openssl', // PATH (works if git/openssl is on it)
    'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
    'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe',
    'C:\\Program Files (x86)\\Git\\usr\\bin\\openssl.exe',
    'C:\\Program Files (x86)\\Git\\mingw64\\bin\\openssl.exe',
  ].filter(Boolean);
  for (const c of cands) {
    try { execFileSync(c, ['version'], { stdio: 'ignore', timeout: 5000 }); return c; } catch (_) { /* try next */ }
  }
  return null;
}

// SHA-512 crypt ($6$) for /boot/firmware/userconf.txt + `chpasswd -e`. The plaintext NEVER reaches a command line
// and is NEVER written to the card — only the hash is.
//
// Hashed IN-PROCESS by flasher/sha512crypt.js. This used to shell out to `openssl passwd -6`, which is a trap on
// Windows: openssl is not part of Windows, so it was only ever found because the dev machine happened to have Git
// for Windows installed. On a clean PC the lookup failed, this returned null, and the card was written with NO
// console password while the UI still said "fleet password applied" — discovered only when someone is at a
// dealership unable to log in. The pure-JS path has no such dependency and is verified against glibc's crypt(3)
// in _test/sha512crypt.test.js.
//
// openssl is still tried FIRST when present, purely so behaviour on machines that have it is bit-identical to
// what shipped before; the two agree byte-for-byte (also asserted in that test), so this is belt-and-braces.
function hashUnixPassword(plain) {
  if (!plain) return null;
  const ossl = resolveOpenssl();
  if (ossl) {
    for (const algo of ['-6', '-5']) {
      try {
        const out = execFileSync(ossl, ['passwd', algo, '-stdin'], { input: String(plain), encoding: 'utf8', timeout: 8000 }).trim();
        if (/^\$(6|5)\$/.test(out)) return out;
      } catch (_) { /* try next algo, then fall through to the built-in */ }
    }
  }
  try { return sha512crypt(String(plain)); } catch (_) { return null; }
}

// Pi hardware models the flasher knows how to write. Each has its OWN golden image — they are NOT interchangeable:
// the "pi4" image is 64-bit (arm64, Pi 4 / Zero 2 W and newer); "zerow" is 32-bit/ARMv6, built specifically because
// the original Pi Zero W's CPU cannot execute 64-bit code at all (see deploy/pi/golden/customize-stock-image.sh).
const PI_MODELS = {
  pi4: { label: 'Raspberry Pi 4 / Zero 2 W', filename: 'autopost-golden.img.xz', envOverride: 'AUTOPOST_PI_IMAGE_PI4' },
  zerow: { label: 'Raspberry Pi Zero W (original, 32-bit)', filename: 'autopost-golden-zerow.img.xz', envOverride: 'AUTOPOST_PI_IMAGE_ZEROW' },
};
function modelOf(piModel) { return PI_MODELS[piModel] || PI_MODELS[DEFAULT_PI_MODEL] || PI_MODELS.pi4; }

// Where the packaged app looks for a golden image, in order:
//   1. AUTOPOST_PI_IMAGE — explicit override, wins for ANY model (testing a specific file).
//   2. the per-model env var (AUTOPOST_PI_IMAGE_PI4 / AUTOPOST_PI_IMAGE_ZEROW) — how the shipped
//      START-HERE.cmd points at the two images bundled next to the app, one per model.
//   3. sibling of the packaged exe (".. / <filename>" and ".. / images / <filename>") — so a portable copy of
//      the "AutoPost-Pi-Setup" folder works with zero configuration as long as the images sit next to it.
//   4. the dev-time default under %LOCALAPPDATA%\AutoPost\images (matches the golden-image build notes).
function defaultImagePath(piModel) {
  if (process.env.AUTOPOST_PI_IMAGE) return process.env.AUTOPOST_PI_IMAGE;
  const model = modelOf(piModel);
  if (process.env[model.envOverride]) return process.env[model.envOverride];
  const exeDir = path.dirname(process.execPath); // packaged: .../AutoPost-Pi-Setup/app/AutoPost Pi Setup.exe
  const siblingCandidates = [
    path.join(exeDir, '..', model.filename),
    path.join(exeDir, '..', 'images', model.filename),
  ];
  for (const c of siblingCandidates) { try { if (fs.existsSync(c)) return c; } catch (_) { /* try next */ } }
  const dir = path.join(os.homedir(), 'AppData', 'Local', 'AutoPost', 'images');
  return path.join(dir, model.filename);
}

// A REAL ship must use a provisioned GOLDEN image (any model). Bare stock has no connector, no autopost user, no
// claim service, and no AUTOPOST-DATA partition — a card flashed from it joins WiFi but NEVER claims, so it is
// invisible to the hub with no remote management and no WiFi recovery, while the flasher would otherwise report
// full success (read-back verify only checks the FAT injections, which land identically on stock). Refuse it unless
// the operator explicitly overrode the image (AUTOPOST_PI_IMAGE) or opted into stock for testing (AUTOPOST_ALLOW_STOCK=1).
function imageIsShippable(imagePath) {
  if (process.env.AUTOPOST_PI_IMAGE) return true;
  if (process.env.AUTOPOST_ALLOW_STOCK === '1') return true;
  return /autopost-golden(-[a-z0-9]+)?\.img\.xz$/i.test(String(imagePath || ''));
}

// For the UI's model picker: does the resolved image for this model actually exist on disk yet?
function resolveImage(piModel) {
  const model = modelOf(piModel);
  const imagePath = defaultImagePath(piModel);
  let exists = false;
  try { exists = fs.existsSync(imagePath); } catch (_) { /* treat as missing */ }
  return { label: model.label, imagePath, exists };
}

// UNELEVATED drive scan -> only the cards the VA may pick. drivelist is native + lazy-required so the pure
// modules (safety/inject) stay testable without it.
async function scanDrives() {
  let drivelist;
  try { drivelist = require('drivelist'); } catch (e) { return { ok: false, reason: 'drivelist not installed (run npm install + electron-rebuild)', drives: [] }; }
  let rows;
  try { rows = await drivelist.list(); } catch (e) { return { ok: false, reason: 'drive scan failed: ' + e.message, drives: [] }; }
  const eligible = safety.eligibleDrives(rows).map((d) => ({
    raw: d.raw, size: d.size, description: d.description,
    isRemovable: d.isRemovable, isCard: d.isCard, isUSB: d.isUSB, isSystem: d.isSystem,
    mountpoints: (d.mountpoints || []).map((m) => m.path || m),
    label: safety.humanLabel(d),
  }));
  return { ok: true, drives: eligible, scanned: rows.length };
}

// Build a plan object from the renderer's form. Never trust the renderer's target blindly — we re-derive it
// from a fresh scan by raw path so a stale/forged descriptor can't slip a wrong drive through.
function buildPlan(form) {
  // CAPTURE-ON-BOOT: ship the card with NO WiFi at all, so the Pi raises its "AutoPost-Setup" AP the moment it
  // boots and takes credentials from whoever is on site. For a dealership whose network we cannot know ahead of
  // time. The BENCH network is withheld too -- adding it would give the box a profile to chase, which is exactly
  // the wait this mode exists to remove. The cost is that such a card cannot claim on the bench, so _confirm()
  // states that plainly rather than letting it look like an ordinary card.
  const captureWifiOnBoot = !!(form && form.noWifi);
  // WIRED MODE. The card takes its uplink from a USB-ethernet adapter on the Pi's USB DATA port instead of WiFi,
  // so it carries no WiFi profiles at all - not even the bench network. A wired box cannot be given the wrong
  // WiFi password, which removes the entire class of failure the rescue system exists for; WiFi stays available
  // as a RESCUE if the wired link is dead. AUTOPOST_NETWORK_MODE=wired makes it the fleet default.
  const networkMode = inject.normalizeNetworkMode(
    (form && form.networkMode) || process.env.AUTOPOST_NETWORK_MODE || 'wifi');
  const wired = networkMode === 'wired';
  const networks = [];
  if (!captureWifiOnBoot && !wired) {
    if (form.primary && form.primary.ssid) networks.push(form.primary);
    if (form.backup && form.backup.ssid) networks.push(form.backup);
  // BENCH network (AUTOPOST_BENCH_SSID / AUTOPOST_BENCH_PASS, normally set in START-HERE.cmd). Appended as the
  // LOWEST-priority network so every unit can join the workshop WiFi and actually CLAIM before it ships - that
  // is the only bench check that proves the whole chain (WiFi -> hub -> Tailscale) rather than just the files on
  // the card. At the dealership the primary always wins on autoconnect-priority, so this never displaces it.
  // Skipped if it duplicates an SSID the operator already typed.
    const benchSsid = String(process.env.AUTOPOST_BENCH_SSID || '').trim();
    if (benchSsid && !networks.some((n) => n.ssid === benchSsid)) {
      networks.push({ ssid: benchSsid, pass: process.env.AUTOPOST_BENCH_PASS || '', bench: true });
    }
  }
  // Per-device identity used for BOTH the OS hostname and the Tailscale node name (autopost-<dealership>).
  const host = 'autopost-' + (inject.slug(form.dealership) || 'pilot');
  return {
    dealership: form.dealership || null,
    claimUrl: CLAIM_URL,
    // Normalize to the exact token the /claim endpoint expects (uppercase, strip the display dash/spaces, map
    // Crockford lookalikes) so a code pasted as "QB1C-1YVD" redeems the same as "QB1C1YVD". Otherwise claim.js
    // would send the dashed form and the hub could reject it.
    claimCode: hub.normalizeCode(form.claimCode),
    networks,
    captureWifiOnBoot,
    country: form.country || 'US',
    tz: form.tz || 'America/New_York',
    // Sanitize to a valid Linux username so userconfTxt/firstrun can never throw on a stray-typed value (uppercase,
    // spaces, a leading digit). Defaults to 'admin' — what the VA guide says to leave it as.
    piUser: (() => { const u = String(form.piUser || 'admin').toLowerCase().replace(/[^a-z0-9-]/g, '').replace(/^[^a-z]+/, ''); return (u || 'admin').slice(0, 32); })(),
    // pre-hash here (unelevated main process, openssl available); plaintext never enters the plan/plan.json.
    // Falls back to the FLEET password (AUTOPOST_PI_PASS, set in START-HERE.cmd) so every card gets the same
    // strong console/SSH login with nothing to type per unit. A typed value still wins, for one-off cards.
    piPassHash: hashUnixPassword(form.piPass || process.env.AUTOPOST_PI_PASS || ''),
    hostname: host,
    // UNATTENDED SSH recall: a reusable, tagged Tailscale key (fleet-wide) injected so the box self-joins on first
    // boot with no commands. Extract just the tskey- token, so a value that arrived with stray newlines/whitespace
    // (e.g. a launcher whose `set /p` over-read past line 1 of an LF-terminated key file) still yields a clean
    // single token — never a multi-line string. Falls back to the first whitespace-delimited token.
    tsAuthKey: (() => { const v = String(form.tsAuthKey || process.env.AUTOPOST_TS_AUTHKEY || ''); return (v.match(/tskey-\S+/) || v.match(/\S+/) || [''])[0]; })(),
    tsHostname: host,
    piModel: form.piModel || DEFAULT_PI_MODEL,
    networkMode,
    // USB gadget SSH — the card comes up as a USB Ethernet adapter at inject.USB.PI_IP with sshd on, so a change
    // can be tested over the cable instead of costing a 45-minute reflash. ON unless the form turns it off or the
    // fleet-wide kill switch (AUTOPOST_USB_GADGET=0) is set.
    // Wired mode FORCES it off: the gadget and the wired uplink are two uses of one physical port, and the
    // gadget's dr_mode=peripheral is exactly what would leave the adapter unpowered.
    usbGadget: wired ? false : (process.env.AUTOPOST_USB_GADGET === '0' ? false : form.usbGadget !== false),
    // Optional: an OpenSSH public key authorized for the uid-1000 account, so USB SSH works with no password at
    // all. Single line, and only a real key type — a pasted PRIVATE key or a stray blob is dropped, never written.
    devSshPubKey: (() => {
      const v = String(form.devSshPubKey || process.env.AUTOPOST_DEV_SSH_PUBKEY || '').replace(/[\r\n]+/g, ' ').trim();
      return /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp\d+|sk-(ssh-ed25519|ecdsa-sha2-nistp\d+)@openssh\.com)\s+\S+/.test(v) ? v : '';
    })(),
    imagePath: form.imagePath || defaultImagePath(form.piModel || DEFAULT_PI_MODEL),
    target: form.target || null, // { raw, size, ... } as picked
    // Opaque lane id from the renderer. Echoed on every progress event so N simultaneous writes can be told apart;
    // without it a 4-card batch would drive all four progress bars from whichever writer emitted last.
    jobId: String(form.jobId || '') || null,
  };
}

// DRY-RUN: render EXACTLY the files that would be written, plus the selected drive — write NOTHING. This is the
// operator's "see it working" demo: no hardware, no native modules needed (just the pure inject.js).
function dryRun(form) {
  try {
    const plan = buildPlan(form);
    if (!plan.claimCode) return { ok: false, reason: 'no claim code (mint one or paste from the Ship-a-Pi page)' };
    if (!plan.networks.length && !plan.captureWifiOnBoot && plan.networkMode !== 'wired') return { ok: false, reason: 'enter at least the primary WiFi (SSID + password), or tick "No WiFi yet"' };
    const files = inject.bootFilesFor(plan).map((f) => ({ path: f.path, content: f.content }));
    files.push({ path: 'cmdline.txt (appended hook)', content: '… ' + inject.HOOK });
    // Show the USB-SSH result as its own panel: the point of the dry run is that the operator can SEE what the card
    // will do, and "how do I actually reach this Pi" is the question the testing loop turns on.
    let usbNote = null;
    if (plan.networkMode === 'wired') {
      // The wired card's equivalent panel. Same question the USB note answers - "how do I actually reach this
      // Pi" - with the same address, because the service address is deliberately unchanged.
      files.push({ path: 'config.txt (wired — dwc2 overlay REMOVED)', content: '(no dtoverlay=dwc2: the USB DATA port stays in HOST mode so it can power a USB-ethernet adapter)' });
      const authW = plan.devSshPubKey ? 'SSH key' : (plan.piPassHash ? 'the Pi login password' : null);
      usbNote = {
        wired: true,
        piIp: inject.ETH.SVC_IP, pcIp: inject.USB.PC_IP, user: plan.piUser,
        ssh: `ssh ${plan.piUser}@${inject.ETH.SVC_IP}`,
        auth: authW,
        warning: authW ? null : 'This card has NO password and NO SSH key — you would reach sshd over the wire and be unable to log in. Set a Pi login password (step 2) or paste a public key.',
      };
    } else if (plan.usbGadget) {
      files.push({
        path: 'cmdline.txt (appended — USB gadget)', content: '… ' + inject.USB_CMDLINE,
      });
      files.push({
        path: 'config.txt (appended — USB gadget)', content: '[all]\n' + inject.USB_DTOVERLAY,
      });
      const auth = plan.devSshPubKey ? 'SSH key' : (plan.piPassHash ? 'the Pi login password' : null);
      usbNote = {
        piIp: inject.USB.PI_IP, pcIp: inject.USB.PC_IP, user: plan.piUser,
        ssh: `ssh ${plan.piUser}@${inject.USB.PI_IP}`,
        auth,
        // A card with USB SSH on but NO credential is the one failure that looks fine here and wastes a whole
        // flash cycle: the link comes up, sshd answers, and there is nothing to log in with.
        warning: auth ? null : 'USB SSH is ON but this card has NO password and NO SSH key — you would reach sshd and be unable to log in. Set a Pi login password (step 2) or paste a public key.',
      };
    }
    return { ok: true, target: plan.target, imagePath: plan.imagePath, imageIsGolden: imageIsShippable(plan.imagePath), files, usb: usbNote };
  } catch (e) { return { ok: false, reason: e.message }; }
}

// ---------------------------------------------------------------------------------------------------------------
// BATCH FLASHING
//
// Cards write CONCURRENTLY, one elevated writer process per card. Two things make that safe:
//   * activeTargets — a raw device path may only be claimed by one running job. Two writers pointed at the same
//     PhysicalDrive would interleave raw sectors and silently produce two corrupt cards that both report success.
//   * confirmTokens — ONE native "erase these N cards" dialog covers the whole batch. Per-job dialogs would queue up
//     as N modals on the same window, which is unusable, and worse, trains the operator to click through them.
// A token is minted only by a real dialog acceptance, is single-use PER RAW PATH, and expires — so it can authorise
// exactly the cards the operator actually saw listed, once each, and never a card swapped in afterwards.
// ---------------------------------------------------------------------------------------------------------------
const activeTargets = new Map();          // raw -> jobId currently writing it
const confirmTokens = new Map();          // token -> { raws:Set<string>, expires:number }
const CONFIRM_TTL_MS = 10 * 60 * 1000;    // long enough to write a batch, short enough that a stale token is useless

function sweepTokens() {
  const now = Date.now();
  for (const [t, v] of confirmTokens) if (v.expires <= now || !v.raws.size) confirmTokens.delete(t);
}

// ONE dialog for the whole batch. Returns a token the individual flash() calls present instead of each popping
// their own modal. Cancelling mints nothing, so nothing can be written.
async function confirmBatch(win, targets) {
  sweepTokens();
  const list = (Array.isArray(targets) ? targets : []).filter((t) => t && t.raw);
  if (!list.length) return { ok: false, reason: 'no cards selected' };
  // Re-derive every target from a FRESH scan, and show the operator the drive as the OS describes it right now —
  // never the renderer's copy, which could be stale (card pulled) or tampered with.
  const scan = await scanDrives();
  const fresh = [];
  for (const t of list) {
    const d = (scan.drives || []).find((x) => x.raw === t.raw);
    if (!d) return { ok: false, reason: 'card no longer present: ' + (t.label || t.raw) + ' — re-scan and pick again' };
    fresh.push(d);
  }
  const n = fresh.length;
  // Cards flashed with no WiFi behave differently once they leave the bench: they cannot claim here, and on site
  // they sit on their own AP until someone hands them a network. Say so on the one screen the operator certainly
  // reads, so it is a deliberate choice rather than a surprise a week later.
  // A WIRED card has the same "will not claim here" property, for a different reason: it has no WiFi to claim
  // over, so the bench needs a live ethernet drop and an adapter in the Pi's USB port. Silence here would let an
  // operator watch a perfectly good card sit unclaimed and conclude it was faulty.
  // Derived from the batch the operator actually selected. This used to read a `form` variable that does not
  // exist in this function - confirmBatch receives (win, targets), never the renderer's form - so every batch
  // threw ReferenceError here, at the confirm dialog, before a single card was written.
  const wiredCount = list.filter((t) => inject.normalizeNetworkMode(
    t.networkMode || process.env.AUTOPOST_NETWORK_MODE) === 'wired').length;
  const wiredSubject = wiredCount === n
    ? (n > 1 ? 'These cards are' : 'This card is')
    : `${wiredCount} of these cards are`;
  const wiredNote = wiredCount
    ? `\n\n${wiredSubject} WIRED: no WiFi is written at all. To claim on the bench, plug a USB-ethernet adapter `
      + "into the Pi's USB port (the one marked USB, not PWR IN) and give it a live drop - the bench WiFi will not "
      + 'be used. For service, run a cable from that adapter to a laptop and reach the Pi at 10.55.0.1.'
    : '';
  const bare = list.filter((t) => t && t.noWifi).length;
  const bareNote = bare
    ? `\n\n${bare} of these card${bare > 1 ? 's are' : ' is'} set to CAPTURE WIFI ON FIRST BOOT: no network is `
      + `written, so ${bare > 1 ? 'they' : 'it'} cannot claim on the bench and VERIFY-PI will not see `
      + `${bare > 1 ? 'them' : 'it'}. On site the Pi raises its own "AutoPost-Setup" WiFi about a minute after `
      + `power-on - join that and enter the dealership's network to finish setup.`
    : '';
  const lines = fresh.map((d, i) => `  ${i + 1}. ${d.label || d.description || d.raw}`).join('\n');
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning', buttons: ['Cancel', `ERASE + FLASH ${n} card${n > 1 ? 's' : ''}`], defaultId: 0, cancelId: 0,
    title: n > 1 ? `Erase these ${n} cards?` : 'Erase this card?',
    message: `This will PERMANENTLY ERASE ${n > 1 ? `all ${n} of these cards` : 'this card'}:\n\n${lines}\n\n`
      + `and write the AutoPost golden image, this dealership's WiFi, and each card's own setup code. This cannot be undone.`
      + bareNote + wiredNote,
  });
  if (response !== 1) return { ok: false, reason: 'cancelled' };
  const token = crypto.randomBytes(18).toString('hex');
  confirmTokens.set(token, { raws: new Set(fresh.map((d) => d.raw)), expires: Date.now() + CONFIRM_TTL_MS });
  return { ok: true, token, count: n };
}

// Redeem a batch token for ONE raw path. Single-use: the path is struck off, so a token can never authorise a
// second write to the same slot (e.g. the operator hot-swaps a card mid-batch and a stale lane re-fires).
function consumeConfirm(token, raw) {
  sweepTokens();
  const rec = token ? confirmTokens.get(token) : null;
  if (!rec) return false;
  if (!rec.raws.delete(raw)) return false;
  if (!rec.raws.size) confirmTokens.delete(token);
  return true;
}

// FLASH: validate -> confirm -> spawn the elevated writer -> stream progress to the renderer.
async function flash(win, form) {
  const plan = buildPlan(form);
  const jobId = plan.jobId;
  if (!plan.claimCode) return { ok: false, reason: 'no claim code' };
  if (!plan.networks.length && !plan.captureWifiOnBoot && plan.networkMode !== 'wired') return { ok: false, reason: 'no WiFi network' };
  if (!plan.target || !plan.target.raw) return { ok: false, reason: 'pick the SD card first' };
  if (activeTargets.has(plan.target.raw)) return { ok: false, reason: 'this card is already being written by another lane' };
  if (!fs.existsSync(plan.imagePath)) return { ok: false, reason: 'Pi image not found at ' + plan.imagePath };
  if (!imageIsShippable(plan.imagePath)) return { ok: false, reason: 'Golden image not found (autopost-golden.img.xz) — a card flashed from bare stock never claims and stays invisible to the hub. Build/download the golden image first, or set AUTOPOST_ALLOW_STOCK=1 to override for testing.' };
  if (imageIsShippable(plan.imagePath) && !plan.tsAuthKey && process.env.AUTOPOST_ALLOW_NO_TAILSCALE !== '1') return { ok: false, reason: 'No Tailscale auth key — the box would ship with no remote SSH recall path (you could never reach it off-LAN to fix or update it). Set AUTOPOST_TS_AUTHKEY to a reusable, tagged Tailscale key (or enter one in the form), or set AUTOPOST_ALLOW_NO_TAILSCALE=1 to override for testing.' };

  // Re-scan and re-confirm the target is STILL an eligible removable card, and it matches what the VA picked.
  const scan = await scanDrives();
  const fresh = (scan.drives || []).find((d) => d.raw === plan.target.raw);
  const chk = safety.assertStillEligible(fresh, plan.target);
  if (!chk.ok) return { ok: false, reason: 'safety re-check failed: ' + chk.reason + ' — re-insert the card and pick it again' };

  // CONFIRMATION. Normally the renderer has already shown ONE batch dialog and hands us its token; we redeem the
  // operator's consent for this exact card. Without a token (single-card path, or a token that expired mid-batch)
  // fall back to the original per-card modal so a write can NEVER happen without an explicit, card-specific OK.
  const imgName = path.basename(plan.imagePath);
  const imgKind = imageIsShippable(plan.imagePath) ? `AutoPost GOLDEN image (${modelOf(plan.piModel).label})` : ('image ' + imgName + ' (NOT the golden — override)');
  if (!consumeConfirm(form.confirmToken, fresh.raw)) {
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning', buttons: ['Cancel', 'ERASE + FLASH'], defaultId: 0, cancelId: 0,
      title: 'Erase this card?',
      message: `This will PERMANENTLY ERASE:\n\n${fresh.label}\n\nand write the ${imgKind} + this dealership's WiFi and setup code. This cannot be undone.`,
    });
    if (response !== 1) return { ok: false, reason: 'cancelled' };
  }

  // Claim the device for the duration of the write, so a second lane cannot be pointed at the same card.
  if (activeTargets.has(fresh.raw)) return { ok: false, reason: 'this card is already being written by another lane' };
  activeTargets.set(fresh.raw, jobId || true);

  // Write plan + progress file to a private temp dir (secrets never touch a visible command line). Guarded so a
  // disk-full/permission failure here releases the device claim instead of wedging that lane for the session.
  let tmp; let planFile; let progFile;
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autopost-flash-'));
    planFile = path.join(tmp, 'plan.json');
    progFile = path.join(tmp, 'progress.jsonl');
    fs.writeFileSync(planFile, JSON.stringify({ ...plan, target: fresh }), { mode: 0o600 });
    fs.writeFileSync(progFile, '');
  } catch (e) {
    activeTargets.delete(fresh.raw);
    try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    return { ok: false, reason: 'could not stage the flash plan: ' + e.message };
  }

  // Tail the progress file and relay each new JSON line to the renderer, STAMPED WITH THIS JOB'S ID so the UI can
  // route it to the right lane (sudo-prompt can't stream stdout, so the file is the transport for both paths).
  let offset = 0;
  const relay = (line) => {
    try {
      const msg = JSON.parse(line);
      msg.jobId = jobId;
      if (!win.isDestroyed()) win.webContents.send('flasher:progress', msg);
    } catch (_) { /* not a JSON line */ }
  };
  const drain = () => {
    try {
      const buf = fs.readFileSync(progFile, 'utf8');
      if (buf.length > offset) { buf.slice(offset).split('\n').filter(Boolean).forEach(relay); offset = buf.length; }
    } catch (_) { /* file gone */ }
  };
  const tail = setInterval(drain, 400);

  const nodeBin = process.execPath; // in a packaged app this is the Electron exe; ELECTRON_RUN_AS_NODE makes it run writer.js as plain node
  const writer = path.join(__dirname, 'writer.js');

  const finish = (result) => {
    clearInterval(tail);
    drain(); // final drain so the last stage/error line always reaches the UI
    activeTargets.delete(fresh.raw);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    return result;
  };
  const lastResult = () => {
    try {
      return fs.readFileSync(progFile, 'utf8').trim().split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch (_) { return null; } })
        .filter(Boolean).reverse().find((o) => o.type === 'done' || o.type === 'error') || null;
    } catch (_) { return null; }
  };

  // ELEVATED ALREADY (the normal case — START-HERE.cmd runs the app as Administrator): spawn the writer directly.
  // No UAC dialog, and crucially this is what lets several cards write AT ONCE — sudo-prompt serialises behind a
  // consent prompt per call, so a 4-card batch under it would mean 4 prompts and no real parallelism.
  if (isElevated()) {
    return await new Promise((resolve) => {
      let stderr = '';
      const child = spawn(nodeBin, [writer, planFile, progFile], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        windowsHide: true,
        // stdout is DISCARDED on purpose: the writer emits a JSON line per progress tick to BOTH stdout and the
        // progress file, and the file is our transport. A piped-but-unread stdout would fill the ~64KB OS buffer
        // partway through a write and block the writer forever — a hang with the bar frozen mid-flash. stderr stays
        // piped because we surface it on failure, and it IS consumed below, so it cannot block either.
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      if (child.stderr) child.stderr.on('data', (d) => { if (stderr.length < 2000) stderr += d.toString(); });
      child.on('error', (e) => resolve(finish({ ok: false, reason: 'could not start the writer: ' + e.message })));
      child.on('close', (code) => {
        const done = lastResult();
        if (done && done.type === 'error') return resolve(finish({ ok: false, reason: done.reason }));
        if (done && done.type === 'done') return resolve(finish({ ok: true, bootDir: done.bootDir }));
        return resolve(finish({ ok: false, reason: 'writer exited ' + code + ' without a result' + (stderr ? ' | ' + stderr.slice(0, 200) : '') }));
      });
    });
  }

  // NOT elevated (app launched directly instead of through START-HERE.cmd): fall back to one UAC per card.
  let sudo;
  try { sudo = require('@vscode/sudo-prompt'); } catch (e) { return finish({ ok: false, reason: '@vscode/sudo-prompt not installed' }); }
  const cmd = `"${nodeBin}" "${writer}" "${planFile}" "${progFile}"`;
  return await new Promise((resolve) => {
    sudo.exec(cmd, { name: 'AutoPost Flasher', env: { ELECTRON_RUN_AS_NODE: '1' } }, (err, stdout, stderr) => {
      const done = lastResult();
      if (err && !done) return resolve(finish({ ok: false, reason: 'flash failed: ' + (err.message || err) + (stderr ? ' | ' + String(stderr).slice(0, 200) : '') }));
      if (done && done.type === 'error') return resolve(finish({ ok: false, reason: done.reason }));
      if (done && done.type === 'done') return resolve(finish({ ok: true, bootDir: done.bootDir }));
      return resolve(finish({ ok: false, reason: 'flash ended without a clear result' }));
    });
  });
}

// Read the injected files back off the card (the VERIFY panel — proves what is physically on the card).
function verifyCard(bootDir) {
  // Mount-free flow: there is no drive letter to read back from — rpi-imager injected during the write and the
  // elevated writer already confirmed the customisation from rpi-imager's log. Report success without a re-read.
  if (!bootDir) return { ok: true, files: {}, note: 'customisation verified during the write (no drive letter needed)' };
  try {
    const out = {};
    for (const name of ['autopost-claim.env', 'autopost-tailscale.env', 'firstrun.sh', 'userconf.txt', 'cmdline.txt']) {
      const p = path.join(bootDir, name);
      out[name] = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '(not present)';
    }
    return { ok: true, files: out };
  } catch (e) { return { ok: false, reason: e.message }; }
}

// Fleet-wide defaults set in START-HERE.cmd, surfaced to the renderer so the UI can tell the operator what is
// ALREADY being applied to every card. Without this the form shows a red "no SSH key" warning on a card that is
// in fact getting the fleet key from the environment — a false alarm that trains people to ignore the warning.
// Only the PUBLIC key and the bench SSID are exposed; the bench password never leaves the main process.
function fleetDefaults() {
  const key = String(process.env.AUTOPOST_DEV_SSH_PUBKEY || '').replace(/[\r\n]+/g, ' ').trim();
  const valid = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp\d+|sk-(ssh-ed25519|ecdsa-sha2-nistp\d+)@openssh\.com)\s+\S+/.test(key);
  // Report only WHETHER a fleet password exists, never the value — the renderer has no business holding it.
  const pass = String(process.env.AUTOPOST_PI_PASS || '');
  return {
    hasFleetKey: valid,
    fleetKeyLabel: valid ? (key.split(/\s+/)[2] || key.split(/\s+/)[0]) : '',
    // The full PUBLIC key, so the form can show it already filled in and the operator never types or pastes one.
    // Safe to hand the renderer: a public key is not a secret. The fleet PASSWORD deliberately stays behind
    // hasFleetPass — it IS a secret, and the renderer has no need for its value to render a filled-looking field.
    fleetKey: valid ? key : '',
    hasFleetPass: pass.length > 0,
    fleetPassWeak: pass.length > 0 && pass.length < 12,
    benchSsid: String(process.env.AUTOPOST_BENCH_SSID || '').trim(),
    usbGadgetForcedOff: process.env.AUTOPOST_USB_GADGET === '0',
    // Fleet-wide default for the network mode, so a shop that has standardised on wired drops does not have to
    // remember to flip it on every card.
    defaultNetworkMode: inject.normalizeNetworkMode(process.env.AUTOPOST_NETWORK_MODE || 'wifi'),
    defaultPiModel: PI_MODELS[DEFAULT_PI_MODEL] ? DEFAULT_PI_MODEL : 'pi4',
    // Concurrency is only real when the app is already Administrator; otherwise every lane costs its own UAC prompt.
    elevated: isElevated(),
  };
}

function register(win) {
  ipcMain.handle('flasher:fleetDefaults', () => fleetDefaults());
  ipcMain.handle('flasher:scanDrives', () => scanDrives());
  ipcMain.handle('flasher:dryRun', (_e, form) => dryRun(form));
  ipcMain.handle('flasher:confirmBatch', (_e, targets) => confirmBatch(win, targets));
  ipcMain.handle('flasher:flash', (_e, form) => flash(win, form));
  ipcMain.handle('flasher:verifyCard', (_e, bootDir) => verifyCard(bootDir));
  ipcMain.handle('flasher:listDealerships', () => hub.listDealerships());
  ipcMain.handle('flasher:mintCode', (_e, dealershipId) => hub.mintCode(dealershipId));
  ipcMain.handle('flasher:resolveImage', (_e, piModel) => resolveImage(piModel));
}

module.exports = {
  register, scanDrives, dryRun, verifyCard, buildPlan, resolveImage, defaultImagePath, imageIsShippable,
  PI_MODELS, DEFAULT_PI_MODEL, fleetDefaults,
  // exported for the batch-safety tests
  _confirm: { confirmTokens, consumeConfirm, activeTargets, CONFIRM_TTL_MS },
};
