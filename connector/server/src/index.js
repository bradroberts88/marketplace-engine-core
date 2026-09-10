'use strict';

/*
 * Dealership tunnel server (test-mode entry point). Starts the WS control server (agents dial in) and the
 * fail-closed HTTP CONNECT proxy (rep/GoLogin clients dial in), sharing one Hub. Standalone: no import of
 * ../../production, no DB, no pm2 wiring. Run: `npm start` (after copying config.example.json -> config.json,
 * or set TUNNEL_CONFIG to a config path).
 */

const fs = require('fs');
const path = require('path');
const { Hub } = require('./hub');
const { createControlServer } = require('./control-server');
const { createProxyServer } = require('./proxy-server');
const { createAdminApi } = require('./admin-api');
const { DealershipStore } = require('./dealership-store');
const { createClaimServer } = require('./claim-server');

const CFG_PATH = process.env.TUNNEL_CONFIG || path.join(__dirname, '..', 'config.json');
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')); }
  catch (e) { console.error(`config missing/invalid at ${CFG_PATH} — copy config.example.json to config.json:`, e.message); process.exit(1); }
}
const cfg = loadConfig();
const log = (...a) => console.log(new Date().toISOString(), '[tunnel]', ...a);

// Dealership identity is DB-backed (a hot JSON store) so a dealership can be added or its token rotated WITHOUT a
// restart that would drop every OTHER dealership's live agent. A legacy config.dealerships[] is imported once.
const storePath = cfg.storePath || path.join(__dirname, '..', 'dealerships.json');
const store = new DealershipStore({
  storePath,
  defaults: {
    publicControlUrl: cfg.publicControlUrl || null,        // handed back to the agent on a successful claim
    allowedPorts: cfg.allowedPorts || [443],
    allowedHostSuffixes: cfg.allowedHostSuffixes || null,   // so claim-onboarded agents enforce the same host allowlist
    heartbeatMs: cfg.agentHeartbeatMs || 20000,
    agentVersion: cfg.agentVersion || '0.1.0',
    claimTtlMinutes: cfg.claimTtlMinutes || 1440,
  },
  log,
});
store.importSeed(cfg.dealerships);
// A tunnel with zero dealerships is only valid if claim-code onboarding is on (it will be populated live).
if (store.size === 0 && !cfg.claimPort) { console.error('no dealerships in the store and claim onboarding (claimPort) is off — nothing to serve'); process.exit(1); }

// The control channel is plaintext ws:// with a static bearer token. Binding it anywhere but loopback without
// a TLS terminator (cloudflared/nginx) in front lets a token be sniffed and a stolen token hijack egress. So
// refuse a non-loopback bind unless the operator explicitly acknowledges TLS is fronting it.
const controlBindHost = cfg.controlBindHost || '127.0.0.1';
const isLoopback = controlBindHost === '127.0.0.1' || controlBindHost === '::1' || controlBindHost === 'localhost';
if (!isLoopback && !cfg.allowInsecureRemoteControl) {
  console.error(`refusing to bind the control WS to ${controlBindHost}: it is plaintext ws:// with a static token. Put TLS (cloudflared/nginx) in front and set "allowInsecureRemoteControl": true to acknowledge, or keep controlBindHost = 127.0.0.1.`);
  process.exit(1);
}

// Notify on connector trouble (offline / security). Logs here, and POSTs to alertWebhook if set — the platform
// receives that and emails the operator (keeps SMTP creds out of this standalone server).
function onAlert(kind, dealershipId, message) {
  log(`ALERT [${kind}] ${dealershipId}: ${message}`);
  if (cfg.alertWebhook) {
    try {
      const u = new URL(cfg.alertWebhook);
      const lib = u.protocol === 'https:' ? require('https') : require('http');
      const req = lib.request(u, { method: 'POST', headers: { 'content-type': 'application/json', 'x-alert-token': cfg.alertWebhookToken || '' } });
      req.on('error', (e) => log('alert webhook failed:', e.message));
      req.end(JSON.stringify({ kind, dealershipId, message, ts: Date.now() }));
    } catch (e) { log('alert webhook error:', e.message); }
  }
}

