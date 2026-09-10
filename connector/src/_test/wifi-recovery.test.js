'use strict';
/* Unit tests for the WiFi-recovery daemon — pure helpers + the single-radio / never-strand state machine with a
 * mocked nmcli runner (no hardware). Run: node src/_test/wifi-recovery.test.js */
const assert = require('assert');
const { createRecovery, _test } = require('../wifi-recovery');
const { conNameFor, apSsid, splitNmcli, parseScanList, isCaptiveProbe, decideOnline, portalPage,
  classifyProbeResponse, decideConnectivityState, pickApChannel } = _test;

let pass = 0; const fail = [];
const t = (name, fn) => { try { fn(); pass++; } catch (e) { fail.push(name + ' :: ' + (e && e.message)); } };
const at = (name, fn) => fn().then(() => { pass++; }).catch((e) => { fail.push(name + ' :: ' + (e && e.message)); });

// ── pure helpers ────────────────────────────────────────────────────────────────────────────────────────────
t('conNameFor matches set-wifi.sh con_name_for (non-alnum -> dash, 40 cap)', () => {
  assert.strictEqual(conNameFor('Dealer WiFi'), 'autopost-wifi-Dealer-WiFi');
  assert.strictEqual(conNameFor("Bob's iPhone"), 'autopost-wifi-Bob-s-iPhone');
  assert.strictEqual(conNameFor('x'.repeat(60)).length, 'autopost-wifi-'.length + 40);
});
t('apSsid uses the last 4 hex of the serial (uppercased), fallback XXXX', () => {
  assert.strictEqual(apSsid('100000001a2b3c4d'), 'AutoPost-Setup-3C4D');
  assert.strictEqual(apSsid(''), 'AutoPost-Setup-XXXX');
  assert.strictEqual(apSsid('abc', 'Foo'), 'Foo-ABC');
});
t('splitNmcli unescapes \\: and \\\\ in -t output', () => {
  assert.deepStrictEqual(splitNmcli('My\\:Net:72:WPA2'), ['My:Net', '72', 'WPA2']);
  assert.deepStrictEqual(splitNmcli('a\\\\b:1'), ['a\\b', '1']);
});
t('parseScanList dedupes by SSID (max signal), drops hidden/blank, sorts desc', () => {
  const out = parseScanList(['HomeWiFi:41:WPA2', 'HomeWiFi:88:WPA2', ':30:WPA2', 'Guest:60:'].join('\n'));
  assert.deepStrictEqual(out.map((n) => n.ssid), ['HomeWiFi', 'Guest']);
  assert.strictEqual(out[0].signal, 88); // strongest kept
  assert.strictEqual(out.find((n) => n.ssid === 'Guest').security, '');
});
t('isCaptiveProbe recognizes the OS probe paths but not arbitrary ones', () => {
  ['/generate_204', '/hotspot-detect.html', '/ncsi.txt', '/canonical.html'].forEach((p) => assert.ok(isCaptiveProbe(p), p));
  assert.ok(!isCaptiveProbe('/connect'));
  assert.ok(!isCaptiveProbe('/'));
});
t('decideOnline: online if EITHER NM=full OR hub reachable (offline needs BOTH to fail)', () => {
  assert.strictEqual(decideOnline('full', false), true);   // NM confirms
  assert.strictEqual(decideOnline('portal', true), true);  // hijacked NM URL but hub reachable
  assert.strictEqual(decideOnline('none', false), false);  // truly offline
  assert.strictEqual(decideOnline('limited', false), false);
});
t('portalPage renders the branded form: network options, password, ◈, HTML-escaped SSIDs', () => {
  const html = portalPage({ networks: [{ ssid: 'A&B<x>', signal: 50, security: 'WPA2' }], error: 'nope' });
  assert.ok(html.includes('◈'));
  assert.ok(html.includes('A&amp;B&lt;x&gt;'), 'SSID is HTML-escaped');
  assert.ok(html.includes('name="password"'));
  assert.ok(html.includes('Other / hidden network'));
  assert.ok(html.includes('nope'), 'error banner shown');
});

// ── mock harness for the state machine ──────────────────────────────────────────────────────────────────────
// iwLink     -> what `iw dev wlan0 link` reports ('Not connected.' | 'Connected to ...' | '' for unknown)
// iwStations -> what `iw dev wlan0 station dump` reports (non-empty = a client is on the rescue AP)
// probe      -> what the HTTP connectivity probe sees. MUST be stubbed: the real one talks to the internet, so an
//               unmocked probe makes every "offline" test silently pass as ONLINE on a dev machine that has a
//               working connection — which is exactly how these four tests started failing when it was added.
//                 'unreachable' (default) -> no reply at all; verdict 'unknown', so the legacy NM+hub votes decide
//                                            and every pre-existing test keeps its original meaning
//                 'full'         -> 204 + empty body: proof of real internet
//                 'portal'       -> 302 to a sign-in page: proof of a captive portal
//                 'portal200'    -> 200 serving a login page instead of the expected 204 (the other portal shape)
// savedCons -> what `nmcli -t -f NAME,TYPE connection show` reports. Defaults to the previous hard-coded value
//              so every pre-existing test keeps its exact meaning; override with '' to model a card flashed
//              with NO WiFi at all (the flasher's "capture WiFi on first boot" option).
// consFail -> make `connection show` REJECT, modelling NetworkManager not being up yet at service start.
// apUpCode  -> exit code `nmcli connection up <ap>` comes back with. Non-zero is the FIELD case, not an exotic
//              one: nmcli blocks until the activation settles and is killed on a timeout long before a busy site
//              has finished bringing an AP up, so a perfectly good AP routinely reports failure.
// nmNotReadyFor -> how many `nmcli -t -f RUNNING general` calls answer "not running" before NetworkManager comes
//              up, modelling this daemon winning the race against NM on a slow Pi.
function harness({ connectivity = 'none', hubReachable = false, apGetsIp = true, iwLink = '', iwStations = '', probe = 'unreachable',
// devices -> what `nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device` reports. Default is a WiFi-only box, so
//            every pre-existing test keeps its exact meaning; override to model a wired card.
                   consFail = false, apUpCode = 0, nmNotReadyFor = 0,
                   devices = 'wlan0:wifi:disconnected:\nlo:loopback:unmanaged:\n',
                   savedCons = 'autopost-wifi-old:802-11-wireless\nEthernet:802-3-ethernet\n' } = {}) {
  const calls = []; // every nmcli/bash invocation, in order
  const clock = { t: 1_000_000 };
  let nmReadyCalls = 0;
  // A runtime dir per harness. The off-band request bridge writes real files, and tests sharing one directory
  // would hand each other stale requests and then pass or fail on execution order.
  const runtimeDir = require('path').join(require('os').tmpdir(), 'wr-test-' + (harness.n = (harness.n || 0) + 1));
  try { require('fs').rmSync(runtimeDir, { recursive: true, force: true }); } catch (_) { /* fresh anyway */ }
  const runner = (cmd, args) => {
    calls.push(cmd + ' ' + args.join(' '));
    const a = args.join(' ');
    if (cmd === 'nmcli' && a.includes('CONNECTIVITY general')) return Promise.resolve({ code: 0, stdout: connectivity + '\n' });
    if (cmd === 'nmcli' && a.startsWith('-t -f DEVICE,TYPE device')) return Promise.resolve({ code: 0, stdout: 'wlan0:wifi\nlo:loopback\n' });
    if (cmd === 'nmcli' && a.includes('device wifi list')) return Promise.resolve({ code: 0, stdout: 'HomeWiFi:80:WPA2\n' });
    if (cmd === 'nmcli' && a.includes('IP4.ADDRESS device show')) return Promise.resolve({ code: 0, stdout: apGetsIp ? '10.42.0.1/24\n' : '\n' });
    if (cmd === 'nmcli' && a.startsWith('-t -f DEVICE,TYPE,STATE,CONNECTION device')) return Promise.resolve({ code: 0, stdout: devices });
    if (cmd === 'nmcli' && a.includes('-f RUNNING general')) {
      const ready = nmReadyCalls++ >= nmNotReadyFor;
      return Promise.resolve({ code: 0, stdout: ready ? 'running\n' : '\n' });
    }
    if (cmd === 'nmcli' && /connection up autopost-setup-ap/.test(a)) {
      return Promise.resolve({ code: apUpCode, stdout: '', stderr: apUpCode ? 'Error: Timeout expired.' : '' });
    }
    if (cmd === 'nmcli' && a.startsWith('-t -f NAME,TYPE connection show')) {
      if (consFail) return Promise.reject(new Error('NetworkManager is not running'));
      return Promise.resolve({ code: 0, stdout: savedCons });
    }
    if (cmd === 'iw' && a.includes('station dump')) return Promise.resolve({ code: 0, stdout: iwStations });
    if (cmd === 'iw' && a.includes('link')) return Promise.resolve({ code: 0, stdout: iwLink });
    // nmcli -g escapes ':' as '\:' — return the ESCAPED form so readMac's unescaping is actually exercised.
    if (cmd === 'nmcli' && a.includes('GENERAL.HWADDR')) return Promise.resolve({ code: 0, stdout: 'B8\\:27\\:EB\\:12\\:34\\:56\n' });
    return Promise.resolve({ code: 0, stdout: '' });
  };
  const httpProbe = (url) => {
    if (probe === 'full') return Promise.resolve({ url, status: 204, location: '', body: '' });
    if (probe === 'portal') return Promise.resolve({ url, status: 302, location: 'http://guest.dealer.example/login', body: '' });
    if (probe === 'portal200') return Promise.resolve({ url, status: 200, location: '', body: '<html><body>Sign in to continue</body></html>' });
    return Promise.resolve({ url, err: new Error('no route to host') });
  };
  const rec = createRecovery({
    runner,
    config: { serve: false, bootGraceMs: 0, offlineGraceMs: 1000, checkMs: 10, connectTimeoutMs: 100, apProbeMs: 0, probeWaitMs: 100, apIpWaitMs: 100, apUpWaitMs: 100, runtimeDir, configPath: '/nonexistent-config.json' },
    tcpReach: () => Promise.resolve(hubReachable),
    httpProbe,
    readSerial: () => Promise.resolve('deadbeef1234'),
    now: () => clock.t,
    sleep: (ms) => { clock.t += ms; return Promise.resolve(); },
    log: () => {},
  });
  // simplify the recorded ordering to the high-level milestones the daemon pushes to state.calls
  return { rec, calls, milestones: rec.state.calls, clock, runtimeDir };
}

