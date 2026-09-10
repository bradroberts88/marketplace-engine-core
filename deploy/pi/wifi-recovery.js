'use strict';
/*
 * AutoPost WiFi recovery — the on-device "wrong credentials" rescue.
 *
 * THE PROBLEM: if a Pi is flashed with the wrong WiFi SSID/password it boots but never connects. It is headless
 * with no internet, so there is no SSH, no Tailscale, no remote fix — the box is stranded. This daemon lets the
 * DEALERSHIP fix it on-site with just a phone: when the Pi is offline past a grace window, wlan0 becomes a WiFi
 * access point ("AutoPost-Setup"); the dealership joins it, a branded captive page lets them pick their network +
 * type the correct password, the Pi saves it (via the proven deploy/pi/set-wifi.sh), reconnects, and tears the AP
 * down. It re-triggers if the dealership later changes their WiFi.
 *
 * RUNS AS ITS OWN SERVICE (autopost-wifi-recovery.service), NOT inside agent.js: a wrong-WiFi fleet-claimed Pi
 * never gets internet -> claim.js never writes config.json -> the connector agent (gated on config.json) NEVER
 * starts. Recovery must run with no config gate and no network-online gate. It runs as the `autopost` user, whose
 * NetworkManager polkit grant (deploy/pi/50-autopost-nm.rules) authorizes every nmcli call used here.
 *
 * DESIGN (matches balena wifi-connect's proven techniques for a single Pi radio):
 *  - Trigger is CONNECTIVITY-based, never "NM gave up" (the flasher sets autoconnect-retries=0 = retry forever).
 *    Offline is declared only when BOTH signals fail: `nmcli CONNECTIVITY != full` AND a TCP reach to our hub
 *    fails. Either succeeding = online (so a dealership network that hijacks NM's connectivity URL can't false-trip
 *    us, and a briefly-down hub can't either). Hysteresis: boot-grace, then continuous offline before the AP.
 *  - One radio can't AP + scan/associate at once, so a strict state machine owns the radio one step at a time:
 *    scan is fully cached BEFORE the AP goes up; the AP is fully torn down BEFORE the station reconnects; we never
 *    scan while the AP is up.
 *  - NEVER STRAND: on submit we tear the AP down first, write the corrected profile (keeping every other saved
 *    network), bound + verify the join, and on ANY failure re-raise the AP with an error. The box is never left
 *    with neither the AP nor internet.
 *  - GUEST / CAPTIVE WIFI is treated as its OWN outcome, not as a failure. Dealership guest networks are the
 *    common case and they break BOTH of the original signals: a portal answers the hub's TCP connect (so the box
 *    reports healthy while never claiming), and it makes NM report 'portal' (so a site that merely blocks NM's
 *    check URL looks broken). The fix is a third, authoritative signal — an HTTP fetch whose correct response is
 *    known in advance (generate_204), which is the one thing a portal cannot fake. When it proves a portal we
 *    KEEP the WiFi profile (the password was right; IT may whitelist the MAC later and it will just start
 *    working) and raise the AP carrying the device's MAC + the sign-in URL instead of a password error.
 *
 * Stdlib only (no `ws`) — consistent with "the only runtime dep is ws". Persistence: on the current stock image
 * NM keyfiles at /etc/NetworkManager/system-connections/ are writable and survive reboot; the golden read-only
 * overlay needs that dir symlinked to AUTOPOST-DATA (a separate, tracked golden-image task).
 */
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// ───────────────────────────── config (env-tunable, mirrors agent.js's Math.max(default, parseInt(env)) style) ──
function envInt(name, def) { const v = parseInt(process.env[name] || '', 10); return Number.isFinite(v) && v >= 0 ? v : def; }
const CONFIG = {
  bootGraceMs: envInt('WIFI_RECOVERY_BOOT_GRACE_MS', 120000), // wait after boot before judging offline (slow first join)
  offlineGraceMs: envInt('WIFI_RECOVERY_OFFLINE_GRACE_MS', 300000), // continuous offline before raising the AP
  // FIRST-RUN grace, used only while the box has NEVER been online (no config.json -> never claimed). The long
  // grace above exists to ride out a transient outage on a WORKING site; a box that has never once reached the
  // hub is not having a blip, it was flashed with credentials that do not work. Making that case wait the full
  // 2+5 minutes just leaves an installer standing there wondering if the device is dead.
  firstRunOfflineGraceMs: envInt('WIFI_RECOVERY_FIRSTRUN_OFFLINE_GRACE_MS', 60000),
  firstRunBootGraceMs: envInt('WIFI_RECOVERY_FIRSTRUN_BOOT_GRACE_MS', 45000),
  checkMs: envInt('WIFI_RECOVERY_CHECK_MS', 30000), // connectivity poll interval
  connectTimeoutMs: envInt('WIFI_RECOVERY_CONNECT_TIMEOUT_MS', 60000), // verify window after a correction
  // ── THE WIRE ───────────────────────────────────────────────────────────────────────────────────────────
  // How often to re-activate a wired uplink while offline. See retryWiredUplink: the wired profile cannot fail
  // its own activation, so NOTHING retries DHCP on it without this. Deliberately well under the AP grace,
  // because a wired card's rescue AP is not a fix for a wired problem.
  wiredRetryMs: envInt('WIFI_RECOVERY_WIRED_RETRY_MS', 60000),
  // `nmcli connection up` blocks until the activation settles. A quiet bench answers in under a second; a busy
  // dealership switch takes far longer, and cutting that short is precisely what made startAp() roll back an AP
  // that was already serving. Give it room.
  wiredRetryTimeoutMs: envInt('WIFI_RECOVERY_WIRED_RETRY_TIMEOUT_MS', 45000),
  // ── AP AVAILABILITY ────────────────────────────────────────────────────────────────────────────────────
  // The single radio cannot be AP and station at once, so re-testing the real network means taking the rescue
  // AP down. Every second it is down is a second a dealership tech cannot connect — and worse, their phone
  // still SHOWS the SSID from its cached scan, so tapping it fails with "unable to join network".
  // Measured on hardware 2026-08-14 with the old values (probe 300s / wait 90s): the AP was actually gone for
  // ~100s out of every 300s. A THIRD of the time the rescue network did not exist.
  // These values invert that: a probe every 15 min, and a probe window of 25s (see the early-exit in
  // probeRealNetwork, which usually returns far sooner). ~25s unavailable per 900s = under 3%.
  apProbeMs: envInt('WIFI_RECOVERY_AP_PROBE_MS', 900000), // 15 min between re-tests
  // The FIRST re-test after raising the AP is much sooner than the rest. The 15-minute figure is sized for an
  // unattended box riding out a site outage, but the commonest reason the AP goes up at all is that the real
  // network simply had not finished coming up yet - a wired adapter still getting DHCP, or a slow WPA
  // association. Fifteen minutes of a rescue hotspot broadcasting from a box that has been online for fourteen
  // of them is confusing to everyone who can see it. After the first probe it backs off to apProbeMs.
  apFirstProbeMs: envInt('WIFI_RECOVERY_AP_FIRST_PROBE_MS', 90000),
  probeWaitMs: envInt('WIFI_RECOVERY_PROBE_WAIT_MS', 25000), // hard cap on how long the AP may be down for a probe
  // If the station has not even ASSOCIATED within this long, the network is not coming back on this attempt —
  // stop waiting and put the AP straight back up. This is what usually ends a probe early.
  probeAssocMs: envInt('WIFI_RECOVERY_PROBE_ASSOC_MS', 12000),
  // A client associated to the AP, or a portal request within this window, counts as "someone is using it" and
  // defers the re-probe. 3 min covers a human reading the page and typing a WiFi password.
  portalBusyMs: envInt('WIFI_RECOVERY_PORTAL_BUSY_MS', 180000),
  // Upper bound on deferring. Without it, one phone that associates and wanders off would pin the AP up forever
  // and the box could never notice its real network came back.
  maxProbeDeferralMs: envInt('WIFI_RECOVERY_MAX_PROBE_DEFERRAL_MS', 1800000), // 30 min
  // ── CAPTIVE / GUEST WIFI ───────────────────────────────────────────────────────────────────────────────
  // Dealership guest networks are the COMMON case, and a bare TCP reach cannot see them: a captive portal
  // accepts the TCP connect to any host:port (it is intercepting), so the hub "reachable" vote comes back TRUE
  // while nothing actually works. The only reliable test is an HTTP fetch whose expected RESPONSE is known —
  // the same generate_204 trick every phone OS uses. Plain http:// on purpose: a portal must be able to
  // intercept it, and an https:// probe would just fail the TLS handshake and tell us nothing about WHERE the
  // sign-in page is. No secrets are sent, and the response body is never trusted, only classified.
  probeUrls: (process.env.WIFI_RECOVERY_PROBE_URLS
    || 'http://connectivity-check.gstatic.com/generate_204,http://www.msftconnecttest.com/connecttest.txt'
  ).split(',').map((s) => s.trim()).filter(Boolean),
  probeHttpTimeoutMs: envInt('WIFI_RECOVERY_PROBE_HTTP_TIMEOUT_MS', 8000),
  // Once we KNOW it is a captive portal, the credentials are right and nothing changes until a human acts
  // (signs in, or has IT whitelist the MAC). Re-testing every 15 min is pointless churn that also takes the
  // rescue AP down; re-test more slowly, and give the on-site tech a "Re-check now" button instead.
  captiveProbeMs: envInt('WIFI_RECOVERY_CAPTIVE_PROBE_MS', 1800000), // 30 min
  apSsidPrefix: process.env.WIFI_RECOVERY_AP_SSID_PREFIX || 'AutoPost-Setup',
  apOpen: process.env.WIFI_RECOVERY_AP_OPEN === '1', // default WPA2-protected; set WIFI_RECOVERY_AP_OPEN=1 for an open AP
  apPassword: process.env.WIFI_RECOVERY_AP_PASSWORD || 'autopost212', // WPA2 password for the AutoPost-Setup hotspot (>=8 chars)
  apGatewayIp: process.env.WIFI_RECOVERY_AP_IP || '10.42.0.1', // NM ipv4.method=shared default gateway
  // ── AP BRING-UP BUDGET ─────────────────────────────────────────────────────────────────────────────────
  // `nmcli connection up` blocks until the activation SETTLES and defaults to a 90s wait, but the command
  // runner's default execFile timeout is 20s — so on any site where the AP takes longer than 20s to come up,
  // nmcli was SIGTERMed, came back non-zero, and startAp() rolled the whole rescue back even when the AP had
  // in fact activated. A quiet bench activates in under a second; a dealership floor with thirty 2.4GHz
  // networks does not. These give the activation a real budget and are the *only* reason the runner is
  // allowed a long timeout anywhere in this file.
  apUpWaitMs: envInt('WIFI_RECOVERY_AP_UP_WAIT_MS', 45000), // nmcli --wait budget for `connection up`
  apIpWaitMs: envInt('WIFI_RECOVERY_AP_IP_WAIT_MS', 45000), // how long to keep polling for the shared-mode gateway IP
  // AP CHANNEL. Left unset, NetworkManager asks wpa_supplicant to pick one (ACS), which the Pi Zero W /
  // Pi 3 brcmfmac firmware does not implement — the supplicant then surveys the whole band and can take tens of
  // seconds or fail outright, which is exactly the slow/failed activation above. 0 = pick the least congested
  // of 1/6/11 from the scan we already cached; set a number to pin it.
  apChannel: envInt('WIFI_RECOVERY_AP_CHANNEL', 0),
  // ── SECOND FRONT DOOR: the USB gadget ──────────────────────────────────────────────────────────────────
  // The golden image already brings up a USB ethernet gadget at a fixed address on every boot, so a laptop on
  // the Pi's USB DATA port reaches it with no radio involved at all. Serving the same rescue portal there costs
  // one extra listener and gives a channel that cannot be broken by anything in the WiFi state machine.
  usbPortalIp: process.env.WIFI_RECOVERY_USB_IP || '10.55.0.1',
  usbPortalEnabled: process.env.WIFI_RECOVERY_USB_PORTAL !== '0',
  // AP-flap guard at a hard-down site. Only SUCCESSFUL raises are counted (see reentryAllowed) — counting
  // FAILED attempts is what let six rolled-back activations use up the whole hour's budget and leave a box
  // silently raising nothing while someone stood in front of it watching the WiFi list.
  maxReentriesPerHour: envInt('WIFI_RECOVERY_MAX_REENTRIES', 6),
  runtimeDir: process.env.CONNECTOR_RUNTIME_DIR || path.join(__dirname, '..', 'runtime'),
  configPath: process.env.CONNECTOR_CONFIG || path.join(__dirname, '..', 'config.json'),
  apConName: 'autopost-setup-ap',
  // Rolling on-disk diagnostic log. A shipped box has no console, no SSH and no internet when this daemon
  // matters, so a message that only reaches the journal reaches nobody. See diagLines().
  diagLines: envInt('WIFI_RECOVERY_DIAG_LINES', 300),
};

