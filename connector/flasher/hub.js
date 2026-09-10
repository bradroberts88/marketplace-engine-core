'use strict';
/*
 * flasher/hub.js — get a one-time claim code for the card being flashed. Two paths:
 *   1. PASTE (default, MVP): the operator mints the code on the super-admin "Ship a Pi" page and the VA pastes it.
 *      hub.js just normalizes + validates the format. No network, nothing to misconfigure.
 *   2. LIVE (optional): if AUTOPOST_ADMIN_URL + AUTOPOST_ADMIN_TOKEN are set, list/mint against the tunnel admin
 *      API documented in CLAIM-ONBOARDING.md (GET/POST /admin/dealerships, x-admin-token). Off unless configured.
 *
 * The claim code is 8 Crockford-base32 chars (I L O U excluded), usually shown grouped `K7QP-3M2R` (src/claim.js).
 */
const https = require('https');
const http = require('http');
const { URL } = require('url');

const ADMIN_URL = process.env.AUTOPOST_ADMIN_URL || null;     // e.g. https://tunnel.marketplaceautopost.com
const ADMIN_TOKEN = process.env.AUTOPOST_ADMIN_TOKEN || null; // x-admin-token
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // no I, L, O, U

// Normalize a pasted code to the exact token the /claim endpoint expects: uppercase, strip spaces/dashes,
// map the visually-ambiguous I/L->1 and O->0 (Crockford's own rule) so a hand-typed code still redeems.
function normalizeCode(raw) {
  let c = String(raw || '').toUpperCase().replace(/[\s-]+/g, '');
  c = c.replace(/[ILO]/g, (ch) => (ch === 'O' ? '0' : '1')).replace(/U/g, 'V');
  return c;
}
function isValidCode(raw) {
  const c = normalizeCode(raw);
  if (c.length !== 8) return false;
  for (const ch of c) if (!CROCKFORD.includes(ch)) return false;
  return true;
}

function req(method, pathname, body) {
  return new Promise((resolve, reject) => {
    if (!ADMIN_URL || !ADMIN_TOKEN) return reject(new Error('no admin API configured'));
    let u; try { u = new URL(pathname, ADMIN_URL); } catch (e) { return reject(e); }
    const lib = u.protocol === 'http:' ? http : https;
    const payload = body ? JSON.stringify(body) : null;
    const r = lib.request(u, {
      method,
      headers: { 'x-admin-token': ADMIN_TOKEN, ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}) },
      timeout: 12000,
    }, (res) => {
      let d = ''; res.on('data', (x) => { d += x; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) { try { resolve(JSON.parse(d || '{}')); } catch (e) { reject(new Error('bad JSON from admin API')); } }
        else reject(new Error('admin API ' + res.statusCode + ': ' + d.slice(0, 160)));
      });
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('admin API timeout')); });
    if (payload) r.write(payload);
    r.end();
  });
}

// List dealerships (live path). MVP default: tell the UI to use the paste box.
async function listDealerships() {
  if (!ADMIN_URL || !ADMIN_TOKEN) return { ok: false, needsPaste: true, reason: 'paste the code from the Ship-a-Pi page (no admin API configured)' };
  try {
    const out = await req('GET', '/admin/dealerships');
    const rows = Array.isArray(out) ? out : (out.dealerships || []);
    return { ok: true, dealerships: rows.map((d) => ({ id: d.id, name: d.name, city: d.city, state: d.state })) };
  } catch (e) { return { ok: false, needsPaste: true, reason: e.message }; }
}

// Mint a fresh claim code for a dealership (live path). Returns { code, claimUrl }.
async function mintCode(dealershipId) {
  if (!ADMIN_URL || !ADMIN_TOKEN) return { ok: false, needsPaste: true, reason: 'no admin API configured' };
  try {
    // reissue if we know the dealership; else create-with-name would be a different call the operator drives on the page.
    const out = await req('POST', '/admin/dealerships/' + encodeURIComponent(dealershipId) + '/reissue');
    const code = out.code || out.claimCode;
    if (!code) return { ok: false, reason: 'admin API returned no code' };
    return { ok: true, code, claimUrl: out.claimUrl || (process.env.AUTOPOST_CLAIM_URL || 'https://marketplaceautopost.com/claim') };
  } catch (e) { return { ok: false, reason: e.message }; }
}

module.exports = { normalizeCode, isValidCode, listDealerships, mintCode };