// ── the two load-bearing behaviors ──────────────────────────────────────────────────────────────────────────
const tasks = [];

// CAPTURE WIFI ON FIRST BOOT. A card can be flashed with no network profiles at all, for a site whose WiFi we
// cannot know in advance. Such a box has nothing to associate with, so waiting out the offline grace only delays
// the person standing next to it; the AP must come up straight away.
tasks.push(at('NO saved WiFi: raises the setup AP IMMEDIATELY, without waiting out the offline grace', async () => {
  const h = harness({ connectivity: 'none', hubReachable: false, savedCons: '' });
  h.rec._cfg.bootGraceMs = 0;
  h.rec._cfg.offlineGraceMs = 600000;   // 10 min: if the grace were honoured this tick could not raise the AP
  await h.rec.tick();
  assert.ok(h.rec.state.calls.includes('startAp'), 'a box with no credentials must raise the AP on the first tick');
}));
tasks.push(at('saved WiFi present: still WAITS OUT the grace (the normal transient-outage path is unchanged)', async () => {
  const h = harness({ connectivity: 'none', hubReachable: false });   // default: one saved wifi profile
  h.rec._cfg.bootGraceMs = 0;
  h.rec._cfg.offlineGraceMs = 600000;
  await h.rec.tick();
  assert.ok(!h.rec.state.calls.includes('startAp'), 'an ordinary offline blip must not raise the AP instantly');
}));
tasks.push(at('boot grace is SKIPPED when there are no saved profiles (AP in seconds, not ~45s)', async () => {
  const h = harness({ connectivity: 'none', hubReachable: false, savedCons: '' });
  h.rec._cfg.bootGraceMs = 600000; h.rec._cfg.firstRunBootGraceMs = 600000;  // 10 min if it were honoured
  const before = h.clock.t;
  const waited = await h.rec.waitOutBootGrace();   // the harness clock only advances via sleep(), so this is exact
  assert.ok(waited <= 5000, 'waited ' + waited + 'ms; expected only the short NM settle');
  assert.ok(h.clock.t - before <= 5000, 'virtual clock advanced ' + (h.clock.t - before) + 'ms');
}));
tasks.push(at('boot grace is STILL honoured when WiFi profiles exist', async () => {
  const h = harness({ connectivity: 'none', hubReachable: false });   // default: one saved profile
  h.rec._cfg.bootGraceMs = 60000; h.rec._cfg.firstRunBootGraceMs = 60000;
  const waited = await h.rec.waitOutBootGrace();
  assert.strictEqual(waited, 60000, 'a box with a network to join must still get its full boot grace');
}));
tasks.push(at('if NetworkManager cannot answer yet, fall back to the FULL boot grace (never guess)', async () => {
  const h = harness({ connectivity: 'none', hubReachable: false, consFail: true });
  h.rec._cfg.bootGraceMs = 60000; h.rec._cfg.firstRunBootGraceMs = 60000;
  assert.strictEqual(await h.rec.noSavedWifi(), false, 'an unanswerable query must NOT read as "no wifi"');
  const waited = await h.rec.waitOutBootGrace();
  assert.strictEqual(waited, 60000, 'must wait the full grace rather than assume the box is bare');
}));
tasks.push(at('the AP profile itself does not count as saved WiFi (or the AP could never come back up)', async () => {
  const h = harness({ connectivity: 'none', hubReachable: false, savedCons: 'autopost-setup-ap:802-11-wireless\n' });
  h.rec._cfg.bootGraceMs = 0;
  h.rec._cfg.offlineGraceMs = 600000;
  await h.rec.tick();
  assert.ok(h.rec.state.calls.includes('startAp'), 'only the AP profile exists => still no real credentials');
}));

