'use strict';
/*
 * Dealership Connector agent (Phase 1 scaffold — ISOLATED, not production, not deployed).
 *
 * Dials OUT to the VPS control server over WSS (no inbound firewall change), authenticates by dealership
 * token, and relays rep Facebook streams out through THIS machine's connection (the dealership's own IP).
 * Heartbeat + remote config + silent auto-update. See ../README.md for the architecture + the VPS-side
 * counterpart that still needs building.
 *
 * IMPLEMENTED: control channel, auth, heartbeat, reconnect w/ backoff, stream open/data/close relay
 *              (the data-plane), LAN-isolation guard (tunnel.js).
 * TODO (needs the VPS side + a signing scheme): apply remote config (enable/hours/throttle), download +
 *      verify + swap the auto-update build, Windows-service wrapper + single-.exe packaging.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const WebSocket = require('ws');

// These two are remotely REPLACEABLE (onUpdateFile). If a swapped-in build throws at require/module-init time
// it would crash agent.js's OWN load here — BEFORE the crash-loop rollback near the bottom can ever run — and
// brick the connector into an infinite load-crash loop. So recover RIGHT HERE: restore the last-known-good .bak
// of any replaceable file and exit for a clean relaunch. (onUpdateFile also load-tests candidates before
// committing, so this is the belt to that suspenders.)
let openStream; let startDashboard;
try {
  ({ openStream } = require('./tunnel'));
  ({ startDashboard } = require('./dashboard'));
} catch (loadErr) {
  emergencyRollbackAndExit(loadErr);
}
function emergencyRollbackAndExit(err) {
  try { console.error(new Date().toISOString(), '[agent] FATAL load error in a replaceable file — rolling back:', (err && err.message) || err); } catch (_) { /* ignore */ }
  const restored = [];
  for (const f of ['dashboard.js', 'tunnel.js', 'preview-ui.js']) {
    try { const t = path.join(__dirname, f); const b = t + '.bak'; if (fs.existsSync(b)) { try { fs.copyFileSync(t, t + '.crashloop'); } catch (_) {} fs.copyFileSync(b, t); restored.push(f); } } catch (_) { /* keep going */ }
  }
  try { console.error('[agent] emergency rollback restored:', restored.join(', ') || '(nothing — no .bak)'); } catch (_) {}
  process.exit(restored.length ? 0 : 1); // 0 = fixed something -> supervisor relaunches good code; 1 = nothing to restore
}

const CFG_PATH = process.env.CONNECTOR_CONFIG || path.join(__dirname, '..', 'config.json');

// Durable JSON write: temp -> fsync the DATA -> rename -> fsync the DIRECTORY.
//
// writeFileSync+renameSync is atomic for READERS but says nothing about durability: the rename can reach the
// disk while the data it points at is still in page cache. Cut the power inside that window and ext4 hands
// back a ZERO-LENGTH file. Not theoretical — that is exactly how a fielded unit lost its config.json on
// 2026-08-30, after which it could neither start (invalid JSON) nor re-claim (an empty file still satisfied
// the old ConditionPathExists). Every config write goes through here now.
function writeJsonDurable(file, obj, mode) {
  const tmp = file + '.tmp';
  const data = JSON.stringify(obj, null, 2);
  const fd = fs.openSync(tmp, 'w', mode === undefined ? 0o600 : mode);
  try { fs.writeSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  // Durability of the rename itself needs the parent directory synced. Opening a directory is not permitted on
  // Windows (the agent runs there too), so this is best-effort BY DESIGN, not by oversight.
  try { const d = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(d); } finally { fs.closeSync(d); } } catch (_) { /* not supported here */ }
}

function loadConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
    // Seed the backup on the FIRST good load, not only when the hub pushes a config. A unit that never
    // receives a push had no .bak at all, so the recovery below had nothing to recover from — which is why
    // the 2026-08-30 failure was unrecoverable in the field.
    try { if (!fs.existsSync(CFG_PATH + '.bak')) writeJsonDurable(CFG_PATH + '.bak', c, 0o600); } catch (_) { /* best effort */ }
    return c;
  }
  catch (e) {
    // Self-heal a truncated/corrupt config (e.g. a power loss mid-write) from the backup onConfig keeps, so a
    // bad config can never permanently wedge the agent into a crash loop.
    try { const c = JSON.parse(fs.readFileSync(CFG_PATH + '.bak', 'utf8')); console.error('config.json invalid — recovered from config.json.bak'); try { fs.copyFileSync(CFG_PATH + '.bak', CFG_PATH); } catch (_) { /* ignore */ } return c; } catch (_) { /* no usable backup */ }
    // QUARANTINE. With no backup, an unparseable config must NOT be left in place: autopost-connector starts
    // on it and dies, while autopost-claim is skipped BECAUSE it is there — the unit is bricked in the field
    // with no way back. Renaming it aside makes the claim service's condition true again, so the next boot
    // re-provisions instead of crash-looping forever. ConditionFileNotEmpty covers the zero-byte case; this
    // covers non-empty-but-invalid (a partial write), which no systemd condition can detect.
    try {
      if (fs.existsSync(CFG_PATH)) {
        fs.renameSync(CFG_PATH, CFG_PATH + '.corrupt');
        console.error('config.json unparseable and no usable backup — quarantined to config.json.corrupt so the claim service can re-provision on next boot');
      }
    } catch (_) { /* ignore */ }
    console.error('config.json missing/invalid — the unit will attempt to re-claim on next boot:', e.message); process.exit(1);
  }
}

// Pinned Ed25519 public key for verifying remote agent-update payloads. The PRIVATE half is held OFF the VPS
// (operator signer), so a compromised VPS, leaked admin token, or MITM cannot forge an update this agent will run.
const UPDATE_PUBKEY_PEM = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAEpZtqEGQKRSMcvuH2tFy0mu2UPcjGt2o4aSdlsN/nNI=\n-----END PUBLIC KEY-----\n';
const cfg = loadConfig();
const log = (...a) => console.log(new Date().toISOString(), ...a);

// SECURITY: the control link MUST be encrypted (wss://) over any real network, or the static agent token
// travels in the clear and can be sniffed off the dealership wifi + used to hijack the egress. Only allow a
// plain ws:// to loopback (local testing).
(function enforceSecureControl() {
  const url = String(cfg.controlUrl || '');
  const loopback = /^wss?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(url);
  if (!/^wss:\/\//i.test(url) && !loopback) {
    console.error('refusing to start: controlUrl must be wss:// (encrypted). Plain ws:// would send the agent token in the clear and let your egress be hijacked. Use wss://, or ws:// only to 127.0.0.1 for a local test.');
    process.exit(1);
  }
})();