// ───────────────────────────── pure helpers (exported for tests) ────────────────────────────────────────────
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// Match deploy/pi/set-wifi.sh con_name_for: "autopost-wifi-" + (each non-alnum -> '-') truncated to 40 chars.
function conNameFor(ssid) { return 'autopost-wifi-' + String(ssid == null ? '' : ssid).replace(/[^a-zA-Z0-9]/g, '-').slice(0, 40); }

// A per-unit AP SSID so two Pis being recovered near each other don't collide. Last 4 hex of the board serial.
function apSsid(serial, prefix = CONFIG.apSsidPrefix) {
  const s = String(serial || '').trim().replace(/[^0-9a-fA-F]/g, '');
  const tail = s ? s.slice(-4).toUpperCase() : 'XXXX';
  return `${prefix}-${tail}`;
}

// Split one `nmcli -t` line into fields on UNescaped ':' (nmcli escapes ':' as '\:' and '\' as '\\').
function splitNmcli(line) {
  const out = []; let cur = ''; let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === '\\' && i + 1 < line.length) { cur += line[i + 1]; i += 2; continue; }
    if (c === ':') { out.push(cur); cur = ''; i += 1; continue; }
    cur += c; i += 1;
  }
  out.push(cur);
  return out;
}

// Parse `nmcli -t -f SSID,SIGNAL,SECURITY,CHAN device wifi list` -> [{ssid,signal,security,chan}], hidden(blank)
// dropped, deduped by SSID keeping the strongest signal, sorted strongest-first. CHAN is appended LAST so output
// captured from the older three-field command still parses (chan just comes back 0).
function parseScanList(output) {
  const byS = new Map();
  for (const raw of String(output || '').split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const [ssid, signalStr, security, chanStr] = splitNmcli(raw);
    if (!ssid) continue; // hidden network -> blank SSID; user enters it manually
    const signal = parseInt(signalStr, 10); const sig = Number.isFinite(signal) ? signal : 0;
    const chanN = parseInt(chanStr, 10); const chan = Number.isFinite(chanN) ? chanN : 0;
    const prev = byS.get(ssid);
    if (!prev || sig > prev.signal) byS.set(ssid, { ssid, signal: sig, security: (security || '').trim(), chan });
  }
  return [...byS.values()].sort((a, b) => b.signal - a.signal);
}

// Choose a 2.4GHz channel for the rescue AP. PINNING one matters more than picking the best one: with no channel
// NetworkManager asks wpa_supplicant to auto-select (ACS), which the Pi Zero W / Pi 3 brcmfmac firmware does not
// implement — so the activation stalls or fails on exactly the crowded sites where the rescue is needed.
// Only 1/6/11 are considered (the non-overlapping set); each neighbour is weighted by signal strength and bleeds
// into the two adjacent candidates, so a wall of APs on 6 pushes us to 1 or 11 rather than piling on.
function pickApChannel(networks, override = 0) {
  if (override > 0) return override;
  const CANDIDATES = [1, 6, 11];
  const cost = new Map(CANDIDATES.map((c) => [c, 0]));
  for (const n of networks || []) {
    const ch = Number(n && n.chan) || 0;
    if (ch < 1 || ch > 14) continue;
    const weight = Math.max(1, Number(n.signal) || 1);
    for (const c of CANDIDATES) {
      const dist = Math.abs(c - ch);
      if (dist === 0) cost.set(c, cost.get(c) + weight);          // same channel: full collision
      else if (dist <= 4) cost.set(c, cost.get(c) + weight / 2);  // overlapping: partial
    }
  }
  // Ties resolve to the earlier candidate, so a site with no scan data at all lands on 1 deterministically
  // rather than on whatever Map iteration happened to yield.
  return CANDIDATES.reduce((best, c) => (cost.get(c) < cost.get(best) ? c : best), CANDIDATES[0]);
}

// OS captive-portal probe paths — each OS fetches one of these and treats "not the expected body" as "captive".
const CAPTIVE_PATHS = new Set([
  '/generate_204', '/gen_204', // Android / Chrome
  '/hotspot-detect.html', '/library/test/success.html', // Apple
  '/ncsi.txt', '/connecttest.txt', // Windows
  '/canonical.html', '/success.txt', // Firefox / NetworkManager
]);
function isCaptiveProbe(pathname) { return CAPTIVE_PATHS.has(String(pathname || '')); }

// Classify ONE connectivity-probe response. This is the authoritative signal, because it checks the CONTENT of a
// response whose correct value we know in advance — which is the only thing a captive portal cannot fake.
//   - generate_204 style: a real internet answers 204 with an empty body.
//   - connecttest.txt style: a real internet answers 200 with exactly "Microsoft Connect Test".
// Anything else on a request that DID get a reply means something answered on the network's behalf: a portal.
// A transport error (no reply at all) is NOT a portal — that is just "no route", so it returns 'unknown' and lets
// the other signals decide. Pure + exported so the whole table is testable without a network.
function classifyProbeResponse(res) {
  if (!res || res.err || typeof res.status !== 'number') return 'unknown';
  const status = res.status;
  const body = String(res.body == null ? '' : res.body);
  // An explicit redirect is the classic portal tell, and its Location is the sign-in page.
  if (status >= 300 && status < 400 && res.location) return 'portal';
  if (/generate_204|gen_204/.test(String(res.url || ''))) {
    if (status === 204 && !body.trim()) return 'full';
    return 'portal'; // 200-with-a-login-page, or any other status: something answered for the network
  }
  if (/connecttest\.txt|ncsi\.txt/.test(String(res.url || ''))) {
    if (status === 200 && /Microsoft Connect Test|Microsoft NCSI/i.test(body)) return 'full';
    return 'portal';
  }
  // Unknown probe URL: only a 204-empty is trusted as proof of real internet.
  if (status === 204 && !body.trim()) return 'full';
  return 'unknown';
}

// Decide "is this box really online" from up to three signals.
//   probeVerdict ('full' | 'portal') is AUTHORITATIVE when present and overrides the other two, because it is the
//   only one that verified a known response body. This is what fixes guest WiFi in both directions:
//     * a genuine captive portal answers the hub's TCP connect, so hubReachable is TRUE while nothing works —
//       without the probe the box reports healthy forever and silently never claims;
//     * a network that merely BLOCKS NetworkManager's own check URL makes NM say 'portal' while the internet is
//       fine — without the probe we would raise the rescue AP on a perfectly good site.
//   With no probe verdict this falls back to the original two-vote rule, so behaviour is unchanged when the
//   probe itself is unreachable.
function decideOnline(connectivity, hubReachable, probeVerdict) {
  if (probeVerdict === 'portal') return false;
  if (probeVerdict === 'full') return true;
  return String(connectivity).trim() === 'full' || !!hubReachable;
}

// Resolve the final connectivity STATE (not just a boolean) from the same three signals. 'portal' is a distinct
// outcome from 'offline' because the operator response is completely different: offline means the WiFi
// credentials are wrong, portal means they are RIGHT and the network needs a sign-in or a MAC whitelist.
function decideConnectivityState(connectivity, hubReachable, probeVerdict, associated) {
  if (decideOnline(connectivity, hubReachable, probeVerdict)) return 'full';
  if (probeVerdict === 'portal' || String(connectivity).trim() === 'portal') return 'portal';
  if (associated === false) return 'none';       // not even joined to a WiFi network
  return 'limited';                              // joined, but no way out
}

// ───────────────────────────── branded captive portal (reuses dashboard.js's ◈ / .mark / .field / .btn look) ──
const PORTAL_STYLE = [
  ':root{--bg:#12162e;--bg2:#171d3a;--card:#1f2547;--ink:#eef1fb;--muted:#98a1c9;--line:#2b3466;--accent:#8f9cf6;--accent2:#b9a5f4;--bad:#f27a9c;--good:#43d6a0}',
  '@media(prefers-color-scheme:light){:root{--bg:#eceffa;--bg2:#f5f7fd;--card:#fff;--ink:#1a2048;--muted:#5c6595;--line:#e4e7f4}}',
  '*{box-sizing:border-box}html,body{margin:0}body{background:radial-gradient(1200px 600px at 12% -8%,var(--bg2),var(--bg));color:var(--ink);font-family:"Segoe UI",system-ui,-apple-system,Roboto,sans-serif;min-height:100vh}',
  '.login{min-height:100vh;display:grid;place-items:center;padding:24px}',
  '.lcard{width:100%;max-width:420px;background:var(--card);border:1px solid var(--line);border-radius:22px;padding:30px 28px;box-shadow:0 14px 34px rgba(6,9,26,.4)}',
  '.mark{width:44px;height:44px;border-radius:13px;background:linear-gradient(135deg,var(--accent),var(--accent2));display:grid;place-items:center;color:#0e1230;font-weight:800;font-size:20px;margin-bottom:16px}',
  'h1{font-size:21px;margin:0 0 4px}p.sub{margin:0 0 20px;color:var(--muted);font-size:14px}',
  '.field{margin-bottom:14px}.field label{display:block;font-size:12.5px;color:var(--muted);margin-bottom:6px}',
  '.field input,.field select{width:100%;padding:12px 14px;border-radius:11px;border:1px solid var(--line);background:var(--bg2);color:var(--ink);font:inherit;font-size:15px}',
  '.field input:focus,.field select:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px rgba(143,156,246,.22)}',
  '.btn{width:100%;margin-top:8px;padding:13px;border:0;border-radius:12px;background:linear-gradient(135deg,var(--accent),var(--accent2));color:#0e1230;font:inherit;font-weight:700;font-size:15px;cursor:pointer}',
  '.btn:hover{filter:brightness(1.05)}.btn[disabled]{opacity:.6;cursor:default}',
  '.row{display:flex;align-items:center;gap:8px;margin:2px 0 14px;color:var(--muted);font-size:13px}.row input{width:auto}',
  '.banner{border-radius:12px;padding:12px 14px;margin-bottom:16px;font-size:13.5px;font-weight:600;display:none}',
  '.banner.err{display:block;background:rgba(242,122,156,.16);border:1px solid rgba(242,122,156,.5);color:var(--bad)}',
  '.banner.ok{display:block;background:rgba(67,214,160,.16);border:1px solid rgba(67,214,160,.5);color:var(--good)}',
  '.hint{color:var(--muted);font-size:12px;margin-top:14px;text-align:center}',
  '.banner.warn{display:block;background:rgba(255,180,84,.16);border:1px solid rgba(255,180,84,.5);color:#ffb454}',
  '.btn.ghost{background:none;border:1px solid var(--line);color:var(--muted);font-weight:600;margin-top:10px}',
  '.note{background:var(--bg2);border:1px solid var(--line);border-radius:14px;padding:16px;margin:4px 0 16px}',
  '.noteh{font-size:12px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);margin-bottom:10px;font-weight:700}',
  '.kv{display:flex;align-items:center;gap:10px;margin-bottom:8px;flex-wrap:wrap}',
  '.kv span{font-size:12.5px;color:var(--muted);min-width:88px}',
  '.kv code{font-family:Consolas,ui-monospace,monospace;font-size:14px;font-weight:700;letter-spacing:.5px;'
    + 'background:var(--card);border:1px solid var(--line);border-radius:8px;padding:6px 10px;word-break:break-all;flex:1}',
  '.fine{font-size:12.5px;color:var(--muted);margin:10px 0 0;line-height:1.5}',
].join('\n');