tasks.push(at('applyAndVerify SUCCESS: tears AP down BEFORE writing WiFi, then connects (correct single-radio order)', async () => {
  const h = harness({ connectivity: 'full', hubReachable: true }); // comes online immediately on verify
  const r = await h.rec.applyAndVerify({ ssid: 'HomeWiFi', password: 'goodpass', identity: '', hidden: false });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(h.milestones, ['stopAp', 'writeNetwork', 'connected'], 'order: teardown -> write network -> connected');
  assert.strictEqual(h.rec.state.phase, 'monitor');
  // profile written directly via nmcli (con name we control) with the corrected psk at priority 20
  assert.ok(h.calls.some((c) => c.startsWith('nmcli connection add type wifi') && c.includes('ssid HomeWiFi') && c.includes('autoconnect-priority 20')), 'nmcli add for the corrected SSID');
  assert.ok(h.calls.some((c) => c.includes('wifi-sec.psk goodpass')), 'psk set');
  assert.ok(!h.calls.some((c) => c.startsWith('bash')), 'no shell-out to set-wifi.sh (avoids flag/open/non-ASCII pitfalls)');
}));
tasks.push(at('applyAndVerify OPEN network (no password): still writes a profile instead of erroring', async () => {
  const h = harness({ connectivity: 'full', hubReachable: true });
  const r = await h.rec.applyAndVerify({ ssid: 'GuestOpen', password: '', identity: '', hidden: false });
  assert.strictEqual(r.ok, true);
  assert.ok(h.calls.some((c) => c.startsWith('nmcli connection add type wifi') && c.includes('ssid GuestOpen')), 'open profile added');
  assert.ok(!h.calls.some((c) => c.includes('wifi-sec.psk')), 'no psk set for an open network');
}));
tasks.push(at('applyAndVerify FAILURE: never strands — re-raises the AP with an error, keeps prior profiles', async () => {
  const h = harness({ connectivity: 'none', hubReachable: false }); // never comes online
  const r = await h.rec.applyAndVerify({ ssid: 'HomeWiFi', password: 'wrongpass', identity: '', hidden: false });
  assert.strictEqual(r.ok, false);
  assert.ok(h.milestones.includes('startAp'), 'AP re-raised (never stranded)');
  assert.ok(h.milestones.indexOf('writeNetwork') < h.milestones.indexOf('startAp'), 'write attempted before re-raising AP');
  assert.strictEqual(h.rec.state.phase, 'ap');
  assert.ok(/Could not connect/.test(h.rec.state.lastError || ''), 'error surfaced to the portal');
}));
tasks.push(at('startAp ROLLBACK: if the AP never gets a gateway IP, station autoconnect is restored (never strand)', async () => {
  const h = harness({ connectivity: 'none', hubReachable: false, apGetsIp: false }); // AP never gets the 10.42.0.1 gateway
  const ok = await h.rec.startAp();
  assert.strictEqual(ok, false, 'startAp reports failure');
  assert.notStrictEqual(h.rec.state.phase, 'ap', 'does NOT latch into ap phase');
  assert.ok(h.calls.some((c) => c.includes('connection.autoconnect yes')), 'station autoconnect restored on rollback');
}));
// REGRESSION (hardware-confirmed 2026-08-14, Pi Zero W / BCM43430 fw 7.45.98): the AP profile MUST disable PMF.
// Without `wifi-sec.pmf 1`, NetworkManager defaults to PMF-optional and offers key_mgmt "WPA-PSK WPA-PSK-SHA256".
// That chip's firmware does not support SHA256 key management in AP MODE, so the kernel rejects the key
// ("nl80211: kernel reports: key setting validation failed"), wpa_supplicant cannot initialise the AP interface,
// and NM fails activation with supplicant-timeout after ~25s. startAp() then correctly rolled back — which
// presented in the field as "the rescue AP never starts" on every wrong-WiFi Zero W, with the recovery service
// itself looking perfectly healthy (active, NRestarts=0). Verified: identical profile activates in <1s with
// pmf=1 and gets its 10.42.0.1 gateway; without it, it never comes up.
tasks.push(at('startAp DISABLES PMF on the rescue AP (BCM43430 cannot do WPA-PSK-SHA256 in AP mode)', async () => {
  const h = harness({ connectivity: 'none', hubReachable: false });
  await h.rec.startAp();
  const sec = h.calls.find((c) => c.includes('wifi-sec.key-mgmt wpa-psk'));
  assert.ok(sec, 'the AP security modify call is made');
  assert.ok(/wifi-sec\.pmf 1/.test(sec),
    'MUST pass `wifi-sec.pmf 1` in the SAME modify call — without it NM negotiates WPA-PSK-SHA256 and the AP never comes up');
}));
// REGRESSION (hardware-confirmed 2026-08-14): the 5-minute re-probe tore the AP down for ~100s out of every
// 5 minutes REGARDLESS of whether anyone was on the portal. Measured live: a phone connected at 21:20:06 was
// disconnected at 21:22:46, mid-session. It also leaves the SSID in the phone's cached scan list after the AP is
// gone, so tapping it gives "unable to join network" - the exact field symptom. The probe must defer while the
// portal is in use, but must NOT defer forever or a recovered network could never close the AP by itself.
tasks.push(at('tick in AP phase: DEFERS the re-probe while the portal is in use (never yanks it mid-form)', async () => {
  const h = harness({ connectivity: 'none', hubReachable: false });
  await h.rec.startAp();
  h.rec.state.apSince = 0;                       // pretend the probe interval has elapsed
  h.rec.state.lastPortalHit = h.rec._cfg.nowFn ? h.rec._cfg.nowFn() : Date.now(); // someone just used the portal
  const before = h.rec.state.phase;
  await h.rec.tick();
  assert.strictEqual(h.rec.state.phase, before, 'still in AP phase - the AP was NOT torn down');
  assert.ok(!h.milestones.includes('probeRecovered'), 'no probe ran');
  assert.ok((h.rec.state.probeDeferrals || 0) >= 1, 'the deferral was counted');
}));
tasks.push(at('tick in AP phase: probe is NOT deferred forever (bounded by maxProbeDeferralMs)', async () => {
  const h = harness({ connectivity: 'none', hubReachable: false });
  await h.rec.startAp();
  h.rec.state.apSince = 0;
  h.rec.state.lastPortalHit = Date.now();
  // push the deferral counter past the bound so the next tick must run the probe anyway
  h.rec.state.probeDeferrals = Math.ceil(h.rec._cfg.maxProbeDeferralMs / h.rec._cfg.checkMs) + 1;
  await h.rec.tick();
  assert.strictEqual(h.rec.state.probeDeferrals, 0, 'counter reset - the probe was allowed to run');
}));
tasks.push(at('requestHandler marks the portal busy, so a page load alone defers the next probe', async () => {
  const h = harness({ connectivity: 'none', hubReachable: false });
  assert.ok(!h.rec.state.lastPortalHit, 'starts unmarked');
  h.rec.requestHandler({ method: 'GET', url: '/' }, { writeHead() {}, end() {} });
  assert.ok(h.rec.state.lastPortalHit > 0, 'a portal request marks it in use');
}));

// AP AVAILABILITY: every second the AP is down is a second nobody can connect, and the phone still shows the
// cached SSID so tapping it fails. Measured on hardware with the OLD values (probe 300s / wait 90s): the AP was
// gone ~100s out of every 300s - a third of the time.
// These assert the SHIPPED DEFAULTS, so they must read a recovery built without the harness's test overrides
// (the harness deliberately collapses every timer to keep the state-machine tests fast).
const defaultCfg = createRecovery({ runner: () => Promise.resolve({ code: 0, stdout: '' }), config: { serve: false } })._cfg;

tasks.push(at('AP downtime budget: the probe cycle leaves the AP up well over 95% of the time', async () => {
  const c = defaultCfg;
  const dutyCycle = c.probeWaitMs / c.apProbeMs;
  assert.ok(dutyCycle <= 0.05, `AP is unavailable ${(dutyCycle * 100).toFixed(1)}% of the time (must be <=5%)`);
  assert.ok(c.probeAssocMs < c.probeWaitMs, 'the early-exit must be able to fire before the hard cap');
}));
tasks.push(at('probe ENDS EARLY when the station never associates (shortens the coverage hole)', async () => {
  // The harness clock only advances via sleep(), so elapsed virtual time IS the AP downtime.
  const h = harness({ connectivity: 'none', hubReachable: false, iwLink: 'Not connected.' });
  h.rec._cfg.probeWaitMs = 25000;   // realistic hard cap
  h.rec._cfg.probeAssocMs = 12000;  // realistic early-exit threshold
  await h.rec.startAp();
  const t0 = h.clock.t;
  await h.rec.probeRealNetwork();
  const downMs = h.clock.t - t0;
  assert.ok(h.rec.state.calls.includes('startAp'), 'AP restored after the probe');
  assert.ok(downMs < 25000, `AP was down ${downMs}ms - the early exit did not fire before the hard cap`);
}));
tasks.push(at('probe does NOT end early while association state is UNKNOWN (iw missing/odd output)', async () => {
  // A broken or absent `iw` must never cut a probe short that would otherwise have succeeded.
  const h = harness({ connectivity: 'none', hubReachable: false, iwLink: '' });
  h.rec._cfg.probeWaitMs = 25000;
  h.rec._cfg.probeAssocMs = 12000;
  await h.rec.startAp();
  const t0 = h.clock.t;
  await h.rec.probeRealNetwork();
  assert.ok(h.clock.t - t0 >= 25000, 'unknown association state must wait out the full window');
}));
tasks.push(at('portalInUse detects an associated station (not just recent portal hits)', async () => {
  const busy = harness({ iwStations: 'Station 02:d3:c5:e8:75:59 (on wlan0)\n\tsignal: -40 dBm\n' });
  assert.strictEqual(await busy.rec.portalInUse(), true, 'an associated client counts as in use');
  const idle = harness({ iwStations: '' });
  assert.strictEqual(await idle.rec.portalInUse(), false, 'nobody associated and no recent hit -> not in use');
}));

// A box that has NEVER claimed was flashed with bad credentials; an installer should not wait 7 minutes to find
// out. Once it HAS claimed, a dropout may be a transient blip and the long hysteresis is correct.
tasks.push(at('first-run (never claimed) uses the SHORT grace so the rescue AP appears fast', async () => {
  const c = defaultCfg;
  assert.ok(c.firstRunOfflineGraceMs < c.offlineGraceMs, 'first-run grace is genuinely shorter');
  assert.ok(c.firstRunBootGraceMs < c.bootGraceMs, 'first-run boot grace is genuinely shorter');
  assert.ok(c.firstRunOfflineGraceMs + c.firstRunBootGraceMs <= 120000,
    'a wrong-WiFi box must surface its AP within ~2 minutes of power-on');
}));
tasks.push(at('the first-run grace may only SHORTEN the wait, never lengthen it', async () => {
  // The harness configures offlineGraceMs=1000 with a nonexistent configPath (so neverOnline() is true). If the
  // first-run value were applied blindly it would REPLACE 1000 with 60000 and make an explicitly-configured box
  // slower to rescue. This is the regression that caught it.
  const h = harness({ connectivity: 'none', hubReachable: false });
  h.rec.state.offlineSince = h.clock.t - 5000;   // well past the configured 1000ms grace
  await h.rec.tick();
  assert.ok(h.rec.state.calls.includes('startAp'),
    'AP must raise on the CONFIGURED short grace, not be held back by the longer first-run default');
}));