// SECURITY (defense in depth): even if the VPS is compromised, the agent itself refuses to open anything but
// the allowed destinations/ports, so the dealership IP can never be driven as an open/spam relay. Only enforced
// when configured (a local test leaves these unset = allow-any).
const ALLOW_SUFFIXES = Array.isArray(cfg.allowedHostSuffixes) ? cfg.allowedHostSuffixes.map((s) => String(s).toLowerCase()) : null;
const ALLOW_PORTS = Array.isArray(cfg.allowedPorts) ? cfg.allowedPorts.map(Number) : null;
// GoLogin's Orbita browser probes an IP-geolocation service (geo.myip.link) on EVERY launch to spoof the exit
// IP's timezone/locale. It is required for every session and is NOT a per-dealership choice, so it is ALWAYS
// permitted even under a Facebook-only allow-list — it is a read-only IP lookup, never a general egress path.
// Without it the anti-detect browser aborts BEFORE it can reach Facebook (observed live 2026-07-08 on Jasmine's
// tunnel: 403 off-allowlist at the hub, then "destination not allowed by agent" here). Pinned to the EXACT host
// the probe uses (NOT a *.myip.link suffix) so a compromised VPS can't drive egress to any myip.link subdomain.
const ALWAYS_ALLOW_EXACT = ['geo.myip.link'];
function destAllowed(host, port) {
  if (ALLOW_PORTS && ALLOW_PORTS.length && !ALLOW_PORTS.includes(Number(port))) return false;
  const h = String(host).toLowerCase().replace(/\.$/, '');
  if (ALWAYS_ALLOW_EXACT.includes(h)) return true;
  if (ALLOW_SUFFIXES && ALLOW_SUFFIXES.length) {
    if (!ALLOW_SUFFIXES.some((s) => h === s || h.endsWith('.' + s))) return false;
  }
  return true;
}

let ws = null;
let hbTimer = null;
let plannedTimer = null;
let plannedReconnecting = false; // true while a scheduled pre-cap refresh is closing the link (fast, no-backoff reconnect)
let reconnectMs = 2000;
// SELF-HEAL: if the control link is unreachable for this long, exit so the Windows service/task restarts a
// clean instance (clears any wedged state). A fresh install that has never connected keeps retrying instead.
let lastConnectedAt = 0;
const WATCHDOG_MAX_DOWN_MS = Math.max(60000, parseInt(process.env.CONNECTOR_MAX_DOWN_MS || '600000', 10));

// DATA-PLANE SELF-HEAL (passive) — the failure that took Roger's tunnel down for hours on 2026-07-13: the control
// channel stayed perfectly healthy (heartbeat + 240s reconnect fine, agent showed LIVE) while the agent could no
// longer open NEW outbound sockets for rep streams, so reps got "tunneling socket could not be established" with
// NO self-recovery. We detect it from REAL traffic, not a synthetic probe: a bare connect to the CONTROL host
// SUCCEEDS throughout this wedge (it is the Facebook-EGRESS path that fails), so an active control-host probe
// would miss it. Instead, every far-socket the hub asks us to open IS the test — if FAR_FAIL_MAX opens in a row
// FAIL for a NETWORK reason (not a policy refusal) while the control link is UP, the egress is wedged -> exit(1)
// for a clean service restart. Guards: (a) never cut a still-flowing stream unless the failures are severe; (b) a
// PERSISTED cross-restart limit so a NON-wedge condition a restart can't fix (e.g. FB blocking the IP) can't
// restart-loop the box — after DP_RESTART_MAX exits in DP_RESTART_WINDOW_MS we stand down and leave it to the VPS
// watchdog + alert.
let farFails = 0;
const FAR_FAIL_MAX = Math.max(3, parseInt(process.env.CONNECTOR_FAR_FAIL_MAX || '5', 10));
const DP_RESTART_MAX = Math.max(1, parseInt(process.env.CONNECTOR_DP_RESTART_MAX || '3', 10));
const DP_RESTART_WINDOW_MS = Math.max(300000, parseInt(process.env.CONNECTOR_DP_RESTART_WINDOW_MS || '1800000', 10));
function isPolicyRefusal(msg) { return /blocked non-public|resolved to private|bad port|not allowed by agent|access paused/i.test(String(msg || '')); }
function dpRestartHistory() {
  const f = path.join(RUNTIME_DIR, 'dp-restart-history.json');
  let hist = []; try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); if (Array.isArray(j)) hist = j; } catch (_) { hist = []; }
  return { f, hist: hist.filter((t) => Date.now() - t < DP_RESTART_WINDOW_MS) };
}
function maybeDataPlaneRestart() {
  if (farFails < FAR_FAIL_MAX) return;
  if (!(streams.size === 0 || farFails >= FAR_FAIL_MAX * 3)) return;   // don't cut a working stream unless severe
  if (!(ws && ws.readyState === WebSocket.OPEN)) return;               // control down => the reconnect path owns it
  const { f, hist } = dpRestartHistory();
  if (hist.length >= DP_RESTART_MAX) { if (farFails === FAR_FAIL_MAX) log('data-plane wedge suspected but self-restart limit reached (' + DP_RESTART_MAX + ' in ' + Math.round(DP_RESTART_WINDOW_MS / 60000) + 'min) — leaving it to the VPS watchdog'); return; }
  try { fs.mkdirSync(RUNTIME_DIR, { recursive: true }); hist.push(Date.now()); fs.writeFileSync(f, JSON.stringify(hist)); } catch (_) { /* best effort */ }
  log('DATA-PLANE WEDGED: ' + farFails + ' consecutive far-socket opens failed while the control link is UP — exiting for a clean service restart (2026-07-13 self-heal)');
  try { ws && ws.close(1001, 'dataplane-wedged'); } catch (_) { /* ignore */ }
  process.exit(1);
}

