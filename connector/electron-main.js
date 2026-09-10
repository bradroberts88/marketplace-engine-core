'use strict';
/*
 * Dealership Connector — desktop app shell (Electron).
 *
 * A REAL standalone Windows application (its own window + a system-tray icon), NOT a browser tab. It runs the
 * connector in the background as a child process and shows the status dashboard in a native window. Closing the
 * window minimizes to the tray (it keeps running); Quit (from the tray) actually exits. Auto-starts at login.
 *
 * If config.json exists it runs the real connector agent (src/agent.js); otherwise it runs the preview
 * (preview-ui.js) so the app still shows a working dashboard out of the box.
 */
const { app, BrowserWindow, Tray, Menu, nativeImage, session, powerSaveBlocker, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = __dirname;
const DASH_PORT = 4599;
const HAS_CONFIG = fs.existsSync(path.join(ROOT, 'config.json'));

// FLASHER MODE — a completely separate product: the VA card-writer (flasher/). It does NOT start the connector,
// has no tray, no localhost dashboard, and talks to main over IPC (the raw-disk writer must never be one HTTP
// call away). Shipped as its own electron-builder target so the disk writer isn't on 1,000 dealership PCs.
// FLASHER MODE — the VA card-writer product (flasher/). Triggered by env/arg in dev, or by a build marker
// (extraMetadata.flasherBuild:true, injected by electron-builder-flasher.json) in the packaged VA .exe.
const FLASHER_MODE = !!process.env.FLASHER_MODE
  || process.argv.includes('--flasher')
  || (() => { try { return require('./package.json').flasherBuild === true; } catch (_) { return false; } })();

// Identify as "AutoPost" (window title, taskbar, Alt+Tab) instead of Electron's default — in dev AND packaged.
// setName must run before the app is ready; the AppUserModelId gives Windows the correct taskbar identity/grouping.
app.setName('AutoPost');
if (process.platform === 'win32') app.setAppUserModelId('com.quantumconnect.autopost');

let creds = { user: 'manager', pass: 'preview' };
if (HAS_CONFIG) {
  try { const c = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')); if (c.dashboard && c.dashboard.user) creds = { user: c.dashboard.user, pass: c.dashboard.pass }; } catch (_) { /* keep defaults */ }
}

let child = null; let win = null; let tray = null; let quitting = false;
const log = (...a) => console.log(new Date().toISOString(), '[app]', ...a);

// --- always-on state: the ONE permitted user-stop (disabled flag, shared with the supervisor) + keep-awake ---
const RUNTIME_DIR = path.join(process.env.LOCALAPPDATA || process.env.APPDATA || ROOT, 'AutoPost');
const DISABLED_FLAG = path.join(RUNTIME_DIR, 'disabled.flag'); // keep-alive.ps1 honors this too
function isDisabled() { try { return fs.existsSync(DISABLED_FLAG); } catch (_) { return false; } }
function setDisabledFlag(on) {
  try { fs.mkdirSync(RUNTIME_DIR, { recursive: true }); if (on) fs.writeFileSync(DISABLED_FLAG, new Date().toISOString()); else if (fs.existsSync(DISABLED_FLAG)) fs.unlinkSync(DISABLED_FLAG); } catch (_) { /* best effort */ }
}
let enabled = !isDisabled();
let powerBlockerId = null;
function keepAwake(on) {
  try {
    if (on && powerBlockerId === null) powerBlockerId = powerSaveBlocker.start('prevent-app-suspension'); // stop IDLE sleep only
    else if (!on && powerBlockerId !== null) { powerSaveBlocker.stop(powerBlockerId); powerBlockerId = null; }
  } catch (_) { /* ignore */ }
}

// --- run the connector (or the preview) as a child process, kept alive ---
let quickExits = 0; // consecutive boot-then-die crashes (for auto-rollback after a bad remote update)
function startChild() {
  if (!enabled || child) return; // do not run the tunnel while the user has it turned OFF (or if already running)
  const script = HAS_CONFIG ? path.join(ROOT, 'src', 'agent.js') : path.join(ROOT, 'firstrun-ui.js');
  const startedAt = Date.now();
  child = spawn(process.execPath, [script], { cwd: ROOT, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  child.stdout.on('data', (d) => process.stdout.write('[connector] ' + d));
  child.stderr.on('data', (d) => process.stderr.write('[connector] ' + d));
  child.on('exit', (code) => {
    child = null;
    if (quitting || !enabled) return; // deliberate stop -> stay down; crash/exit otherwise -> self-heal
    const ranMs = Date.now() - startedAt;
    // AUTO-ROLLBACK: onUpdate self-tests a build before swapping, but as a last resort, if a swapped-in build
    // BOOTS then dies within ~12s repeatedly (a post-connect crash the self-test couldn't catch), restore the
    // pre-update agent.js.bak after 3 such quick deaths so the dealership self-recovers with no hands-on visit.
    if (HAS_CONFIG && code !== 0 && ranMs < 12000) {
      quickExits += 1;
      if (quickExits >= 3) {
        const agentPath = path.join(ROOT, 'src', 'agent.js');
        try {
          if (fs.existsSync(agentPath + '.bak')) { fs.copyFileSync(agentPath + '.bak', agentPath); log('connector crash-looped after an update — ROLLED BACK to the previous agent build'); }
          else log('connector crash-looping but there is no agent.js.bak to roll back to');
        } catch (e) { log('rollback failed: ' + e.message); }
        quickExits = 0;
      }
    } else if (ranMs >= 12000) { quickExits = 0; } // ran fine for a while -> not an update crash-loop
    log('connector exited (' + code + ') — restarting in 3s');
    setTimeout(startChild, 3000);
  });
}
function restartChild() { if (child) { try { child.kill(); } catch (_) { /* exit handler respawns */ } } else { startChild(); } }

// First run (no config): the setup screen (firstrun-ui.js) writes config.json when a code is redeemed. Watch for
// it and relaunch into the real connector, so the dealership just types a code and the app configures itself.
function watchForConfig() {
  const cfgFile = path.join(ROOT, 'config.json');
  const timer = setInterval(() => {
    if (fs.existsSync(cfgFile)) { clearInterval(timer); log('setup complete — relaunching into the connector'); try { app.relaunch(); } catch (_) { /* ignore */ } app.exit(0); }
  }, 1500);
}

// --- wait for the local dashboard to answer, then sign in silently ---
function waitForDashboard(cb, tries = 0) {
  const req = http.get({ host: '127.0.0.1', port: DASH_PORT, path: '/', timeout: 1500 }, (res) => { res.resume(); cb(true); });
  const retry = () => { if (tries > 60) return cb(false); setTimeout(() => waitForDashboard(cb, tries + 1), 500); };
  req.on('error', retry);
  req.on('timeout', () => { req.destroy(); retry(); });
}
function autoLogin() {
  return new Promise((resolve) => {
    const body = JSON.stringify({ user: creds.user, pass: creds.pass });
    const req = http.request({ host: '127.0.0.1', port: DASH_PORT, path: '/login', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
      const sc = res.headers['set-cookie']; res.resume();
      const m = sc && sc[0] && /ds=([a-f0-9]+)/.exec(sc[0]);
      if (m) { session.defaultSession.cookies.set({ url: 'http://127.0.0.1:' + DASH_PORT, name: 'ds', value: m[1], httpOnly: true }).then(() => resolve(true)).catch(() => resolve(false)); }
      else resolve(false);
    });
    req.on('error', () => resolve(false));
    req.end(body);
  });
}

// Retry silent login so a transient race with the dashboard coming up never dumps the user on a password screen
// (in the packaged app the human does not know the password — the account manager set it).
async function autoLoginWithRetry(max = 8) {
  for (let i = 0; i < max; i += 1) {
    if (await autoLogin()) return true;
    await new Promise((r) => setTimeout(r, Math.min(1000 * (i + 1), 5000)));
  }
  return false;
}

// --- FLASHER window: local file UI + preload bridge, no connector, no tray ---
function createFlasherWindow() {
  const fwin = new BrowserWindow({
    width: 980, height: 920, minWidth: 760, minHeight: 640,
    title: 'AutoPost — Set up a Pi', backgroundColor: '#0f1330', autoHideMenuBar: true, show: false,
    icon: path.join(ROOT, 'build', 'icon.png'),
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(ROOT, 'flasher', 'preload.js') },
  });
  fwin.removeMenu();
  fwin.loadFile(path.join(ROOT, 'flasher', 'index.html'));
  fwin.once('ready-to-show', () => fwin.show());
  try { require('./flasher/main-flasher').register(fwin); } catch (e) { log('flasher IPC failed to register: ' + e.message); }
  return fwin;
}

// --- native window + tray ---
function createWindow(show) {
  if (win) { if (show) { win.show(); win.focus(); } return; }
  win = new BrowserWindow({
    width: 1180, height: 780, minWidth: 900, minHeight: 600,
    title: 'AutoPost', backgroundColor: '#12162e', autoHideMenuBar: true, show: false,
    icon: path.join(ROOT, 'build', 'icon.png'),
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.removeMenu();
  win.loadURL('http://127.0.0.1:' + DASH_PORT + '/');
  win.once('ready-to-show', () => { if (show) win.show(); });
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win.hide(); } }); // X minimizes to tray
  win.on('closed', () => { win = null; });
}
function trayIconImage() {
  try { const img = nativeImage.createFromPath(path.join(ROOT, 'build', 'icon.png')); return img.isEmpty() ? img : img.resize({ width: 18, height: 18 }); }
  catch (_) { return nativeImage.createEmpty(); }
}
// The ONE permitted user-stop. Turn Off marks disabled (the supervisor honors the flag and stops auto-restarting)
// and stops the tunnel, but keeps the app in the tray so turning it back on is one click. Quit / close never call
// this — they stay "accidental" and are auto-restarted, per the never-drop goal.
function turnOff() {
  enabled = false; setDisabledFlag(true); keepAwake(false);
  if (child) { try { child.kill(); } catch (_) { /* ignore */ } child = null; }
  log('AutoPost turned OFF by the user');
  refreshTray();
}
function turnOn() {
  enabled = true; setDisabledFlag(false); keepAwake(true);
  log('AutoPost turned ON by the user');
  startChild();
  waitForDashboard(async (ok) => { if (ok) await autoLoginWithRetry(); });
  refreshTray();
}
function refreshTray() {
  if (!tray) return;
  tray.setToolTip(enabled ? 'AutoPost' : 'AutoPost — OFF');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open dashboard', click: () => createWindow(true) },
    enabled ? { label: 'Restart connector', click: restartChild } : { label: 'AutoPost is OFF', enabled: false },
    { type: 'separator' },
    enabled ? { label: 'Turn Off AutoPost', click: turnOff } : { label: 'Turn On AutoPost', click: turnOn },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; if (child) { try { child.kill(); } catch (_) { /* ignore */ } } app.quit(); } },
  ]));
}
function buildTray() {
  tray = new Tray(trayIconImage());
  refreshTray();
  tray.on('click', () => createWindow(true));
  tray.on('double-click', () => createWindow(true));
}