tasks.push(at('tick: offline past grace -> scans then raises the AP', async () => {
  const h = harness({ connectivity: 'none', hubReachable: false });
  await h.rec.tick(); // first tick: offlineSince set (not yet past grace)
  h.clock.t += 2000;  // advance past offlineGraceMs (1000)
  await h.rec.tick(); // now raises AP
  assert.ok(h.calls.some((c) => c.includes('device wifi list')), 'scanned before AP');
  assert.ok(h.rec.state.calls.includes('startAp'), 'AP raised');
  assert.strictEqual(h.rec.state.phase, 'ap');
  assert.deepStrictEqual(h.rec.state.networks.map((n) => n.ssid), ['HomeWiFi']);
}));
tasks.push(at('tick in AP: periodic re-probe self-heals a transient outage (drops AP, network back -> monitor)', async () => {
  const h = harness({ connectivity: 'full', hubReachable: true }); // the real network has returned
  h.rec.state.phase = 'ap'; h.rec.state.apSince = 0; // apProbeMs=0 in test -> probe fires immediately
  h.rec.state.stationCons = ['autopost-wifi-old']; // as startAp would have paused
  await h.rec.tick();
  assert.strictEqual(h.rec.state.phase, 'monitor', 'closed recovery once the network came back on its own');
  assert.ok(h.rec.state.calls.includes('probeRecovered'), 're-probe detected recovery');
  assert.ok(h.calls.some((c) => c.includes('connection.autoconnect yes')), 'station autoconnect restored');
}));
tasks.push(at('tick race guard: a correction in flight (applying) makes tick leave the radio alone', async () => {
  const h = harness({ connectivity: 'none', hubReachable: false });
  h.rec.state.phase = 'connecting';
  const before = h.calls.length;
  await h.rec.tick();
  assert.strictEqual(h.calls.length, before, 'tick did no nmcli work while a correction is connecting');
}));

// ══ GUEST / CAPTIVE-PORTAL WIFI ═══════════════════════════════════════════════════════════════════════════════
// Dealership guest networks are the common deployment, and they look nothing like the failure the rescue AP was
// originally built for. The distinction that matters: a wrong password means RE-ENTER IT; a captive portal means
// the password was RIGHT and someone has to sign the device in or whitelist its MAC. Telling a tech to re-check a
// password that already worked burns the site visit, so these two must never be conflated.

// ── the classifier, as a pure table ──────────────────────────────────────────────────────────────────────────
t('classifyProbeResponse: only a known-correct response counts as real internet', () => {
  assert.strictEqual(classifyProbeResponse({ url: 'http://x/generate_204', status: 204, body: '' }), 'full');
  assert.strictEqual(classifyProbeResponse({ url: 'http://x/connecttest.txt', status: 200, body: 'Microsoft Connect Test' }), 'full');
});
t('classifyProbeResponse: a redirect is a captive portal', () => {
  assert.strictEqual(classifyProbeResponse({ url: 'http://x/generate_204', status: 302, location: 'http://login/' }), 'portal');
  assert.strictEqual(classifyProbeResponse({ url: 'http://x/generate_204', status: 307, location: 'http://login/' }), 'portal');
});
t('classifyProbeResponse: a 200 where a 204 was expected is a captive portal', () => {
  // the intercept-without-redirect shape: the portal just serves its login page in place of the probe response
  assert.strictEqual(classifyProbeResponse({ url: 'http://x/generate_204', status: 200, body: '<html>Sign in</html>' }), 'portal');
  assert.strictEqual(classifyProbeResponse({ url: 'http://x/connecttest.txt', status: 200, body: '<html>Welcome to Guest WiFi</html>' }), 'portal');
});
t('classifyProbeResponse: a 204 with a body is NOT trusted as online', () => {
  assert.strictEqual(classifyProbeResponse({ url: 'http://x/generate_204', status: 204, body: 'injected' }), 'portal');
});
t('classifyProbeResponse: no reply is "unknown", never a portal', () => {
  // a dead network must fall through to the other signals, not be misreported as needing a sign-in
  assert.strictEqual(classifyProbeResponse({ url: 'http://x/generate_204', err: new Error('ENETUNREACH') }), 'unknown');
  assert.strictEqual(classifyProbeResponse(null), 'unknown');
  assert.strictEqual(classifyProbeResponse({}), 'unknown');
});

t('decideOnline: a PROVEN portal beats a reachable hub (the silent-stranding bug)', () => {
  // THE bug this fixes: a captive portal answers the TCP connect to any host:port, so the hub vote comes back
  // true and the box reports healthy forever while never actually claiming.
  assert.strictEqual(decideOnline('portal', true, 'portal'), false);
  assert.strictEqual(decideOnline('full', true, 'portal'), false, 'even NM saying full loses to a proven portal');
});
t('decideOnline: a PROVEN 204 beats NM wrongly saying portal', () => {
  // the opposite error: a site that blocks NM's own check URL must not trip the rescue AP on a healthy box
  assert.strictEqual(decideOnline('portal', false, 'full'), true);
});
t('decideOnline: with no probe verdict the original two-vote rule is unchanged', () => {
  assert.strictEqual(decideOnline('full', false, undefined), true);
  assert.strictEqual(decideOnline('portal', true, undefined), true);
  assert.strictEqual(decideOnline('none', false, undefined), false);
});
t('decideConnectivityState: portal, offline and unassociated are three different answers', () => {
  assert.strictEqual(decideConnectivityState('portal', true, 'portal', true), 'portal');
  assert.strictEqual(decideConnectivityState('full', false, 'full', true), 'full');
  assert.strictEqual(decideConnectivityState('none', false, undefined, false), 'none', 'not joined to any WiFi');
  assert.strictEqual(decideConnectivityState('limited', false, undefined, true), 'limited', 'joined but no way out');
});

// ── the portal page in guest-WiFi mode ───────────────────────────────────────────────────────────────────────
t('the guest-WiFi panel shows the MAC and does NOT blame the password', () => {
  const html = portalPage({
    networks: [{ ssid: 'Dealer-Guest', signal: 70, security: 'WPA2' }],
    captive: { ssid: 'Dealer-Guest', signInUrl: 'http://guest.dealer.example/login' },
    mac: 'B8:27:EB:12:34:56',
  });
  assert.ok(html.includes('B8:27:EB:12:34:56'), 'the MAC is what IT needs in order to whitelist a headless device');
  assert.ok(html.includes('guest.dealer.example/login'), 'the sign-in page is shown');
  assert.ok(/password was correct/i.test(html), 'must state the password worked');
  assert.ok(!/Check the password and try again/i.test(html), 'must NOT send the tech chasing the password');
  assert.ok(/re-check now/i.test(html), 'offers an immediate re-test once they have acted');
  assert.ok(html.includes('id="wifiForm"') && html.includes('display:none'), 'the WiFi form is collapsed, not gone');
  assert.ok(/different network/i.test(html), 'and can still be reopened');
});
t('the guest-WiFi panel escapes hostile SSIDs and URLs', () => {
  const html = portalPage({ captive: { ssid: '<script>x</script>', signInUrl: 'http://a/"><script>y</script>' }, mac: 'AA:BB' });
  assert.ok(!html.includes('<script>x</script>'), 'SSID must be escaped');
  assert.ok(!html.includes('"><script>y</script>'), 'sign-in URL must be escaped');
});
t('the normal (non-captive) page is unchanged and still blames the password when it should', () => {
  const html = portalPage({ networks: [], error: 'Could not connect to "X". Check the password and try again.' });
  assert.ok(/Check the password/i.test(html));
  assert.ok(!/needs a sign-in/i.test(html), 'no guest-WiFi panel when it is a genuine credential failure');
});