const hub = new Hub({
  heartbeatTimeoutMs: cfg.heartbeatTimeoutMs || 60000,
  maxStreamsPerDealership: cfg.maxStreamsPerDealership || 256,
  offlineGraceMs: cfg.offlineGraceMs != null ? cfg.offlineGraceMs : 45000, // suppress the alert for a sub-grace reconnect (agent's pre-cap refresh)
  alertOnRootfsWritable: !!cfg.alertOnRootfsWritable, // default OFF: v1 images ship a writable rootfs on purpose
  onAlert,
  log,
});

createControlServer({
  hub,
  port: cfg.controlPort || 8443,
  bindHost: controlBindHost,
  resolveAgentToken: (tok) => store.resolveAgentToken(tok),
  log,
});

const proxyHost = cfg.bindHost || '127.0.0.1'; // GoLogin runs on the SAME host in prod -> localhost is correct + safe
const proxyLoopback = proxyHost === '127.0.0.1' || proxyHost === '::1' || proxyHost === 'localhost';
if (!proxyLoopback && !cfg.allowPublicProxyBind) {
  console.error(`refusing to bind the proxy to ${proxyHost}: that would expose an authenticated forward proxy ON the dealership IP. Keep bindHost = 127.0.0.1 (GoLogin runs on the same host), or set "allowPublicProxyBind": true to acknowledge.`);
  process.exit(1);
}
if (!cfg.allowedHostSuffixes || !cfg.allowedHostSuffixes.length) {
  log('WARNING: allowedHostSuffixes is not set — the proxy will allow ANY https host (open forward proxy on the dealership IP). Set it to ["facebook.com","fbcdn.net","fbsbx.com","messenger.com","facebook.net"] before production.');
}

const proxy = createProxyServer({
  hub,
  resolveDealership: ({ user, pass }) => store.resolveProxy({ user, pass }),
  allowedHostSuffixes: cfg.allowedHostSuffixes || null,
  allowedPorts: cfg.allowedPorts || [443],
  log,
});
proxy.listen(cfg.proxyPort || 1080, proxyHost, () => log(`proxy (HTTP CONNECT) listening on ${proxyHost}:${cfg.proxyPort || 1080}`));

// Admin API for the super-admin platform (localhost only): status + event log + remote restart + create / list /
// rotate / revoke dealerships (claim-code onboarding).
if (cfg.adminPort && cfg.adminToken) {
  const admin = createAdminApi({ hub, store, token: cfg.adminToken, claimBaseUrl: cfg.publicClaimUrl || null, agentBuildPath: cfg.agentBuildPath || path.join(__dirname, '..', 'agent-build.js'), log });
  admin.listen(cfg.adminPort, '127.0.0.1', () => log(`admin API on 127.0.0.1:${cfg.adminPort} (status / events / restart / dealerships)`));
} else {
  log('admin API disabled (set adminPort + adminToken to enable super-admin status/logs/restart)');
}

// Claim server (public via TLS/nginx in prod; loopback here). An unconfigured agent redeems a one-time code to
// self-provision — no hand-edited config.json. Off unless claimPort is set.
if (cfg.claimPort) {
  if (!cfg.publicControlUrl) log('WARNING: claimPort is set but publicControlUrl is not — claims are refused until it is set');
  const claim = createClaimServer({ store, log });
  claim.listen(cfg.claimPort, '127.0.0.1', () => log(`claim server on 127.0.0.1:${cfg.claimPort} (POST /claim, GET /health) — put TLS in front`));
}

log(`up — ${store.size} dealership(s). FAIL-CLOSED: a rep is refused unless its dealership agent is live.`);

process.on('SIGINT', () => { log('shutting down'); process.exit(0); });
process.on('SIGTERM', () => { log('shutting down'); process.exit(0); });
