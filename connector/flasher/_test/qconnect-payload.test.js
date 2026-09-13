// QConnect card payload — the card recipe is the thing that decides whether a
// box connects at a dealership, so every rule it relies on is asserted here.
const assert = require('assert');
const path = require('path');
const { qconnectSteps, qconnectBootFiles, provisionJson, PAYLOAD } = require('../qconnect-payload');
const { firstRunScriptSelfContained, bootFilesFor } = require('../inject');

let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed = 1;
    console.log(`  FAIL ${name}\n       ${err && err.message}`);
  }
}

const good = {
  deviceId: 'QCN-0042',
  dealerId: 'kendall-ford-meridian',
  deviceToken: 'tok_abc123',
  enrolmentTicket: 'tkt_zzz',
  supabaseUrl: 'https://example.supabase.co/',
  supabaseAnonKey: 'sb_publishable_test',
  wifiSsid: "Dealer's Guest",
  wifiPass: 'p@ss "word" $1',
  version: '1.4.0',
};

console.log('\nQConnect payload');

test('provision.json carries the identity the device scripts read', () => {
  const p = provisionJson(good);
  assert.equal(p.device_id, 'QCN-0042');
  assert.equal(p.dealer_id, 'kendall-ford-meridian');
  assert.equal(p.enrolment_ticket, 'tkt_zzz');
  assert.equal(p.supabase_url, 'https://example.supabase.co', 'trailing slash must be trimmed');
});

test('AT&T is the default mobile network', () => {
  assert.equal(provisionJson(good).cellular_apn, 'broadband');
  assert.equal(provisionJson({ ...good, cellularApn: 'm2m.com.attz' }).cellular_apn, 'm2m.com.attz');
});

test('a card with no enrolment ticket is refused', () => {
  assert.throws(() => provisionJson({ ...good, enrolmentTicket: '' }), /enrolment ticket/);
});

test('missing backend details are refused before a card is written', () => {
  assert.throws(() => provisionJson({ ...good, supabaseAnonKey: '' }), /supabaseAnonKey/);
  assert.throws(() => provisionJson({ ...good, deviceToken: ' ' }), /deviceToken/);
});

test('every payload file is present in the repository', () => {
  const files = qconnectBootFiles(good);
  assert.equal(files.length, PAYLOAD.length + 2, 'scripts + provision.json + VERSION');
  for (const f of files) assert.ok(f.content.length > 0, `${f.path} is empty`);
});

test('scripts are executable, units are not', () => {
  const files = qconnectBootFiles(good);
  const setup = files.find((f) => f.path.endsWith('qconnect-setup.sh'));
  const unit = files.find((f) => f.path.endsWith('qconnect-setup.service'));
  assert.equal(setup.mode, 0o755);
  assert.equal(unit.mode, 0o644);
});

test('no Windows line endings reach the card', () => {
  for (const f of qconnectBootFiles(good)) {
    assert.ok(!f.content.includes('\r'), `${f.path} carries a CR`);
  }
});

test('awkward passwords and quotes survive the write', () => {
  const steps = qconnectSteps(good).join('\n');
  // The value is base64 inside the script, never interpolated raw.
  assert.ok(!steps.includes('p@ss "word" $1'), 'the password must not appear unescaped');
  // Decode the provision.json the card would receive and check it round-trips.
  const blocks = steps.split("cat > /tmp/qc.b64 <<'QC_B64_EOF'\n").slice(1);
  const decoded = blocks
    .map((b) => Buffer.from(b.split('\nQC_B64_EOF')[0].replace(/\n/g, ''), 'base64').toString('utf8'))
    .filter((s) => s.trim().startsWith('{'));
  assert.equal(decoded.length, 1, 'exactly one provision.json');
  assert.equal(JSON.parse(decoded[0]).wifi_pass, 'p@ss "word" $1');
});

test('the card is handed to the first-run installer', () => {
  const steps = qconnectSteps(good).join('\n');
  assert.ok(/bash \/boot\/firmware\/qconnect\/firstrun\.sh/.test(steps));
});

test('quarantined code can never be written to a card', () => {
  const mod = require('../qconnect-payload');
  assert.ok(!JSON.stringify(mod.PAYLOAD).includes('attic'));
  const steps = qconnectSteps(good).join('\n');
  assert.ok(!steps.includes('ble-setup'), 'the retired Bluetooth channel must not be on a card');
});

test('a plan with a QConnect card produces a first-run script that installs it', () => {
  const plan = {
    claimUrl: 'https://hub.example.com',
    claimCode: 'ABCD-EFGH',
    networks: [{ ssid: 'Dealer', psk: 'secret123' }],
    piUser: 'admin',
    piPassHash: '$6$abc$def',
    hostname: 'qcn-0042',
    qconnect: good,
  };
  const script = firstRunScriptSelfContained(plan);
  assert.ok(script.includes('/boot/firmware/qconnect/provision.json'));
  assert.ok(script.includes('QConnect card payload'));
  const preview = bootFilesFor(plan).map((f) => f.path);
  assert.ok(preview.includes('qconnect/provision.json'));
  assert.ok(preview.includes('qconnect/qconnect-setup.service'));
});

test('plans without a QConnect card are untouched', () => {
  const plan = {
    claimUrl: 'https://hub.example.com',
    claimCode: 'ABCD-EFGH',
    networks: [{ ssid: 'Dealer', psk: 'secret123' }],
    piUser: 'admin',
    piPassHash: '$6$abc$def',
  };
  assert.ok(!firstRunScriptSelfContained(plan).includes('qconnect'));
  assert.ok(!bootFilesFor(plan).some((f) => f.path.startsWith('qconnect/')));
});

console.log(failed ? '\nQConnect payload: FAILED\n' : '\nQConnect payload: all good\n');
process.exit(failed);