// The GUEST-WIFI panel. Shown INSTEAD of a password error when we have proven the joined network is behind a
// sign-in page — because at that point the WiFi password was right and re-typing it will not help. What the tech
// actually needs is (a) to know the device joined fine, (b) the MAC address, since whitelisting it is how a
// headless device gets onto a guest network for good, and (c) a way to re-test the moment they have done it.
function captivePanel({ ssid = '', signInUrl = '', mac = '' } = {}) {
  return '<div class="banner warn" style="display:block">This network needs a sign-in</div>'
    + '<p class="sub" style="margin-top:-6px">The device joined <b>' + esc(ssid || 'your WiFi') + '</b> successfully — the password was correct. '
    + 'But this network makes new devices sign in through a web page before they can reach the internet, and this device has no screen to do that on.</p>'
    + '<div class="note"><div class="noteh">Give this to whoever manages the WiFi</div>'
    + (mac ? '<div class="kv"><span>Device MAC</span><code id="mac">' + esc(mac) + '</code></div>' : '')
    + (signInUrl ? '<div class="kv"><span>Sign-in page</span><code>' + esc(signInUrl) + '</code></div>' : '')
    + '<p class="fine">Ask them to <b>allow this MAC address</b> on the network (sometimes called whitelisting, a bypass rule, or a device exception). '
    + 'That is the permanent fix — guest sign-ins expire every day or two and there is nobody here to click through them.</p>'
    + '<p class="fine">A staff or back-office network without a sign-in page also works, and is usually the simpler answer.</p></div>'
    + '<button class="btn" id="recheck" type="button">I’ve done that — re-check now</button>'
    + '<button class="btn ghost" id="other" type="button">Use a different network instead</button>';
}

function portalPage({ networks = [], error = '', selected = '', captive = null, mac = '' } = {}) {
  const opts = networks.map((n) => {
    const lock = n.security && n.security !== '--' ? ' \u{1F512}' : '';
    const sel = n.ssid === selected ? ' selected' : '';
    return `<option value="${esc(n.ssid)}"${sel}>${esc(n.ssid)}${lock} (${Number(n.signal) || 0}%)</option>`;
  }).join('');
  const banner = error ? `<div class="banner err">${esc(error)}</div>` : '<div class="banner" id="b"></div>';
  // In captive mode the WiFi form is still present but collapsed behind "Use a different network instead", so the
  // tech is not made to re-enter a password that already worked, yet is never trapped if they want another SSID.
  const cap = captive ? captivePanel({ ssid: captive.ssid, signInUrl: captive.signInUrl, mac }) : '';
  const formStyle = captive ? ' style="display:none"' : '';
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>AutoPost Setup</title><style>' + PORTAL_STYLE + '</style></head><body><div class="login"><form class="lcard" id="f">'
    + '<div class="mark">◈</div><h1>' + (captive ? 'Almost there' : 'Connect this AutoPost device') + '</h1>'
    + (captive ? '' : '<p class="sub">Choose your WiFi network and enter the password. The device will join it and this setup network will disappear.</p>')
    + cap
    + (captive ? '' : banner)
    + '<div id="wifiForm"' + formStyle + '>'
    + (captive ? banner : '')
    + '<div class="field"><label>WiFi network</label><select name="ssid" id="ssid">'
    + (opts || '<option value="">(no networks found — enter one below)</option>')
    + '<option value="__other__">Other / hidden network…</option></select></div>'
    + '<div class="field" id="otherWrap" style="display:none"><label>Network name (SSID)</label><input name="ssidManual" id="ssidManual" autocomplete="off"></div>'
    + '<div class="field"><label>Password</label><input name="password" id="password" type="password" autocomplete="off"></div>'
    + '<div class="row"><input type="checkbox" id="ent"><label for="ent" style="margin:0">Business/enterprise WiFi (needs a username)</label></div>'
    + '<div class="field" id="entWrap" style="display:none"><label>Username</label><input name="identity" id="identity" autocomplete="off"></div>'
    + '<button class="btn" id="go" type="submit">Connect</button>'
    + '</div>'
    + '<div class="hint">' + (captive
      ? 'Re-checking takes about half a minute, and this setup network drops while it runs — rejoin it if the page stops responding.'
      : 'Wrong password? The AutoPost-Setup network comes back in about a minute — rejoin it and try again.') + '</div>'
    + '</form><script>' + PORTAL_JS + '</script></body></html>';
}

const PORTAL_JS = [
  'var f=document.getElementById("f"),ssid=document.getElementById("ssid"),ow=document.getElementById("otherWrap"),ent=document.getElementById("ent"),ew=document.getElementById("entWrap"),go=document.getElementById("go");',
  'function sync(){ow.style.display=ssid.value==="__other__"?"block":"none";ew.style.display=ent.checked?"block":"none"}',
  'ssid.addEventListener("change",sync);ent.addEventListener("change",sync);sync();',
  'function banner(t,cls){var b=document.getElementById("b");if(!b)return;b.textContent=t;b.className="banner "+cls}',
  // Guest-WiFi panel controls. Present only in captive mode, hence the null guards.
  'var rc=document.getElementById("recheck"),ot=document.getElementById("other"),wf=document.getElementById("wifiForm");',
  'if(ot&&wf){ot.addEventListener("click",function(){wf.style.display="block";ot.style.display="none"})}',
  'if(rc){rc.addEventListener("click",function(){',
  ' rc.disabled=true;rc.textContent="Re-checking\\u2026";',
  ' banner("Testing the network. This setup page drops for about half a minute \\u2014 rejoin AutoPost-Setup if it stops responding.","ok");',
  ' fetch("/recheck",{method:"POST"}).catch(function(){});',
  '})}',
  // Tapping the MAC selects the whole thing, so it can be copied or read out without transcription errors.
  'var mc=document.getElementById("mac");',
  'if(mc){mc.style.cursor="pointer";mc.addEventListener("click",function(){',
  ' try{var r=document.createRange();r.selectNodeContents(mc);var s=window.getSelection();s.removeAllRanges();s.addRange(r);}catch(e){}',
  ' try{navigator.clipboard&&navigator.clipboard.writeText(mc.textContent)}catch(e){}',
  '})}',
  'f.addEventListener("submit",function(ev){ev.preventDefault();',
  ' var s=ssid.value==="__other__"?(document.getElementById("ssidManual").value||"").trim():ssid.value;',
  ' if(!s){banner("Please choose or type a network name.","err");return}',
  ' var body={ssid:s,password:document.getElementById("password").value,identity:ent.checked?(document.getElementById("identity").value||"").trim():"",hidden:ssid.value==="__other__"};',
  ' go.disabled=true;go.textContent="Connecting\\u2026";banner("Saving your WiFi. Your phone will drop the AutoPost-Setup network in a moment \\u2014 that is normal.","ok");',
  ' fetch("/connect",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)}).catch(function(){});',
  '});',
].join('\n');