// LIVENESS (half-open detection) — the #1 "never drop" fix. A slept / NAT-timed-out socket stays
// readyState===OPEN for many minutes while the OS TCP stack gives up, so ws emits neither 'close' nor 'error'
// and nothing heals it: the app looks connected but posts nothing (the competitor's silent "stops through the
// day"). We drive REAL liveness off ws PONG replies (+ any inbound frame): if the link is silent for
// PONG_TIMEOUT_MS we ws.terminate() to force a 'close' -> reconnect. A HEARTBEAT FILE written every ~15s
// (regardless of connectivity) lets the external supervisor tell "app alive but tunnel down" (leave it, it is
// reconnecting) from "app frozen/dead" (stale timestamp -> kill + restart).
const HB_MS = Math.max(5000, Number(cfg.heartbeatMs) || 20000); // floored so a bad remote-config value can't self-DoS the heartbeat
const PONG_TIMEOUT_MS = Math.max(45000, HB_MS * 3);
// PROACTIVE REFRESH ("never drop under traffic"): some networks on the dealership's path (ISP/router/firewall)
// cap ANY single connection at a hard max-lifetime (~10 min observed on Roger's link) and tear it down even
// though ping/pong keeps it "alive" — which, if it lands mid-post, kills the post (ERR_TUNNEL_CONNECTION_FAILED).
// We can't stop the middlebox, and a live TCP stream can't migrate to a new socket, so instead we RESET the
// connection age ourselves DURING IDLE, before the cap: every PLANNED_RECONNECT_MS, if no post stream is in
// flight, we cleanly close + immediately reopen (a sub-second blip while idle). Posts therefore always run on a
// young link far from the cap. If a post IS in flight we wait for it to finish (poll), leaving the middlebox as
// the only backstop — never worse than today, and the hub's alert-grace hides the blip.
// Default 120s (2 min): lowered from 240s (2026-07-14) after recurring tunnel SESSION_LOST — a photo-heavy post
// can run 5-8 min, so at 240s a post starting on a ~240s-old link could cross the ~600s network middlebox cut
// mid-post. 120s keeps the link young enough that even a ~7-8 min post finishes before the cap. The hub also
// pushes this on every (re)connect (survives an agent restart). Override per-dealership via config.plannedReconnectMs.
const PLANNED_RECONNECT_MS = Math.max(60000, parseInt(cfg.plannedReconnectMs || process.env.CONNECTOR_PLANNED_RECONNECT_MS || '120000', 10));
// IDLE MUST MEAN "NO BYTES MOVING", NOT "NO SOCKETS OPEN" (2026-08-17). The refresh above used to wait for
// streams.size === 0. But a rep's browser holds HTTP keep-alive sockets to Facebook open for the WHOLE session,
// so the socket count never returns to 0 while anyone is working: the refresh only ever fired when nobody was
// posting, the link aged straight into the ~600s middlebox cap, and the middlebox severed it mid-session and
// took every stream with it. The 2026-08-17 field logs show exactly that — four cuts at ~10m13s of link age,
// 8-10 live streams dropped each, versus clean sub-second refreshes for the whole hour the box sat idle.
// So we refresh during a genuine LULL (no bytes on any stream for STREAM_QUIET_MS), which is common between
// posts, and if no lull ever comes we refresh anyway at PLANNED_RECONNECT_MAX_MS — deliberately below the cap,
// because a controlled 250ms blip we choose is strictly better than an uncontrolled cut we don't.
const STREAM_QUIET_MS = Math.max(1000, parseInt(cfg.streamQuietMs || process.env.CONNECTOR_STREAM_QUIET_MS || '5000', 10));
// Hard ceiling on link age. Must stay comfortably UNDER the observed ~600s network cap or it is not a backstop
// at all. Floored at PLANNED_RECONNECT_MS so a bad config can never make the ceiling tighter than the target.
const PLANNED_RECONNECT_MAX_MS = Math.max(PLANNED_RECONNECT_MS, parseInt(cfg.plannedReconnectMaxMs || process.env.CONNECTOR_PLANNED_RECONNECT_MAX_MS || '480000', 10));
let lastStreamByteAt = 0; // last time ANY byte moved in EITHER direction on ANY stream (the real activity signal)
let lastPongAt = 0;
let lastInboundAt = 0;
const RUNTIME_DIR = process.env.CONNECTOR_RUNTIME_DIR || path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'AutoPost');
const HEARTBEAT_FILE = path.join(RUNTIME_DIR, 'heartbeat.json');
function isLinkAlive() {
  const a = Math.max(lastPongAt, lastInboundAt);
  return Boolean(ws && ws.readyState === WebSocket.OPEN && a && (Date.now() - a < PONG_TIMEOUT_MS));
}
function writeHeartbeat(extra) {
  try { fs.mkdirSync(RUNTIME_DIR, { recursive: true }); fs.writeFileSync(HEARTBEAT_FILE, JSON.stringify({ ts: Date.now(), connected: isLinkAlive(), pid: process.pid, paused, ...(extra || {}) })); } catch (_) { /* best effort */ }
}

// Live state surfaced to the local dashboard (src/dashboard.js).
const metrics = { wsState: 'connecting', connectedSince: null, lastHeartbeatAt: null, requests: 0, bytesUp: 0, bytesDown: 0 };
// Set by the super-admin On/Off switch (a 'paused' control message). While paused the tunnel is connected but
// egress is turned OFF; the dashboard surfaces this so the dealership user sees WHY nothing is going out.
let paused = false;
function status() {
  const connected = isLinkAlive(); // OPEN readyState alone is NOT proof — require a fresh pong/inbound (RULE 0)
  return {
    paused,
    tunnel: { state: connected ? 'connected' : metrics.wsState, connectedSince: metrics.connectedSince, lastHeartbeatAt: metrics.lastHeartbeatAt },
    activity: { activeSessions: streams.size, totalRequests: metrics.requests, bytesUp: metrics.bytesUp, bytesDown: metrics.bytesDown },
  };
}
const streams = new Map();    // streamId -> net.Socket (connected)
const connecting = new Map(); // streamId -> { sock, cancelled } while net.connect is still in flight

