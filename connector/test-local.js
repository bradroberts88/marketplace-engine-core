'use strict';

/*
 * LOCAL SMOKE TEST — proves the dealership tunnel end to end on THIS machine, with ZERO VPS involvement.
 * It starts the tunnel server + the connector agent locally (temp configs in the OS temp dir), then:
 *   TEST 1: sends a real HTTPS request through the fail-closed proxy and shows the exit IP
 *           (which should be THIS computer's public IP — proof the traffic egressed via the agent), and
 *   TEST 2: kills the agent and retries, expecting the proxy to REFUSE (proof it fails closed).
 * Touches nothing in production, GoLogin, or the VPS. Requires `ws` installed (npm install in this folder).
 *
 *   node test-local.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const tls = require('tls');
const { spawn } = require('child_process');

const ROOT = __dirname;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-test-'));
const CONTROL_PORT = 8788;
const PROXY_PORT = 8789;
const TOKEN = 'LOCAL-SMOKE-TOKEN';
const PROXY_USER = 'testrep';
const PROXY_PASS = 'testpass';

const serverCfg = path.join(TMP, 'server.json');
const agentCfg = path.join(TMP, 'agent.json');
fs.writeFileSync(serverCfg, JSON.stringify({
  controlPort: CONTROL_PORT, controlBindHost: '127.0.0.1', proxyPort: PROXY_PORT, bindHost: '127.0.0.1', heartbeatTimeoutMs: 60000,
  dealerships: [{ id: 'test-local', agentToken: TOKEN, proxyAuth: { user: PROXY_USER, pass: PROXY_PASS } }],
}, null, 2));
fs.writeFileSync(agentCfg, JSON.stringify({
  controlUrl: `ws://127.0.0.1:${CONTROL_PORT}/agent`, dealershipToken: TOKEN, heartbeatMs: 20000, agentVersion: '0.1.0-test',
}, null, 2));

const procs = [];
function stopAll() { for (const p of procs) { try { p.kill(); } catch (_) { /* ignore */ } } }
function waitFor(child, re, label, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const to = setTimeout(() => reject(new Error(`timeout waiting for "${label}"`)), timeoutMs);
    const onData = (d) => {
      buf += d.toString();
      process.stdout.write(`  [${label}] ${d}`);
      if (re.test(buf)) { clearTimeout(to); child.stdout.removeListener('data', onData); child.stderr.removeListener('data', onData); resolve(); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
  });
}

function fetchThroughProxy() {
  return new Promise((resolve) => {
    let done = false;
    const finish = (err, data) => { if (done) return; done = true; resolve({ err, data }); };
    const req = http.request({
      host: '127.0.0.1', port: PROXY_PORT, method: 'CONNECT', path: 'ipinfo.io:443',
      headers: { 'proxy-authorization': 'Basic ' + Buffer.from(`${PROXY_USER}:${PROXY_PASS}`).toString('base64') },
    });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) { try { socket.destroy(); } catch (_) { /* ignore */ } return finish(new Error(`proxy refused: HTTP ${res.statusCode}`)); }
      const t = tls.connect({ socket, servername: 'ipinfo.io' }, () => t.write('GET /json HTTP/1.1\r\nHost: ipinfo.io\r\nUser-Agent: tunnel-smoke\r\nConnection: close\r\n\r\n'));
      let body = '';
      t.on('data', (d) => { body += d.toString(); });
      t.on('end', () => { const i = body.indexOf('{'); finish(null, i >= 0 ? body.slice(i) : body); });
      t.on('error', (e) => finish(e));
    });
    req.on('error', (e) => finish(e));
    req.setTimeout(15000, () => { try { req.destroy(); } catch (_) { /* ignore */ } finish(new Error('request timeout')); });
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let ok = true;
  try {
    const server = spawn(process.execPath, ['server/src/index.js'], { cwd: ROOT, env: { ...process.env, TUNNEL_CONFIG: serverCfg } });
    procs.push(server);
    await waitFor(server, /proxy \(HTTP CONNECT\) listening/, 'server');

    const agent = spawn(process.execPath, ['src/agent.js'], { cwd: ROOT, env: { ...process.env, CONNECTOR_CONFIG: agentCfg } });
    procs.push(agent);
    await waitFor(agent, /control channel up/, 'agent');
    await sleep(1500);

    console.log('\n--- TEST 1: request through the LIVE tunnel (exit IP should be YOUR home IP) ---');
    const r1 = await fetchThroughProxy();
    if (r1.err) { console.log('  FAIL:', r1.err.message); ok = false; }
    else {
      let geo = {}; try { geo = JSON.parse(r1.data); } catch (_) { /* ignore */ }
      console.log(`  EGRESS OK -> ip=${geo.ip}  ${[geo.city, geo.region, geo.country].filter(Boolean).join(', ')}  (org: ${geo.org || '?'})`);
      console.log("  ^ confirm this is THIS computer's public IP + location.");
    }

    console.log('\n--- TEST 2: kill the agent, retry (expect REFUSED = fail-closed) ---');
    agent.kill();
    await sleep(2500);
    const r2 = await fetchThroughProxy();
    if (r2.err) console.log(`  FAIL-CLOSED OK -> proxy refused with the agent DOWN (${r2.err.message})`);
    else { console.log('  FAIL: proxy served traffic with the agent DOWN — NOT fail-closed! body:', String(r2.data).slice(0, 80)); ok = false; }
  } catch (e) {
    console.log('SMOKE ERROR:', e.message); ok = false;
  } finally {
    stopAll();
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }
  console.log(`\n=== SMOKE ${ok ? 'PASSED' : 'FAILED'} ===`);
  process.exit(ok ? 0 : 1);
})();