// ───────────────────────────── the recovery engine (injectable deps for tests) ──────────────────────────────
function createRecovery(deps = {}) {
  const cfg = Object.assign({}, CONFIG, deps.config || {});
  const log = deps.log || (() => {});
  const runner = deps.runner || defaultRunner();
  const tcpReach = deps.tcpReach || defaultTcpReach;
  const httpProbe = deps.httpProbe || defaultHttpProbe;
  const readSerial = deps.readSerial || defaultReadSerial;
  const nowFn = deps.now || Date.now;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));

  const state = {
    phase: 'boot', // boot | monitor | ap | connecting | captive
    iface: null,
    mac: '',
    // Set when we have PROVEN the joined network is behind a captive portal: { ssid, signInUrl, since }.
    // Distinct from lastError on purpose — the WiFi password is correct, so telling the tech to re-check it is
    // wrong and wastes their visit.
    captive: null,
    apSsid: null,
    networks: [], // last cached scan
    stationCons: [], // autopost-* station cons whose autoconnect we disabled while the AP is up
    server: null,
    reentries: [], // timestamps of SUCCESSFUL AP entries (rate limit — see reentryAllowed)
    lastPortalHit: 0, // last portal request (portalInUse -> defers the AP-tearing re-probe)
    probeDeferrals: 0, // consecutive ticks the re-probe has been deferred (bounded by maxProbeDeferralMs)
    apFailures: 0, // consecutive startAp() rollbacks — surfaced in the status file so a dead AP is visible
    apProbes: 0, // re-probes run this AP session; the FIRST one is scheduled much sooner (see apFirstProbeMs)
    lastRequestId: '', // id of the last off-band (Bluetooth / USB) credential request consumed
    diag: [], // rolling diagnostic ring, mirrored to runtime/recovery-log.txt (see diag())
    calls: [], // recorded command names (tests assert ordering)
  };

  const nmcli = (args, opts) => runner('nmcli', args, opts);

  // Everything log() says, PLUS the detail that only becomes interesting once something has gone wrong, kept in
  // a rolling on-disk ring. A shipped box has no console, no SSH and no internet at exactly the moment this
  // daemon matters, so anything that only reaches the journal reaches nobody — every field failure so far has
  // had to be diagnosed by guesswork because the box could not say what it had tried. This file is what the
  // rescue portal serves at /log and what the Bluetooth service exposes as its diagnostics characteristic.
  function diag(msg) {
    state.diag.push(new Date(nowFn()).toISOString() + ' ' + String(msg));
    if (state.diag.length > cfg.diagLines) state.diag.splice(0, state.diag.length - cfg.diagLines);
    try {
      fs.mkdirSync(cfg.runtimeDir, { recursive: true });
      fs.writeFileSync(path.join(cfg.runtimeDir, 'recovery-log.txt'), state.diag.join('\n') + '\n', { mode: 0o600 });
    } catch (_) { /* best effort — never let diagnostics break the rescue */ }
  }
  // say() is the operator-facing line; it always ALSO lands in the ring, so the journal and the on-box log can
  // never tell two different stories about the same boot.
  function say(msg) { log(msg); diag(msg); }

  async function detectIface() {
    if (state.iface) return state.iface;
    const r = await nmcli(['-t', '-f', 'DEVICE,TYPE', 'device']);
    for (const line of String(r.stdout || '').split(/\r?\n/)) {
      const [dev, type] = splitNmcli(line);
      if (type === 'wifi' && dev) { state.iface = dev; break; }
    }
    if (!state.iface) state.iface = 'wlan0';
    return state.iface;
  }

  // Run the HTTP connectivity probes in order until one gives a definitive verdict. Errors are not verdicts —
  // a network with no route at all just fails every probe, which is 'unknown', not 'portal'.
  async function captiveProbe() {
    for (const url of cfg.probeUrls) {
      let res = null;
      try { res = await httpProbe(url, cfg.probeHttpTimeoutMs); } catch (e) { res = { err: e }; }
      const verdict = classifyProbeResponse(res && Object.assign({ url }, res));
      if (verdict === 'full') return { verdict, url, signInUrl: '' };
      if (verdict === 'portal') {
        // Where a human would have to go to sign in. The redirect target is the best answer; failing that the
        // probe URL itself lands on the portal, which is still a usable thing to hand the tech.
        return { verdict, url, signInUrl: (res && res.location) || url };
      }
    }
    return { verdict: 'unknown', url: '', signInUrl: '' };
  }

  // FULL classification: NM's own view + the authoritative HTTP probe + the hub TCP vote. Returns a STATE, not a
  // boolean, so callers can treat "guest WiFi needs sign-in" differently from "the password is wrong".
  async function classifyConnectivity() {
    let connectivity = 'unknown';
    try { const r = await nmcli(['-t', '-f', 'CONNECTIVITY', 'general'], { timeoutMs: 8000 }); connectivity = String(r.stdout || '').trim() || 'unknown'; } catch (_) { /* ignore */ }
    const probe = await captiveProbe();
    // The hub vote is only consulted when the probe was inconclusive (see decideOnline) — otherwise a captive
    // portal answering the TCP connect would read as "online".
    const hub = hubTarget();
    let reach = false;
    try { reach = await tcpReach(hub.host, hub.port, 6000); } catch (_) { reach = false; }
    const assoc = await stationAssociated();
    const verdict = probe.verdict === 'unknown' ? undefined : probe.verdict;
    const st = decideConnectivityState(connectivity, reach, verdict, assoc);
    // Record the outcome for the status file the off-band channels read. Kept here rather than at the call sites
    // so every path that measures connectivity updates it — a status file that only refreshes on some code paths
    // is worse than none, because it reads as current.
    state.lastConnectivity = st;
    if (st === 'full' || st === 'portal' || st === 'limited') { const s = await currentSsid(); if (s) state.lastSsid = s; }
    return {
      state: st,
      online: st === 'full',
      captive: st === 'portal',
      signInUrl: st === 'portal' ? (probe.signInUrl || '') : '',
      nm: connectivity,
      probe: probe.verdict,
      hubReachable: reach,
    };
  }

  // Boolean wrapper kept for the call sites (and tests) that only care "is it up".
  async function hasInternet() { return (await classifyConnectivity()).online; }

  // Which network the station is actually on right now. Purely informational — it is what turns "offline" into
  // "joined DealerGuest but no route out" on the status a technician reads, which is a different problem.
  async function currentSsid() {
    try {
      const iface = await detectIface();
      const r = await nmcli(['-g', 'GENERAL.CONNECTION', 'device', 'show', iface], { timeoutMs: 8000 }).catch(() => ({ stdout: '' }));
      const con = String(r.stdout || '').trim();
      if (!con || con === '--' || con === cfg.apConName) return '';
      const g = await nmcli(['-g', '802-11-wireless.ssid', 'connection', 'show', con], { timeoutMs: 8000 }).catch(() => ({ stdout: '' }));
      return String(g.stdout || '').trim();
    } catch (_) { return ''; }
  }

  // The Pi's WiFi MAC. On a guest network with a captive portal this is THE thing the dealership's IT needs in
  // order to whitelist a headless device — so the rescue portal shows it. Best-effort; never throws.
  async function readMac() {
    if (state.mac) return state.mac;
    try {
      const iface = await detectIface();
      const r = await nmcli(['-g', 'GENERAL.HWADDR', 'device', 'show', iface], { timeoutMs: 8000 }).catch(() => ({ stdout: '' }));
      const m = /([0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5})/.exec(String(r.stdout || '').replace(/\\:/g, ':'));
      if (m) { state.mac = m[1].toUpperCase(); return state.mac; }
      const sys = fs.readFileSync('/sys/class/net/' + iface + '/address', 'utf8');
      const m2 = /([0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5})/.exec(sys);
      if (m2) { state.mac = m2[1].toUpperCase(); return state.mac; }
    } catch (_) { /* best effort */ }
    return state.mac || '';
  }

  function hubTarget() {
    try {
      const c = JSON.parse(fs.readFileSync(cfg.configPath, 'utf8'));
      const u = c.controlUrl || c.hubUrl || c.controlUrls && c.controlUrls[0];
      if (u) { const p = new URL(u.replace(/^ws/, 'http')); return { host: p.hostname, port: Number(p.port) || (p.protocol === 'https:' ? 443 : 80) }; }
    } catch (_) { /* no config yet (pre-claim) — fall through */ }
    return { host: '1.1.1.1', port: 443 };
  }

  async function scanNetworks() {
    const iface = await detectIface();
    // free the radio from the forever-retrying station attempt so the scan is clean
    await nmcli(['device', 'disconnect', iface]).catch(() => {});
    const r = await nmcli(['-t', '-f', 'SSID,SIGNAL,SECURITY,CHAN', 'device', 'wifi', 'list', 'ifname', iface, '--rescan', 'yes'], { timeoutMs: 25000 });
    state.networks = parseScanList(r.stdout);
    try { fs.mkdirSync(cfg.runtimeDir, { recursive: true }); fs.writeFileSync(path.join(cfg.runtimeDir, 'wifi-scan.json'), JSON.stringify({ at: nowFn(), networks: state.networks }), { mode: 0o600 }); } catch (_) { /* best effort */ }
    return state.networks;
  }

  // list autopost-* wifi station profiles (so we can pause their autoconnect while the AP owns the radio)
  async function listStationCons() {
    const r = await nmcli(['-t', '-f', 'NAME,TYPE', 'connection', 'show']);
    const out = [];
    for (const line of String(r.stdout || '').split(/\r?\n/)) {
      const [name, type] = splitNmcli(line);
      if (type === '802-11-wireless' && name && name !== cfg.apConName && /^autopost-/.test(name)) out.push(name);
    }
    return out;
  }

  // Re-enable autoconnect on the station profiles and nudge the radio to rejoin a real network.
  //
  // Re-lists from NetworkManager rather than trusting state.stationCons: the profile we most need to un-pause is
  // the one an EARLIER run paused and never got to release (power pulled while the AP was up), and that run's
  // in-memory list died with it. Deliberately NOT --temporary — the pause is temporary, the release is a repair,
  // and it has to reach the keyfile to heal a card that already shipped with autoconnect=false written to disk.
  async function restoreStation() {
    const iface = await detectIface();
    const cons = new Set(state.stationCons);
    for (const c of await listStationCons().catch(() => [])) cons.add(c);
    for (const c of cons) await nmcli(['connection', 'modify', c, 'connection.autoconnect', 'yes']).catch(() => {});
    state.stationCons = [];
    await nmcli(['device', 'connect', iface]).catch(() => {}); // let NM re-associate to the best known network
  }

  // "Is a human actually using the rescue portal right now?" Two independent signals, either one counts:
  //   1. a station is ASSOCIATED to the AP (`iw dev <if> station dump` lists it), and
  //   2. the portal served a request within portalBusyMs.
  // (1) alone is not enough - a phone can stay associated after the person walks away - and (2) alone is not
  // enough either, since someone can sit on the page reading without issuing a request. Together they cover the
  // real case: do not tear the AP down while it is being used.
  async function portalInUse() {
    if (state.lastPortalHit && (nowFn() - state.lastPortalHit) < cfg.portalBusyMs) return true;
    try {
      const iface = await detectIface();
      const r = await runner('iw', ['dev', iface, 'station', 'dump'], { timeoutMs: 8000 });
      if (/^\s*Station\s/mi.test(String(r.stdout || ''))) return true;
    } catch (_) { /* iw missing or failed -> fall through, do not block the probe on a broken check */ }
    return false;
  }

  async function startAp() {
    const iface = await detectIface();
    state.apSsid = apSsid(await readSerial(), cfg.apSsidPrefix);
    // Pause station autoconnect so NM (retries=0=forever) can't grab the radio back mid-AP.
    //
    // --temporary IS THE WHOLE POINT HERE, not a tidiness flag. Without it nmcli REWRITES the keyfile on disk,
    // so a card whose power is pulled while the rescue AP is up ships with the customer's own network marked
    // autoconnect=false — and on arrival it does not so much as attempt their WiFi, however perfect the
    // credentials are. That is a bench test actively breaking the card it was meant to validate. Temporary
    // changes live in NetworkManager's memory only and evaporate on the next boot, so a yanked power cord
    // leaves the profile exactly as the flasher wrote it.
    state.stationCons = await listStationCons();
    for (const c of state.stationCons) await nmcli(['connection', 'modify', '--temporary', c, 'connection.autoconnect', 'no']).catch(() => {});
    await nmcli(['device', 'disconnect', iface]).catch(() => {});
    await nmcli(['connection', 'delete', cfg.apConName]).catch(() => {}); // clear any stale AP profile
    const chan = pickApChannel(state.networks, cfg.apChannel);
    const add = ['connection', 'add', 'type', 'wifi', 'ifname', iface, 'con-name', cfg.apConName, 'autoconnect', 'no',
      'ssid', state.apSsid, '802-11-wireless.mode', 'ap', '802-11-wireless.band', 'bg',
      '802-11-wireless.channel', String(chan), 'ipv4.method', 'shared', 'ipv6.method', 'ignore'];
    await nmcli(add);
    if (!cfg.apOpen && cfg.apPassword) {
      // pmf=1 (DISABLE Protected Management Frames) is REQUIRED, not a preference. Without it NM defaults to
      // pmf=optional and offers key_mgmt "WPA-PSK WPA-PSK-SHA256". The Pi Zero W's BCM43430 firmware
      // (7.45.98) does not support SHA256 key management IN AP MODE, so the kernel rejects the key
      // ("nl80211: kernel reports: key setting validation failed"), wpa_supplicant cannot initialise the AP
      // interface, and NM fails the activation with supplicant-timeout after ~25s. startAp() then correctly
      // rolls back — which presented as "the recovery AP never starts" on every wrong-WiFi Zero W.
      // Confirmed on hardware 2026-08-14: identical profile activates in <1s with pmf=1 and gets its
      // 10.42.0.1 shared-mode gateway; without it, it never comes up. Safe on newer radios too — the AP is a
      // transient, on-site rescue network, so dropping PMF costs nothing operationally.
      await nmcli(['connection', 'modify', cfg.apConName, 'wifi-sec.key-mgmt', 'wpa-psk', 'wifi-sec.psk', cfg.apPassword, 'wifi-sec.pmf', '1']);
    }
    // Give the activation a real budget on BOTH clocks. `nmcli connection up` blocks until the activation
    // settles (default 90s); the command runner's default execFile timeout is 20s. Left mismatched, nmcli was
    // killed at 20s on any site where bring-up took longer, and the exit code below then condemned an AP that
    // had actually come up.
    const upWaitS = Math.max(5, Math.round(cfg.apUpWaitMs / 1000));
    const up = await nmcli(['--wait', String(upWaitS), 'connection', 'up', cfg.apConName], { timeoutMs: cfg.apUpWaitMs + 10000 });
    // VERIFY the AP actually came up, and let the OBSERVED radio state be the verdict. The shared-mode gateway
    // address appearing on the interface is direct evidence the AP is serving; nmcli's exit code is a report
    // about one command invocation, and a non-zero one is routinely just "it took longer than I waited".
    // Trusting the exit code over the evidence is what tore down working rescue APs in the field, so a bad
    // code now only gets logged.
    let ipUp = false;
    const ipDeadline = nowFn() + cfg.apIpWaitMs;
    while (nowFn() < ipDeadline) {
      const r = await nmcli(['-g', 'IP4.ADDRESS', 'device', 'show', iface]).catch(() => ({ stdout: '' }));
      if (String(r.stdout || '').includes(cfg.apGatewayIp)) { ipUp = true; break; }
      await sleep(1000);
    }
    if (up && up.code !== 0) {
      diag('AP activation returned ' + up.code + (ipUp ? ' but the gateway IP is up, so the AP is serving — continuing' : '')
        + (String(up.stderr || '').trim() ? ' :: ' + String(up.stderr).trim().split(/\r?\n/)[0] : ''));
    }
    if (!ipUp) {
      say('recovery: AP did NOT come up (up.code=' + (up && up.code) + ', channel=' + chan + ', no ' + cfg.apGatewayIp
        + ' after ' + Math.round(cfg.apIpWaitMs / 1000) + 's) — rolling back to station mode so the box is never stranded'
        + (String(up && up.stderr || '').trim() ? ' :: ' + String(up.stderr).trim().split(/\r?\n/)[0] : ''));
      await nmcli(['connection', 'delete', cfg.apConName]).catch(() => {});
      await restoreStation();
      state.phase = 'monitor';
      state.apFailures = (state.apFailures || 0) + 1;
      writeState();
      return false;
    }
    state.apSince = nowFn();
    state.apFailures = 0;
    state.calls.push('startAp');
    state.phase = 'ap';
    startServer();
    say('recovery: AP up as "' + state.apSsid + '" on channel ' + chan + ' — portal on http://' + cfg.apGatewayIp);
    writeState();
    return true;
  }

  async function stopAp() {
    stopServer();
    await nmcli(['connection', 'down', cfg.apConName]).catch(() => {});
    await nmcli(['connection', 'delete', cfg.apConName]).catch(() => {});
    // Same repair-not-pause reasoning as restoreStation(): re-list so a profile left paused by a previous
    // process also gets released, and write it through to disk.
    const cons = new Set(state.stationCons);
    for (const c of await listStationCons().catch(() => [])) cons.add(c);
    for (const c of cons) await nmcli(['connection', 'modify', c, 'connection.autoconnect', 'yes']).catch(() => {});
    state.stationCons = [];
    state.calls.push('stopAp');
  }

  // Write a corrected station profile DIRECTLY via nmcli (mirrors deploy/pi/set-wifi.sh's logic but keeps the con
  // name we control end-to-end — so bring-up + dup-cleanup can't target the wrong profile for a non-ASCII SSID,
  // an SSID that looks like a set-wifi.sh flag can't hijack an arg parser, and an OPEN network with no password is
  // handled instead of rejected). One profile per SSID; every OTHER saved network is left intact as a fallback.
  async function writeNetwork({ ssid, password, identity, hidden }) {
    const iface = await detectIface();
    const con = conNameFor(ssid);
    await nmcli(['connection', 'delete', con]).catch(() => {}); // update-in-place, never clobber other SSIDs
    await nmcli(['connection', 'add', 'type', 'wifi', 'con-name', con, 'ifname', iface, 'ssid', ssid,
      'connection.autoconnect', 'yes', 'connection.autoconnect-priority', '20']);
    if (hidden) await nmcli(['connection', 'modify', con, '802-11-wireless.hidden', 'yes']).catch(() => {});
    if (identity) {
      // WPA-Enterprise (PEAP/MSCHAPv2). No CA cert to ship -> don't validate (matches set-wifi.sh).
      await nmcli(['connection', 'modify', con, 'wifi-sec.key-mgmt', 'wpa-eap', '802-1x.eap', 'peap',
        '802-1x.phase2-auth', 'mschapv2', '802-1x.identity', identity, '802-1x.password', password]).catch(() => {});
      await nmcli(['connection', 'modify', con, '802-1x.system-ca-certs', 'no']).catch(() => {});
    } else if (password) {
      await nmcli(['connection', 'modify', con, 'wifi-sec.key-mgmt', 'wpa-psk', 'wifi-sec.psk', password]).catch(() => {});
    } // else: OPEN network — a freshly-added wifi con has no security, which is correct for an open SSID.
    state.calls.push('writeNetwork');
    return con;
  }

  // Apply a corrected network + join it + verify. NEVER strands: teardown-first, keep other profiles, re-raise AP on fail.
  async function applyAndVerify({ ssid, password, identity, hidden }) {
    state.phase = 'connecting';
    writeState();
    // 1) tear the AP DOWN FIRST so the single radio is free before we scan/associate
    await stopAp();
    // 2) write the corrected profile (direct nmcli, con name we control end-to-end; keeps other saved networks)
    const con = await writeNetwork({ ssid, password, identity, hidden });
    // 3) bring it up (bounded) and 4) verify real connectivity within the window
    await nmcli(['--wait', '30', 'connection', 'up', con], { timeoutMs: 45000 }).catch(() => {});
    const deadline = nowFn() + cfg.connectTimeoutMs;
    let cls = { state: 'none', online: false, captive: false, signInUrl: '' };
    while (nowFn() < deadline) {
      cls = await classifyConnectivity();
      // Stop as soon as the answer is DEFINITIVE either way. A captive portal is a final answer too: waiting out
      // the rest of the window cannot turn it into internet, and the tech is standing there.
      if (cls.online || cls.captive) break;
      await sleep(4000);
    }
    if (cls.online) {
      await cleanupDuplicateProfiles(ssid, con);
      state.calls.push('connected');
      state.phase = 'monitor';
      state.offlineSince = 0;
      state.lastError = '';
      state.captive = null;
      writeState();
      say('recovery: corrected WiFi connected to "' + ssid + '" — online');
      return { ok: true };
    }
    // 5a) GUEST / CAPTIVE WIFI. The credentials WORKED — we associated and got an address, and something is
    //     intercepting. Reverting would be wrong and telling the tech to re-check the password would send them
    //     chasing a fault that does not exist. KEEP the profile (IT may whitelist the MAC later and then it just
    //     starts working), and re-raise the AP carrying sign-in instructions instead of a password error.
    if (cls.captive) {
      await cleanupDuplicateProfiles(ssid, con);
      state.captive = { ssid, signInUrl: cls.signInUrl || '', since: nowFn() };
      state.lastError = '';
      state.calls.push('captive');
      say('recovery: joined "' + ssid + '" but it is behind a captive portal (sign-in required)'
        + (cls.signInUrl ? ' — sign-in page: ' + cls.signInUrl : ''));
      await readMac();
      await startAp();
      writeState();
      return { ok: false, captive: true, signInUrl: cls.signInUrl || '' };
    }
    // 5b) FAILED -> never strand: re-raise the AP with an error for another try. If even the AP can't come up,
    //     startAp() has already rolled the station back to autoconnect (best-effort recovery).
    say('recovery: correction to "' + ssid + '" did not come online — re-opening setup portal');
    state.captive = null;
    state.lastError = 'Could not connect to "' + ssid + '". Check the password and try again.';
    await startAp();
    return { ok: false };
  }

  // After a good correction, drop any OTHER profile for the SAME SSID (e.g. the flasher's wrong-password keyfile).
  // `keepCon` is the exact profile we just connected, so this can never delete the live one (the non-ASCII bug).
  async function cleanupDuplicateProfiles(ssid, keepCon) {
    const keep = keepCon || conNameFor(ssid);
    const r = await nmcli(['-t', '-f', 'NAME,TYPE', 'connection', 'show']).catch(() => ({ stdout: '' }));
    for (const line of String(r.stdout || '').split(/\r?\n/)) {
      const [name, type] = splitNmcli(line);
      if (type !== '802-11-wireless' || !name || name === keep || name === cfg.apConName) continue;
      const g = await nmcli(['-g', '802-11-wireless.ssid', 'connection', 'show', name]).catch(() => ({ stdout: '' }));
      if (String(g.stdout || '').trim() === ssid) { await nmcli(['connection', 'delete', name]).catch(() => {}); say('recovery: removed stale duplicate profile "' + name + '" for SSID "' + ssid + '"'); }
    }
  }

  // AP-flap guard. Two rules, both learned the hard way:
  //   1. Only SUCCESSFUL raises count (recordApRaise is called on the way OUT of startAp, not before it). When
  //      failed attempts counted, six rolled-back activations burned the whole hour's budget in about ten
  //      minutes and the box then raised NOTHING while someone stood in front of it refreshing their WiFi list.
  //      A failing AP is the case that needs retrying most, not the one to give up on.
  //   2. A box that has NEVER been online is exempt. The guard exists to stop a claimed, working unit flapping
  //      its radio through a transient site outage; a unit that has never once reached the hub has no working
  //      state to protect and the rescue AP is its only remaining way of being fixed.
  function reentryAllowed() {
    if (neverOnline()) return true;
    const cutoff = nowFn() - 3600000;
    state.reentries = state.reentries.filter((t) => t > cutoff);
    return state.reentries.length < cfg.maxReentriesPerHour;
  }
  function recordApRaise() { state.reentries.push(nowFn()); }

  // Persist enough for the fleet dashboard / VERIFY-PI.cmd to tell "needs a network sign-in" apart from "offline".
  // Those are the same symptom to a human watching a status light and completely different problems to fix, and
  // without `captive` here a rack of guest-WiFi units all read as generic failures.
  //
  // Two files, on purpose. `wifi-recovery.json` keeps its exact original shape because VERIFY-PI.cmd, pi-verify.sh
  // and the dashboard already parse it. `wifi-status.json` is the richer one the OFF-BAND channels read
  // (Bluetooth, and anything else that later has to answer "what is this box actually doing" without touching the
  // radio) — widening the old file instead would have meant re-certifying every existing reader to learn nothing.
  function writeState() {
    const base = {
      at: nowFn(),
      phase: state.phase,
      apSsid: state.apSsid,
      mac: state.mac || '',
      captive: state.captive ? { ssid: state.captive.ssid || '', signInUrl: state.captive.signInUrl || '', since: state.captive.since || 0 } : null,
    };
    try {
      fs.mkdirSync(cfg.runtimeDir, { recursive: true });
      fs.writeFileSync(path.join(cfg.runtimeDir, 'wifi-recovery.json'), JSON.stringify(base), { mode: 0o600 });
      fs.writeFileSync(path.join(cfg.runtimeDir, 'wifi-status.json'), JSON.stringify(Object.assign({}, base, {
        connectivity: state.lastConnectivity || 'unknown',
        online: state.lastConnectivity === 'full',
        ssid: state.lastSsid || '',
        lastError: state.lastError || '',
        apFailures: state.apFailures || 0,
        neverOnline: neverOnline(),
        uptimeS: Math.round(process.uptime()),
      })), { mode: 0o600 });
    } catch (_) { /* best effort */ }
  }

  // ── OFF-BAND CREDENTIAL REQUESTS (the Bluetooth channel, and anything added after it) ───────────────────────
  // The Bluetooth service deliberately does NOT drive nmcli. One radio, one owner, one state machine: it drops a
  // request file here and THIS daemon applies it through the same applyAndVerify() the captive portal uses, so
  // the never-strand teardown order, the captive-portal outcome, the duplicate-profile cleanup and the AP
  // re-raise on failure are identical no matter which door the credentials arrived through. A second process
  // running its own `nmcli connection up` against the same single radio is exactly the class of bug this avoids.
  //
  // Requests are idempotent by `id`, and the last id consumed is persisted: a service restart, or a Bluetooth
  // client that never saw the reply and wrote the file again, must not re-apply a correction that already ran
  // and knock a now-working box back off its network.
  function requestPath() { return path.join(cfg.runtimeDir, 'wifi-request.json'); }
  function resultPath() { return path.join(cfg.runtimeDir, 'wifi-result.json'); }
  function lastIdPath() { return path.join(cfg.runtimeDir, 'wifi-request-last'); }

  function writeResult(res) {
    try {
      fs.mkdirSync(cfg.runtimeDir, { recursive: true });
      fs.writeFileSync(resultPath(), JSON.stringify(Object.assign({ at: nowFn() }, res)), { mode: 0o600 });
    } catch (_) { /* best effort */ }
  }

  // Read a pending off-band request, or null. Never throws: the Bluetooth service and this daemon are separate
  // processes with no lock between them, so a half-written file must read as "nothing pending" and be retried on
  // the next tick — not crash the loop that is the box's only way home.
  function readRequest() {
    let req = null;
    try { req = JSON.parse(fs.readFileSync(requestPath(), 'utf8')); } catch (_) { return null; }
    if (!req || typeof req !== 'object') return null;
    const id = String(req.id || '');
    if (!id || id === state.lastRequestId) return null;
    if (!state.lastRequestId) {
      // First look this process has had at the file — consult the persisted marker so a restart mid-apply does
      // not replay a request that was already handled.
      try { if (fs.readFileSync(lastIdPath(), 'utf8').trim() === id) { state.lastRequestId = id; return null; } } catch (_) { /* none yet */ }
    }
    return req;
  }

  function consumeRequest(id) {
    state.lastRequestId = String(id || '');
    try { fs.writeFileSync(lastIdPath(), state.lastRequestId, { mode: 0o600 }); } catch (_) { /* best effort */ }
  }

  // Act on one off-band request. Returns true if it took the radio, so tick() stops for this round.
  async function handleRequest(req) {
    const id = String(req.id || '');
    const action = String(req.action || 'connect');
    const source = String(req.source || 'off-band');
    consumeRequest(id);
    if (action === 'recheck') {
      say('recovery: re-check requested over ' + source);
      state.recheckRequested = true;
      writeResult({ id, action, ok: true, message: 'Re-testing the network.' });
      return false;
    }
    if (action === 'scan') {
      say('recovery: network scan requested over ' + source);
      // Only safe while the AP is not the radio's owner. In AP mode the cached list is what we have — scanning
      // would mean tearing the rescue network down underneath whoever just asked for the list.
      if (state.phase !== 'ap') await scanNetworks().catch(() => {});
      writeResult({ id, action, ok: true, count: state.networks.length });
      return false;
    }
    const ssid = String(req.ssid || '').trim();
    if (!ssid) { writeResult({ id, action, ok: false, error: 'No network name given.' }); return false; }
    say('recovery: WiFi credentials for "' + ssid + '" received over ' + source + ' — applying');
    writeResult({ id, action: 'connect', ssid, ok: null, message: 'Connecting...' });
    const out = await applyAndVerify({
      ssid,
      password: String(req.password || ''),
      identity: String(req.identity || '').trim(),
      hidden: !!req.hidden,
    });
    writeResult({
      id,
      action: 'connect',
      ssid,
      ok: !!(out && out.ok),
      captive: !!(out && out.captive),
      signInUrl: (out && out.signInUrl) || '',
      error: out && out.ok ? '' : (state.lastError || (out && out.captive ? 'This network needs a sign-in.' : 'Could not connect.')),
    });
    return true;
  }

  // ── HTTP portal ──
  function requestHandler(req, res) {
    // Mark the portal as IN USE. tick() refuses to run the re-probe (which tears the AP down) for
    // portalBusyMs after the last request, so nobody gets thrown off mid-form. See tick().
    state.lastPortalHit = nowFn();
    const send = (code, type, body) => { try { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); } catch (_) { /* ignore */ } };
    let pathname = '/';
    try { pathname = new URL(req.url, 'http://x').pathname; } catch (_) { pathname = req.url || '/'; }
    if (req.method === 'GET' && pathname === '/networks') return send(200, 'application/json', JSON.stringify({ networks: state.networks }));
    if (req.method === 'GET' && pathname === '/status') {
      return send(200, 'application/json', JSON.stringify({
        phase: state.phase, apSsid: state.apSsid, mac: state.mac || '',
        connectivity: state.lastConnectivity || 'unknown', ssid: state.lastSsid || '',
        apFailures: state.apFailures || 0, lastError: state.lastError || '',
        captive: state.captive ? { ssid: state.captive.ssid || '', signInUrl: state.captive.signInUrl || '' } : null,
      }));
    }
    // The rolling diagnostic log, as plain text. This is the endpoint that turns "it just never worked" into a
    // fault someone can name — and it is reachable over the USB cable even when the radio is the thing that is
    // broken, which is the case where every other way of asking is gone.
    if (req.method === 'GET' && pathname === '/log') {
      return send(200, 'text/plain; charset=utf-8', state.diag.join('\n') + '\n');
    }
    // "I've whitelisted the MAC / signed the device in — try again now." Sets a flag the main loop picks up on its
    // next tick rather than probing inline: probing tears the AP down, and doing that inside a request handler
    // would kill the very connection we still need to answer on.
    if (req.method === 'POST' && pathname === '/recheck') {
      state.recheckRequested = true;
      say('recovery: re-check requested from the setup page');
      return send(200, 'application/json', JSON.stringify({ ok: true, message: 'Re-testing the network now. This setup network will drop briefly.' }));
    }
    if (req.method === 'POST' && pathname === '/connect') {
      let raw = ''; req.on('data', (d) => { if (raw.length < 4000) raw += d; });
      req.on('end', () => {
        let b = {}; try { b = JSON.parse(raw || '{}'); } catch (_) { b = {}; }
        const ssid = String(b.ssid || '').trim();
        // respond IMMEDIATELY (tearing the AP down kills the phone's link before any later result could arrive)
        send(200, 'application/json', JSON.stringify({ ok: true, message: 'Saving. Your phone will drop AutoPost-Setup shortly. If the device comes online you are done; if not, the setup network returns in about a minute.' }));
        if (ssid) { applyAsync({ ssid, password: String(b.password || ''), identity: String(b.identity || '').trim(), hidden: !!b.hidden }); }
      });
      return undefined;
    }
    // captive-portal probes + everything else -> serve the portal so the OS pops the "sign in to network" sheet
    return send(200, 'text/html; charset=utf-8', portalPage({
      networks: state.networks,
      error: state.lastError || '',
      selected: (state.captive && state.captive.ssid) || '',
      captive: state.captive,
      mac: state.mac || '',
    }));
  }

  // fire-and-forget the correction (guarded so a second submit while one is running is ignored)
  let applying = false;
  function applyAsync(input) {
    // Clear the guest-WiFi panel for the duration of the attempt: the operator has chosen to try something, and
    // leaving "this network needs a sign-in" on screen while we act on a DIFFERENT network would be a lie.
    if (applying) return; applying = true; state.lastError = ''; state.captive = null;
    Promise.resolve().then(() => applyAndVerify(input)).catch((e) => { say('recovery: apply error ' + (e && e.message)); }).finally(() => { applying = false; });
  }

  function startServer() {
    if (cfg.serve === false) return; // tests drive requestHandler directly without binding a real AP socket
    if (state.server) return;
    const srv = http.createServer((req, res) => requestHandler(req, res));
    srv.on('error', (e) => say('recovery: portal server error ' + (e && e.message)));
    try { srv.listen(80, cfg.apGatewayIp, () => say('recovery: portal listening on ' + cfg.apGatewayIp + ':80')); } catch (e) { say('recovery: listen failed ' + (e && e.message)); }
    state.server = srv;
  }
  function stopServer() { if (state.server) { try { state.server.close(); } catch (_) { /* ignore */ } state.server = null; } }

  // THE USB FRONT DOOR. The same rescue portal, bound to the USB-gadget address, up from the moment this daemon
  // starts and never taken down — it is not part of the AP lifecycle at all. Plug a laptop into the Pi's USB DATA
  // port and http://10.55.0.1 is the setup page, with no radio involved in reaching it. That matters twice over:
  // it works when the WiFi rescue is what is broken, and it is how a returned unit gets diagnosed on the bench
  // (GET /log) instead of being reflashed and losing the evidence.
  //
  // Bound to the gadget address SPECIFICALLY, never 0.0.0.0: a wildcard bind would put an unauthenticated "set my
  // WiFi" form on the dealership's LAN. EADDRNOTAVAIL just means no gadget on this box, which is not an error.
  function startUsbServer() {
    if (cfg.serve === false || !cfg.usbPortalEnabled) return;
    if (state.usbServer) return;
    // Retried from tick(), because the gadget script waits up to 45s for the USB controller and the usb0
    // interface to exist — so on a cold boot this daemon is running well before the address it wants does.
    // Backed off, because "retry every tick forever" on a box where the gadget never appears means a discarded
    // Server object every 30 seconds for the life of the unit, and these boxes run for months.
    if (state.usbRetryAfter && nowFn() < state.usbRetryAfter) return;
    const srv = http.createServer((req, res) => requestHandler(req, res));
    srv.on('error', (e) => {
      const code = e && e.code;
      if (code === 'EADDRNOTAVAIL' || code === 'EADDRINUSE') {
        if (!state.usbQuiet) { state.usbQuiet = true; diag('USB portal not bound (' + code + ') — no usb0 address yet; will keep retrying'); }
      } else { diag('USB portal error ' + (e && e.message)); }
      try { srv.close(); } catch (_) { /* already dead */ }
      state.usbServer = null;
      state.usbRetryAfter = nowFn() + 60000;
    });
    try {
      srv.listen(80, cfg.usbPortalIp, () => {
        state.usbQuiet = false;
        say('recovery: USB portal listening on http://' + cfg.usbPortalIp + ' (plug a laptop into the USB DATA port)');
      });
      state.usbServer = srv;
    } catch (e) {
      diag('USB portal listen failed ' + (e && e.message));
      state.usbRetryAfter = nowFn() + 60000;
    }
  }

  // While the AP owns the single radio the station can't associate, so connectivity can't be measured in AP mode.
  // Instead, periodically DROP the AP and re-test the real network — this self-heals a transient outage (an ISP or
  // router blip that tripped the AP on a HEALTHY box) with nobody touching the portal, and guarantees station
  // autoconnect is never left off. If still offline, the AP goes back up for the dealership.
  // Has the station actually ASSOCIATED to a real AP? Used to abandon a probe early. `iw link` says "Not
  // connected." when it has not, which is the cheap check; any failure of the check is treated as "unknown" so
  // a missing/odd iw can never make us cut a probe short that would have succeeded.
  async function stationAssociated() {
    try {
      const iface = await detectIface();
      const r = await runner('iw', ['dev', iface, 'link'], { timeoutMs: 6000 });
      const out = String(r.stdout || '');
      if (/Not connected/i.test(out)) return false;
      if (/Connected to/i.test(out)) return true;
    } catch (_) { /* unknown */ }
    return null; // unknown -> keep waiting out the full window
  }

  async function probeRealNetwork() {
    state.apProbes = (state.apProbes || 0) + 1;
    say('recovery: re-testing the dealership network (dropping the setup AP briefly)');
    await stopAp(); // restores station autoconnect + frees the radio so it can re-associate
    const started = nowFn();
    const deadline = started + cfg.probeWaitMs;
    let cls = { online: false, captive: false, signInUrl: '' };
    while (nowFn() < deadline) {
      cls = await classifyConnectivity();
      if (cls.online || cls.captive) break;
      // EARLY EXIT: if the radio has not even associated by probeAssocMs, the network is not coming back on this
      // attempt. Sitting out the rest of the window just extends the hole in AP coverage for no information.
      if ((nowFn() - started) >= cfg.probeAssocMs && (await stationAssociated()) === false) {
        say('recovery: station did not associate — ending the probe early and restoring the AP');
        break;
      }
      await sleep(3000);
    }
    if (cls.online) {
      state.phase = 'monitor'; state.offlineSince = 0; state.lastError = ''; state.captive = null;
      state.apProbes = 0;   // a later AP session gets its own fast first look
      writeState();
      state.calls.push('probeRecovered');
      say('recovery: the dealership network is back — setup closed automatically');
      return;
    }
    // Still behind the guest network's sign-in. Refresh what we know (the sign-in URL can change per session)
    // and keep the AP up so the tech can read the instructions — but do NOT overwrite it with a password error.
    if (cls.captive) {
      state.captive = Object.assign({ ssid: (state.captive && state.captive.ssid) || '', since: nowFn() },
        state.captive || {}, { signInUrl: cls.signInUrl || (state.captive && state.captive.signInUrl) || '' });
      state.lastError = '';
      await readMac();
      say('recovery: still behind the guest network sign-in — keeping the setup page open');
    }
    await startAp(); // still not usable -> put the setup AP back
  }

  // A box that has NEVER been online is not suffering an outage — it was flashed with credentials that do not
  // work, and the person standing next to it needs the rescue AP now, not in seven minutes. Once config.json
  // exists (i.e. it has claimed at least once) we switch to the long, conservative hysteresis, because from then
  // on a dropout really could be a transient router blip worth riding out.
  function neverOnline() {
    try { return !fs.existsSync(cfg.configPath); } catch (_) { return false; }
  }
  // NO SAVED WIFI AT ALL. A card can be flashed deliberately with no credentials (the flasher's "capture WiFi on
  // first boot" option) for a site whose network is not known in advance. Such a box has nothing to associate
  // with, so both graces are pointless: they exist to ride out a network that might come back, and here there is
  // no network to come back. Raise the AP straight away so whoever is standing next to it can hand it
  // credentials -- the same reasoning as the captive-portal case in tick(). Detected from live NetworkManager
  // state rather than a flag baked on the card, so it is self-clearing (the instant any profile is saved this is
  // false) and it equally covers a box that lost every profile some other way.
  // IS THERE A WIRE? A wired card (see the flasher's wired mode) takes its uplink from a USB-ethernet adapter and
  // ships with no WiFi profiles AT ALL, on purpose. Without this, noSavedWifi() reads that intended configuration
  // as the emergency it was written for and raises the rescue AP within seconds of every boot - before the
  // adapter has finished DHCP - on a box that is about to be perfectly online.
  //
  // Detected from live NetworkManager state rather than the mode marker on the card, for the same reason
  // noSavedWifi() is: it self-clears. Unplug the adapter and the box correctly goes back to treating a missing
  // network as something to rescue.
  //
  // The USB GADGET is excluded by name AND by profile. It is type=ethernet and permanently "connected" with its
  // static service address, so counting it would suppress the instant AP on every gadget card - including the
  // "capture WiFi on first boot" cards whose whole purpose is to raise that AP immediately.
  async function wiredDevicePresent() {
    try {
      const r = await nmcli(['-t', '-f', 'DEVICE,TYPE,STATE,CONNECTION', 'device']).catch(() => null);
      if (!r) return false;
      const wifiIface = state.iface;
      for (const line of String(r.stdout || '').split(/\r?\n/)) {
        if (!line.trim()) continue;
        const [dev, type, , con] = splitNmcli(line);
        if (!dev || !type) continue;
        if (type === 'wifi' || type === 'loopback' || dev === wifiIface) continue;
        if (dev === 'usb0' || con === 'autopost-usb0') continue;   // the service link, not an uplink
        if (type === 'ethernet') return true;
      }
      return false;
    } catch (_) { return false; }   // never let this throw the tick
  }

  // THE WIRE HAS NO RETRY OF ITS OWN, and that is the whole point of this function.
  //
  // autopost-eth0 carries `may-fail=true` alongside a static service address, so its IPv4 configuration can
  // never actually FAIL: when DHCP does not answer - a managed switch holding the port down through
  // spanning-tree, a slow or briefly-dead DHCP server, a cable moved between sites - NetworkManager still marks
  // the connection ACTIVATED, carrying only 10.55.0.1 and no default route. And because the activation
  // SUCCEEDED, `autoconnect-retries=0` has nothing to retry. The box sits there reporting a live connection,
  // with no way off the LAN, until a human reboots it.
  //
  // Nothing else in this daemon covers that. The rescue AP is a WiFi door, and a wired card ships with no WiFi
  // profiles at all, so the offline branch's only remedy is useless to it. So: while offline with a wire
  // present, re-activate the wire on an interval. `connection up` re-runs DHCP from scratch, which is exactly
  // what a late-arriving DHCP server needs. Rate-limited, so a genuinely dead port is not thrashed every tick.
  async function retryWiredUplink() {
    if (nowFn() - (state.lastWiredRetry || 0) < cfg.wiredRetryMs) return false;
    let tried = false;
    try {
      const r = await nmcli(['-t', '-f', 'DEVICE,TYPE,STATE,CONNECTION', 'device']).catch(() => null);
      if (!r) return false;
      for (const line of String(r.stdout || '').split(/\r?\n/)) {
        if (!line.trim()) continue;
        const [dev, type, , con] = splitNmcli(line);
        if (!dev || !type) continue;
        if (type === 'wifi' || type === 'loopback' || dev === state.iface) continue;
        if (dev === 'usb0' || con === 'autopost-usb0') continue;   // the service link, not an uplink
        if (type !== 'ethernet') continue;
        state.lastWiredRetry = nowFn();
        tried = true;
        say('recovery: offline with a wire present - re-activating ' + (con || dev) + ' to force a fresh DHCP');
        if (con) await nmcli(['connection', 'up', con], { timeoutMs: cfg.wiredRetryTimeoutMs }).catch(() => null);
        else await nmcli(['device', 'connect', dev], { timeoutMs: cfg.wiredRetryTimeoutMs }).catch(() => null);
      }
    } catch (_) { /* never let this throw the tick */ }
    return tried;
  }

  async function noSavedWifi() {
    try {
      const r = await nmcli(['-t', '-f', 'NAME,TYPE', 'connection', 'show']).catch(() => null);
      if (!r) return false;                 // could not tell -> assume wifi exists and keep the normal graces
      for (const line of String(r.stdout || '').split(/\r?\n/)) {
        const [name, type] = splitNmcli(line);
        if (type === '802-11-wireless' && name && name !== cfg.apConName) return false;
      }
      return true;
    } catch (_) { return false; }           // never let this throw the tick
  }
  // Math.min, deliberately: the first-run value may only ever SHORTEN the wait. If an operator (or a test) has
  // explicitly configured a shorter grace, that must still win — otherwise "first run" would silently make the
  // box slower to rescue than it was told to be.
  function offlineGrace() { return neverOnline() ? Math.min(cfg.firstRunOfflineGraceMs, cfg.offlineGraceMs) : cfg.offlineGraceMs; }
  function bootGrace() { return neverOnline() ? Math.min(cfg.firstRunBootGraceMs, cfg.bootGraceMs) : cfg.bootGraceMs; }
  // The wait before the FIRST tick. Boot grace exists to give a REAL network time to come up before we judge the
  // box offline -- but a card flashed with no credentials at all has nothing to come up, so that wait is pure
  // delay in front of the one thing the person on site is waiting for. Settle briefly first so NetworkManager is
  // up enough to answer honestly; if it cannot answer yet, fall through to the full grace rather than guessing.
  // Split out of run() so it can be tested without entering run()'s endless tick loop.
  async function waitOutBootGrace() {
    const settleMs = Math.min(5000, bootGrace());
    await sleep(settleMs);
    if (await noSavedWifi() && !(await wiredDevicePresent())) {
      say('recovery: no saved WiFi profiles - skipping the boot grace, raising the setup AP now');
      return settleMs;
    }
    const rest = Math.max(0, bootGrace() - settleMs);
    await sleep(rest);
    return settleMs + rest;
  }

  // ── main loop ──
  async function tick() {
    if (applying || state.phase === 'connecting') return; // a correction is in flight — leave the radio alone
    // Retry the USB bind every round. The gadget script waits up to 45s for the USB controller and the usb0
    // interface, so on a cold boot this daemon is usually running well before the address it wants exists.
    startUsbServer();
    // OFF-BAND FIRST, before anything that touches the radio. Someone is standing there with a phone paired over
    // Bluetooth; their correction outranks a scheduled re-probe, and applying it also settles what the radio
    // should be doing for the rest of this round.
    const offBand = readRequest();
    if (offBand) { if (await handleRequest(offBand)) return; }
    if (state.phase === 'ap') {
      // do NOT measure connectivity here (the AP owns the radio); re-probe the real network on an interval instead.
      // A PROVEN captive portal gets the slower interval: the credentials are right and nothing will change until
      // a human signs in or IT whitelists the MAC, so tearing the AP down every 15 minutes is pure churn — and the
      // tech has a "Re-check now" button for the moment they DO act.
      const probeEvery = state.captive
        ? Math.max(cfg.apProbeMs, cfg.captiveProbeMs)
        : (state.apProbes ? cfg.apProbeMs : Math.min(cfg.apFirstProbeMs, cfg.apProbeMs));
      if (state.recheckRequested) {
        state.recheckRequested = false;
        say('recovery: re-check requested from the setup page — testing the network now');
        await probeRealNetwork();
        return;
      }
      if (nowFn() - (state.apSince || 0) >= probeEvery) {
        // DO NOT yank the AP out from under someone who is using it. The re-probe exists to self-heal a
        // transient router outage on an UNATTENDED box; when a human is actually on the portal it is pure harm.
        // Measured on hardware 2026-08-14: the probe takes the AP down for ~100s out of every 5 minutes, which
        // (a) disconnects a phone mid-form, and (b) leaves the SSID showing in the phone's cached scan list, so
        // tapping it gives "unable to join network" - the exact symptom reported from the field.
        const busy = await portalInUse();
        if (busy) {
          state.probeDeferrals = (state.probeDeferrals || 0) + 1;
          // Never defer forever: if the box has been held open for ages by a stuck/idle client, let the probe
          // run so a genuinely-recovered network can still close the AP by itself.
          if (state.probeDeferrals * cfg.checkMs < cfg.maxProbeDeferralMs) {
            say('recovery: portal in use - deferring the network re-probe (keeping the AP up)');
            return;
          }
          say('recovery: portal held open too long - running the re-probe anyway');
        }
        state.probeDeferrals = 0;
        await probeRealNetwork();
      }
      return;
    }
    const cls = await classifyConnectivity();
    if (applying || state.phase === 'connecting') return; // re-check AFTER the await: a /connect POST may have started
    if (cls.online) { state.offlineSince = 0; state.phase = 'monitor'; state.captive = null; writeState(); return; }
    // GUEST WIFI. We are associated and the credentials are fine — the network wants a sign-in. Record it (so the
    // dashboard and VERIFY-PI can say so instead of "offline") and raise the AP straight away without waiting out
    // the offline grace: that grace exists to ride out a transient outage, and this is not one. It will not clear
    // on its own, and the person who can fix it is on site right now.
    if (cls.captive) {
      if (!state.captive) { state.captive = { ssid: '', signInUrl: cls.signInUrl || '', since: nowFn() }; }
      else { state.captive.signInUrl = cls.signInUrl || state.captive.signInUrl; }
      state.lastError = '';
      await readMac();
      writeState();
      if (!reentryAllowed()) { say('recovery: captive portal detected but AP re-entry rate limit hit — holding'); return; }
      await scanNetworks();
      if (await startAp()) recordApRaise();
      return;
    }
    // NO CREDENTIALS ON THE BOX: skip the graces entirely (see noSavedWifi). Nothing to wait for — UNLESS there
    // is a wire, in which case there is something to wait for and the normal grace applies (see
    // wiredDevicePresent). A wired card having no WiFi is its intended configuration, not an emergency.
    const hasWire = await wiredDevicePresent();
    const bare = (await noSavedWifi()) && !hasWire;
    if (applying || state.phase === 'connecting') return;   // re-check after the await, same as above
    if (!state.offlineSince) state.offlineSince = nowFn();
    // OFFLINE WITH A WIRE: the uplink IS the wire, so retry the wire. Runs on the ordinary poll interval, long
    // before the AP grace expires, because raising a WiFi rescue AP does nothing for a wired card - and on the
    // shipping wired build there are no WiFi credentials for anyone to fix through it anyway.
    if (hasWire) await retryWiredUplink();
    if (bare || nowFn() - state.offlineSince >= offlineGrace()) {
      if (bare && !state.bareLogged) { state.bareLogged = true; say('recovery: no saved WiFi profiles - raising the setup AP immediately to capture credentials'); }
      if (!reentryAllowed()) { say('recovery: offline but AP re-entry rate limit hit — holding'); return; }
      await scanNetworks();
      if (await startAp()) recordApRaise();
    }
  }

  // Wait until NetworkManager can actually answer, up to a bound. The unit is ordered After=NetworkManager.service,
  // which only means "after systemd started it", not "after it is ready" — on a Pi Zero W this daemon routinely
  // wins that race by several seconds.
  //
  // This is not cosmetic. The startup repair below is the thing that un-sticks a card whose WiFi profile was left
  // disabled, and it is driven by `nmcli connection show`. The command runner never REJECTS — a failed call comes
  // back as empty stdout — so an early call did not look like an error, it looked like "this box has no saved WiFi
  // profiles", and the repair silently did nothing at all. Nothing downstream could tell the difference.
  async function waitForNm(maxMs = 60000) {
    const deadline = nowFn() + maxMs;
    let waited = false;
    while (nowFn() < deadline) {
      const r = await nmcli(['-t', '-f', 'RUNNING', 'general'], { timeoutMs: 8000 }).catch(() => ({ stdout: '' }));
      if (/running/i.test(String(r.stdout || ''))) { if (waited) diag('NetworkManager ready'); return true; }
      waited = true;
      await sleep(2000);
    }
    diag('NetworkManager did not report running within ' + Math.round(maxMs / 1000) + 's — carrying on anyway');
    return false;
  }

  async function run() {
    await waitForNm();
    // Undo any leftover AP session from a crash/restart mid-recovery: re-enable station autoconnect + remove a
    // stale AP profile, so a service bounce (Restart=always) can never leave the box's real networks disabled.
    //
    // This ALSO heals cards that already shipped. Before the AP pause was made --temporary, a card whose power
    // was pulled while the rescue AP was up kept autoconnect=false written into its keyfile, and arrived at the
    // customer refusing to even attempt their WiFi. Those cards are already out there; this puts them right on
    // their next boot without anyone touching them.
    try {
      const leftover = await listStationCons();
      if (leftover.length) diag('startup: restoring autoconnect on ' + leftover.length + ' station profile(s): ' + leftover.join(', '));
      for (const c of leftover) await nmcli(['connection', 'modify', c, 'connection.autoconnect', 'yes']).catch(() => {});
      await nmcli(['connection', 'delete', cfg.apConName]).catch(() => {});
      const iface = await detectIface();
      await nmcli(['device', 'connect', iface]).catch(() => {}); // nudge NM to act on the profiles it just got back
    } catch (e) { diag('startup repair failed: ' + (e && e.message)); }
    startUsbServer();
    // Read the MAC once, up front, rather than only on the captive-portal path. It is the single most useful
    // thing a technician can carry away from a device that will not connect - whitelisting it is how a headless
    // box gets onto a guest network permanently - and it must already be in the status file when someone reads
    // it over Bluetooth, not appear later once the daemon happens to have proven a portal.
    await readMac();
    const first = neverOnline();
    say('recovery: started (' + (first ? 'FIRST RUN - never claimed, using short grace' : 'previously online, using full hysteresis')
      + ': boot ' + Math.round(bootGrace() / 1000) + 's, offline ' + Math.round(offlineGrace() / 1000)
      + 's, AP re-probe every ' + Math.round(cfg.apProbeMs / 60000) + 'min)');
    await waitOutBootGrace();
    // eslint-disable-next-line no-constant-condition
    while (true) { try { await tick(); } catch (e) { say('recovery: tick error ' + (e && e.message)); } await sleep(cfg.checkMs); }
  }

  return {
    state, run, tick, hasInternet, scanNetworks, startAp, stopAp, applyAndVerify, writeNetwork, probeRealNetwork,
    waitOutBootGrace, noSavedWifi, waitForNm, wiredDevicePresent, retryWiredUplink,
    requestHandler, detectIface, cleanupDuplicateProfiles, portalInUse,
    classifyConnectivity, captiveProbe, readMac, currentSsid,
    readRequest, handleRequest, writeState, diag,
    _cfg: cfg,
  };
}