// FIELD TELEMETRY — cheap host-health the hub watches for undervoltage / overheating / disk-full / mem-leak on a
// device we cannot physically see. Sent with every heartbeat. Degrades gracefully off-Pi (fields just absent).
let _throttleCache = { at: 0, v: undefined };
let _modelCache; // Pi model string ("Raspberry Pi 4 Model B Rev 1.4"), read once
function hostTelemetry() {
  const t = { uptimeS: Math.round(os.uptime()), rssMb: Math.round(process.memoryUsage().rss / 1048576) };
  try { t.tempC = Math.round(Number(fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8')) / 1000); } catch (_) { /* not a Pi */ }
  try { // vcgencmd is the only source of the undervolt/throttle bits; cache for 60s to keep heartbeats light.
    if (Date.now() - _throttleCache.at > 60000) {
      const o = require('child_process').execSync('vcgencmd get_throttled', { timeout: 3000, encoding: 'utf8' });
      _throttleCache = { at: Date.now(), v: parseInt((o.split('=')[1] || '0x0').trim(), 16) };
    }
    if (_throttleCache.v !== undefined) t.throttled = _throttleCache.v;
  } catch (_) { /* not a Pi */ }
  // Report the ROOT filesystem (the SD card) so the operator sees the real card size, not a small data/overlay
  // partition. Include the TOTAL so the UI can show "free / total" + used% (a 2GB card that never expanded, or a
  // filling SD, is then obvious). diskDataFreeMb is the connector's own writable dir (RUNTIME_DIR) — the thing that
  // actually wedges the connector if it fills, kept as a secondary signal.
  try { const s = fs.statfsSync('/'); t.diskFreeMb = Math.round((s.bavail * s.bsize) / 1048576); t.diskTotalMb = Math.round((s.blocks * s.bsize) / 1048576); } catch (_) { /* older node / not linux */ }
  try { const s = fs.statfsSync(RUNTIME_DIR); t.diskDataFreeMb = Math.round((s.bavail * s.bsize) / 1048576); } catch (_) { /* ignore */ }
  try {
    const mi = fs.readFileSync('/proc/meminfo', 'utf8');
    const avail = mi.match(/MemAvailable:\s+(\d+)/); if (avail) t.memFreeMb = Math.round(Number(avail[1]) / 1024);
    const total = mi.match(/MemTotal:\s+(\d+)/); if (total) t.memTotalMb = Math.round(Number(total[1]) / 1024);
    const swTot = mi.match(/SwapTotal:\s+(\d+)/); const swFree = mi.match(/SwapFree:\s+(\d+)/);
    if (swTot && swFree) t.swapUsedMb = Math.max(0, Math.round((Number(swTot[1]) - Number(swFree[1])) / 1024));
  } catch (_) { /* not linux */ }
  // CPU load (cross-platform via os; 0 on Windows) + core count so load1/cpus reads as utilisation.
  try { t.load1 = Math.round(os.loadavg()[0] * 100) / 100; t.cpus = os.cpus().length; } catch (_) { /* ignore */ }
  // Active network + WiFi signal — a weak/roaming WiFi is a top reason a shipped box silently drops. Use the DEFAULT
  // ROUTE interface (destination 00000000 in /proc/net/route) as the real egress path, so a WIRED box that also has
  // WiFi associated is correctly 'eth' (not mislabeled 'wifi' off an idle radio). /proc/net/wireless gives the WiFi
  // signal (dBm, col 4). Fall back to "wireless row present => wifi" only when the default route can't be read.
  try {
    let defIface = null;
    try { for (const line of fs.readFileSync('/proc/net/route', 'utf8').split('\n')) { const p = line.trim().split(/\s+/); if (p[1] === '00000000') { defIface = p[0]; break; } } } catch (_) { /* ignore */ }
    let wl = null;
    try { wl = fs.readFileSync('/proc/net/wireless', 'utf8').split('\n').find((l) => /:/.test(l) && !/face|Inter/.test(l)) || null; } catch (_) { /* ignore */ }
    if (defIface) t.net = /^wl/.test(defIface) ? 'wifi' : 'eth';
    else t.net = wl ? 'wifi' : 'eth';
    if (t.net === 'wifi' && wl) { const p = wl.trim().split(/\s+/); const dbm = Math.round(parseFloat(p[3])); if (Number.isFinite(dbm)) t.wifiSignal = dbm; }
  } catch (_) { /* not linux */ }
  // Pi model — read ONCE (constant) so the fleet view can tell a 2GB board from a 4GB, spot a wrong SKU, etc.
  try { if (_modelCache === undefined) { try { _modelCache = fs.readFileSync('/proc/device-tree/model', 'utf8').replace(/\0/g, '').trim() || null; } catch (_) { _modelCache = null; } } if (_modelCache) t.model = _modelCache; } catch (_) { /* ignore */ }
  // Post-ship DRIFT signals: was the corruption-safe overlay lost (a bad update rewrote cmdline)? is the data dir
  // still writable (not remounted read-only after an SD fault)? A dying device shows here before it goes dark.
  try { t.rootfsOverlay = fs.readFileSync('/proc/cmdline', 'utf8').includes('boot=overlay'); } catch (_) { /* not a Pi */ }
  try { const cf = path.join(RUNTIME_DIR, '.wcanary'); fs.writeFileSync(cf, '1'); fs.unlinkSync(cf); t.dataWritable = true; } catch (_) { t.dataWritable = false; }
  return t;
}
// The pre-ship burn-in verdict written by deploy/pi/selftest.sh — forwarded so the provisioning page can gate shipping.
function readSelftest() {
  try { return JSON.parse(fs.readFileSync(path.join(RUNTIME_DIR, 'selftest.json'), 'utf8')); } catch (_) { return null; }
}

function send(obj) {
  try { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); } catch (_) { /* dropped; reconnect handles it */ }
}

function connect() {
  log('connecting to control', cfg.controlUrl);
  ws = new WebSocket(cfg.controlUrl, {
    headers: { 'x-agent-token': cfg.dealershipToken, 'x-agent-version': cfg.agentVersion || '0.1.0' },
  });

  ws.on('open', () => {
    log('control channel up');
    reconnectMs = 2000;
    plannedReconnecting = false;
    lastConnectedAt = Date.now();
    lastPongAt = Date.now();
    lastInboundAt = Date.now();
    metrics.wsState = 'connected';
    metrics.connectedSince = Date.now();
    send({ type: 'hello', version: cfg.agentVersion || '0.1.0', host: os.hostname(), pid: process.pid, telemetry: hostTelemetry(), selftest: readSelftest() });
    armPlannedReconnect();
    clearInterval(hbTimer);
    hbTimer = setInterval(() => {
      metrics.lastHeartbeatAt = Date.now();
      // Half-open check: no pong/inbound for PONG_TIMEOUT_MS => the socket is dead. Force it closed so
      // scheduleReconnect (and the self-heal watchdog) fires — ws will NOT do it on its own on a half-open socket.
      const silentMs = Date.now() - Math.max(lastPongAt, lastInboundAt);
      if (silentMs > PONG_TIMEOUT_MS) {
        log('control link silent ' + Math.round(silentMs / 1000) + 's (half-open) — terminating to force reconnect');
        try { ws.terminate(); } catch (_) { /* 'close' will fire -> scheduleReconnect */ }
        return;
      }
      try { ws.ping(); } catch (_) { /* ignore */ }
      send({ type: 'heartbeat', ts: Date.now(), streams: streams.size, telemetry: hostTelemetry() });
      writeHeartbeat();
    }, HB_MS);
  });

  ws.on('pong', () => { lastPongAt = Date.now(); });

  ws.on('message', (raw) => {
    lastInboundAt = Date.now(); // any inbound frame proves the link is genuinely alive (RULE 0 liveness)
    let msg; try { msg = JSON.parse(raw); } catch (_) { return; }
    try {
      switch (msg.type) {
        case 'open':   return onOpen(msg);            // VPS: open a stream to a public target (Facebook)
        case 'data':   return onData(msg);            // VPS: bytes for an existing stream (base64)
        case 'close':  return onCloseReq(msg.id);     // VPS: close a stream
        case 'config': return onConfig(msg.config);   // VPS: push per-dealership settings
        case 'paused': return onPaused(msg);          // VPS/super-admin: On/Off switch (egress paused/resumed)
        case 'update': return onUpdate(msg);          // VPS: a newer signed build is available (agent.js)
        case 'update-file': return onUpdateFile(msg); // VPS: a newer signed build of a whitelisted NON-agent file (dashboard.js…)
        case 'restart': return onRestart(msg);        // VPS/super-admin: restart this agent (service starts a fresh one)
        case 'wifi':   return onWifi(msg);            // super-admin: set/change the dealership WiFi (applied via nmcli+polkit)
        default: break;
      }
    } catch (e) { log('message handler error', msg && msg.type, e.message); } // never let one message crash the agent
  });

  ws.on('close', scheduleReconnect);
  ws.on('error', (e) => log('control error', e.message));
}

// Schedule the pre-cap refresh: once the link has been up PLANNED_RECONNECT_MS, close+reopen it at the first
// QUIET moment (see STREAM_QUIET_MS — quiet, not stream-less), so an in-flight transfer is never cut; if bytes
// keep moving, re-check every 2s until PLANNED_RECONNECT_MAX_MS, then refresh regardless rather than let the
// ~600s middlebox cap sever the link on its own terms. A clean close (code 1000) then an immediate no-backoff
// reconnect keeps the gap sub-second, and (removeAgent fires before the new connect) avoids the server's
// "replaced while live" alarm.
// PURE decision, kept free of module state so it can be tested directly (src/_test/planned-refresh.test.js
// extracts it between the markers below and exercises it). Returns {refresh, forced, quietMs, linkAgeMs}.
// --- BEGIN plannedRefreshDecision (pure; extracted verbatim by the test) ---
function plannedRefreshDecision({ now, linkOpenedAt, lastByteAt, streamCount, quietMs: quietWindowMs, maxAgeMs }) {
  const linkAgeMs = now - linkOpenedAt;
  // Measure quiet from the LATER of "last byte" and "link opened", so a freshly-opened stream that has not sent
  // anything yet cannot read as quiet merely because lastByteAt is still stale or zero.
  const quietMs = now - Math.max(lastByteAt, linkOpenedAt);
  const quiet = streamCount === 0 || quietMs >= quietWindowMs;
  const overdue = linkAgeMs >= maxAgeMs;
  return { refresh: quiet || overdue, forced: overdue && !quiet, quietMs, linkAgeMs };
}
// --- END plannedRefreshDecision ---

function armPlannedReconnect() {
  clearTimeout(plannedTimer);
  const linkOpenedAt = Date.now();
  const tick = () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return; // already down; the reconnect path owns it
    const d = plannedRefreshDecision({
      now: Date.now(), linkOpenedAt, lastByteAt: lastStreamByteAt, streamCount: streams.size,
      quietMs: STREAM_QUIET_MS, maxAgeMs: PLANNED_RECONNECT_MAX_MS,
    });
    if (!d.refresh) { plannedTimer = setTimeout(tick, 2000); return; } // bytes still moving — wait for a lull
    plannedReconnecting = true;
    log(d.forced
      ? 'proactive link refresh FORCED at ' + Math.round(d.linkAgeMs / 1000) + 's link age (' + streams.size + ' stream(s) still busy) — refreshing on our terms instead of waiting for the ~10min network cap to sever it'
      : 'proactive link refresh (' + Math.round(d.quietMs / 1000) + 's quiet, ' + streams.size + ' stream(s) open) before the ~10min network cap — sub-second blip, keeps posting on a young link');
    try { ws.close(1000, 'planned-refresh'); } catch (_) { /* 'close' -> scheduleReconnect (fast path) */ }
  };
  plannedTimer = setTimeout(tick, PLANNED_RECONNECT_MS);
}

function scheduleReconnect() {
  clearInterval(hbTimer);
  clearTimeout(plannedTimer);
  metrics.wsState = 'connecting';
  metrics.connectedSince = null;
  for (const s of streams.values()) { try { s.destroy(); } catch (_) {} }
  streams.clear();
  for (const c of connecting.values()) { c.cancelled = true; try { c.sock && c.sock.destroy(); } catch (_) {} }
  connecting.clear();
  // PLANNED pre-cap refresh: this close was ours and the link was healthy — reconnect ALMOST immediately (no
  // backoff, no jitter) so the gap is sub-second. A small delay lets the server process our close first (so the
  // reconnect registers cleanly, not as a live-replace).
  if (plannedReconnecting) {
    plannedReconnecting = false;
    reconnectMs = 2000; // keep backoff reset for any future UNplanned drop
    log('planned refresh — reconnecting immediately');
    setTimeout(connect, 250);
    return;
  }
  // SELF-HEAL: after a prolonged outage (having previously connected), exit so the service restarts a fresh
  // instance. Reconnect-forever handles the normal sleep/network-drop case; this only fires on a long wedge.
  if (lastConnectedAt && Date.now() - lastConnectedAt > WATCHDOG_MAX_DOWN_MS) {
    log(`control channel down > ${Math.round(WATCHDOG_MAX_DOWN_MS / 60000)} min — exiting for a clean restart by the service`);
    process.exit(1);
  }
  // Jitter the reconnect so a fleet of agents doesn't stampede the control server in lockstep after a
  // server restart/deploy (thundering herd). Matters at scale; harmless at N=1.
  const jitter = Math.floor(Math.random() * 5000);
  log('control down — reconnecting in', reconnectMs + jitter, 'ms');
  setTimeout(connect, reconnectMs + jitter);
  reconnectMs = Math.min(reconnectMs * 2, 30000); // capped exponential backoff
}

// VPS asks us to open a TCP stream to a public target; we open it locally (egress = dealership IP) and
// relay both directions over the control channel. The LAN-isolation guard lives in tunnel.openStream.
function onOpen({ id, host, port }) {
  metrics.requests += 1;
  // Defense in depth: while the super-admin has this dealership turned OFF, refuse egress here too (the server
  // already refuses, so it normally never reaches us).
  if (paused) { log('refused: access is paused (super-admin OFF)'); return send({ type: 'close', id, error: 'access paused' }); }
  if (!destAllowed(host, port)) { log('blocked off-allowlist destination', host + ':' + port); return send({ type: 'close', id, error: 'destination not allowed by agent: ' + String(host) }); }
  const rec = { sock: null, cancelled: false };
  connecting.set(id, rec);
  rec.sock = openStream(host, Number(port), (err, sock) => {
    connecting.delete(id);
    // The server may have closed this id while our connect was still in flight (client aborted / open-timeout).
    // Do NOT hold an orphan egress socket for a stream the server threw away.
    if (rec.cancelled) { try { sock && sock.destroy(); } catch (_) {} return; }
    if (err) {
      log('open blocked/failed', host + ':' + port, err.message);
      // PASSIVE DATA-PLANE SELF-HEAL: a real (non-policy) far-socket open failure is a live symptom of the wedge.
      if (!isPolicyRefusal(err.message)) { farFails += 1; maybeDataPlaneRestart(); }
      return send({ type: 'close', id, error: err.message });
    }
    farFails = 0; // a far socket actually opened => the egress works; clear the wedge counter
    streams.set(id, sock);
    sock.on('data', (buf) => { metrics.bytesDown += buf.length; lastStreamByteAt = Date.now(); send({ type: 'data', id, b64: buf.toString('base64') }); });
    sock.on('close', () => { streams.delete(id); send({ type: 'close', id }); });
    sock.on('error', () => { streams.delete(id); send({ type: 'close', id }); });
    send({ type: 'opened', id });
  });
}
function onData({ id, b64 }) { const s = streams.get(id); if (s) { const buf = Buffer.from(String(b64 || ''), 'base64'); metrics.bytesUp += buf.length; lastStreamByteAt = Date.now(); try { s.write(buf); } catch (_) {} } }
function onCloseReq(id) {
  const c = connecting.get(id);
  if (c) { c.cancelled = true; try { c.sock && c.sock.destroy(); } catch (_) {} connecting.delete(id); } // abort an in-flight connect
  const s = streams.get(id);
  if (s) { try { s.destroy(); } catch (_) {} streams.delete(id); }
}

// Super-admin REMOTE CONFIG: apply a small WHITELIST of TUNING knobs only. Deliberately EXCLUDES controlUrl /
// dealershipToken / dashboard (identity + where we connect = a re-provision, not a hot tweak) AND the egress
// allow-list (allowedPorts / allowedHostSuffixes) — that guard is provisioning-time and must not be remotely
// widened. Each value is clamped/typed so a bad push can't self-DoS. Persisted atomically (temp + rename) with a
// backup, then restart to apply.
const HOT_CONFIG_KEYS = ['plannedReconnectMs', 'plannedReconnectMaxMs', 'streamQuietMs', 'heartbeatMs', 'agentVersion'];
function clampHot(k, v) {
  if (k === 'plannedReconnectMs') { const n = Number(v); return Number.isFinite(n) ? Math.max(60000, Math.floor(n)) : undefined; }
  // Ceiling on link age before we refresh regardless of traffic. Clamped to 540s: above that it stops being a
  // backstop, because the observed dealership middlebox cap is ~600s and would win the race.
  if (k === 'plannedReconnectMaxMs') { const n = Number(v); return Number.isFinite(n) ? Math.min(540000, Math.max(60000, Math.floor(n))) : undefined; }
  // How long the streams must be byte-quiet to count as a lull. Capped at 60s so a bad push can't make a lull
  // effectively unreachable and silently disable the refresh.
  if (k === 'streamQuietMs') { const n = Number(v); return Number.isFinite(n) ? Math.min(60000, Math.max(1000, Math.floor(n))) : undefined; }
  if (k === 'heartbeatMs') { const n = Number(v); return Number.isFinite(n) ? Math.max(5000, Math.floor(n)) : undefined; }
  if (k === 'agentVersion') { return v == null ? undefined : String(v).slice(0, 64); }
  return undefined;
}
function onConfig(c) {
  try {
    if (!c || typeof c !== 'object') { log('remote config: empty/invalid — ignoring'); return; }
    const patch = {};
    for (const k of HOT_CONFIG_KEYS) if (k in c) { const cv = clampHot(k, c[k]); if (cv !== undefined) patch[k] = cv; }
    if (!Object.keys(patch).length) { log('remote config: no applicable/valid keys (allowed: ' + HOT_CONFIG_KEYS.join(',') + ')'); return; }
    const cur = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
    // IDEMPOTENT (root cause of the pi-pilot flap, 2026-07-17): the hub RE-PUSHES this tuning config on EVERY
    // (re)connect so it survives an agent restart. If nothing actually CHANGED, we must NOT rewrite the file +
    // process.exit(0) to reload — otherwise connect -> config -> exit -> systemd restart -> reconnect -> config
    // -> exit loops forever and the tunnel never stays up (egress dead). Only act on a REAL delta.
    const changed = {};
    for (const k of Object.keys(patch)) if (cur[k] !== patch[k]) changed[k] = patch[k];
    if (!Object.keys(changed).length) {
      log('remote config: already current (' + Object.keys(patch).join(',') + ') — no rewrite, no restart');
      try { send({ type: 'config-result', ok: true, applied: [] }); } catch (_) { /* ignore */ }
      return;
    }
    Object.assign(cur, changed);
    try { fs.copyFileSync(CFG_PATH, CFG_PATH + '.bak'); } catch (_) { /* best effort */ }
    writeJsonDurable(CFG_PATH, cur); // atomic AND durable — see writeJsonDurable
    log('remote config APPLIED: ' + JSON.stringify(changed) + ' — restarting to load it');
    send({ type: 'config-result', ok: true, applied: Object.keys(changed) });
    setTimeout(() => { try { ws && ws.close(1000, 'config'); } catch (_) { /* ignore */ } process.exit(0); }, 400);
  } catch (e) { log('remote config FAILED: ' + e.message + ' — keeping current config'); try { send({ type: 'config-result', ok: false, reason: e.message }); } catch (_) { /* ignore */ } }
}
// Super-admin On/Off. Paused = egress OFF (the dashboard shows an "access paused" banner). Dropping any live
// streams here mirrors the server, so nothing keeps flowing the instant it is turned off.
function onPaused(m) {
  paused = !!(m && m.on);
  log('access ' + (paused ? 'PAUSED (super-admin turned it OFF)' : 'RESUMED (super-admin turned it ON)'));
  if (paused) {
    for (const s of streams.values()) { try { s.destroy(); } catch (_) {} }
    streams.clear();
    for (const c of connecting.values()) { c.cancelled = true; try { c.sock && c.sock.destroy(); } catch (_) {} }
    connecting.clear();
  }
}
// Super-admin REMOTE UPDATE: the new agent code arrives INLINE over the already-authenticated wss control channel
// (token + TLS), so there is no separate download to MITM. We refuse to apply it unless the SHA-256 matches AND it
// syntactically compiles AND it looks like a real agent build — so a truncated/garbled/hostile push can never
// brick the machine. We back up the current code, atomically swap our OWN source file, then exit for the
// supervisor/electron to relaunch into the new code. On ANY doubt we keep the current code and report failure.
function onUpdate(m) {
  try {
    if (!m || typeof m.codeB64 !== 'string' || !m.sha256 || !m.sigB64) { log('update: malformed (need codeB64 + sha256 + sigB64) — ignoring'); try { send({ type: 'update-result', ok: false, reason: 'malformed' }); } catch (_) { /* ignore */ } return; }
    const buf = Buffer.from(m.codeB64, 'base64');
    const got = crypto.createHash('sha256').update(buf).digest('hex');
    if (got !== String(m.sha256).toLowerCase()) { log(`update REJECTED: sha256 mismatch — keeping current code (want ${m.sha256}, got ${got})`); send({ type: 'update-result', ok: false, reason: 'sha256_mismatch' }); return; }
    // AUTHENTICITY (the real gate): verify the operator's Ed25519 signature over the exact bytes, against the
    // PINNED public key. The private key is off the VPS, so a compromised control plane / leaked token / MITM
    // cannot forge a build this agent will execute. The hash above is only an integrity double-check.
    let sigOk = false;
    try { sigOk = crypto.verify(null, buf, UPDATE_PUBKEY_PEM, Buffer.from(m.sigB64, 'base64')); } catch (_) { sigOk = false; }
    if (!sigOk) { log('update REJECTED: signature invalid — refusing unsigned/forged build (keeping current code)'); send({ type: 'update-result', ok: false, reason: 'bad_signature' }); return; }
    const text = buf.toString('utf8');
    if (buf.length < 3000 || !/scheduleReconnect/.test(text) || !/openStream/.test(text)) { log('update REJECTED: payload does not look like a valid agent build — keeping current code'); send({ type: 'update-result', ok: false, reason: 'not_agent_build' }); return; }
    const self = __filename; // our own running source file (…/src/agent.js)
    const tmp = self + '.new';
    fs.writeFileSync(tmp, buf);
    // LOADABILITY GATE: actually LOAD the candidate in a throwaway child (`node <tmp> --selftest`). A build that
    // throws at require/module-init time (e.g. a missing dependency — updates ship only agent.js) fails HERE and is
    // never committed, so a runtime-broken-but-syntactically-valid build can't brick the machine into a crash loop.
    let ok = false;
    try {
      const st = require('child_process').spawnSync(process.execPath, [tmp, '--selftest'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 20000, encoding: 'utf8' });
      ok = st.status === 0 && /selftest-ok/.test(String(st.stdout || ''));
      if (!ok) log('update self-test output: status=' + st.status + ' err=' + String(st.stderr || '').slice(0, 200));
    } catch (e) { ok = false; log('update self-test spawn error: ' + e.message); }
    if (!ok) { try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ } log('update REJECTED: candidate failed the load self-test — keeping current code'); send({ type: 'update-result', ok: false, reason: 'selftest_failed' }); return; }
    // FAIL-CLOSED backup: a verified rollback target MUST exist before we swap, or a later post-connect crash
    // has nothing to roll back to. If the .bak can't be written (AV lock, IO), reject the update as a retryable
    // no-op rather than committing a build with no safety net.
    let bakOk = false;
    try { fs.copyFileSync(self, self + '.bak'); bakOk = fs.existsSync(self + '.bak') && fs.statSync(self + '.bak').size === fs.statSync(self).size; } catch (_) { bakOk = false; }
    if (!bakOk) { try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ } log('update REJECTED: could not create a verified rollback backup — keeping current code'); send({ type: 'update-result', ok: false, reason: 'backup_failed' }); return; }
    fs.renameSync(tmp, self); // commit (atomic on same dir)
    // Stamp the new version into config so the agent reports it on reconnect (confirms which build actually booted).
    try { const c = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')); c.agentVersion = m.version || c.agentVersion; writeJsonDurable(CFG_PATH, c); } catch (_) { /* non-fatal */ }
    log(`update APPLIED: wrote ${buf.length} bytes -> ${self} (version ${m.version || '?'}). Restarting to load it.`);
    send({ type: 'update-result', ok: true, version: m.version || null });
    setTimeout(() => { try { ws && ws.close(1000, 'update'); } catch (_) { /* ignore */ } process.exit(0); }, 400);
  } catch (e) {
    log('update FAILED: ' + e.message + ' — keeping current code');
    try { send({ type: 'update-result', ok: false, reason: 'exception' }); } catch (_) { /* ignore */ }
  }
}

