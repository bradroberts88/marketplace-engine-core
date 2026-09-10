'use strict';
/*
 * plannedRefreshDecision — the pre-cap link-refresh gate in src/agent.js.
 *
 * WHY THIS EXISTS (2026-08-17 field logs). The gate used to be `streams.size > 0 => wait`. A rep's browser holds
 * HTTP keep-alive sockets to Facebook open for the WHOLE session, so the socket count never fell back to 0 while
 * anyone was working: the refresh only ran when nobody was posting, the link aged into the ~600s dealership
 * middlebox cap, and the middlebox severed it mid-session. The logs show four such cuts at ~10m13s of link age
 * with 8-10 live streams dropped each, against clean sub-second refreshes for the whole hour the box sat idle.
 *
 * agent.js is a bare script (requiring it starts the agent and dials the VPS), so we extract the pure decision
 * function VERBATIM from the source between its markers and exercise that. This tests the shipped code, not a
 * restatement of it: if someone edits the function in agent.js, this test runs the edited version.
 *
 * Run: node src/_test/planned-refresh.test.js     (no dependencies)
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'agent.js');
const src = fs.readFileSync(SRC, 'utf8');
const m = src.match(/--- BEGIN plannedRefreshDecision[^\n]*\n([\s\S]*?)\n\/\/ --- END plannedRefreshDecision ---/);
if (!m) {
  console.error('FAIL: could not find the plannedRefreshDecision markers in src/agent.js.');
  console.error('      If the function was renamed or the markers removed, update this test deliberately —');
  console.error('      do not delete it: it is the only guard on the gate that caused the 2026-08-17 cuts.');
  process.exit(1);
}
// eslint-disable-next-line no-new-func
const plannedRefreshDecision = new Function(`${m[1]}\nreturn plannedRefreshDecision;`)();

let pass = 0; let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log('  ok   ' + name); }
  else { fail += 1; console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

const QUIET = 5000;      // STREAM_QUIET_MS default
const MAX = 480000;      // PLANNED_RECONNECT_MAX_MS default (8 min, below the ~600s cap)
const T0 = 1_000_000;    // arbitrary fixed clock; the function is pure so real time never enters
const at = (ageMs, over) => plannedRefreshDecision({
  now: T0 + ageMs, linkOpenedAt: T0, lastByteAt: T0 + ageMs - (over.sinceByteMs == null ? ageMs : over.sinceByteMs),
  streamCount: over.streamCount, quietMs: QUIET, maxAgeMs: MAX,
});

console.log('plannedRefreshDecision');

// --- the original behaviour that still must hold -------------------------------------------------------------
check('idle box (no streams) refreshes at the 120s target',
  at(120000, { streamCount: 0 }).refresh === true);
check('idle refresh is not flagged as forced',
  at(120000, { streamCount: 0 }).forced === false);

// --- THE BUG: keep-alive sockets open but no bytes moving must count as idle ----------------------------------
const lull = at(120000, { streamCount: 8, sinceByteMs: 6000 });
check('8 keep-alive sockets open but byte-quiet 6s => refresh (the 2026-08-17 fix)',
  lull.refresh === true, 'this is exactly the case the old streams.size gate refused to refresh on');
check('a quiet-window refresh is not forced', lull.forced === false);

// --- genuinely busy: an in-flight transfer must NOT be cut ----------------------------------------------------
const busy = at(120000, { streamCount: 8, sinceByteMs: 500 });
check('bytes moved 0.5s ago => do NOT refresh (never cut an in-flight post)', busy.refresh === false);

// --- boundary: exactly at the quiet window --------------------------------------------------------------------
check('exactly STREAM_QUIET_MS of quiet counts as quiet',
  at(120000, { streamCount: 1, sinceByteMs: QUIET }).refresh === true);
check('one ms short of the quiet window does not',
  at(120000, { streamCount: 1, sinceByteMs: QUIET - 1 }).refresh === false);

// --- a freshly-opened stream must not read as quiet off a stale/zero lastByteAt --------------------------------
const fresh = plannedRefreshDecision({
  now: T0 + 120000, linkOpenedAt: T0 + 119000, lastByteAt: 0, streamCount: 3, quietMs: QUIET, maxAgeMs: MAX,
});
check('stream open 1s on a 1s-old link with lastByteAt=0 is NOT treated as quiet',
  fresh.refresh === false, 'quiet must be measured from link-open, not from epoch 0');

// --- the backstop: never let the ~600s middlebox cap win the race ---------------------------------------------
const forced = at(MAX, { streamCount: 8, sinceByteMs: 100 });
check('permanently busy link refreshes anyway at the max-age ceiling', forced.refresh === true);
check('the ceiling refresh is reported as forced', forced.forced === true);
check('the ceiling (8min) fires well before the observed ~600s cap', MAX < 600000);
check('still no refresh just under the ceiling while busy',
  at(MAX - 1, { streamCount: 8, sinceByteMs: 100 }).refresh === false);

// --- the regression that produced the logs: busy at 10min must never be reachable ------------------------------
check('a busy link can never still be up at the ~10min cap',
  at(600000, { streamCount: 8, sinceByteMs: 100 }).refresh === true,
  'if this fails the middlebox gets to sever the link again');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