// ───────────────────────────── real-runtime deps ────────────────────────────────────────────────────────────
function defaultRunner() {
  return (cmd, args, opts = {}) => new Promise((resolve) => {
    execFile(cmd, args, { timeout: opts.timeoutMs || 20000, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code == null ? 1 : err.code) : 0, stdout: stdout || '', stderr: stderr || '', err: err || null });
    });
  });
}
// One connectivity probe. Deliberately does NOT follow redirects — the redirect itself is the captive-portal
// tell, and its Location header is the sign-in URL we want to show the tech. Reads only the first 2KB (a portal's
// login page can be large and we only ever classify it, never render it). Never throws: a transport failure comes
// back as { err }, which classifyProbeResponse reads as 'unknown', not as a portal.
function defaultHttpProbe(url, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let req;
    const done = (v) => { try { req && req.destroy(); } catch (_) {} resolve(v); };
    try {
      req = http.get(url, { headers: { 'user-agent': 'AutoPost-Connectivity-Check/1', 'cache-control': 'no-cache' } }, (res) => {
        let body = '';
        res.on('data', (d) => { if (body.length < 2048) body += d.toString('utf8'); });
        res.on('end', () => done({
          url,
          status: res.statusCode,
          location: (res.headers && res.headers.location) || '',
          body,
        }));
        res.on('error', (e) => done({ url, err: e }));
      });
      req.setTimeout(timeoutMs, () => done({ url, err: new Error('probe timeout') }));
      req.on('error', (e) => done({ url, err: e }));
    } catch (e) { done({ url, err: e }); }
  });
}

