// QConnect card payload — the ONE card recipe.
//
// The flasher used to be able to write two different kinds of card. That is the
// single biggest reason two identical-looking boxes behaved differently at a
// dealership. This module is now the only thing that decides what a freshly
// written card contains: the QConnect scripts, the systemd units, and one
// provision.json describing that specific card.
//
// It produces SHELL LINES, not files on a Windows drive letter. The lines go
// into the first-run script Raspberry Pi Imager writes during the burn, so the
// card needs no drive letter, no second pass and no operator afterwards.
// Everything is base64 so a password, an SSID or an auth key can contain any
// character at all without a quoting accident turning into a card that boots
// and never connects.
//
// Pure except for reading the QConnect sources off disk at call time, which is
// deliberate: the card always carries the scripts that are in the repo right
// now, so nobody can ship a card built from a stale copy of them.

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const QCONNECT_DIR = path.join(REPO_ROOT, 'qconnect');
const TARGET = '/boot/firmware/qconnect';

// Files copied verbatim onto the card, as [source path, name on the card].
const PAYLOAD = [
  ['boot-payload/qconnect-firstrun.sh', 'firstrun.sh'],
  ['device/qconnect-setup.sh', 'qconnect-setup.sh'],
  ['device/qconnect-netmanager.sh', 'qconnect-netmanager.sh'],
  ['device/qconnect-steps.sh', 'qconnect-steps.sh'],
  ['device/qconnect-portal.py', 'qconnect-portal.py'],
  ['device/qconnect-heartbeat.sh', 'qconnect-heartbeat.sh'],
  ['device/qconnect-agent-update.sh', 'qconnect-agent-update.sh'],
  ['device/qconnect-command-exec.sh', 'qconnect-command-exec.sh'],
  ['device/systemd/qconnect-setup.service', 'qconnect-setup.service'],
  ['device/systemd/qconnect-heartbeat.service', 'qconnect-heartbeat.service'],
  ['device/systemd/qconnect-heartbeat.timer', 'qconnect-heartbeat.timer'],
  ['device/systemd/qconnect-netwatch.service', 'qconnect-netwatch.service'],
];

// Quarantined code must never reach a card, whatever a caller passes in.
function assertLive(abs) {
  const rel = path.relative(REPO_ROOT, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`qconnect payload: ${abs} is outside the repository`);
  }
  if (rel.split(path.sep)[0] === 'attic') {
    throw new Error(`qconnect payload: ${rel} is quarantined and cannot be written to a card`);
  }
}

function readPayloadFile(relSource) {
  const abs = path.join(QCONNECT_DIR, relSource);
  assertLive(abs);
  if (!fs.existsSync(abs)) {
    throw new Error(`qconnect payload: missing ${path.relative(REPO_ROOT, abs)} — the card would boot without it`);
  }
  // Always LF. A CR from a Windows checkout makes bash report "bad interpreter"
  // and systemd refuse the unit, on a card that otherwise looks perfect.
  return fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n');
}

const REQUIRED = ['deviceId', 'dealerId', 'deviceToken', 'supabaseUrl', 'supabaseAnonKey'];