// Files (other than agent.js) that a super-admin may replace remotely. agent.js has its OWN path (onUpdate).
// Anything not on this list is refused, and the name is basename-only (no directories) so a payload can NEVER
// write outside src/. A bad build of one of these is caught by --check AND the crash-loop rollback restores its
// .bak, so this cannot brick the connector.
const UPDATABLE_FILES = ['dashboard.js', 'tunnel.js', 'preview-ui.js'];
function onUpdateFile(m) {
  try {
    if (!m || typeof m.codeB64 !== 'string' || !m.sha256 || !m.sigB64 || typeof m.filename !== 'string') { log('update-file: malformed — ignoring'); try { send({ type: 'update-file-result', ok: false, reason: 'malformed' }); } catch (_) {} return; }
    const base = path.basename(m.filename); // strip ANY path component
    if (!UPDATABLE_FILES.includes(base)) { log('update-file REJECTED: ' + base + ' is not on the updatable whitelist'); send({ type: 'update-file-result', ok: false, filename: base, reason: 'not_whitelisted' }); return; }
    const buf = Buffer.from(m.codeB64, 'base64');
    const got = crypto.createHash('sha256').update(buf).digest('hex');
    if (got !== String(m.sha256).toLowerCase()) { log('update-file REJECTED: sha256 mismatch'); send({ type: 'update-file-result', ok: false, filename: base, reason: 'sha256_mismatch' }); return; }
    let sigOk = false;
    try { sigOk = crypto.verify(null, buf, UPDATE_PUBKEY_PEM, Buffer.from(m.sigB64, 'base64')); } catch (_) { sigOk = false; }
    if (!sigOk) { log('update-file REJECTED: signature invalid'); send({ type: 'update-file-result', ok: false, filename: base, reason: 'bad_signature' }); return; }
    if (buf.length < 200) { log('update-file REJECTED: too small'); send({ type: 'update-file-result', ok: false, filename: base, reason: 'too_small' }); return; }
    const target = path.join(__dirname, base);
    if (path.dirname(target) !== __dirname) { log('update-file REJECTED: path escapes src/'); send({ type: 'update-file-result', ok: false, filename: base, reason: 'bad_path' }); return; }
    // tmp MUST keep a .js extension or `node --check` refuses it (ERR_UNKNOWN_FILE_EXTENSION) and every push fails.
    const tmp = target + '.new.js';
    fs.writeFileSync(tmp, buf);
    // LOADABILITY GATE: actually LOAD the candidate in a child (require it), NOT just --check it. These files
    // (dashboard.js/tunnel.js/preview-ui.js) are pure modules with no side effects on require, so requiring them
    // executes their module body and surfaces syntax AND require-time throws (a bad require, a top-level call to
    // an undefined fn, etc.) — the exact class agent.js's own top-level require('./dashboard') would crash on at
    // boot. Only a candidate that loads cleanly is ever committed.
    let ok = false;
    try { const st = require('child_process').spawnSync(process.execPath, ['-e', 'require(process.argv[1])', tmp], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 15000, encoding: 'utf8' }); ok = st.status === 0; if (!ok) log('update-file load-test failed: ' + String(st.stderr || '').slice(0, 200)); }
    catch (e) { ok = false; log('update-file load-test spawn error: ' + e.message); }
    if (!ok) { try { fs.unlinkSync(tmp); } catch (_) {} log('update-file REJECTED: candidate failed the load test — keeping current file'); send({ type: 'update-file-result', ok: false, filename: base, reason: 'selftest_failed' }); return; }
    // FAIL-CLOSED backup so the crash-loop rollback has a fresh target.
    let bakOk = false;
    try { if (fs.existsSync(target)) { fs.copyFileSync(target, target + '.bak'); bakOk = fs.existsSync(target + '.bak') && fs.statSync(target + '.bak').size === fs.statSync(target).size; } else { bakOk = true; } } catch (_) { bakOk = false; }
    if (!bakOk) { try { fs.unlinkSync(tmp); } catch (_) {} log('update-file REJECTED: could not back up current file'); send({ type: 'update-file-result', ok: false, filename: base, reason: 'backup_failed' }); return; }
    fs.renameSync(tmp, target);
    log(`update-file APPLIED: wrote ${buf.length} bytes -> ${target}. Restarting to load it.`);
    send({ type: 'update-file-result', ok: true, filename: base, sha256: m.sha256 });
    setTimeout(() => { try { ws && ws.close(1000, 'update-file'); } catch (_) { /* ignore */ } process.exit(0); }, 400);
  } catch (e) {
    log('update-file FAILED: ' + e.message + ' — keeping current file');
    try { send({ type: 'update-file-result', ok: false, reason: 'exception' }); } catch (_) { /* ignore */ }
  }
}
// Operator/super-admin restart: close cleanly and exit; the Windows service/scheduled task starts a fresh
// instance within seconds. exit(0) = intentional (no crash-loop counting).
function onRestart(m) {
  log('RESTART requested' + (m && m.reason ? ` (${m.reason})` : '') + ' — exiting for the service to relaunch');
  try { ws && ws.close(); } catch (_) { /* ignore */ }
  setTimeout(() => process.exit(0), 300);
}

