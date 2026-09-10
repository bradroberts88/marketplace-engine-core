'use strict';
// End-to-end test for the first-run setup screen: stand up the REAL claim server + store, create a dealership,
// run firstrun-ui.js, submit the code to /setup, and verify it writes a valid config.json. Loopback only.
const http = require('http');
const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { DealershipStore } = require('./server/src/dealership-store');
const { createClaimServer } = require('./server/src/claim-server');

function freePort() { return new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); }); }
function req(method, url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url); const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const h = { 'content-type': 'application/json' }; if (data) h['content-length'] = data.length;
    const r = http.request(u, { method, headers: h }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(b || '{}'); } catch (_) {} resolve({ status: res.statusCode, json: j, text: b }); }); });
    r.on('error', reject); r.setTimeout(8000, () => r.destroy(new Error('timeout'))); if (data) r.end(data); else r.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const claimPort = await freePort(); const frPort = await freePort();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-test-'));
  const store = new DealershipStore({ storePath: path.join(tmp, 'store.json'), defaults: { publicControlUrl: 'wss://example.test/agent', allowedPorts: [443], heartbeatMs: 20000, agentVersion: '0.1.0' } });
  const created = store.createDealership({ name: 'Firstrun Test Motors' });
  const claimServer = createClaimServer({ store, log: () => {} });
  await new Promise((r) => claimServer.listen(claimPort, '127.0.0.1', r));

  const configPath = path.join(tmp, 'config.json');
  const fr = spawn(process.execPath, [path.join(__dirname, 'firstrun-ui.js')],
    { env: { ...process.env, AUTOPOST_CLAIM_URL: `http://127.0.0.1:${claimPort}/claim`, AUTOPOST_DASH_PORT: String(frPort), CONNECTOR_CONFIG: configPath }, stdio: ['ignore', 'pipe', 'pipe'] });
  let frlog = ''; fr.stdout.on('data', (d) => { frlog += d; }); fr.stderr.on('data', (d) => { frlog += d; });
  await sleep(1500);

  const checks = [];
  const ok = (n, c) => { checks.push(c); console.log((c ? '  PASS  ' : '  FAIL  ') + n); };

  const page = await req('GET', `http://127.0.0.1:${frPort}/`);
  ok('setup page served', page.status === 200 && /Set up AutoPost/.test(page.text));

  const bad = await req('POST', `http://127.0.0.1:${frPort}/setup`, { code: 'ZZZZ-ZZZZ' });
  ok('bad code -> friendly error', bad.status === 400 && bad.json && bad.json.ok === false && /not recognized/i.test(bad.json.error || ''));

  const good = await req('POST', `http://127.0.0.1:${frPort}/setup`, { code: created.claimCode });
  ok('valid code accepted', good.status === 200 && good.json && good.json.ok === true);
  ok('response names the dealership', good.json && /Firstrun Test Motors/.test(good.json.dealership || ''));

  let cfg = null; try { cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (_) {}
  ok('config.json written', !!cfg);
  ok('config has controlUrl + token + dashboard', !!cfg && cfg.controlUrl === 'wss://example.test/agent' && !!cfg.dealershipToken && !!(cfg.dashboard && cfg.dashboard.user));
  ok('config withholds proxyAuth (secret)', !!cfg && cfg.proxyAuth === undefined);

  const reuse = await req('POST', `http://127.0.0.1:${frPort}/setup`, { code: created.claimCode });
  ok('reused code -> already-used error', reuse.status === 400 && /already used/i.test((reuse.json && reuse.json.error) || ''));

  try { fr.kill(); } catch (_) {} try { claimServer.close(); } catch (_) {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  const failed = checks.filter((c) => !c).length;
  if (failed) console.log('\n--- firstrun log ---\n' + frlog.slice(-700));
  console.log(`\n${failed ? 'FAILURES' : 'ALL PASS'} — ${checks.length - failed}/${checks.length}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('test error', e); process.exit(1); });
