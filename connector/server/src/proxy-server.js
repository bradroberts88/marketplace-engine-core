'use strict';

/*
 * FAIL-CLOSED HTTP CONNECT proxy — what a rep's GoLogin session (custom_proxy = host:port:user:pass) points at.
 * For every CONNECT it: authenticates the proxy user -> resolves the dealership -> checks the dealership's
 * agent is LIVE. If it is not, the request is REFUSED (no fallback, ever). If it is, the byte stream is
 * relayed through the Hub to the dealership agent, which opens the far socket locally so traffic egresses
 * from the dealership's own IP.
 *
 * HTTPS/CONNECT only. Optional destination + port allowlists (set in prod to Facebook only) stop the tunnel
 * from being an open forward proxy that burns the dealership's IP reputation.
 */

const http = require('http');

const OPEN_TIMEOUT_MS = 15000;

// The connector refreshes its control link every ~120s (PLANNED_RECONNECT_MS) to stay under the ~600s network
// middlebox cap, and re-dials after any unplanned cut. That leaves a brief window where no agent is live: a
// planned refresh reconnects in ~250ms (no backoff), but an UNPLANNED cut costs 2-7s of backoff+jitter plus the
// time to notice. Without a grace, a rep browser that opens a CONNECT during that window gets an instant 503
// (this is what failed Roger's posts + spammed the warm inbox). So when the agent is momentarily absent we WAIT
// up to this grace for it to re-dial before refusing. Fail-closed is fully preserved: a genuine outage still
// refuses after the grace (and never falls back to this host's own network). The happy path returns the instant
// the agent is live again, so this adds latency only during a real reconnect.
//
// RAISED 8s -> 15s (2026-08-17). The old 8s was sized for the "2-7s" estimate above, but the real unplanned gaps
// measured in the field were 8-9s — landing exactly ON the limit, so reps were still collecting 503s for a few
// seconds after every middlebox cut. 15s covers the measured gap plus one backoff retry. The cost of being too
// generous is small and one-sided: this only delays how fast a genuinely-offline dealership reports as offline,
// and it stays well inside normal browser timeouts. The cost of being too tight is a failed post.
const RECONNECT_GRACE_MS = Math.max(0, parseInt(process.env.PROXY_RECONNECT_GRACE_MS || '15000', 10));
const LIVE_POLL_MS = 150;

function parseBasicAuth(req) {
  const h = req.headers['proxy-authorization'] || '';
  const m = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(h);
  if (!m) return null;
  let dec;
  try { dec = Buffer.from(m[1], 'base64').toString('utf8'); } catch (_) { return null; }
  const i = dec.indexOf(':');
  if (i < 0) return null;
  return { user: dec.slice(0, i), pass: dec.slice(i + 1) };
}

function hostAllowed(host, suffixes) {
  if (!suffixes || !suffixes.length) return true; // no allowlist configured => any public host (agent still blocks LAN)
  const h = String(host).toLowerCase().replace(/\.$/, '');
  return suffixes.some((s) => { const x = String(s).toLowerCase(); return h === x || h.endsWith('.' + x); });
}

function createProxyServer({ hub, resolveDealership, log, allowedHostSuffixes = null, allowedPorts = [443] }) {
  // Resolve true as soon as the dealership's agent is live, or false once the grace elapses (or the client
  // bails). Polls cheaply; used to ride out the connector's sub-second-to-few-second reconnect gap.
  const waitForLive = (dealershipId, clientSocket) => {
    if (hub.isLive(dealershipId)) return Promise.resolve(true);
    if (RECONNECT_GRACE_MS <= 0) return Promise.resolve(false);
    return new Promise((resolve) => {
      const deadline = Date.now() + RECONNECT_GRACE_MS;
      const iv = setInterval(() => {
        if (hub.isLive(dealershipId)) { clearInterval(iv); resolve(true); }
        else if (clientSocket.destroyed || Date.now() >= deadline) { clearInterval(iv); resolve(false); }
      }, LIVE_POLL_MS);
    });
  };

  // Plain HTTP requests are not proxied (would be plaintext egress); only CONNECT is honored.
  const server = http.createServer((req, res) => {
    res.writeHead(405, { 'content-type': 'text/plain' });
    res.end('This is an HTTPS (CONNECT) tunnel proxy only.\n');
  });

  server.on('connect', async (req, clientSocket, head) => {
    clientSocket.on('error', () => { /* client vanished; stream cleanup handles the rest */ });

    const deny = (code, reason) => {
      try { clientSocket.write(`HTTP/1.1 ${code} ${reason}\r\n\r\n`); } catch (_) { /* ignore */ }
      try { clientSocket.destroy(); } catch (_) { /* ignore */ }
    };

    const auth = parseBasicAuth(req);
    if (!auth) return deny(407, 'Proxy Authentication Required');
    const dealershipId = resolveDealership(auth);
    if (!dealershipId) return deny(403, 'Forbidden');

    // FAIL CLOSED: no live tunnel for this dealership => refuse. Never fall back to this host's own network.
    // But first ride out the connector's brief keep-alive reconnect gap (see RECONNECT_GRACE_MS) so a post that
    // opens mid-reconnect is not falsely 503'd. A genuine outage still refuses after the grace.
    if (!hub.isLive(dealershipId)) {
      const back = await waitForLive(dealershipId, clientSocket);
      if (clientSocket.destroyed) return; // client gave up during the wait; nothing to answer
      if (!back) {
        log(`REFUSED (fail-closed): dealership ${dealershipId} tunnel offline (waited ${RECONNECT_GRACE_MS}ms) -> ${req.url}`);
        return deny(503, 'Tunnel Offline');
      }
      log(`tunnel ${dealershipId} live again within grace -> ${req.url}`);
    }

    const target = String(req.url || '');
    const lastColon = target.lastIndexOf(':');
    const host = lastColon > 0 ? target.slice(0, lastColon) : '';
    const port = parseInt(target.slice(lastColon + 1), 10);
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return deny(400, 'Bad Target');
    if (allowedPorts && allowedPorts.length && !allowedPorts.includes(port)) return deny(403, 'Port Not Allowed');
    if (!hostAllowed(host, allowedHostSuffixes)) { log(`REFUSED off-allowlist: ${host}`); return deny(403, 'Destination Not Allowed'); }

    let settled = false;
    let timer = null;
    const finish = (fn) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); fn(); };

    const id = hub.openStream(dealershipId, host, port, clientSocket, {
      onOpened: () => finish(() => {
        try { clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); }
        catch (_) { hub.closeStream(id); return; }
        if (head && head.length) hub.sendData(id, head);
        clientSocket.on('data', (buf) => hub.sendData(id, buf));
      }),
      onFailed: () => finish(() => deny(502, 'Tunnel Connect Failed')),
    });

    if (!id) return deny(503, 'Tunnel Offline'); // agent vanished/stale/at-cap between isLive and openStream

    // Client disconnect at ANY point (before OR after the tunnel opens) tears the stream down and tells the
    // agent to close its far socket — so a client that bails during the up-to-15s open window never leaves a
    // live egress socket dangling.
    const onGone = () => { if (!settled) finish(() => hub.closeStream(id)); else hub.closeStream(id); };
    clientSocket.on('close', onGone);
    clientSocket.on('end', onGone);

    timer = setTimeout(() => finish(() => { hub.closeStream(id); deny(504, 'Tunnel Open Timeout'); }), OPEN_TIMEOUT_MS);
  });

  return server;
}

module.exports = { createProxyServer };