// Super-admin "Set WiFi": apply the dealership's WiFi via set-wifi.sh (nmcli, authorized for this unprivileged
// service user by the polkit rule). It ADDS/updates a saved 'autopost-wifi' connection with autoconnect ON and
// KEEPS the existing WiFi as a fallback — so a wrong password can never strand the device. The Pi auto-joins the
// new network whenever it is in range (e.g. the moment the box is powered on at the dealership). No terminal,
// no per-device SSH: the operator types the creds in super-admin at onboarding and they land here.
// MULTI-NETWORK (operator 2026-07-15): the box can hold SEVERAL WiFi networks (dealership WiFi + a phone hotspot)
// and NetworkManager auto-fails-over between them. action: 'set' (add/update, default) | 'prefer' (switch to it) |
// 'remove'. priority: higher wins when both are in range. Adding a network never clobbers the others.
function onWifi(m) {
  const ssid = String((m && m.ssid) || '').trim();
  const password = String((m && m.password) || '');
  const action = String((m && m.action) || 'set');
  const priority = String(parseInt((m && m.priority), 10) || 10);
  // hidden: non-broadcasting SSID (must be probed for). enterpriseUser: WPA-Enterprise 802.1x identity — corporate
  // WiFi with a username+password instead of a shared key. Both are common at dealerships and, without them, the
  // box simply cannot join that network (added 2026-07-15).
  const hidden = !!(m && m.hidden);
  const enterpriseUser = String((m && m.enterpriseUser) || '').trim();
  if (!ssid || ssid.length > 64 || password.length > 128 || enterpriseUser.length > 128) { send({ type: 'wifi-result', ok: false, reason: 'bad_ssid_or_password' }); return; }
  if (!['set', 'prefer', 'remove'].includes(action)) { send({ type: 'wifi-result', ok: false, ssid, reason: 'bad_action' }); return; }
  const script = path.join(__dirname, '..', 'deploy', 'pi', 'set-wifi.sh');
  const args = action === 'set' ? [script, ssid, password, priority] : [script, '--' + action, ssid];
  if (action === 'set') {
    if (hidden) args.push('--hidden');
    if (enterpriseUser) args.push('--enterprise-user', enterpriseUser);
  }
  log('WIFI ' + action + ' requested for SSID ' + JSON.stringify(ssid));
  try {
    require('child_process').execFile('bash', args, { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) { log('wifi apply failed: ' + err.message); send({ type: 'wifi-result', ok: false, ssid, reason: String(stderr || err.message).slice(0, 200) }); }
      else { log('wifi applied: ' + ssid); send({ type: 'wifi-result', ok: true, ssid, detail: String(stdout || '').trim().slice(0, 200) }); }
    });
  } catch (e) { send({ type: 'wifi-result', ok: false, ssid, reason: e.message }); }
}

