'use strict';

/*
 * DealershipStore — DB-backed dealership identity for the tunnel (replaces the static config.dealerships[]).
 *
 * WHY: today every dealership is hand-written into config.json and adding one means editing the file + a full
 * tunnel restart (which drops every OTHER dealership's live agent). That does not scale past a handful. This
 * store keeps identities in a small JSON file that is mutated HOT — create a dealership and its agent can
 * connect immediately, no restart, no impact on anyone else. It is also the backend for CLAIM-CODE onboarding:
 * the operator creates a dealership -> gets a short one-time code -> the dealership types it into the app once
 * and the app self-configures (no hand-edited config.json, no per-dealership tunnel process).
 *
 * SECURITY:
 *   - agentToken: 24 random bytes (48 hex) — the credential the agent authenticates the control WS with.
 *   - proxyAuth.pass: 18 random bytes — the credential the co-located GoLogin/worker uses on the CONNECT proxy.
 *   - claim code: 8 Crockford-base32 chars (~40 bits), ONE-TIME, EXPIRES (default 24h). Guessing is stopped by
 *     the code entropy + expiry + one-time use + the claim server's per-IP and global rate limits.
 *   - the public claim response carries ONLY what the agent needs (controlUrl, token, dashboard login). It never
 *     returns proxyAuth (that is the worker's, delivered to the operator via the localhost admin API) or the
 *     admin token.
 *   - proxy password compare is timing-safe (matches the tunnel's existing safeEqual).
 *
 * Persistence is a single JSON file with an atomic write (tmp + rename). Writes are rare (a dealership create /
 * claim / rotate), so a plain file is plenty and keeps the tunnel dependency-free (crypto + fs only).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Crockford base32 minus the ambiguous letters (I, L, O, U) — human-typeable claim codes.
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CONFUSABLES = { I: '1', L: '1', O: '0', U: 'V' };

function randomB32(len) {
  const bytes = crypto.randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i += 1) s += B32[bytes[i] % 32];
  return s;
}
function formatCode(raw) { return raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw; }
// Accept what a human actually types: lowercase, spaces, dashes, and the confusable letters O/I/L/U.
function normalizeCode(input) {
  return String(input || '')
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/[ILOU]/g, (c) => CONFUSABLES[c] || c);
}
function slugify(name) {
  return String(name || 'dealership')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'dealership';
}
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

class DealershipStore {
  /*
   * defaults: { publicControlUrl, allowedPorts, heartbeatMs, agentVersion, claimTtlMinutes, maxClaimAttempts }
   * — used to build the config handed back on a successful claim.
   */
  constructor({ storePath, defaults = {}, log = () => {} } = {}) {
    this.storePath = storePath;
    this.log = log;
    this.defaults = {
      publicControlUrl: defaults.publicControlUrl || null,
      allowedPorts: Array.isArray(defaults.allowedPorts) ? defaults.allowedPorts : [443],
      allowedHostSuffixes: Array.isArray(defaults.allowedHostSuffixes) ? defaults.allowedHostSuffixes : null,
      heartbeatMs: defaults.heartbeatMs || 20000,
      agentVersion: defaults.agentVersion || '0.1.0',
      claimTtlMinutes: Math.max(5, defaults.claimTtlMinutes || 1440),
    };
    this.dealerships = new Map(); // id -> record
    this._load();
    this._reindex();
  }

  _load() {
    let raw;
    try { raw = fs.readFileSync(this.storePath, 'utf8'); }
    catch (e) { if (e.code === 'ENOENT') return; throw e; } // absent = fresh start; any other read error must surface
    let arr;
    try { arr = JSON.parse(raw); }
    catch (e) {
      // The file EXISTS but is corrupt/truncated. Starting empty here would let the next _persist() OVERWRITE it
      // and permanently erase every dealership identity. Preserve the bad file and refuse to start so the operator
      // restores a good copy (or deletes the .corrupt file to start fresh).
      const aside = `${this.storePath}.corrupt-${Date.now()}`;
      try { fs.renameSync(this.storePath, aside); } catch (_) { /* best effort */ }
      throw new Error(`dealership store at ${this.storePath} is corrupt (${e.message}); moved aside to ${aside}. Refusing to start so identities are not overwritten.`);
    }
    if (Array.isArray(arr)) for (const d of arr) if (d && d.id) this.dealerships.set(d.id, d);
    this.log(`store loaded ${this.dealerships.size} dealership(s) from ${this.storePath}`);
  }

  _persist() {
    const arr = Array.from(this.dealerships.values());
    const dir = path.dirname(this.storePath);
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* exists */ }
    const tmp = `${this.storePath}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(arr, null, 2), { mode: 0o600 });
      try { const fd = fs.openSync(tmp, 'r'); fs.fsyncSync(fd); fs.closeSync(fd); } catch (_) { /* fsync best-effort */ }
      fs.renameSync(tmp, this.storePath);
    } catch (e) {
      // Fallback for filesystems where rename-over-existing is flaky: write in place. Less atomic, still correct.
      try { fs.writeFileSync(this.storePath, JSON.stringify(arr, null, 2), { mode: 0o600 }); }
      catch (e2) { this.log(`store PERSIST FAILED: ${e2.message}`); throw e2; }
    }
    try { fs.chmodSync(this.storePath, 0o600); } catch (_) { /* windows / best-effort */ }
  }

  _reindex() {
    this.byToken = new Map();      // agentToken -> id
    this.byProxyUser = new Map();  // proxyUser  -> record
    this.byClaimCode = new Map();  // normalized claim code -> id
    for (const d of this.dealerships.values()) {
      if (d.agentToken) this.byToken.set(String(d.agentToken), d.id);
      if (d.proxyAuth && d.proxyAuth.user) this.byProxyUser.set(String(d.proxyAuth.user), d);
      // Index every record that still carries a code so a KNOWN code returns a PRECISE state (claimed / expired /
      // too-many-attempts) while an UNKNOWN code returns not_found. Bounded to one entry per dealership — a
      // superseded code (after reissue/rotate) drops on the next reindex.
      if (d.claim && d.claim.code) this.byClaimCode.set(normalizeCode(d.claim.code), d.id);
    }
  }

  _uniqueId(name) {
    const base = slugify(name);
    for (let i = 0; i < 50; i += 1) {
      const id = `${base}-${crypto.randomBytes(2).toString('hex')}`;
      if (!this.dealerships.has(id)) return id;
    }
    return `${base}-${crypto.randomBytes(6).toString('hex')}`;
  }

  // Import pre-existing config.dealerships[] once (so a legacy config keeps working). They are marked already
  // claimed (they were provisioned by hand) and never overwrite a record already in the store.
  importSeed(list) {
    if (!Array.isArray(list)) return 0;
    let added = 0;
    for (const d of list) {
      if (!d || !d.id || this.dealerships.has(d.id)) continue;
      if (!d.agentToken || !d.proxyAuth || !d.proxyAuth.user || !d.proxyAuth.pass) continue;
      this.dealerships.set(d.id, {
        id: d.id,
        name: d.name || d.id,
        agentToken: String(d.agentToken),
        proxyAuth: { user: String(d.proxyAuth.user), pass: String(d.proxyAuth.pass) },
        dashboard: d.dashboard || { user: 'manager', pass: crypto.randomBytes(6).toString('hex') },
        allowedPorts: d.allowedPorts || null,
        createdAt: Date.now(),
        source: 'seed',
        claim: { code: null, claimedAt: Date.now(), expiresAt: 0, attempts: 0 },
      });
      added += 1;
    }
    if (added) { this._persist(); this._reindex(); this.log(`seeded ${added} pre-existing dealership(s) into the store`); }
    return added;
  }

  // Operator creates a dealership (localhost admin API). Returns the claim code + the proxy creds the operator
  // needs to point the rep's GoLogin at. Secrets returned here are for the TRUSTED operator only.
  createDealership({ name, city, state, timezone, ttlMinutes } = {}) {
    const id = this._uniqueId(name);
    const ttl = Math.max(5, ttlMinutes || this.defaults.claimTtlMinutes);
    const code = randomB32(8);
    const rec = {
      id,
      name: name || id,
      city: city || null,
      state: state || null,
      timezone: timezone || null,
      agentToken: crypto.randomBytes(24).toString('hex'),
      proxyAuth: { user: `d-${id}`.slice(0, 40), pass: crypto.randomBytes(18).toString('base64url') },
      dashboard: { user: 'manager', pass: crypto.randomBytes(6).toString('hex') },
      allowedPorts: this.defaults.allowedPorts,
      createdAt: Date.now(),
      source: 'claim',
      claim: { code, claimedAt: null, expiresAt: Date.now() + ttl * 60000, attempts: 0 },
    };
    this.dealerships.set(id, rec);
    this._persist();
    this._reindex();
    this.log(`dealership created: ${id} (claim code issued, expires in ${ttl}m)`);
    return {
      id,
      name: rec.name,
      claimCode: formatCode(code),
      expiresAt: rec.claim.expiresAt,
      proxyAuth: rec.proxyAuth, // operator needs these to configure GoLogin
    };
  }

  // The agent redeems a claim code (public, rate-limited by the claim server). One-time; returns the config the
  // agent writes to config.json. Throws { status, code } on any failure so the caller maps it to an HTTP code.
  claim(codeInput) {
    const norm = normalizeCode(codeInput);
    if (!norm || norm.length < 6) { const e = new Error('bad code'); e.status = 400; e.reason = 'malformed'; throw e; }
    if (!this.defaults.publicControlUrl) { const e = new Error('claim not configured'); e.status = 503; e.reason = 'no_control_url'; throw e; }

    const id = this.byClaimCode.get(norm);
    const rec = id ? this.dealerships.get(id) : null;
    if (!rec || !rec.claim) { const e = new Error('invalid or expired code'); e.status = 404; e.reason = 'not_found'; throw e; }

    // Count the attempt against the record regardless of outcome, then persist (defense against slow brute force
    // even if a code somehow leaked — a code with too many attempts is burned).
    rec.claim.attempts = (rec.claim.attempts || 0) + 1;
    if (rec.claim.claimedAt) { this._persist(); const e = new Error('this code was already used'); e.status = 409; e.reason = 'already_claimed'; throw e; }
    if (rec.claim.expiresAt <= Date.now()) { this._persist(); const e = new Error('code expired'); e.status = 410; e.reason = 'expired'; throw e; }

    // Repair a missing dashboard (a legacy seed record may lack one) so building the config can't throw, and
    // build the FULL config BEFORE marking claimedAt — so a construction problem can never burn the one-time code.
    if (!rec.dashboard || !rec.dashboard.user || !rec.dashboard.pass) {
      rec.dashboard = { user: 'manager', pass: crypto.randomBytes(6).toString('hex') };
    }
    const config = {
      dealershipId: rec.id,
      dealership: rec.name,
      controlUrl: this.defaults.publicControlUrl,
      dealershipToken: rec.agentToken,
      dashboard: { port: 4599, user: rec.dashboard.user, pass: rec.dashboard.pass, displayName: rec.name },
      reps: [{ name: rec.name }],
      allowedPorts: rec.allowedPorts || this.defaults.allowedPorts,
      allowedHostSuffixes: rec.allowedHostSuffixes || this.defaults.allowedHostSuffixes, // same host allowlist as a hand-configured agent
      heartbeatMs: this.defaults.heartbeatMs,
      agentVersion: this.defaults.agentVersion,
    };
    rec.claim.claimedAt = Date.now();
    this._persist();
    this.log(`dealership CLAIMED: ${rec.id}`);
    return config;
  }

  resolveAgentToken(tok) {
    return this.byToken.get(String(tok || '')) || null;
  }

  resolveProxy({ user, pass }) {
    const d = this.byProxyUser.get(String(user || ''));
    if (!d || !d.proxyAuth) return null;
    if (!safeEqual(d.proxyAuth.pass, pass)) return null;
    return d.id;
  }

  // Sanitized list for the super-admin (NO tokens/passwords).
  list() {
    const now = Date.now();
    return Array.from(this.dealerships.values()).map((d) => ({
      id: d.id,
      name: d.name,
      source: d.source || null,
      createdAt: d.createdAt || null,
      claimed: !!(d.claim && d.claim.claimedAt),
      claimPending: !!(d.claim && d.claim.code && !d.claim.claimedAt && d.claim.expiresAt > now),
      claimExpiresAt: d.claim ? d.claim.expiresAt : null,
      proxyUser: d.proxyAuth ? d.proxyAuth.user : null,
    }));
  }

  // Rotate a dealership's agent token (kills a leaked/compromised one). The agent using the old token is rejected
  // on its next reconnect; the NEW token must be redelivered (a fresh claim code, below). Returns the new token.
  rotateToken(id) {
    const rec = this.dealerships.get(id);
    if (!rec) return null;
    rec.agentToken = crypto.randomBytes(24).toString('hex');
    this._persist();
    this._reindex();
    this.log(`dealership token ROTATED: ${id}`);
    return rec.agentToken;
  }

  // Issue a fresh one-time claim code for an existing dealership (e.g. after a rotate, or a re-install).
  reissueClaim(id, ttlMinutes) {
    const rec = this.dealerships.get(id);
    if (!rec) return null;
    const ttl = Math.max(5, ttlMinutes || this.defaults.claimTtlMinutes);
    const code = randomB32(8);
    rec.claim = { code, claimedAt: null, expiresAt: Date.now() + ttl * 60000, attempts: 0 };
    this._persist();
    this._reindex();
    this.log(`claim code reissued: ${id} (expires in ${ttl}m)`);
    return { id, claimCode: formatCode(code), expiresAt: rec.claim.expiresAt };
  }

  revoke(id) {
    const existed = this.dealerships.delete(id);
    if (existed) { this._persist(); this._reindex(); this.log(`dealership REVOKED: ${id}`); }
    return existed;
  }

  get size() { return this.dealerships.size; }
}

module.exports = { DealershipStore, normalizeCode, formatCode };