// --- lifecycle: single instance, auto-start at login, keep running in the tray ---
// FLASHER MODE runs as its OWN tool: it must NOT share the connector's single-instance lock (otherwise, if the
// connector is already running in the tray, the flasher window would be silently swallowed). Launch it directly.
if (FLASHER_MODE) {
  // Own profile folder so the flasher never collides with the connector's locked cache (they share appId).
  try { app.setPath('userData', path.join(app.getPath('appData'), 'AutoPostFlasher')); } catch (_) { /* ignore */ }
  app.whenReady().then(() => { log('FLASHER MODE — SD card writer (connector NOT started)'); createFlasherWindow(); });
  app.on('window-all-closed', () => app.quit());
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { createWindow(true); });
  app.whenReady().then(async () => {
    // Auto-start at login so the tunnel is always up in the tray after a reboot — no one has to open it.
    // Packaged: the exe registers itself. Dev (electron .): relaunch `electron <appdir>` on login.
    try {
      const opts = { openAtLogin: true, openAsHidden: true };
      if (!app.isPackaged) { opts.path = process.execPath; opts.args = [path.resolve(ROOT)]; }
      app.setLoginItemSettings(opts);
    } catch (_) { /* ignore */ }
    buildTray();
    keepAwake(enabled); // stop the PC idle-sleeping while the tunnel should be up (idle-sleep only; see notes)
    // Force an immediate reconnect on wake / unlock: after sleep the socket is stale even though the process
    // lived, so proactively bounce the connector (the agent's own half-open detector is the backstop).
    powerMonitor.on('resume', () => { if (enabled) { log('system resumed — forcing reconnect'); restartChild(); } });
    powerMonitor.on('unlock-screen', () => { if (enabled && !child) startChild(); });
    startChild();
    if (!HAS_CONFIG) watchForConfig(); // fresh install: relaunch into the connector once a setup code is redeemed
    waitForDashboard(async (ok) => {
      if (!ok) { log('dashboard did not come up — check the connector'); return; }
      if (!HAS_CONFIG) { createWindow(true); return; } // first-run setup screen: always show it
      await autoLoginWithRetry();
      const openedHidden = (() => { try { return app.getLoginItemSettings().wasOpenedAsHidden; } catch (_) { return false; } })();
      createWindow(!openedHidden); // launched at login -> stay in the tray; launched by hand -> show the window
    });
  });
  app.on('window-all-closed', () => { if (FLASHER_MODE) app.quit(); /* connector app: keep running in the tray */ });
  app.on('before-quit', () => { quitting = true; if (child) { try { child.kill(); } catch (_) { /* ignore */ } } });
}
