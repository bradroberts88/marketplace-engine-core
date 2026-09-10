'use strict';
/*
 * Hub health-alert de-duping + the planned-vs-real disconnect distinction.
 *
 * WHY THIS EXISTS (2026-08-17 field logs). The de-dupe state (`_alerted`) and the throttled-word accumulator
 * lived on the LIVE agent entry, which registerAgent() rebuilds from scratch on every (re)connect — while the
 * agent refreshes its control link every ~2 minutes by design. So both were wiped every couple of minutes: one
 * device re-fired the identical rootfs alert ~30 times in 100 minutes, which is enough to bury a real alert.
 * Both now live on the persistent per-device record instead.
 *
 * Run: node server/src/_test/health-alerts.test.js     (no dependencies)
 */
const { Hub } = require('../hub');

let pass = 0; let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log('  ok   ' + name); }
  else { fail += 1; console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

const WS_OPEN = 1;
const fakeWs = () => ({ readyState: WS_OPEN, send() {}, close() {} });
// A hub that records every alert instead of emailing it.
function makeHub(opts = {}) {
  const alerts = [];
  const hub = new Hub({ onAlert: (kind, id, msg) => alerts.push({ kind, id, msg }), log: () => {}, ...opts });
  return { hub, alerts };
}
const HEALTHY = { throttled: 0, tempC: 45, diskFreeMb: 8000, uptimeS: 90000, rootfsOverlay: false, dataWritable: true };
const health = (alerts) => alerts.filter((a) => a.kind === 'device-health');

console.log('Hub health alerts');

// --- the reported bug: the same condition re-alerting on every reconnect --------------------------------------
{
  const { hub, alerts } = makeHub();
  // Overheating is a genuine condition, so it SHOULD alert — but only once, not once per link refresh.
  const hot = { ...HEALTHY, tempC: 88 };
  for (let i = 0; i < 30; i += 1) {                       // 30 planned link refreshes, ~1 hour of real time
    hub.registerAgent('d1', fakeWs());
    hub.onAgentMessage('d1', { type: 'heartbeat', telemetry: hot });
    hub.removeAgent('d1', hub.agents.get('d1').ws, { code: 1000, reason: 'planned-refresh' });
  }
  check('a persistent condition alerts ONCE across 30 reconnects, not 30 times',
    health(alerts).length === 1, `got ${health(alerts).length} device-health alerts`);
}

// --- it must still re-alert if the condition genuinely clears and returns -------------------------------------
{
  const { hub, alerts } = makeHub();
  hub.registerAgent('d1', fakeWs());
  hub.onAgentMessage('d1', { type: 'heartbeat', telemetry: { ...HEALTHY, tempC: 88 } });  // hot -> alert
  hub.onAgentMessage('d1', { type: 'heartbeat', telemetry: { ...HEALTHY, tempC: 40 } });  // cooled -> clears
  hub.onAgentMessage('d1', { type: 'heartbeat', telemetry: { ...HEALTHY, tempC: 88 } });  // hot again -> alert
  check('a condition that clears and returns alerts again', health(alerts).length === 2,
    `got ${health(alerts).length}, expected 2`);
}

// --- the accumulator must outlive the reconnect that used to reset it -----------------------------------------
{
  const { hub, alerts } = makeHub();
  hub.registerAgent('d1', fakeWs());
  // One transient undervoltage spike (bit0), seen once, then gone.
  hub.onAgentMessage('d1', { type: 'heartbeat', telemetry: { ...HEALTHY, throttled: 0x1 } });
  hub.removeAgent('d1', hub.agents.get('d1').ws, { code: 1000, reason: 'planned-refresh' });
  hub.registerAgent('d1', fakeWs());
  hub.onAgentMessage('d1', { type: 'heartbeat', telemetry: { ...HEALTHY, throttled: 0x0 } });
  const uv = health(alerts).filter((a) => /UNDERVOLTAGE/.test(a.msg));
  check('a transient undervoltage spike still alerts', uv.length === 1, `got ${uv.length}`);
  check('the accumulator survives a reconnect (evidence is not erased)',
    hub.lastKnown.get('d1').throttledAccum === 0x1,
    `accum=0x${(hub.lastKnown.get('d1').throttledAccum || 0).toString(16)}`);
}

// --- the rootfs alert is a v1 false positive and must be off by default ----------------------------------------
{
  const { hub, alerts } = makeHub();                      // rootfsOverlay:false on every v1 Pi, by design
  hub.registerAgent('d1', fakeWs());
  hub.onAgentMessage('d1', { type: 'heartbeat', telemetry: HEALTHY });
  check('a writable rootfs does NOT alert by default (v1 ships that way on purpose)',
    health(alerts).length === 0, `got: ${health(alerts).map((a) => a.msg).join(' | ')}`);
}
{
  const { hub, alerts } = makeHub({ alertOnRootfsWritable: true });
  hub.registerAgent('d1', fakeWs());
  hub.onAgentMessage('d1', { type: 'heartbeat', telemetry: HEALTHY });
  check('...but still alerts when explicitly enabled (once the overlay ships)',
    health(alerts).filter((a) => /rootfs is WRITABLE/.test(a.msg)).length === 1);
}

// --- a real failure must still page ----------------------------------------------------------------------------
{
  const { hub, alerts } = makeHub();
  hub.registerAgent('d1', fakeWs());
  hub.onAgentMessage('d1', { type: 'heartbeat', telemetry: { ...HEALTHY, dataWritable: false } });
  check('a failed data partition still alerts',
    health(alerts).filter((a) => /STORAGE FAILED/.test(a.msg)).length === 1);
}

console.log('\nHub disconnect classification');

// --- a planned refresh that drops streams must not page as an outage -------------------------------------------
{
  const { hub, alerts } = makeHub();
  hub.registerAgent('d1', fakeWs());
  hub.onAgentMessage('d1', { type: 'heartbeat', telemetry: HEALTHY });
  hub.streams.set('s1', { dealershipId: 'd1', clientSocket: { destroy() {} } }); // a live stream riding the link
  hub.removeAgent('d1', hub.agents.get('d1').ws, { code: 1000, reason: 'planned-refresh' });
  check('a planned refresh with live streams does not page immediately',
    alerts.filter((a) => a.kind === 'offline').length === 0);
  check('...and the event log says so, rather than "failed closed"',
    /planned link refresh/.test(hub.getEvents('d1').slice(-1)[0].detail));
  check('...but the streams are still dropped (fail-closed is unchanged)', hub.streams.size === 0);
}

// --- a genuine drop with live streams must still page immediately ----------------------------------------------
{
  const { hub, alerts } = makeHub();
  hub.registerAgent('d1', fakeWs());
  hub.onAgentMessage('d1', { type: 'heartbeat', telemetry: HEALTHY });
  hub.streams.set('s1', { dealershipId: 'd1', clientSocket: { destroy() {} } });
  hub.removeAgent('d1', hub.agents.get('d1').ws, { code: 1006, reason: '' }); // middlebox cut / abnormal close
  check('an abnormal close with live streams pages immediately',
    alerts.filter((a) => a.kind === 'offline').length === 1);
  check('...and the event log still reads "failed closed"',
    /failed closed/.test(hub.getEvents('d1').slice(-1)[0].detail));
}

// --- a "planned" close that never comes back must still alert, via the grace timer -------------------------------
{
  const { hub, alerts } = makeHub({ offlineGraceMs: 0 }); // grace 0 => the timer path fires inline
  hub.registerAgent('d1', fakeWs());
  hub.streams.set('s1', { dealershipId: 'd1', clientSocket: { destroy() {} } });
  hub.removeAgent('d1', hub.agents.get('d1').ws, { code: 1000, reason: 'planned-refresh' });
  check('a planned close still alerts when it does not reconnect (no trust granted)',
    alerts.filter((a) => a.kind === 'offline').length === 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