process.on('SIGINT', () => { try { ws && ws.close(); } catch (_) {} process.exit(0); });
process.on('SIGTERM', () => { try { ws && ws.close(); } catch (_) {} process.exit(0); });

// Independent wall-clock watchdog (decoupled from ws events): (1) refresh the heartbeat file every 15s so the
// supervisor can tell alive-but-disconnected (leave it, it is reconnecting) from frozen/dead (stale ts -> kill +
// restart); (2) after a prolonged outage, exit cleanly so the supervisor relaunches a fresh instance. A fresh
// install that has NEVER connected keeps retrying forever (never self-exits) so a first-run network hiccup can't
// wedge onboarding.
setInterval(() => {
  writeHeartbeat();
  if (lastConnectedAt && Date.now() - lastConnectedAt > WATCHDOG_MAX_DOWN_MS) {
    log('watchdog: control link down > ' + Math.round(WATCHDOG_MAX_DOWN_MS / 60000) + ' min — exiting for a clean supervisor restart');
    writeHeartbeat({ exiting: true });
    process.exit(1);
  }
}, 15000);

// SELF-TEST for the remote-update loadability gate (onUpdate spawns `node agent.js --selftest`): reaching this
// line means every require + all module init succeeded, so this build is loadable. Report + exit BEFORE connecting
// or starting the dashboard, so the check has zero side effects.
if (process.argv.includes('--selftest')) { console.log('selftest-ok'); process.exit(0); }