// The card's own identity file. Field names match what the device scripts read
// (qconnect-setup.sh / qconnect-netmanager.sh / qconnect-heartbeat.sh).
function provisionJson(q) {
  const cfg = q || {};
  const missing = REQUIRED.filter((k) => !String(cfg[k] || '').trim());
  if (missing.length) {
    throw new Error(`qconnect payload: missing ${missing.join(', ')}`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,62}$/.test(String(cfg.deviceId))) {
    throw new Error('qconnect payload: deviceId must be letters, digits, dot, dash or underscore');
  }
  if (!cfg.enrolmentTicket && !cfg.allowPreregistered) {
    throw new Error('qconnect payload: an enrolment ticket is required (a card with none can never register itself)');
  }
  return {
    device_id: String(cfg.deviceId),
    dealer_id: String(cfg.dealerId),
    device_token: String(cfg.deviceToken),
    enrolment_ticket: String(cfg.enrolmentTicket || ''),
    batch_id: String(cfg.batchId || ''),
    wifi_ssid: String(cfg.wifiSsid || ''),
    wifi_pass: String(cfg.wifiPass || ''),
    wifi_hidden: cfg.wifiHidden ? 'yes' : 'no',
    wifi_country: String(cfg.wifiCountry || 'US'),
    hotspot_ssid: String(cfg.hotspotSsid || ''),
    hotspot_pass: String(cfg.hotspotPass || ''),
    // AT&T is the fleet SIM: 'broadband' is the consumer/IoT APN and the right
    // default. The device falls back through m2m.com.attz / att.mvno itself.
    cellular_apn: String(cfg.cellularApn || 'broadband'),
    cellular_user: String(cfg.cellularUser || ''),
    cellular_pass: String(cfg.cellularPass || ''),
    tailscale_authkey: String(cfg.tailscaleKey || ''),
    tailscale_key_id: String(cfg.tailscaleKeyId || ''),
    tailscale_key_expires_at: String(cfg.tailscaleKeyExpiresAt || ''),
    supabase_url: String(cfg.supabaseUrl).replace(/\/+$/, ''),
    supabase_anon_key: String(cfg.supabaseAnonKey),
  };
}

function b64Write(target, content, mode) {
  const b64 = Buffer.from(content, 'utf8').toString('base64');
  // Wrapped so a long script does not produce a single multi-kilobyte line that
  // some editors and some FAT tooling mangle.
  const wrapped = b64.replace(/(.{120})/g, '$1\n');
  return [
    `cat > /tmp/qc.b64 <<'QC_B64_EOF'`,
    wrapped,
    'QC_B64_EOF',
    `base64 -d /tmp/qc.b64 > ${target}`,
    `chmod ${mode} ${target}`,
    'rm -f /tmp/qc.b64',
  ];
}

// The shell lines that lay the payload down and hand control to it.
function qconnectSteps(q) {
  const prov = provisionJson(q);
  const lines = [
    '# --- QConnect card payload -------------------------------------------------',
    `mkdir -p ${TARGET}`,
  ];
  for (const [source, name] of PAYLOAD) {
    const isUnit = name.endsWith('.service') || name.endsWith('.timer');
    lines.push(...b64Write(`${TARGET}/${name}`, readPayloadFile(source), isUnit ? '644' : '755'));
  }
  lines.push(...b64Write(`${TARGET}/provision.json`, `${JSON.stringify(prov, null, 2)}\n`, '600'));
  lines.push(`printf '%s\\n' ${JSON.stringify(String(q.version || 'dev'))} > ${TARGET}/VERSION`);
  // Hand over. The installer copies itself into the rootfs, removes the secrets
  // from the boot partition and leaves the box provisioning itself. It is run
  // inline rather than through a second cmdline hook so there is exactly one
  // place a card can stall, and its log says where.
  lines.push(`bash ${TARGET}/firstrun.sh || echo "QConnect first-run installer reported a problem — see /var/log/qconnect-firstrun.log"`);
  return lines;
}

// Same payload expressed as files, for the dry-run preview and for an operator
// writing a card by hand from a mounted boot partition.
function qconnectBootFiles(q) {
  const prov = provisionJson(q);
  const files = PAYLOAD.map(([source, name]) => ({
    path: `qconnect/${name}`,
    content: readPayloadFile(source),
    mode: name.endsWith('.service') || name.endsWith('.timer') ? 0o644 : 0o755,
  }));
  files.push({ path: 'qconnect/provision.json', content: `${JSON.stringify(prov, null, 2)}\n`, mode: 0o600 });
  files.push({ path: 'qconnect/VERSION', content: `${String(q.version || 'dev')}\n`, mode: 0o644 });
  return files;
}

module.exports = { qconnectSteps, qconnectBootFiles, provisionJson, PAYLOAD, TARGET };