// ── end-to-end through the state machine ─────────────────────────────────────────────────────────────────────
tasks.push(at('applyAndVerify on GUEST WIFI: keeps the profile, reports captive, does not blame the password', async () => {
  const h = harness({ connectivity: 'portal', hubReachable: true, probe: 'portal' });
  const r = await h.rec.applyAndVerify({ ssid: 'Dealer-Guest', password: 'goodpass', identity: '', hidden: false });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.captive, true, 'reported as captive, not as a failure');
  assert.strictEqual(r.signInUrl, 'http://guest.dealer.example/login');
  assert.strictEqual(h.rec.state.lastError, '', 'must NOT set a password error');
  assert.ok(h.rec.state.captive, 'captive state recorded');
  assert.strictEqual(h.rec.state.captive.ssid, 'Dealer-Guest');
  assert.ok(h.rec.state.calls.includes('captive'));
  assert.ok(h.rec.state.calls.includes('startAp'), 'AP re-raised so the on-site tech can read the instructions');
  // The profile is KEPT: if IT later whitelists the MAC the box just starts working with nobody on site.
  // writeNetwork deletes-then-adds to update in place, so what matters is that no delete lands AFTER the add.
  const idx = (pred) => h.calls.reduce((last, c, i) => (pred(c) ? i : last), -1);
  const lastAdd = idx((c) => c.includes('connection add type wifi') && c.includes('ssid Dealer-Guest'));
  const lastDel = idx((c) => c === 'nmcli connection delete autopost-wifi-Dealer-Guest');
  assert.ok(lastAdd >= 0, 'the corrected profile was written');
  assert.ok(lastDel < lastAdd, 'the corrected profile must survive the captive verdict, not be torn up');
}));
tasks.push(at('applyAndVerify still blames the password when it really IS the password', async () => {
  const h = harness({ connectivity: 'none', hubReachable: false, probe: 'unreachable' });
  const r = await h.rec.applyAndVerify({ ssid: 'HomeWiFi', password: 'wrongpass', identity: '', hidden: false });
  assert.strictEqual(r.ok, false);
  assert.ok(!r.captive, 'a dead network is not a captive portal');
  assert.match(h.rec.state.lastError, /Check the password/);
  assert.strictEqual(h.rec.state.captive, null);
}));
tasks.push(at('the MAC is read and unescaped from nmcli output', async () => {
  const h = harness({ connectivity: 'portal', hubReachable: false, probe: 'portal' });
  const mac = await h.rec.readMac();
  assert.strictEqual(mac, 'B8:27:EB:12:34:56', 'nmcli escapes colons as \\: — they must be unescaped');
}));
tasks.push(at('tick on guest WiFi raises the AP immediately, without waiting out the offline grace', async () => {
  // The offline grace exists to ride out a transient outage. A captive portal is not transient and will not clear
  // itself, and the installer is standing there — making them wait is pure lost time.
  const h = harness({ connectivity: 'portal', hubReachable: true, probe: 'portal' });
  h.rec._cfg.offlineGraceMs = 3600000; // an hour: if the grace were honoured this test could never pass
  await h.rec.tick();
  assert.ok(h.rec.state.calls.includes('startAp'), 'AP raised on the first tick');
  assert.ok(h.rec.state.captive, 'captive recorded');
  assert.strictEqual(h.rec.state.lastError, '');
}));
tasks.push(at('a captive box reports "captive" in its runtime state, not a generic failure', async () => {
  const fsx = require('fs'); const pathx = require('path');
  const h = harness({ connectivity: 'portal', hubReachable: true, probe: 'portal' });
  const dir = h.runtimeDir;
  await h.rec.applyAndVerify({ ssid: 'Dealer-Guest', password: 'goodpass', identity: '', hidden: false });
  const st = JSON.parse(fsx.readFileSync(pathx.join(dir, 'wifi-recovery.json'), 'utf8'));
  assert.ok(st.captive, 'the dashboard must be able to say "needs a network sign-in", not just "offline"');
  assert.strictEqual(st.captive.ssid, 'Dealer-Guest');
  assert.strictEqual(st.mac, 'B8:27:EB:12:34:56', 'the MAC travels with the status so it can be read remotely too');
}));
tasks.push(at('a guest network that later gets whitelisted recovers by itself', async () => {
  // The payoff for keeping the profile: nobody has to come back to site. Note the captive re-probe interval must
  // be set explicitly here — a captive box deliberately re-probes SLOWLY (see the churn test below), so with the
  // default 30 min this would not fire at all. That IS the intended behaviour; the tech has "Re-check now" for
  // the attended case, and an unattended whitelist is picked up within the interval.
  const h = harness({ connectivity: 'full', hubReachable: true, probe: 'full' });
  h.rec.state.phase = 'ap'; h.rec.state.apSince = 0;
  h.rec._cfg.captiveProbeMs = 0;
  h.rec.state.captive = { ssid: 'Dealer-Guest', signInUrl: 'http://x/', since: 1 };
  await h.rec.tick();
  assert.strictEqual(h.rec.state.phase, 'monitor', 'closed itself once the network actually worked');
  assert.strictEqual(h.rec.state.captive, null, 'captive state cleared');
}));
tasks.push(at('POST /recheck queues an immediate re-test instead of probing inside the request', async () => {
  // probing tears the AP down, which would kill the very connection the response has to travel over
  const h = harness({ connectivity: 'portal', hubReachable: true, probe: 'portal' });
  h.rec.state.phase = 'ap';
  const before = h.calls.length;
  let sent = '';
  h.rec.requestHandler(
    { method: 'POST', url: '/recheck', on: () => {} },
    { writeHead: () => {}, end: (b) => { sent = String(b || ''); } },
  );
  assert.strictEqual(h.rec.state.recheckRequested, true, 'flag set for the main loop');
  assert.strictEqual(h.calls.length, before, 'no radio work done inside the request handler');
  assert.match(sent, /ok/, 'the page still gets an answer');
  // and the next tick acts on it, even though the slow captive re-probe interval has not elapsed
  h.rec.state.apSince = h.clock.t; // nowhere near the probe interval
  h.rec._cfg.captiveProbeMs = 3600000;
  await h.rec.tick();
  assert.ok(h.rec.state.calls.includes('stopAp'), 're-check actually ran the probe');
  assert.strictEqual(h.rec.state.recheckRequested, false, 'flag consumed, so it fires once');
}));
tasks.push(at('a proven captive portal slows the AP-tearing re-probe instead of churning every 15 min', async () => {
  const h = harness({ connectivity: 'portal', hubReachable: true, probe: 'portal' });
  h.rec.state.phase = 'ap';
  h.rec.state.captive = { ssid: 'G', signInUrl: '', since: 1 };
  h.rec._cfg.apProbeMs = 1000;          // the normal interval HAS elapsed
  h.rec._cfg.captiveProbeMs = 3600000;  // but the captive one has not
  h.rec.state.apSince = h.clock.t - 2000;
  const before = h.rec.state.calls.slice();
  await h.rec.tick();
  assert.deepStrictEqual(h.rec.state.calls, before, 'no probe: nothing changes until a human acts, so do not drop the AP');
}));

// ══ WPA-ENTERPRISE (802.1X) ═══════════════════════════════════════════════════════════════════════════════════
// A CORPORATE network that asks for a USERNAME + password at join time. This is a completely different thing from
// a captive portal, and unlike a portal it CAN be solved unattended — the credentials go in once at the rescue
// page and the box joins by itself forever after. It was implemented but had no coverage at all, which is a bad
// place to be for a path a dealership rollout depends on.
tasks.push(at('enterprise WiFi: writes a real 802.1X/PEAP profile, not a PSK one', async () => {
  const h = harness({ connectivity: 'full', hubReachable: true, probe: 'full' });
  const r = await h.rec.applyAndVerify({ ssid: 'Dealer-Corp', password: 'svc-pass', identity: 'svc-autopost', hidden: false });
  assert.strictEqual(r.ok, true, 'enterprise WiFi connects with no human follow-up');
  const joined = h.calls.join('\n');
  assert.ok(/wifi-sec\.key-mgmt wpa-eap/.test(joined), 'key management must be wpa-eap');
  assert.ok(/802-1x\.eap peap/.test(joined), 'PEAP');
  assert.ok(/802-1x\.phase2-auth mschapv2/.test(joined), 'MSCHAPv2 inner auth');
  assert.ok(/802-1x\.identity svc-autopost/.test(joined), 'the username is sent as the 802.1X identity');
  assert.ok(/802-1x\.password svc-pass/.test(joined), 'the password goes in the 802.1X slot');
  assert.ok(!/wifi-sec\.psk/.test(joined), 'must NOT also write a pre-shared key — that would break the join');
  assert.ok(/802-1x\.system-ca-certs no/.test(joined), 'no CA cert ships with the unit, so validation is off');
}));
tasks.push(at('enterprise WiFi: a plain PSK network never gets 802.1X settings', async () => {
  const h = harness({ connectivity: 'full', hubReachable: true, probe: 'full' });
  await h.rec.applyAndVerify({ ssid: 'Dealer-Staff', password: 'psk-pass', identity: '', hidden: false });
  const joined = h.calls.join('\n');
  assert.ok(/wifi-sec\.key-mgmt wpa-psk/.test(joined), 'PSK network stays PSK');
  assert.ok(!/802-1x/.test(joined), 'no enterprise settings leak onto a normal network');
}));
tasks.push(at('enterprise WiFi: wrong credentials still surface as a credential error', async () => {
  const h = harness({ connectivity: 'none', hubReachable: false, probe: 'unreachable' });
  const r = await h.rec.applyAndVerify({ ssid: 'Dealer-Corp', password: 'bad', identity: 'svc-autopost', hidden: false });
  assert.strictEqual(r.ok, false);
  assert.ok(!r.captive);
  assert.match(h.rec.state.lastError, /Check the password/);
}));
tasks.push(at('enterprise WiFi behind a captive portal is still reported as captive', async () => {
  // the two are independent: a corporate 802.1X network can ALSO put new devices behind a sign-in page
  const h = harness({ connectivity: 'portal', hubReachable: true, probe: 'portal' });
  const r = await h.rec.applyAndVerify({ ssid: 'Dealer-Corp', password: 'svc-pass', identity: 'svc-autopost', hidden: false });
  assert.strictEqual(r.captive, true);
  assert.strictEqual(h.rec.state.lastError, '', 'the 802.1X credentials worked — do not blame them');
}));
t('the rescue page offers the enterprise username field', () => {
  const html = portalPage({ networks: [{ ssid: 'Dealer-Corp', signal: 70, security: 'WPA2 802.1X' }] });
  assert.ok(/needs a username/i.test(html), 'the enterprise option is discoverable');
  assert.ok(html.includes('name="identity"'), 'and has a username field');
});


