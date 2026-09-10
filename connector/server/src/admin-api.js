'use strict';

/*
 * Admin API — localhost-only HTTP the super-admin platform (co-located on the VPS) calls to manage the tunnel.
 * Token-authenticated (x-admin-token) and bound to 127.0.0.1 — never exposed to the network.
 *
 *   GET  /admin/status                          -> { agents: [...] }                live agent registry
 *   GET  /admin/events/<id>                     -> { dealershipId, events: [...] }  per-dealership log
 *   POST /admin/pause/<id>                      -> { ok, paused:true }              egress OFF (fail-closed)
 *   POST /admin/resume/<id>                     -> { ok, paused:false }             egress ON
 *   POST /admin/restart/<id>                    -> { ok, detail }                   remote-restart the agent
 *   GET  /admin/dealerships                     -> { dealerships: [...] }           identities (NO secrets)
 *   POST /admin/dealerships  {name,city,...}    -> { id, claimCode, proxyAuth, ...} create + issue a claim code
 *   POST /admin/dealerships/<id>/reissue        -> { id, claimCode, expiresAt }     fresh one-time claim code
 *   POST /admin/dealerships/<id>/rotate         -> { id, agentToken, claimCode }    rotate token + reissue code
 *   POST /admin/dealerships/<id>/revoke         -> { ok, removed }                  delete the dealership
 * All require header  x-admin-token: <adminToken>.
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function tokenOk(header, token) {
  const a = Buffer.from(String(header || ''));
  const b = Buffer.from(String(token || ''));
  if (!token || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Read a small JSON body, never hanging (resolves on end/error/close/oversize).
function readJson(req, cap = 8192) {
  return new Promise((resolve) => {
    let body = '';
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    req.on('data', (c) => { body += c; if (body.length > cap) { finish(null); try { req.destroy(); } catch (_) { /* ignore */ } } });
    req.on('end', () => { try { finish(JSON.parse(body || '{}')); } catch (_) { finish(null); } });
    req.on('error', () => finish(null));
    req.on('close', () => finish(null));
  });
}

