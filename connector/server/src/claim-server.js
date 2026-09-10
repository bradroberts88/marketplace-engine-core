'use strict';

/*
 * Claim server — the ONE public endpoint an unconfigured agent calls on first run to self-provision.
 *
 *   POST /claim   { "code": "ABCD-1234" }  ->  200 { config }   (one-time; the agent writes it to config.json)
 *                                              4xx { error, reason }
 *   GET  /health                           ->  200 { ok: true } (monitoring; no secrets)
 *
 * Binds to loopback; nginx/cloudflared terminates TLS in front (same pattern as the control server). Guessing of
 * the 40-bit codes is bounded by: code entropy + 24h expiry + one-time use + the per-IP and global rate limits
 * here (a single source is capped, so it can neither brute-force nor alone exhaust the global budget). The rate
 * limits are a DoS/guessing guard only — they are NOT the auth (the code is). Fails closed on any error.
 */

const http = require('http');

function clientIp(req) {
  // Behind nginx using the standard $proxy_add_x_forwarded_for, the RIGHTMOST X-Forwarded-For entry is the hop
  // nginx appended (the real client as nginx saw it); leftmost entries are attacker-supplied and must NOT be
  // trusted for rate-limit keying. Fall back to the socket peer when there is no proxy header.
  const chain = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (chain.length) return chain[chain.length - 1];
  return req.socket.remoteAddress || 'unknown';
}

function createClaimServer({ store, log = () => {}, windowMs = 600000, maxPerIp = 12, maxGlobal = 200 } = {}) {
  const perIp = new Map();               // ip -> { count, resetAt }
  let global = { count: 0, resetAt: Date.now() + windowMs };

  function limited(ip) {
    const now = Date.now();
    // Per-IP FIRST: a single source is capped at maxPerIp, so it contributes at most maxPerIp to the global
    // counter — one IP can therefore never drive the global cap and deny onboarding for everyone else.
    let b = perIp.get(ip);
    if (!b || now > b.resetAt) { b = { count: 0, resetAt: now + windowMs }; perIp.set(ip, b); }
    b.count += 1;
    if (b.count > maxPerIp) return { blocked: true, scope: 'ip', retryMs: b.resetAt - now };
    // Global counts only requests that already passed the per-IP gate — a last-resort distributed-abuse backstop.
    if (now > global.resetAt) global = { count: 0, resetAt: now + windowMs };
    global.count += 1;
    if (global.count > maxGlobal) return { blocked: true, scope: 'global', retryMs: global.resetAt - now };
    return { blocked: false };
  }

  // Bound memory: drop expired per-IP buckets periodically.
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [ip, b] of perIp) if (now > b.resetAt) perIp.delete(ip);
  }, windowMs);
  if (sweeper.unref) sweeper.unref();

  const server = http.createServer((req, res) => {
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
    const url = (req.url || '').split('?')[0];

    if (req.method === 'GET' && url === '/health') return send(200, { ok: true });

    if (req.method === 'POST' && url === '/claim') {
      const ip = clientIp(req);
      const lim = limited(ip);
      if (lim.blocked) {
        log(`claim RATE-LIMITED (${lim.scope}) from ${ip}`);
        res.setHeader('retry-after', Math.ceil(Math.max(0, lim.retryMs) / 1000));
        return send(429, { error: 'too many requests', reason: 'rate_limited' });
      }
      let body = '';
      let done = false;
      const finish = (fn) => { if (done) return; done = true; fn(); };
      req.on('data', (c) => {
        body += c;
        if (body.length > 4096) { finish(() => send(413, { error: 'payload too large', reason: 'too_large' })); try { req.destroy(); } catch (_) { /* ignore */ } }
      });
      req.on('end', () => finish(() => {
        let code;
        try { code = JSON.parse(body || '{}').code; } catch (_) { return send(400, { error: 'invalid json', reason: 'bad_json' }); }
        try {
          const config = store.claim(code);
          log(`claim OK from ${ip} -> ${config.dealershipId}`);
          return send(200, { ok: true, config });
        } catch (e) {
          log(`claim REJECTED from ${ip}: ${e.reason || e.message}`);
          return send(e.status || 400, { error: e.message, reason: e.reason || 'error' });
        }
      }));
      req.on('error', () => finish(() => { try { send(400, { error: 'request error', reason: 'req_error' }); } catch (_) { /* ignore */ } }));
      req.on('close', () => finish(() => { /* aborted before end — socket gone, nothing to send */ }));
      return undefined;
    }

    return send(404, { error: 'not found', reason: 'not_found' });
  });

  return server;
}

module.exports = { createClaimServer };