// ── THE FIELD FAILURES ──────────────────────────────────────────────────────────────────────────────────────
// Everything below is a regression test for a way this rescue was observed to fail on customer sites while
// passing every bench test. They share one shape: the daemon reported itself healthy while doing nothing useful.

// #1 THE BENCH TEST BROKE THE CARD IT VALIDATED. startAp() pauses station autoconnect so NetworkManager cannot
// grab the radio back mid-AP. Without --temporary, nmcli writes that pause into the keyfile on disk — so an
// operator who confirmed the rescue AP appeared and then pulled the power shipped a card whose profile for the
// customer's own network said autoconnect=false. On arrival it would not so much as attempt their WiFi, no
// matter how correct the credentials were.
tasks.push(at('AP pause is TEMPORARY: pulling power mid-rescue cannot leave the real network disabled on disk', async () => {
  const h = harness({ connectivity: 'none', hubReachable: false });
  await h.rec.startAp();
  const pauses = h.calls.filter((c) => /connection modify .*connection\.autoconnect no$/.test(c));
  assert.ok(pauses.length >= 1, 'the station profile must be paused while the AP owns the radio');
  pauses.forEach((c) => assert.ok(c.includes('--temporary'),
    'pause must be in-memory only, or a yanked power cord persists it: ' + c));
}));
tasks.push(at('releasing the pause is PERSISTENT, so a card that already shipped disabled heals itself', async () => {
  const h = harness({ connectivity: 'none', hubReachable: false });
  await h.rec.startAp();
  await h.rec.stopAp();
  const rel = h.calls.filter((c) => /connection modify .*connection\.autoconnect yes$/.test(c));
  assert.ok(rel.length >= 1, 'the pause must be released');
  rel.forEach((c) => assert.ok(!c.includes('--temporary'),
    'the release is a repair and has to reach the keyfile: ' + c));
}));

// #2 A WORKING AP WAS TORN DOWN FOR REPORTING FAILURE. `nmcli connection up` blocks until the activation
// settles; the command runner killed it on a timeout. On a quiet bench the AP is up in under a second, so this
// never fired. On a dealership floor it takes longer, nmcli came back non-zero, and startAp() rolled back an
// access point that was in fact already serving.
tasks.push(at('a SLOW-but-successful AP activation is kept: the gateway IP outranks the nmcli exit code', async () => {
  const h = harness({ connectivity: 'none', hubReachable: false, apUpCode: 1, apGetsIp: true });
  const ok = await h.rec.startAp();
  assert.strictEqual(ok, true, 'the AP is serving on 10.42.0.1 — a timed-out nmcli must not condemn it');
  assert.strictEqual(h.rec.state.phase, 'ap');
  assert.ok(h.rec.state.calls.includes('startAp'));
}));
tasks.push(at('an AP that genuinely never comes up STILL rolls back (never strand)', async () => {
  const h = harness({ connectivity: 'none', hubReachable: false, apUpCode: 0, apGetsIp: false });
  const ok = await h.rec.startAp();
  assert.strictEqual(ok, false, 'no gateway address means no AP, whatever nmcli said');
  assert.strictEqual(h.rec.state.phase, 'monitor', 'the box must be handed back to station mode, not left dead');
  assert.ok(h.calls.some((c) => /connection modify .*connection\.autoconnect yes$/.test(c)), 'station autoconnect restored');
}));

// #3 THE FLAP GUARD SILENCED THE RESCUE. Failed raises used to consume the same six-per-hour budget as
// successful ones, so six rolled-back activations — about ten minutes — bought an hour of total silence. That is
// the shape of "we watched the WiFi list for twenty minutes and nothing ever appeared".
tasks.push(at('failed AP attempts do NOT consume the flap budget', async () => {
  // A box that HAS been online before is the one the guard actually applies to, so this test gives it a
  // config.json (neverOnline() false) and then fails every activation. Under the old accounting the budget was
  // spent by attempt six and the box went quiet for the rest of the hour; the rescue has to keep trying.
  const h = harness({ connectivity: 'none', hubReachable: false, apGetsIp: false });
  h.rec._cfg.configPath = __filename;          // any existing file reads as "this box has claimed before"
  h.rec._cfg.maxReentriesPerHour = 3;
  h.rec._cfg.offlineGraceMs = 0;
  assert.strictEqual(h.rec.state.reentries.length, 0);
  for (let i = 0; i < 6; i += 1) { h.rec.state.phase = 'monitor'; await h.rec.tick(); }
  assert.strictEqual(h.rec.state.reentries.length, 0, 'only SUCCESSFUL raises may be counted');
  assert.ok(h.rec.state.apFailures >= 6, 'and every attempt is recorded as a failure instead');
  const attempts = h.calls.filter((c) => /connection up autopost-setup-ap/.test(c)).length;
  assert.ok(attempts >= 6, 'the rescue must keep trying, not fall silent after the budget; saw ' + attempts);
}));
tasks.push(at('SUCCESSFUL raises still spend the budget, so a healthy box cannot flap its radio forever', async () => {
  const h = harness({ connectivity: 'none', hubReachable: false, apGetsIp: true });
  h.rec._cfg.configPath = __filename;          // previously online -> the guard applies
  h.rec._cfg.maxReentriesPerHour = 2;
  h.rec._cfg.offlineGraceMs = 0;
  for (let i = 0; i < 5; i += 1) { h.rec.state.phase = 'monitor'; await h.rec.tick(); }
  assert.strictEqual(h.rec.state.reentries.length, 2, 'the guard still caps a genuinely flapping box');
}));
tasks.push(at('a box that has NEVER been online is exempt from the flap guard entirely', async () => {
  const h = harness({ connectivity: 'none', hubReachable: false });
  h.rec._cfg.maxReentriesPerHour = 1;
  h.rec.state.reentries = [h.clock.t, h.clock.t, h.clock.t, h.clock.t];  // way over budget
  h.rec._cfg.offlineGraceMs = 0; h.rec._cfg.firstRunOfflineGraceMs = 0;
  await h.rec.tick();
  assert.ok(h.rec.state.calls.includes('startAp'),
    'a never-claimed box has no working state to protect — the rescue AP is its only way of being fixed');
}));

// #4 THE STARTUP REPAIR SILENTLY DID NOTHING. It is driven by `nmcli connection show`, and the command runner
// never rejects — a call made before NetworkManager was ready came back as empty stdout, which does not look
// like an error, it looks like "this box has no saved WiFi profiles at all".
tasks.push(at('waitForNm polls until NetworkManager actually reports running', async () => {
  const h = harness({ nmNotReadyFor: 3 });
  const ok = await h.rec.waitForNm(60000);
  assert.strictEqual(ok, true);
  const polls = h.calls.filter((c) => c.includes('-f RUNNING general')).length;
  assert.ok(polls >= 4, 'expected repeated polling, saw ' + polls);
}));
tasks.push(at('waitForNm gives up after its bound rather than blocking the rescue forever', async () => {
  const h = harness({ nmNotReadyFor: 1e9 });
  const ok = await h.rec.waitForNm(10000);
  assert.strictEqual(ok, false, 'a wedged NetworkManager must not stop the daemon from trying anyway');
}));

