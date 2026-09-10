'use strict';

/*
 * PI-TO-SERVER END-TO-END HARNESS — the whole journey a shipped Raspberry Pi makes, on one machine.
 *
 * Unlike test-local.js (which hand-writes both configs) this starts from ZERO agent identity and drives the
 * REAL production path, in order:
 *   1. boot the real tunnel server (server/src/index.js) on ephemeral loopback ports
 *   2. mint a dealership + one-time claim code through the admin API (what the super-admin does)
 *   3. redeem that code with the REAL claim client (src/claim.js) — exactly what autopost-claim.service runs
 *      on the Pi's first boot — and prove config.json is written durably
 *   4. start the REAL agent (src/agent.js) against only that claimed config — no hand-fed token or URL
 *   5. prove the agent registers LIVE on the hub
 *   6. push a real HTTPS request through the fail-closed proxy and read back the exit IP
 *      (must equal this machine's own public IP = the traffic really egressed via the agent)
 *   7. kill the agent and prove the proxy REFUSES rather than falling back to another route
 *   8. restart the agent from the same on-disk config and prove it reconnects with no re-claim
 *
 *   node e2e-pi.js          (or: npm run e2e:pi)
 *
 * Requires: `npm install` in this folder (ws) and outbound internet for step 6.
 */

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');

const ROOT = __dirname;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'autopost-e2e-'));
const CONFIG_PATH = path.join(TMP, 'pi', 'config.json');
const IP_HOST = process.env.E2E_IP_HOST || 'api.ipify.org';

let passed = 0;
let failed = 0;
const procs = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ok(name, cond, extra) {
  if (cond) { passed += 1; console.log(`  PASS  ${name}`); }
  else { failed += 1; console.log(`  FAIL  ${name}${extra ? '  — ' + String(extra).slice(0, 400) : ''}`); }
}
function step(n, text) { console.log(`\n[${n}] ${text}`); }
function stopAll() { for (const p of procs) { try { p.kill(); } catch (_) { /* already gone */ } } }

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}

function httpJson(method, url, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const h = { 'content-type': 'application/json', ...headers };
    if (data) h['content-length'] = data.length;
    const req = http.request(new URL(url), { method, headers: h }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(b || '{}'); } catch (_) { /* non-json */ } resolve({ status: res.statusCode, json: j }); });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('http timeout')));
    if (data) req.end(data); else req.end();
  });
}

/** This machine's public IP, fetched DIRECTLY (no proxy) — the value the tunnelled request must match. */
function directPublicIp() {
  return new Promise((resolve) => {
    const req = https.request({ host: IP_HOST, path: '/', method: 'GET', timeout: 10000 }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve(b.trim()));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

/** Same request, but forced through the fail-closed CONNECT proxy (what a rep's browser profile does). */
function ipThroughProxy(proxyPort, user, pass) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (result) => { if (!done) { done = true; resolve(result); } };
    const auth = Buffer.from(`${user}:${pass}`).toString('base64');
    const req = http.request({
      host: '127.0.0.1', port: proxyPort, method: 'CONNECT', path: `${IP_HOST}:443`,
      headers: { 'proxy-authorization': `Basic ${auth}`, host: `${IP_HOST}:443` },
    });
    req.setTimeout(20000, () => { req.destroy(); finish({ status: 0, ip: null, error: 'proxy timeout' }); });
    req.on('error', (e) => finish({ status: 0, ip: null, error: e.message }));
    req.on('response', (res) => finish({ status: res.statusCode, ip: null, error: `proxy refused: ${res.statusCode}` }));
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); return finish({ status: res.statusCode, ip: null, error: `CONNECT ${res.statusCode}` }); }
      const tls = require('tls');
      const tlsSock = tls.connect({ socket, servername: IP_HOST }, () => {
        tlsSock.write(`GET / HTTP/1.1\r\nHost: ${IP_HOST}\r\nUser-Agent: autopost-e2e\r\nConnection: close\r\n\r\n`);
      });
      let body = '';
      tlsSock.on('data', (c) => { body += c; });
      tlsSock.on('error', (e) => finish({ status: 200, ip: null, error: e.message }));
      tlsSock.on('end', () => {
        const ip = (body.split('\r\n\r\n').slice(1).join('\r\n\r\n') || '').trim().split('\n').pop().trim();
        finish({ status: 200, ip, error: null });
      });
    });
    req.end();
  });
}

async function waitForAgentLive(adminBase, adminH, dealershipId, timeoutMs = 15000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const r = await httpJson('GET', `${adminBase}/admin/status`, { headers: adminH });
      const agents = (r.json && r.json.agents) || [];
      if (agents.some((a) => (a.id || a.dealershipId) === dealershipId)) return true;
    } catch (_) { /* server still booting */ }
    await sleep(300);
  }
  return false;
}

async function agentGone(adminBase, adminH, dealershipId, timeoutMs = 10000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const r = await httpJson('GET', `${adminBase}/admin/status`, { headers: adminH });
    const agents = (r.json && r.json.agents) || [];
    if (!agents.some((a) => (a.id || a.dealershipId) === dealershipId)) return true;
    await sleep(300);
  }
  return false;
}

function startAgent() {
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'agent.js')], {
    env: { ...process.env, CONNECTOR_CONFIG: CONFIG_PATH, CONNECTOR_RUNTIME_DIR: path.join(TMP, 'runtime') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write(`      [agent] ${d}`));
  child.stderr.on('data', (d) => process.stdout.write(`      [agent] ${d}`));
  procs.push(child);
  return child;
}

