'use strict';
/*
 * Sign an AutoPost agent build with the operator's Ed25519 PRIVATE key (held OFF the VPS). Produces a detached
 * <build>.sig next to it. Upload BOTH the build and the .sig to the tunnel's agentBuildPath; the agent verifies
 * the signature against the public key PINNED in agent.js (UPDATE_PUBKEY_PEM) before it will run any remote update.
 *
 *   node scripts/sign-build.js <path-to-agent-build.js> [privateKeyPath]
 *
 * privateKeyPath defaults to $AUTOPOST_SIGNING_KEY or C:/Users/Roger/.autopost-signing/autopost-agent-ed25519.key
 * NEVER copy the private key onto the VPS. If it is ever exposed, rotate the keypair + re-pin the public key.
 */
const crypto = require('crypto');
const fs = require('fs');

const buildPath = process.argv[2];
const keyPath = process.argv[3] || process.env.AUTOPOST_SIGNING_KEY || 'C:/Users/Roger/.autopost-signing/autopost-agent-ed25519.key';
if (!buildPath) { console.error('usage: node scripts/sign-build.js <agent-build.js> [privateKeyPath]'); process.exit(1); }

const buf = fs.readFileSync(buildPath);
if (buf.length < 3000) { console.error('refusing: build looks too small (' + buf.length + ' bytes) — wrong file?'); process.exit(1); }
const key = crypto.createPrivateKey(fs.readFileSync(keyPath, 'utf8'));
const sig = crypto.sign(null, buf, key); // Ed25519: algorithm is implied by the key
fs.writeFileSync(buildPath + '.sig', sig);
const sha = crypto.createHash('sha256').update(buf).digest('hex');
console.log('signed:', buildPath);
console.log('  bytes :', buf.length);
console.log('  sha256:', sha);
console.log('  sig   :', buildPath + '.sig', '(' + sig.length + ' bytes)');
console.log('Upload BOTH the build and the .sig to the tunnel agentBuildPath. Do NOT upload the private key.');