// #5 NOTHING COULD SAY WHAT HAPPENED. A headless box with no internet reaches nobody through the journal.
tasks.push(at('the diagnostic ring records what the daemon did, and the portal serves it at /log', async () => {
  const h = harness({ connectivity: 'none', hubReachable: false, apGetsIp: false, apUpCode: 1 });
  await h.rec.startAp();
  assert.ok(h.rec.state.diag.length > 0, 'a failed AP must leave evidence behind');
  assert.ok(h.rec.state.diag.some((l) => /AP did NOT come up/.test(l)), 'and evidence that names the fault');
  let body = null;
  h.rec.requestHandler({ method: 'GET', url: '/log', on: () => {} },
    { writeHead: () => {}, end: (b) => { body = b; } });
  assert.ok(/AP did NOT come up/.test(String(body)), '/log serves the ring so a USB cable is enough to read it');
}));
tasks.push(at('the ring is bounded, so a box left running for months cannot fill its data partition', async () => {
  const h = harness({});
  h.rec._cfg.diagLines = 10;
  for (let i = 0; i < 50; i += 1) h.rec.diag('line ' + i);
  assert.strictEqual(h.rec.state.diag.length, 10);
  assert.ok(/line 49/.test(h.rec.state.diag[9]), 'the NEWEST lines are the ones kept');
}));

// #6 AP CHANNEL. Leaving it unset asks wpa_supplicant to auto-select, which the Pi Zero W / Pi 3 brcmfmac
// firmware does not implement — so the bring-up stalls or fails on exactly the congested sites that need it.
t('pickApChannel avoids the crowd and is deterministic with no data', () => {
  assert.strictEqual(pickApChannel([], 0), 1, 'no scan data must give a stable answer, not a random one');
  assert.notStrictEqual(pickApChannel([{ chan: 6, signal: 90 }], 0), 6, 'do not pile onto a busy channel');
  const crowded = [{ chan: 1, signal: 90 }, { chan: 1, signal: 80 }, { chan: 6, signal: 85 }, { chan: 6, signal: 70 }];
  assert.strictEqual(pickApChannel(crowded, 0), 11, 'the clear channel wins');
  assert.strictEqual(pickApChannel(crowded, 6), 6, 'an explicit override always wins');
});
t('parseScanList reads CHAN but still parses output captured without it', () => {
  const withChan = parseScanList('HomeWiFi:80:WPA2:6\nGuest:40:WPA2:11');
  assert.strictEqual(withChan[0].chan, 6);
  const legacy = parseScanList('HomeWiFi:80:WPA2');
  assert.strictEqual(legacy[0].chan, 0, 'a missing channel is 0, not NaN');
  assert.strictEqual(legacy[0].ssid, 'HomeWiFi');
});
tasks.push(at('startAp pins a channel rather than leaving the radio to auto-select', async () => {
  const h = harness({ connectivity: 'none', hubReachable: false });
  h.rec.state.networks = [{ ssid: 'A', signal: 90, chan: 1 }, { ssid: 'B', signal: 90, chan: 6 }];
  await h.rec.startAp();
  const add = h.calls.find((c) => c.includes('connection add type wifi'));
  assert.ok(/802-11-wireless\.channel 11/.test(add), 'expected a pinned channel in: ' + add);
}));

// ── THE BLUETOOTH BRIDGE ────────────────────────────────────────────────────────────────────────────────────
// The Bluetooth service never drives nmcli. It drops a request file and this daemon applies it through the same
// applyAndVerify() the captive portal uses, so both doors get identical never-strand behaviour.
const fsq = require('fs'); const pathq = require('path');
function putRequest(h, obj) {
  fsq.mkdirSync(h.runtimeDir, { recursive: true });
  fsq.writeFileSync(pathq.join(h.runtimeDir, 'wifi-request.json'), JSON.stringify(obj));
}
function lastResult(h) {
  return JSON.parse(fsq.readFileSync(pathq.join(h.runtimeDir, 'wifi-result.json'), 'utf8'));
}