(async () => {
  console.log('AutoPost Pi -> server end-to-end harness');
  console.log(`  workspace: ${TMP}`);

  const [controlPort, proxyPort, adminPort, claimPort] = await Promise.all([freePort(), freePort(), freePort(), freePort()]);
  const adminToken = 'e2e-admin-' + Math.random().toString(16).slice(2);
  const serverCfg = path.join(TMP, 'tunnel-config.json');
  fs.writeFileSync(serverCfg, JSON.stringify({
    controlPort, controlBindHost: '127.0.0.1',
    proxyPort, bindHost: '127.0.0.1',
    adminPort, adminToken,
    claimPort,
    publicControlUrl: `ws://127.0.0.1:${controlPort}/agent`,
    allowedPorts: [443],
    allowedHostSuffixes: [IP_HOST],
    storePath: path.join(TMP, 'dealerships.json'),
    heartbeatTimeoutMs: 60000,
    claimTtlMinutes: 60,
    dealerships: [],
  }, null, 2));

  const adminBase = `http://127.0.0.1:${adminPort}`;
  const claimBase = `http://127.0.0.1:${claimPort}`;
  const adminH = { 'x-admin-token': adminToken };

  try {
    step(1, 'booting the real tunnel server');
    const server = spawn(process.execPath, [path.join(ROOT, 'server', 'src', 'index.js')], {
      env: { ...process.env, TUNNEL_CONFIG: serverCfg }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let serverLog = '';
    server.stdout.on('data', (d) => { serverLog += d; });
    server.stderr.on('data', (d) => { serverLog += d; });
    procs.push(server);

    let up = false;
    for (let i = 0; i < 80; i += 1) {
      try { const r = await httpJson('GET', `${claimBase}/health`); if (r.status === 200) { up = true; break; } } catch (_) { /* booting */ }
      await sleep(100);
    }
    ok('tunnel server is up', up, serverLog);
    if (!up) throw new Error('server did not boot');

    step(2, 'minting a dealership + one-time claim code (super-admin action)');
    const created = await httpJson('POST', `${adminBase}/admin/dealerships`, { headers: adminH, body: { name: 'E2E Motors' } });
    const dealershipId = created.json && created.json.id;
    const claimCode = created.json && created.json.claimCode;
    const proxyAuth = (created.json && created.json.proxyAuth) || {};
    ok('claim code issued', created.status === 201 && !!claimCode && !!dealershipId, JSON.stringify(created.json));

    step(3, 'redeeming the code with the real claim client (Pi first boot)');
    const { claim } = require('./src/claim');
    const claimedCfg = await claim({ claimUrl: `${claimBase}/claim`, code: claimCode, configPath: CONFIG_PATH });
    ok('claim returned a usable config', !!claimedCfg.controlUrl && !!claimedCfg.dealershipToken, JSON.stringify(Object.keys(claimedCfg)));
    const onDisk = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    ok('config.json written and non-empty', fs.statSync(CONFIG_PATH).size > 0 && !!onDisk.dealershipToken);
    ok('config.json.bak seeded for recovery', fs.existsSync(`${CONFIG_PATH}.bak`));
    ok('proxy password never reached the device', onDisk.proxyAuth === undefined);

    step(4, 'starting the real agent from that claimed config only');
    startAgent();

    step(5, 'waiting for the agent to register LIVE on the hub');
    const live = await waitForAgentLive(adminBase, adminH, dealershipId);
    ok('agent is LIVE on the hub', live);

    step(6, `pushing a real HTTPS request through the proxy (${IP_HOST})`);
    const direct = await directPublicIp();
    const viaProxy = await ipThroughProxy(proxyPort, proxyAuth.user, proxyAuth.pass);
    if (direct === null) {
      console.log('      SKIP: no outbound internet in this environment — steps 6 cannot be judged');
    } else {
      ok('request completed through the tunnel', viaProxy.status === 200 && !!viaProxy.ip, JSON.stringify(viaProxy));
      ok(`exit IP is this machine's own IP (${direct})`, viaProxy.ip === direct, `tunnelled=${viaProxy.ip} direct=${direct}`);
    }

    step(7, 'killing the agent — the proxy must FAIL CLOSED, never reroute');
    stopAll.agentOnly = true;
    const agentProc = procs[procs.length - 1];
    try { agentProc.kill('SIGKILL'); } catch (_) { /* gone */ }
    const gone = await agentGone(adminBase, adminH, dealershipId);
    ok('hub marked the dealership down', gone);
    const refused = await ipThroughProxy(proxyPort, proxyAuth.user, proxyAuth.pass);
    ok('proxy refuses with 503 and no fallback egress', refused.status === 503 || (refused.status !== 200 && refused.ip === null), JSON.stringify(refused));

    step(8, 'restarting the agent from the same on-disk config (no re-claim)');
    startAgent();
    const relive = await waitForAgentLive(adminBase, adminH, dealershipId, 20000);
    ok('agent reconnected using the persisted identity', relive);
  } catch (e) {
    failed += 1;
    console.log(`\n  FAIL  harness error — ${e.message}`);
  } finally {
    stopAll();
    await sleep(300);
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  }

  console.log(`\n${failed === 0 ? 'ALL CHECKS PASSED' : 'FAILURES PRESENT'} — ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
