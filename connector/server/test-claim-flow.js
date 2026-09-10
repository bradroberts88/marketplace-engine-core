'use strict';

/*
 * End-to-end test for claim-code onboarding + DB-backed identity. Spins up the REAL tunnel (src/index.js) on
 * ephemeral loopback ports with a throwaway store, then drives the whole flow: create -> claim -> connect, every
 * rejection path (wrong token, re-claim, bogus code, rate limit), token lifecycle (rotate/revoke), and that
 * rotate/revoke FORCE-DISCONNECT a live agent. Zero VPS/network dependency — everything is 127.0.0.1.
 *   node test-claim-flow.js
 */

const http = require('http');
const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const WebSocket = require('ws');

let passed = 0;
let failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed += 1; console.log(`  PASS  ${name}`); }
  else { failed += 1; console.log(`  FAIL  ${name}${extra ? '  — ' + String(extra).slice(0, 300) : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}

function httpJson(method, url, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const h = { 'content-type': 'application/json', ...headers };
    if (data) h['content-length'] = data.length;
    const req = http.request(u, { method, headers: h }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(b || '{}'); } catch (_) { /* non-json */ } resolve({ status: res.statusCode, json: j }); });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('http timeout')));
    if (data) req.end(data); else req.end();
  });
}

// Connect a WS agent; report whether it STAYED open (accepted) or was CLOSED (rejected) within holdMs.
function wsProbe(url, token, holdMs = 1400) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers: { 'x-agent-token': token, 'x-agent-version': '0.1.0' } });
    let opened = false; let closed = null;
    ws.on('open', () => { opened = true; });
    ws.on('close', (code) => { if (closed === null) closed = code; });
    ws.on('error', () => {});
    setTimeout(() => { try { ws.close(); } catch (_) {} resolve({ opened, closed }); }, holdMs);
  });
}

// A persistent agent connection whose live state can be inspected while the test acts on the server.
function wsLive(url, token) {
  const ws = new WebSocket(url, { headers: { 'x-agent-token': token, 'x-agent-version': '0.1.0' } });
  const state = { opened: false, closedCode: null };
  ws.on('open', () => { state.opened = true; try { ws.send(JSON.stringify({ type: 'hello', version: '0.1.0', host: 'test', pid: 1 })); } catch (_) {} });
  ws.on('close', (code) => { if (state.closedCode === null) state.closedCode = code; });
  ws.on('error', () => {});
  state.close = () => { try { ws.close(); } catch (_) {} };
  return state;
}

(async () => {
  const [controlPort, proxyPort, adminPort, claimPort] = await Promise.all([freePort(), freePort(), freePort(), freePort()]);
  const adminToken = 'test-admin-' + Math.random().toString(16).slice(2);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-test-'));
  const cfgPath = path.join(tmpDir, 'tunnel-config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    controlPort, controlBindHost: '127.0.0.1',
    proxyPort, bindHost: '127.0.0.1',
    adminPort, adminToken,
    claimPort,
    publicControlUrl: `ws://127.0.0.1:${controlPort}/agent`,
    allowedPorts: [443],
    allowedHostSuffixes: ['facebook.com', 'fbcdn.net'],
    storePath: path.join(tmpDir, 'dealerships.json'),
    claimTtlMinutes: 60,
    dealerships: [],
  }));

  const child = spawn(process.execPath, [path.join(__dirname, 'src', 'index.js')], { env: { ...process.env, TUNNEL_CONFIG: cfgPath }, stdio: ['ignore', 'pipe', 'pipe'] });
  let childLog = '';
  child.stdout.on('data', (d) => { childLog += d; });
  child.stderr.on('data', (d) => { childLog += d; });

  const adminBase = `http://127.0.0.1:${adminPort}`;
  const claimBase = `http://127.0.0.1:${claimPort}`;
  const adminH = { 'x-admin-token': adminToken };
  const create = (name) => httpJson('POST', `${adminBase}/admin/dealerships`, { headers: adminH, body: { name } });
  const claim = (code) => httpJson('POST', `${claimBase}/claim`, { body: { code } });

  let up = false;
  for (let i = 0; i < 60; i += 1) { try { const r = await httpJson('GET', `${claimBase}/health`); if (r.status === 200) { up = true; break; } } catch (_) { /* booting */ } await sleep(100); }

  try {
    ok('tunnel booted (claim /health 200)', up, childLog);
    if (!up) throw new Error('tunnel did not boot');

    const noauth = await httpJson('GET', `${adminBase}/admin/dealerships`);
    ok('admin rejects missing token (401)', noauth.status === 401, `got ${noauth.status}`);

    const created = await create('Test Motors');
    ok('create dealership (201 + claimCode + proxyAuth)', created.status === 201 && !!created.json.claimCode && !!(created.json.proxyAuth && created.json.proxyAuth.pass), JSON.stringify(created.json));
    const code = created.json && created.json.claimCode;
    const id = created.json && created.json.id;

    const claimed = await claim(code);
    const cfg = claimed.json && claimed.json.config;
    ok('claim returns config (200 + token + controlUrl)', claimed.status === 200 && !!cfg && !!cfg.dealershipToken && !!cfg.controlUrl, JSON.stringify(claimed.json));
    ok('claim config withholds proxyAuth (secret not leaked)', !!cfg && cfg.proxyAuth === undefined);
    ok('claim config carries allowedHostSuffixes (agent allowlist preserved)', !!cfg && Array.isArray(cfg.allowedHostSuffixes) && cfg.allowedHostSuffixes.includes('facebook.com'), JSON.stringify(cfg && cfg.allowedHostSuffixes));
    ok('claim config carries a reps array', !!cfg && Array.isArray(cfg.reps) && cfg.reps.length >= 1, JSON.stringify(cfg && cfg.reps));
    const token = cfg && cfg.dealershipToken;
    const controlUrl = cfg && cfg.controlUrl;

    const good = await wsProbe(controlUrl, token);
    ok('agent connects with claimed token (stays open)', good.opened && good.closed === null, JSON.stringify(good));

    const bad = await wsProbe(controlUrl, 'not-a-real-token-000000000000');
    ok('wrong token rejected (closed 4001)', bad.closed === 4001, JSON.stringify(bad));

    const reclaim = await claim(code);
    ok('re-claim same code rejected (409 already_claimed)', reclaim.status === 409 && reclaim.json.reason === 'already_claimed', JSON.stringify(reclaim.json));

    const bogus = await claim('ZZZZ-ZZZZ');
    ok('bogus code rejected (404 not_found)', bogus.status === 404, JSON.stringify(bogus.json));

    const list = await httpJson('GET', `${adminBase}/admin/dealerships`, { headers: adminH });
    const rec = list.json && list.json.dealerships && list.json.dealerships.find((d) => d.id === id);
    ok('list shows dealership claimed + no token/pass fields', !!rec && rec.claimed === true && rec.agentToken === undefined && rec.dashboard === undefined, JSON.stringify(rec));

    const rotated = await httpJson('POST', `${adminBase}/admin/dealerships/${encodeURIComponent(id)}/rotate`, { headers: adminH });
    ok('rotate returns new token + fresh claim code', rotated.status === 200 && !!rotated.json.agentToken && rotated.json.agentToken !== token && !!rotated.json.claimCode, JSON.stringify(rotated.json));
    const newToken = rotated.json && rotated.json.agentToken;
    const oldNow = await wsProbe(controlUrl, token);
    ok('old token rejected after rotate (closed 4001)', oldNow.closed === 4001, JSON.stringify(oldNow));
    const newNow = await wsProbe(controlUrl, newToken);
    ok('new (rotated) token accepted', newNow.opened && newNow.closed === null, JSON.stringify(newNow));

    // --- live eviction: revoke must drop an ACTIVELY-connected agent immediately ---
    const d2 = await create('Evict Revoke');
    const c2 = await claim(d2.json.claimCode);
    const live2 = wsLive(controlUrl, c2.json.config.dealershipToken);
    await sleep(500);
    const wasOpen2 = live2.opened && live2.closedCode === null;
    await httpJson('POST', `${adminBase}/admin/dealerships/${encodeURIComponent(d2.json.id)}/revoke`, { headers: adminH });
    await sleep(700);
    ok('revoke force-disconnects a LIVE agent (4001)', wasOpen2 && live2.closedCode === 4001, `open=${wasOpen2} closed=${live2.closedCode}`);
    live2.close();

    // --- live eviction: rotate must drop the old ACTIVE connection immediately ---
    const d3 = await create('Evict Rotate');
    const c3 = await claim(d3.json.claimCode);
    const live3 = wsLive(controlUrl, c3.json.config.dealershipToken);
    await sleep(500);
    const wasOpen3 = live3.opened && live3.closedCode === null;
    await httpJson('POST', `${adminBase}/admin/dealerships/${encodeURIComponent(d3.json.id)}/rotate`, { headers: adminH });
    await sleep(700);
    ok('rotate force-disconnects the old LIVE agent (4001)', wasOpen3 && live3.closedCode === 4001, `open=${wasOpen3} closed=${live3.closedCode}`);
    live3.close();

    // --- rate limit LAST (it trips the per-IP window for the rest of the run) ---
    let got429 = false;
    for (let i = 0; i < 25; i += 1) { const r = await claim(`RATE-${i}`); if (r.status === 429) { got429 = true; break; } }
    ok('per-IP rate limit trips (429)', got429);

    const reissue = await httpJson('POST', `${adminBase}/admin/dealerships/${encodeURIComponent(id)}/reissue`, { headers: adminH });
    ok('reissue returns a fresh claim code', reissue.status === 200 && !!reissue.json.claimCode, JSON.stringify(reissue.json));

    const revoked = await httpJson('POST', `${adminBase}/admin/dealerships/${encodeURIComponent(id)}/revoke`, { headers: adminH });
    ok('revoke removes dealership (200)', revoked.status === 200 && revoked.json.removed === true, JSON.stringify(revoked.json));
    const afterRevoke = await wsProbe(controlUrl, newToken);
    ok('revoked token rejected (closed 4001)', afterRevoke.closed === 4001, JSON.stringify(afterRevoke));
  } catch (e) {
    failed += 1;
    console.log('  ERROR', e.message);
  } finally {
    try { child.kill(); } catch (_) { /* ignore */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }

  console.log(`\n${failed === 0 ? 'ALL PASS' : 'FAILURES'} — ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