// ---- Crash-loop self-rollback + fatal handlers (AFTER the --selftest early-exit so a selftest spawn is never counted) ----
// Fatal-error handlers turn an uncaught async throw — in connect(), a timer, or the stream relay, i.e. exactly the
// post-connect code the module-load selftest CANNOT catch — into a clean non-zero exit. That makes the crash
// observable AND counts it toward the crash-loop detector below.
process.on('uncaughtException', (e) => { try { log('FATAL uncaughtException: ' + ((e && e.stack) || e)); writeHeartbeat({ fatal: true }); } catch (_) { /* ignore */ } process.exit(1); });
process.on('unhandledRejection', (e) => { try { log('FATAL unhandledRejection: ' + ((e && (e.stack || e.message)) || e)); } catch (_) { /* ignore */ } process.exit(1); });

// SUPERVISOR-INDEPENDENT crash-loop self-rollback: every start is timestamped in a small history file; if the
// process has restarted CRASH_LOOP_COUNT times within CRASH_LOOP_WINDOW_MS the current code is crash-looping
// (e.g. a signed build that passes the load selftest but throws post-connect). We restore agent.js.bak (the
// last-known-good, guaranteed fresh by the fail-closed backup in onUpdate) over ourselves and exit for a clean
// relaunch. Living HERE — not only in electron-main — means EVERY supervisor path (Electron, the run-agent.cmd
// loop, keep-alive) recovers without a site visit. Normal single restarts (a config or update apply) never trip
// it; only a genuine rapid loop does.
const BOOT_HISTORY_FILE = path.join(RUNTIME_DIR, 'boot-history.json');
const CRASH_LOOP_COUNT = 3;
const CRASH_LOOP_WINDOW_MS = 30000;
function recordBootAndMaybeRollback() {
  try {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    let hist = [];
    try { const j = JSON.parse(fs.readFileSync(BOOT_HISTORY_FILE, 'utf8')); if (Array.isArray(j)) hist = j; } catch (_) { hist = []; }
    const now = Date.now();
    hist = hist.filter((t) => typeof t === 'number' && now - t < CRASH_LOOP_WINDOW_MS);
    hist.push(now);
    fs.writeFileSync(BOOT_HISTORY_FILE, JSON.stringify(hist));
    if (hist.length >= CRASH_LOOP_COUNT) {
      // Restore the last-known-good of EVERYTHING that has a .bak — agent.js AND any remotely-updatable file
      // (dashboard.js …). Restoring all of them guarantees a known-good state regardless of which push caused the
      // loop (a bad dashboard.js crashes agent.js's top-level require, which restoring agent.js.bak alone would
      // NOT fix). Worst case we revert one file a version further than strictly needed; the operator re-pushes.
      const restored = [];
      const tryRestore = (target, label, minSize) => {
        try { const b = target + '.bak'; if (fs.existsSync(b) && fs.statSync(b).size > minSize) { try { fs.copyFileSync(target, target + '.crashloop'); } catch (_) {} fs.copyFileSync(b, target); restored.push(label); } } catch (_) { /* keep going */ }
      };
      tryRestore(__filename, 'agent.js', 2000);
      for (const f of UPDATABLE_FILES) tryRestore(path.join(__dirname, f), f, 50);
      if (restored.length) {
        log(`crash-loop detected (${hist.length} restarts in ${Math.round(CRASH_LOOP_WINDOW_MS / 1000)}s) — rolled back: ${restored.join(', ')}`);
        try { fs.unlinkSync(BOOT_HISTORY_FILE); } catch (_) { /* reset so the restored build starts clean */ }
        // Stamp a visible marker so the hub's version column shows a rollback happened.
        try { const c = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')); c.agentVersion = 'rolled-back'; writeJsonDurable(CFG_PATH, c); } catch (_) { /* non-fatal */ }
        try { writeHeartbeat({ rolledBack: true }); } catch (_) { /* ignore */ }
        process.exit(0); // clean exit -> supervisor relaunches the restored (good) code
      } else {
        log('crash-loop detected but no usable .bak to roll back to — continuing (manual recovery may be needed)');
      }
    }
  } catch (_) { /* self-heal must never itself crash the boot */ }
}
recordBootAndMaybeRollback();

log('dealership-connector agent starting (Phase 1 scaffold)');
writeHeartbeat(); // create the heartbeat file immediately (connected=false) so the supervisor sees the app alive from t=0
if (cfg.dashboard && cfg.dashboard.port) {
  try { startDashboard({ cfg, status, log }); } catch (e) { log('dashboard failed to start', e.message); }
}
connect();
