'use strict';

/*
 * Claim client — first-run self-provisioning for the agent. POSTs a one-time setup code to the tunnel's public
 * claim endpoint and writes the returned config to config.json, so a dealership NEVER hand-edits a config file.
 *
 * Used two ways:
 *   - by the app's first-run screen (electron-main):  require('./claim').claim({ claimUrl, code, configPath })
 *   - as a CLI (testing / power users):                node src/claim.js <claimUrl> <setup-code> [configPath]
 */

const fs = require('fs');
const path = require('path');

function postJson(url, payload, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (_) { return reject(new Error('invalid claim URL')); }
    const lib = u.protocol === 'https:' ? require('https') : require('http');
    const data = Buffer.from(JSON.stringify(payload));
    const req = lib.request(u, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': data.length } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; if (body.length > 65536) req.destroy(new Error('response too large')); });
      res.on('end', () => { let j = null; try { j = JSON.parse(body || '{}'); } catch (_) { /* non-JSON */ } resolve({ status: res.statusCode, json: j }); });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('claim request timed out')); });
    req.end(data);
  });
}

async function claim({ claimUrl, code, configPath }) {
  if (!claimUrl) throw new Error('claimUrl is required');
  if (!code) throw new Error('a setup code is required');
  const { status, json } = await postJson(claimUrl, { code });
  if (status !== 200 || !json || !json.config) {
    const reason = (json && (json.error || json.reason)) || `HTTP ${status}`;
    const e = new Error(`setup code was not accepted: ${reason}`);
    e.status = status; e.reason = json && json.reason;
    throw e;
  }
  const cfg = json.config;
  if (!cfg.controlUrl || !cfg.dealershipToken) throw new Error('claim response was incomplete (missing controlUrl/token)');
  if (configPath) {
    const dir = path.dirname(configPath);
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* exists */ }
    const tmp = `${configPath}.tmp`;
    const data = JSON.stringify(cfg, null, 2);
    // fsync BEFORE the rename, and fsync the directory after it. Without both, a power cut in the writeback
    // window leaves a zero-length config.json — and a first-boot claim is followed by exactly the kind of
    // unplug-and-move that produces one. The unit is then wedged: too broken to run, too present to re-claim.
    const fd = fs.openSync(tmp, 'w', 0o600);
    try { fs.writeSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    try { fs.renameSync(tmp, configPath); }
    catch (_) { fs.writeFileSync(configPath, data, { mode: 0o600 }); }
    try { const d = fs.openSync(dir, 'r'); try { fs.fsyncSync(d); } finally { fs.closeSync(d); } } catch (_) { /* not supported on Windows */ }
    // Seed the known-good backup at provisioning time, so the agent's recovery path is armed from boot one.
    try { fs.writeFileSync(`${configPath}.bak`, data, { mode: 0o600 }); } catch (_) { /* best effort */ }
  }
  return cfg;
}

module.exports = { claim, postJson };

// CLI entry
if (require.main === module) {
  const [claimUrl, code, cfgArg] = process.argv.slice(2);
  const configPath = cfgArg || process.env.CONNECTOR_CONFIG || path.join(__dirname, '..', 'config.json');
  if (!claimUrl || !code) { console.error('usage: node src/claim.js <claimUrl> <setup-code> [configPath]'); process.exit(2); }
  claim({ claimUrl, code, configPath })
    .then((cfg) => { console.log(`configured for "${cfg.dealership || cfg.dealershipId}" -> ${configPath}`); process.exit(0); })
    .catch((e) => { console.error('claim failed:', e.message); process.exit(1); });
}