function createAdminApi({ hub, store, token, claimBaseUrl = null, agentBuildPath = null, log = () => {} }) {
  // Read the current agent build the operator wants to push, with its SHA-256 (the integrity check the agent
  // enforces before swapping its own code). Returns null if no build file is present / it looks too small.
  function readBuild() {
    if (!agentBuildPath) return null;
    try {
      const buf = fs.readFileSync(agentBuildPath);
      if (!buf || buf.length < 3000) return null;
      // The detached Ed25519 signature (produced OFF the VPS by the operator's signer) rides alongside the build.
      // Without it the agent refuses the update, so we surface "unsigned" as an error rather than pushing a dud.
      let sigB64 = null;
      try { const s = fs.readFileSync(agentBuildPath + '.sig'); if (s && s.length) sigB64 = s.toString('base64'); } catch (_) { sigB64 = null; }
      return { codeB64: buf.toString('base64'), sha256: crypto.createHash('sha256').update(buf).digest('hex'), sigB64, bytes: buf.length };
    } catch (_) { return null; }
  }
  // Read a signed build of a whitelisted NON-agent file, staged as <buildDir>/<file>-build (+ .sig) next to the
  // agent build. filename is basename-only + whitelisted so this can never read/serve an arbitrary path.
  const FILE_WHITELIST = ['dashboard.js', 'tunnel.js', 'preview-ui.js'];
  function readFileBuild(filename) {
    if (!agentBuildPath) return null;
    const base = path.basename(String(filename || ''));
    if (!FILE_WHITELIST.includes(base)) return { error: 'not_whitelisted' };
    const p = path.join(path.dirname(agentBuildPath), base + '-build');
    try {
      const buf = fs.readFileSync(p);
      if (!buf || buf.length < 200) return null;
      let sigB64 = null;
      try { const s = fs.readFileSync(p + '.sig'); if (s && s.length) sigB64 = s.toString('base64'); } catch (_) { sigB64 = null; }
      return { filename: base, codeB64: buf.toString('base64'), sha256: crypto.createHash('sha256').update(buf).digest('hex'), sigB64, bytes: buf.length };
    } catch (_) { return null; }
  }
  const server = http.createServer(async (req, res) => {
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
    try {
      if (!tokenOk(req.headers['x-admin-token'], token)) return send(401, { error: 'unauthorized' });
      const url = (req.url || '').split('?')[0];
      let m;

      // ---- hub / agent liveness ----
      // agents = LIVE registry; lastKnown = persistent per-device post-mortem (last vitals + why-offline verdict)
      // that outlives the live entry, so the super-admin can diagnose a device that is CURRENTLY offline.
      if (req.method === 'GET' && url === '/admin/status') return send(200, { agents: hub.listAgents(), lastKnown: hub.getLastKnown() });
      if (req.method === 'GET' && (m = /^\/admin\/events\/([^/]+)$/.exec(url))) {
        const id = decodeURIComponent(m[1]);
        return send(200, { dealershipId: id, events: hub.getEvents(id) });
      }
      if (req.method === 'POST' && (m = /^\/admin\/pause\/([^/]+)$/.exec(url))) {
        const id = decodeURIComponent(m[1]); const paused = hub.setPaused(id, true);
        log(`admin: turn OFF ${id}`); return send(200, { ok: true, dealershipId: id, paused });
      }
      if (req.method === 'POST' && (m = /^\/admin\/resume\/([^/]+)$/.exec(url))) {
        const id = decodeURIComponent(m[1]); const paused = hub.setPaused(id, false);
        log(`admin: turn ON ${id}`); return send(200, { ok: true, dealershipId: id, paused });
      }
      if (req.method === 'POST' && (m = /^\/admin\/restart\/([^/]+)$/.exec(url))) {
        const id = decodeURIComponent(m[1]); const ok = hub.restartAgent(id, 'super-admin');
        log(`admin: restart ${id} -> ${ok ? 'sent' : 'not connected'}`);
        return send(ok ? 200 : 409, { ok, dealershipId: id, detail: ok ? 'restart sent' : 'agent not connected' });
      }
      // ---- DATA-PLANE SELF-TEST (watchdog): does this agent actually open a socket to Facebook right now? ----
      // Catches a WEDGED agent (control channel live, but far-sockets dead — the 2026-07-13 failure). The watchdog
      // polls this and restarts the agent when it fails; live=true alone is NOT proof the tunnel carries traffic.
      if (req.method === 'POST' && (m = /^\/admin\/selftest\/([^/]+)$/.exec(url))) {
        const id = decodeURIComponent(m[1]);
        const r = await hub.selfTest(id);
        log(`admin: selftest ${id} -> ${r.ok ? 'OK' : (r.skip ? 'SKIP (' + r.detail + ')' : 'WEDGED (' + r.detail + ')')}`);
        return send(200, { dealershipId: id, ...r });
      }
      // ---- SET WIFI (onboarding: push the dealership's WiFi so the box auto-joins when powered on there) ----
      if (req.method === 'POST' && (m = /^\/admin\/wifi\/([^/]+)$/.exec(url))) {
        const id = decodeURIComponent(m[1]);
        const body = await readJson(req);
        const ssid = body && String(body.ssid || '').trim();
        const password = body ? String(body.password != null ? body.password : '') : '';
        // MULTI-NETWORK: action 'set' (add/update, keeps the others) | 'prefer' (switch to it) | 'remove'.
        // priority: higher wins when both are in range (e.g. dealership WiFi 20, phone hotspot 10 as the backup).
        const action = body && ['set', 'prefer', 'remove'].includes(String(body.action)) ? String(body.action) : 'set';
        const priority = Math.max(0, Math.min(99, parseInt(body && body.priority, 10) || 10));
        // hidden = non-broadcasting SSID; enterpriseUser = WPA-Enterprise (802.1x) identity. Both common at
        // dealerships; without them the box cannot join those networks at all.
        const hidden = !!(body && body.hidden);
        const enterpriseUser = body ? String(body.enterpriseUser || '').trim() : '';
        if (!ssid) return send(400, { error: 'ssid is required' });
        const ok = hub.setWifi(id, ssid, password, { action, priority, hidden, enterpriseUser });
        log(`admin: wifi-${action} ${id} -> ${ok ? 'sent' : 'not connected'} (ssid ${ssid}${hidden ? ', hidden' : ''}${enterpriseUser ? ', enterprise' : ''})`); // password NOT logged
        return send(ok ? 200 : 409, { ok, dealershipId: id, ssid, action, priority, hidden, enterprise: !!enterpriseUser, detail: ok ? `wifi ${action} sent (the box keeps every saved network and auto-joins whichever is in range, preferring the highest priority)` : 'agent not connected' });
      }

      // ---- remote UPGRADE (push the current agent build to a connected agent; hash-verified on the agent) ----
      if (req.method === 'POST' && (m = /^\/admin\/update\/([^/]+)$/.exec(url))) {
        const id = decodeURIComponent(m[1]);
        const build = readBuild();
        if (!build) return send(500, { error: 'no agent build available on the server (set agentBuildPath)' });
        if (!build.sigB64) return send(400, { error: 'agent build is not signed (missing agent-build.js.sig) — sign it off-VPS first; the agent refuses unsigned builds' });
        const version = build.sha256.slice(0, 12);
        const ok = hub.updateAgent(id, { ...build, version });
        log(`admin: update ${id} -> ${ok ? 'sent' : 'not connected'} (sha ${version}, ${build.bytes}b, signed)`);
        return send(ok ? 200 : 409, { ok, dealershipId: id, sha256: build.sha256, bytes: build.bytes, detail: ok ? 'update sent (agent verifies signature + self-tests + swaps + restarts)' : 'agent not connected' });
      }

      // ---- remote FILE update (push a signed build of a whitelisted NON-agent file, e.g. dashboard.js) ----
      if (req.method === 'POST' && (m = /^\/admin\/update-file\/([^/]+)$/.exec(url))) {
        const id = decodeURIComponent(m[1]);
        const q = require('url').parse(req.url, true).query || {};
        const file = q.file || (await readJson(req).catch(() => ({}))).file;
        const build = readFileBuild(file);
        if (build && build.error === 'not_whitelisted') return send(400, { error: `"${file}" is not an updatable file (allowed: ${FILE_WHITELIST.join(', ')})` });
        if (!build) return send(500, { error: `no signed build staged for "${file}" (expected ${file}-build + .sig next to the agent build)` });
        if (!build.sigB64) return send(400, { error: `${file}-build is not signed (missing ${file}-build.sig) — sign it off-VPS first` });
        const ok = hub.updateAgentFile(id, build);
        log(`admin: update-file ${id} <- ${build.filename} -> ${ok ? 'sent' : 'not connected'} (sha ${build.sha256.slice(0, 12)}, ${build.bytes}b, signed)`);
        return send(ok ? 200 : 409, { ok, dealershipId: id, filename: build.filename, sha256: build.sha256, bytes: build.bytes, detail: ok ? 'file update sent (agent verifies signature + syntax-checks + backs up + swaps + restarts)' : 'agent not connected' });
      }
      // Fleet update: CANARY-STAGED — push to ONE agent first (?canary=<id>, or the first live one), then the rest
      // only with ?confirm=1. update-all without confirm returns the plan so the operator can watch the canary
      // reconnect on the NEW version before committing the fleet.
      if (req.method === 'POST' && url === '/admin/update-all') {
        const build = readBuild();
        if (!build) return send(500, { error: 'no agent build available on the server (set agentBuildPath)' });
        if (!build.sigB64) return send(400, { error: 'agent build is not signed — sign it off-VPS first' });
        const version = build.sha256.slice(0, 12);
        const q = require('url').parse(req.url, true).query || {};
        const live = hub.listAgents().filter((a) => a.live).map((a) => a.dealershipId);
        const canary = q.canary && live.includes(q.canary) ? q.canary : live[0];
        if (!q.confirm) {
          const target = canary ? [canary] : [];
          const results = target.map((id) => ({ id, sent: hub.updateAgent(id, { ...build, version }) }));
          log(`admin: update-all CANARY -> ${target.join(',') || '(none live)'} (sha ${version}); rest held pending confirm=1`);
          return send(200, { ok: true, staged: 'canary', sha256: build.sha256, canary, remaining: live.filter((id) => id !== canary), results, note: 'Watch the canary reconnect on the new build (GET /admin/status version), then POST /admin/update-all?confirm=1 to push the rest.' });
        }
        const rest = live.filter((id) => id !== canary || q.canary);
        const results = rest.map((id) => ({ id, sent: hub.updateAgent(id, { ...build, version }) }));
        log(`admin: update-all CONFIRM -> ${results.filter((r) => r.sent).length}/${results.length} sent (sha ${version})`);
        return send(200, { ok: true, staged: 'fleet', sha256: build.sha256, results });
      }
      // ---- remote CONFIG (push a whitelisted tuning patch; agent ignores anything but its knobs) ----
      if (req.method === 'POST' && (m = /^\/admin\/config\/([^/]+)$/.exec(url))) {
        const id = decodeURIComponent(m[1]);
        const body = await readJson(req);
        if (!body || typeof body !== 'object') return send(400, { error: 'config object required' });
        const ok = hub.pushConfig(id, body);
        log(`admin: config ${id} -> ${ok ? 'sent' : 'not connected'} (${Object.keys(body).join(',')})`);
        return send(ok ? 200 : 409, { ok, dealershipId: id, detail: ok ? 'config sent' : 'agent not connected' });
      }

      // ---- dealership identity (claim-code onboarding) ----
      if (store && req.method === 'GET' && url === '/admin/dealerships') {
        return send(200, { dealerships: store.list() });
      }
      if (store && req.method === 'POST' && url === '/admin/dealerships') {
        const body = await readJson(req);
        if (!body || !body.name) return send(400, { error: 'name is required' });
        const d = store.createDealership({ name: body.name, city: body.city, state: body.state, timezone: body.timezone, ttlMinutes: body.ttlMinutes });
        log(`admin: created dealership ${d.id}`);
        return send(201, { ...d, claimUrl: claimBaseUrl });
      }
      if (store && req.method === 'POST' && (m = /^\/admin\/dealerships\/([^/]+)\/reissue$/.exec(url))) {
        const id = decodeURIComponent(m[1]);
        const body = await readJson(req);
        const r = store.reissueClaim(id, body && body.ttlMinutes);
        if (!r) return send(404, { error: 'unknown dealership' });
        log(`admin: reissued claim for ${id}`);
        return send(200, { ...r, claimUrl: claimBaseUrl });
      }
      if (store && req.method === 'POST' && (m = /^\/admin\/dealerships\/([^/]+)\/rotate$/.exec(url))) {
        const id = decodeURIComponent(m[1]);
        const newToken = store.rotateToken(id);
        if (!newToken) return send(404, { error: 'unknown dealership' });
        const r = store.reissueClaim(id); // the rotated token must be re-delivered via a fresh claim
        hub.disconnectAgent(id, 'rotated'); // cut the live socket NOW so a stolen old token stops egressing immediately
        log(`admin: rotated token for ${id}`);
        return send(200, { id, agentToken: newToken, claimCode: r.claimCode, expiresAt: r.expiresAt, claimUrl: claimBaseUrl });
      }
      if (store && req.method === 'POST' && (m = /^\/admin\/dealerships\/([^/]+)\/revoke$/.exec(url))) {
        const id = decodeURIComponent(m[1]);
        const removed = store.revoke(id);
        if (removed) hub.disconnectAgent(id, 'revoked'); // drop the live socket + in-flight streams immediately
        log(`admin: revoke ${id} -> ${removed}`);
        return send(removed ? 200 : 404, { ok: removed, removed });
      }

      return send(404, { error: 'not found' });
    } catch (e) {
      log(`admin API error: ${e.message}`);
      try { return send(500, { error: 'internal error' }); } catch (_) { return undefined; }
    }
  });
  return server;
}

module.exports = { createAdminApi };
