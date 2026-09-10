'use strict';
// Runs the REAL agent against a mock control server and verifies the never-drop liveness plumbing:
// connect -> hello, active ping, and a trustworthy heartbeat.json (connected=true + fresh). Loopback only.
const WebSocket = require('ws');
const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

function freePort() { return new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); }); }

(async () => {
  const ctlPort = await freePort();
  const dashPort = await freePort();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-test-'));
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({
    controlUrl: `ws://127.0.0.1:${ctlPort}/agent`, dealershipToken: 'test-token',
    dashboard: { port: dashPort, user: 'u', pass: 'p' }, heartbeatMs: 1500, allowedPorts: [443], agentVersion: '0.1.0',
  }));

  const wss = new WebSocket.Server({ port: ctlPort, path: '/agent' });
  let gotHello = false, gotHeartbeat = false, pinged = false;
  wss.on('connection', (ws) => {
    ws.on('message', (m) => { try { const j = JSON.parse(m); if (j.type === 'hello') gotHello = true; if (j.type === 'heartbeat') gotHeartbeat = true; } catch (_) {} });
    ws.on('ping', () => { pinged = true; }); // ws auto-replies pong
  });

  const agent = spawn(process.execPath, [path.join(__dirname, 'src', 'agent.js')],
    { env: { ...process.env, CONNECTOR_CONFIG: path.join(tmp, 'config.json'), CONNECTOR_RUNTIME_DIR: tmp }, stdio: ['ignore', 'pipe', 'pipe'] });
  let alog = ''; agent.stdout.on('data', (d) => { alog += d; }); agent.stderr.on('data', (d) => { alog += d; });

  await new Promise((r) => setTimeout(r, 6000));

  let hb = null; try { hb = JSON.parse(fs.readFileSync(path.join(tmp, 'heartbeat.json'), 'utf8')); } catch (_) {}
  const now = Date.now();
  const checks = [];
  const ok = (n, c) => { checks.push(c); console.log((c ? '  PASS  ' : '  FAIL  ') + n); };
  ok('agent connected (hello received)', gotHello);
  ok('agent sent app heartbeat', gotHeartbeat);
  ok('agent sent a liveness PING', pinged);
  ok('heartbeat.json written', !!hb);
  ok('heartbeat connected=true (fresh pong)', !!hb && hb.connected === true);
  ok('heartbeat ts fresh (<5s)', !!hb && (now - hb.ts < 5000));

  try { agent.kill(); } catch (_) {} try { wss.close(); } catch (_) {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  const failed = checks.filter((c) => !c).length;
  if (failed) console.log('\n--- agent log tail ---\n' + alog.slice(-900));
  console.log(`\n${failed ? 'FAILURES' : 'ALL PASS'} — ${checks.length - failed}/${checks.length}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('test error', e); process.exit(1); });
