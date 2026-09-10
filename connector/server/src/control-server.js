'use strict';

/*
 * WS control server — the endpoint each dealership agent dials OUT to. Authenticates the agent by its
 * per-dealership token, hands its messages to the Hub, and runs a server-side ping/pong so a silently-dead
 * agent (PC slept, cable pulled — no clean close) is detected and dropped within ~30s (which fails its
 * streams closed via hub.removeAgent).
 */

const http = require('http');
const WebSocket = require('ws');

const PING_INTERVAL_MS = 15000;

function createControlServer({ hub, resolveAgentToken, port, bindHost, log }) {
  const httpServer = http.createServer((req, res) => { res.writeHead(426); res.end('Upgrade Required'); });
  const wss = new WebSocket.Server({ server: httpServer, path: '/agent', maxPayload: 8 * 1024 * 1024 });

  wss.on('connection', (ws, req) => {
    const dealershipId = resolveAgentToken(req.headers['x-agent-token']);
    if (!dealershipId) {
      log('agent REJECTED: bad/unknown token');
      try { ws.close(4001, 'bad token'); } catch (_) { /* ignore */ }
      return;
    }
    hub.registerAgent(dealershipId, ws);
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; hub.touchAgent(dealershipId); });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch (_) { return; }
      hub.onAgentMessage(dealershipId, msg);
    });
    // Pass the close code/reason through: it is the only signal that tells the agent's own deliberate pre-cap
    // link refresh apart from a genuine drop, and the two deserve very different alerting (see removeAgent).
    ws.on('close', (code, reason) => hub.removeAgent(dealershipId, ws, { code, reason: String(reason || '') }));
    ws.on('error', () => { /* a 'close' will follow; removeAgent handles fail-closed */ });
  });

  const pinger = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { try { ws.terminate(); } catch (_) { /* ignore */ } continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch (_) { /* ignore */ }
    }
  }, PING_INTERVAL_MS);
  wss.on('close', () => clearInterval(pinger));

  httpServer.listen(port, bindHost || '0.0.0.0', () => log(`control server (WS) listening on ${bindHost || '0.0.0.0'}:${port}/agent`));
  return { httpServer, wss };
}

module.exports = { createControlServer };