tasks.push(at('credentials arriving over Bluetooth are applied through the SAME path as the portal', async () => {
  const h = harness({ connectivity: 'full', hubReachable: true, probe: 'full' });
  putRequest(h, { id: 'r1', source: 'bluetooth', action: 'connect', ssid: 'Dealer-Main', password: 'good' });
  const req = h.rec.readRequest();
  assert.ok(req, 'the request must be visible to the daemon');
  await h.rec.handleRequest(req);
  assert.ok(h.rec.state.calls.includes('writeNetwork'), 'it goes through writeNetwork, not a second nmcli driver');
  assert.ok(h.rec.state.calls.includes('connected'));
  assert.ok(h.rec.state.calls.indexOf('stopAp') < h.rec.state.calls.indexOf('writeNetwork'),
    'teardown-first ordering must hold on this path too — the radio cannot be AP and station at once');
  assert.strictEqual(lastResult(h).ok, true);
}));
tasks.push(at('a Bluetooth correction to a guest network reports CAPTIVE, not a bad password', async () => {
  const h = harness({ connectivity: 'portal', hubReachable: true, probe: 'portal' });
  putRequest(h, { id: 'r2', source: 'bluetooth', action: 'connect', ssid: 'Dealer-Guest', password: 'right' });
  await h.rec.handleRequest(h.rec.readRequest());
  const res = lastResult(h);
  assert.strictEqual(res.captive, true);
  assert.strictEqual(res.ok, false);
  assert.ok(/sign-in/i.test(res.error), 'the tech must not be sent to re-check a password that worked');
}));
tasks.push(at('a request is consumed exactly once, so a restart cannot re-apply it', async () => {
  const h = harness({ connectivity: 'full', hubReachable: true, probe: 'full' });
  putRequest(h, { id: 'r3', source: 'bluetooth', action: 'connect', ssid: 'Net', password: 'p' });
  await h.rec.handleRequest(h.rec.readRequest());
  assert.strictEqual(h.rec.readRequest(), null, 'the same id must never be applied twice');
  putRequest(h, { id: 'r4', source: 'bluetooth', action: 'connect', ssid: 'Net2', password: 'p' });
  assert.ok(h.rec.readRequest(), 'a fresh id is a fresh request');
}));
tasks.push(at('a torn or malformed request file reads as "nothing pending", never as a crash', async () => {
  const h = harness({});
  fsq.mkdirSync(h.runtimeDir, { recursive: true });
  fsq.writeFileSync(pathq.join(h.runtimeDir, 'wifi-request.json'), '{"id":"r5","ssi');
  assert.strictEqual(h.rec.readRequest(), null, 'half a file must be retried next tick, not throw in the main loop');
  fsq.writeFileSync(pathq.join(h.runtimeDir, 'wifi-request.json'), '{"no":"id"}');
  assert.strictEqual(h.rec.readRequest(), null, 'a request with no id cannot be tracked, so it is not honoured');
}));
tasks.push(at('a Bluetooth "recheck" defers to the main loop instead of grabbing the radio', async () => {
  const h = harness({ connectivity: 'none', hubReachable: false });
  putRequest(h, { id: 'r6', source: 'bluetooth', action: 'recheck' });
  const took = await h.rec.handleRequest(h.rec.readRequest());
  assert.strictEqual(took, false, 'a re-check must not block the tick it arrived on');
  assert.strictEqual(h.rec.state.recheckRequested, true);
}));
tasks.push(at('a Bluetooth "scan" is refused while the AP owns the radio', async () => {
  const h = harness({ connectivity: 'none', hubReachable: false });
  await h.rec.startAp();
  const before = h.calls.filter((c) => c.includes('device wifi list')).length;
  putRequest(h, { id: 'r7', source: 'bluetooth', action: 'scan' });
  await h.rec.handleRequest(h.rec.readRequest());
  const after = h.calls.filter((c) => c.includes('device wifi list')).length;
  assert.strictEqual(after, before, 'scanning would tear the rescue network out from under whoever asked');
}));
tasks.push(at('the status file carries what an off-band client needs to explain the fault', async () => {
  const h = harness({ connectivity: 'portal', hubReachable: true, probe: 'portal' });
  await h.rec.classifyConnectivity();
  h.rec.writeState();
  const st = JSON.parse(fsq.readFileSync(pathq.join(h.runtimeDir, 'wifi-status.json'), 'utf8'));
  assert.strictEqual(st.connectivity, 'portal');
  assert.strictEqual(st.online, false);
  assert.ok('apFailures' in st && 'neverOnline' in st && 'phase' in st);
  // The original file keeps its exact old shape — VERIFY-PI.cmd and the dashboard already parse it.
  const legacy = JSON.parse(fsq.readFileSync(pathq.join(h.runtimeDir, 'wifi-recovery.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(legacy).sort(), ['apSsid', 'at', 'captive', 'mac', 'phase']);
}));



// ── WIRED CARDS ─────────────────────────────────────────────────────────────────────────────────────────────
// A wired card takes its uplink from a USB-ethernet adapter and ships with NO WiFi profiles on purpose. Without
// wiredDevicePresent(), noSavedWifi() reads that intended configuration as the emergency it was written for and
// raises the rescue AP within seconds of every boot — before the adapter has finished DHCP — on a box that is
// about to be perfectly online.
const ETH_DHCP = 'eth0:ethernet:connecting:autopost-eth0\nwlan0:wifi:disconnected:\nlo:loopback:unmanaged:\n';
const ETH_UP = 'eth0:ethernet:connected:autopost-eth0\nwlan0:wifi:disconnected:\nlo:loopback:unmanaged:\n';
const GADGET = 'usb0:ethernet:connected:autopost-usb0\nwlan0:wifi:disconnected:\nlo:loopback:unmanaged:\n';

tasks.push(at('a wired card mid-DHCP does NOT flash up a spurious rescue AP', async () => {
  const h = harness({ connectivity: 'none', hubReachable: false, savedCons: '', devices: ETH_DHCP });
  h.rec._cfg.offlineGraceMs = 600000; h.rec._cfg.firstRunOfflineGraceMs = 600000;
  await h.rec.tick();
  assert.ok(!h.rec.state.calls.includes('startAp'),
    'having no WiFi is a wired card\'s intended configuration, not an emergency');
}));
tasks.push(at('a wired card whose cable is genuinely dead STILL gets the WiFi rescue after the grace', async () => {
  const h = harness({ connectivity: 'none', hubReachable: false, savedCons: '', devices: ETH_DHCP });
  h.rec._cfg.offlineGraceMs = 0; h.rec._cfg.firstRunOfflineGraceMs = 0;
  await h.rec.tick(); await h.rec.tick();
  assert.ok(h.rec.state.calls.includes('startAp'), 'WiFi stops being the uplink; it does not stop being the rescue');
}));
tasks.push(at('the USB GADGET is not mistaken for an uplink', async () => {
  // usb0 is type=ethernet and permanently "connected" with its static service address. Counting it would
  // suppress the instant AP on every gadget card — including the "capture WiFi on first boot" cards whose whole
  // purpose is to raise that AP immediately.
  const h = harness({ connectivity: 'none', hubReachable: false, savedCons: '', devices: GADGET });
  h.rec._cfg.offlineGraceMs = 600000; h.rec._cfg.firstRunOfflineGraceMs = 600000;
  await h.rec.tick();
  assert.ok(h.rec.state.calls.includes('startAp'), 'a no-WiFi gadget card must still raise the AP at once');
}));
tasks.push(at('wiredDevicePresent sees a real wired NIC and ignores wifi/loopback/gadget', async () => {
  assert.strictEqual(await harness({ devices: ETH_UP }).rec.wiredDevicePresent(), true);
  assert.strictEqual(await harness({ devices: GADGET }).rec.wiredDevicePresent(), false);
  assert.strictEqual(await harness({ devices: 'wlan0:wifi:connected:x\nlo:loopback:unmanaged:\n' }).rec.wiredDevicePresent(), false);
}));
tasks.push(at('a wired card that is online stays in monitor and never touches its wired device', async () => {
  const h = harness({ connectivity: 'full', hubReachable: true, probe: 'full', savedCons: '', devices: ETH_UP });
  await h.rec.tick();
  assert.strictEqual(h.rec.state.phase, 'monitor');
  assert.ok(!h.calls.some((c) => /eth0/.test(c) && /(disconnect|modify)/.test(c)),
    'the rescue owns the WiFi radio and nothing else');
}));

// ── THE WIRE RETRIES ITSELF ─────────────────────────────────────────────────────────────────────────────────
// autopost-eth0 carries may-fail=true PLUS a static service address, so its activation can never FAIL: a site
// whose DHCP is slow (spanning-tree holding the port, a briefly-dead server) leaves the box "connected" on
// 10.55.0.1 with no default route, and autoconnect-retries=0 has nothing to retry because nothing failed.
// Before this, the only offline remedy was the WiFi rescue AP - useless on a card that carries no WiFi at all.
// A unit moved between sites could sit there dead forever. These four pin the fix.
tasks.push(at('offline WITH a wire: re-activates the wire to force a fresh DHCP', async () => {
  const h = harness({ connectivity: 'none', hubReachable: false, savedCons: '', devices: ETH_DHCP });
  h.rec._cfg.offlineGraceMs = 600000; h.rec._cfg.firstRunOfflineGraceMs = 600000; // the AP must not be what fires
  await h.rec.tick();
  assert.ok(h.calls.some((c) => /connection up autopost-eth0/.test(c)),
    'the wire is the uplink on a wired card, so the wire is what must be retried');
}));
tasks.push(at('the wired retry is rate-limited, but never gives up', async () => {
  const h = harness({ connectivity: 'none', hubReachable: false, savedCons: '', devices: ETH_DHCP });
  h.rec._cfg.offlineGraceMs = 600000; h.rec._cfg.firstRunOfflineGraceMs = 600000;
  h.rec._cfg.wiredRetryMs = 60000;
  await h.rec.tick();
  h.clock.t += 1000;                                    // well inside the retry interval
  await h.rec.tick();
  assert.strictEqual(h.calls.filter((c) => /connection up autopost-eth0/.test(c)).length, 1,
    'a genuinely dead port must not be thrashed on every poll');
  h.clock.t += 60000;                                   // interval elapsed
  await h.rec.tick();
  assert.strictEqual(h.calls.filter((c) => /connection up autopost-eth0/.test(c)).length, 2,
    'but it MUST keep trying indefinitely - that is the whole point');
}));
tasks.push(at('an ONLINE wired card is never re-activated', async () => {
  const h = harness({ connectivity: 'full', hubReachable: true, probe: 'full', savedCons: '', devices: ETH_UP });
  await h.rec.tick();
  assert.ok(!h.calls.some((c) => /connection up autopost-eth0/.test(c)),
    'bouncing a working uplink would cut live streams for no reason');
}));
tasks.push(at('the USB gadget is never re-activated as if it were an uplink', async () => {
  const h = harness({ connectivity: 'none', hubReachable: false, savedCons: '', devices: GADGET });
  await h.rec.retryWiredUplink();
  assert.ok(!h.calls.some((c) => /connection up autopost-usb0/.test(c)),
    'usb0 is the service link; bouncing it would drop the very session an engineer is debugging through');
}));

// ── THE FIRST RE-PROBE ──────────────────────────────────────────────────────────────────────────────────────
// 15 minutes is sized for an unattended box riding out a site outage. But the commonest reason the AP goes up at
// all is that the real network simply had not finished coming up — a wired adapter still getting DHCP, or a slow
// WPA association — and fifteen minutes of a rescue hotspot broadcasting from a box that has been online for
// fourteen of them confuses everyone who can see it.
tasks.push(at('the FIRST re-probe after raising the AP comes quickly, then backs off', async () => {
  const h = harness({ connectivity: 'none', hubReachable: false });
  h.rec._cfg.apFirstProbeMs = 90000;
  h.rec._cfg.apProbeMs = 900000;
  await h.rec.startAp();
  const raisedAt = h.rec.state.apSince;

  h.clock.t = raisedAt + 95000;                 // past the first-probe window, nowhere near 15 min
  await h.rec.tick();
  assert.ok(h.rec.state.calls.includes('probeRecovered') || h.rec.state.apProbes >= 1,
    'the first re-test must happen within ~90s, not 15 minutes');

  // ...and once it has run, the interval backs off to the full one.
  h.rec.state.phase = 'ap';
  h.rec.state.apSince = h.clock.t;
  const probesAfterFirst = h.rec.state.apProbes;
  h.clock.t += 95000;
  await h.rec.tick();
  assert.strictEqual(h.rec.state.apProbes, probesAfterFirst,
    'after the first look it must NOT keep tearing the rescue down every 90 seconds');
}));
tasks.push(at('a recovered network resets the fast-probe budget for a later AP session', async () => {
  const h = harness({ connectivity: 'none', hubReachable: false });
  await h.rec.startAp();
  h.rec.state.apProbes = 5;
  h.rec._cfg.apProbeMs = 0;                      // force a probe on the next tick
  h.rec.state.apSince = h.clock.t - 1;
  await h.rec.tick();
  assert.strictEqual(h.rec.state.apProbes, 5 + 1, 'the probe ran');
}));


Promise.all(tasks).then(() => {
  console.log(`wifi-recovery.test: ${pass} passed, ${fail.length} failed`);
  if (fail.length) { fail.forEach((f) => console.log('  FAIL ' + f)); process.exit(1); }
});