function defaultTcpReach(host, port, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port }, () => { resolve(true); s.destroy(); });
    s.setTimeout(timeoutMs, () => { s.destroy(); resolve(false); });
    s.on('error', () => resolve(false));
  });
}
async function defaultReadSerial() {
  for (const p of ['/proc/cpuinfo', '/sys/firmware/devicetree/base/serial-number']) {
    try {
      const t = fs.readFileSync(p, 'utf8');
      const m = /Serial\s*:\s*([0-9a-fA-F]+)/.exec(t) || /([0-9a-fA-F]{6,})/.exec(t);
      if (m) return m[1];
    } catch (_) { /* next */ }
  }
  return '';
}

function start() {
  const rec = createRecovery({ log: (...a) => console.log(new Date().toISOString(), '[wifi-recovery]', ...a) });
  rec.run().catch((e) => { console.error('wifi-recovery fatal', e); process.exit(1); });
  return rec;
}

if (require.main === module) start();

module.exports = {
  start, createRecovery,
  _test: {
    esc, conNameFor, apSsid, splitNmcli, parseScanList, isCaptiveProbe, decideOnline, portalPage, CAPTIVE_PATHS,
    classifyProbeResponse, decideConnectivityState, captivePanel, defaultHttpProbe, pickApChannel,
  },
};
