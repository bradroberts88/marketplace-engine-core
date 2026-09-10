'use strict';
/*
 * CONFIG RESILIENCE — the 2026-08-30 field failure, pinned.
 *
 * A unit was unplugged to be moved between sites. The power cut landed inside the writeback window of a
 * config.json rewrite, so ext4 gave back a ZERO-LENGTH file. On arrival the unit had perfect internet and was
 * still completely dead, because an empty config.json is simultaneously:
 *
 *   - valid enough to satisfy autopost-connector's start condition  -> the agent starts, JSON.parse throws, exit 1,
 *     and systemd (Restart=always, StartLimitIntervalSec=0) crash-loops it forever without ever marking it failed;
 *   - valid enough to satisfy autopost-claim's !exists condition    -> the ONE service that could re-provision it
 *     is skipped on every boot.
 *
 * Nothing in the field could break that deadlock. Three fixes, one test each below:
 *   1. ConditionFileNotEmpty on both units      -> a zero-byte config reads as "not provisioned".
 *   2. quarantine an unparseable config          -> covers non-empty-but-invalid, which no systemd condition can see.
 *   3. fsync before rename + seed the .bak       -> stop producing the broken file in the first place.
 *
 * The two functions are extracted VERBATIM from agent.js (which cannot be required here — it pulls in `ws`, and
 * the consolidated tree ships no node_modules). Reverting the fix in agent.js therefore fails these tests.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const AGENT = path.join(__dirname, '..', 'agent.js');
const SRC = fs.readFileSync(AGENT, 'utf8');

function slice(from, to, label) {
  const a = SRC.indexOf(from);
  const b = SRC.indexOf(to);
  assert.ok(a !== -1 && b !== -1 && b > a, `could not extract ${label} from agent.js — did a marker get renamed?`);
  return SRC.slice(a, b);
}
const BODY = slice('function writeJsonDurable', '// Pinned Ed25519', 'writeJsonDurable+loadConfig');
assert.ok(/function loadConfig/.test(BODY), 'loadConfig must sit between writeJsonDurable and the pinned key');

// Build the pair against injected deps so process.exit is observable instead of killing the runner.
function build(cfgPath) {
  const errs = [];
  const fakeConsole = { error: (...a) => errs.push(a.join(' ')), log: () => {} };
  const fakeProcess = { exit: (c) => { const e = new Error('EXIT:' + c); e.exitCode = c; throw e; } };
  const make = new Function('fs', 'path', 'console', 'process', 'CFG_PATH',
    BODY + '\nreturn { writeJsonDurable, loadConfig };');
  return { api: make(fs, path, fakeConsole, fakeProcess, cfgPath), errs };
}

let dirN = 0;
function tmp() {
  const d = path.join(os.tmpdir(), `cfgres-${process.pid}-${++dirN}`);
  fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(d, { recursive: true });
  return d;
}

const tasks = [];
const at = (name, fn) => ({ name, fn });
let pass = 0; const fails = [];

// ── 1. the exact field failure: a zero-byte config ──────────────────────────────────────────────────────────
tasks.push(at('a ZERO-BYTE config is quarantined, not left to wedge the unit forever', () => {
  const d = tmp(); const p = path.join(d, 'config.json');
  fs.writeFileSync(p, '');
  const { api, errs } = build(p);
  assert.throws(() => api.loadConfig(), /EXIT:1/, 'it must still refuse to run on a broken config');
  assert.ok(!fs.existsSync(p), 'config.json must be MOVED ASIDE — while it exists, autopost-claim stays skipped');
  assert.ok(fs.existsSync(p + '.corrupt'), 'and kept for diagnosis rather than deleted');
  assert.ok(errs.join(' ').includes('re-provision'), 'the operator log must say recovery is expected on next boot');
}));

// ── 2. the case no systemd condition can catch ──────────────────────────────────────────────────────────────
tasks.push(at('a NON-EMPTY but truncated config is quarantined too', () => {
  const d = tmp(); const p = path.join(d, 'config.json');
  fs.writeFileSync(p, '{"controlUr');   // a partial write - ConditionFileNotEmpty would happily pass this
  const { api } = build(p);
  assert.throws(() => api.loadConfig(), /EXIT:1/);
  assert.ok(!fs.existsSync(p), 'ConditionFileNotEmpty cannot see this, so the agent itself must handle it');
  assert.ok(fs.existsSync(p + '.corrupt'));
}));

// ── 3. the backup must exist BEFORE it is needed ────────────────────────────────────────────────────────────
tasks.push(at('a good config seeds .bak on FIRST load, not only on a hub push', () => {
  const d = tmp(); const p = path.join(d, 'config.json');
  fs.writeFileSync(p, JSON.stringify({ controlUrl: 'wss://x/y', dealershipToken: 't' }));
  const { api } = build(p);
  const c = api.loadConfig();
  assert.strictEqual(c.controlUrl, 'wss://x/y');
  assert.ok(fs.existsSync(p + '.bak'),
    'the dead unit had no .bak because it never received a config push — that is why it was unrecoverable');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(p + '.bak', 'utf8')), c);
}));

tasks.push(at('with a .bak present a broken config is REPAIRED rather than quarantined', () => {
  const d = tmp(); const p = path.join(d, 'config.json');
  const good = { controlUrl: 'wss://x/y', dealershipToken: 't' };
  fs.writeFileSync(p + '.bak', JSON.stringify(good));
  fs.writeFileSync(p, '');
  const { api } = build(p);
  const c = api.loadConfig();
  assert.deepStrictEqual(c, good, 'recovery beats re-claiming: it keeps the unit on its existing identity');
  assert.ok(fs.existsSync(p), 'and the live file is restored in place');
  assert.ok(!fs.existsSync(p + '.corrupt'), 'nothing to quarantine when it could be repaired');
}));

// ── 4. stop producing the broken file at all ────────────────────────────────────────────────────────────────
tasks.push(at('writeJsonDurable fsyncs the DATA before the rename (not just after)', () => {
  const d = tmp(); const p = path.join(d, 'config.json');
  const { api } = build(p);
  api.writeJsonDurable(p, { a: 1 });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(p, 'utf8')), { a: 1 });
  assert.ok(!fs.existsSync(p + '.tmp'), 'the temp file must be renamed away, never left behind');
  // The durability itself is a kernel-level guarantee we cannot observe from here, so assert on the SOURCE:
  // an fsync of the file descriptor must happen before the rename. That ordering IS the fix.
  const fn = BODY.slice(BODY.indexOf('function writeJsonDurable'), BODY.indexOf('function loadConfig'));
  const iSync = fn.indexOf('fsyncSync');
  const iRename = fn.indexOf('renameSync');
  assert.ok(iSync !== -1, 'no fsync at all — this is the bug that zeroed a customer config');
  assert.ok(iSync < iRename, 'fsync must come BEFORE the rename or it guarantees nothing');
}));

// ── 5. the systemd side of the deadlock ─────────────────────────────────────────────────────────────────────
const UNITS = path.join(__dirname, '..', '..', 'deploy', 'pi');
tasks.push(at('autopost-connector starts on a NON-EMPTY config, not merely a present one', () => {
  const u = fs.readFileSync(path.join(UNITS, 'autopost-connector.service'), 'utf8');
  assert.ok(/^ConditionFileNotEmpty=\/var\/lib\/autopost\/config\.json$/m.test(u),
    'ConditionPathExists lets a zero-byte config start the agent, which then crash-loops forever');
  assert.ok(!/^ConditionPathExists=\/var\/lib\/autopost\/config\.json$/m.test(u), 'the old condition must be gone');
}));
tasks.push(at('autopost-claim re-provisions when the config is EMPTY, not only when absent', () => {
  const u = fs.readFileSync(path.join(UNITS, 'autopost-claim.service'), 'utf8');
  assert.ok(/^ConditionFileNotEmpty=!\/var\/lib\/autopost\/config\.json$/m.test(u),
    'with ConditionPathExists an empty config permanently skips the only service that can repair the unit');
  assert.ok(!/^ConditionPathExists=!\/var\/lib\/autopost\/config\.json$/m.test(u), 'the old condition must be gone');
}));
tasks.push(at('an empty claim.env cannot launch a claim with a blank URL and code', () => {
  const u = fs.readFileSync(path.join(UNITS, 'autopost-claim.service'), 'utf8');
  assert.ok(/^ConditionFileNotEmpty=\/boot\/firmware\/autopost-claim\.env$/m.test(u));
}));

for (const t of tasks) {
  try { t.fn(); pass++; }
  catch (e) { fails.push(`  FAIL ${t.name} :: ${e.message}`); }
}
console.log(`config-resilience.test: ${pass} passed, ${fails.length} failed`);
if (fails.length) { console.log(fails.join('\n')); process.exit(1); }
