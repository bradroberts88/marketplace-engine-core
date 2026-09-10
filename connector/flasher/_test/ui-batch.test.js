'use strict';
/* Drives the REAL inline script out of flasher/index.html against a stub DOM, to prove the multi-card lane flow
   before it is ever pointed at hardware.  Run: node flasher/_test/ui-batch.test.js

   The stub is NOT a browser — it implements only the handful of DOM surfaces this screen actually touches
   (getElementById / createElement / innerHTML-with-classes / querySelector / addEventListener). That is enough to
   catch the failures that matter here and that a syntax check cannot see: a lane wired to the wrong element, a
   progress event painting the wrong bar, the fleet password sentinel leaking out as a real password, or two cards
   going out under one setup code. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0; const fail = [];
const t = (name, fn) => { try { fn(); pass++; } catch (e) { fail.push(name + ' :: ' + e.message); } };
const tick = () => new Promise((r) => setImmediate(r));
const settle = async () => { for (let i = 0; i < 12; i += 1) await tick(); };

// ---- minimal DOM stub ------------------------------------------------------------------------------------------
function makeEl(tag) {
  const el = {
    tagName: (tag || 'div').toUpperCase(),
    value: '', checked: false, disabled: false, placeholder: '', textContent: '',
    className: '', style: {}, dataset: {}, children: [], _byClass: new Map(), _listeners: {},
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); },
    },
    addEventListener(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); },
    fire(ev) { (this._listeners[ev] || []).forEach((f) => f({ target: this })); },
    appendChild(c) { this.children.push(c); return c; },
    _options: null, // seeded for <select> from the real markup, so option lookups are answered truthfully
    querySelector(sel) {
      if (sel === '.bar > i') { const b = this._byClass.get('bar'); return b ? b._byClass.get('__i') : null; }
      const opt = /^option\[value="([^"]*)"\]$/.exec(sel);
      if (opt) return (this._options && this._options.has(opt[1])) ? makeEl('option') : null;
      const cls = sel.replace(/^\./, '');
      return this._byClass.get(cls) || null;
    },
    querySelectorAll() { return []; },
    get innerHTML() { return this._html || ''; },
    // Registers one stub child per class token found in the markup, which is all querySelector needs here.
    set innerHTML(html) {
      this._html = html;
      this._byClass = new Map();
      this.children = [];
      const re = /<(\w+)[^>]*class="([^"]+)"/g;
      let m;
      while ((m = re.exec(html))) {
        const child = makeEl(m[1]);
        m[2].split(/\s+/).filter(Boolean).forEach((c) => { if (!this._byClass.has(c)) this._byClass.set(c, child); });
      }
      // <div class="bar"><i></i></div> — give the bar an inner <i> so `.bar > i` resolves
      const bar = this._byClass.get('bar');
      if (bar) bar._byClass.set('__i', makeEl('i'));
    },
  };
  return el;
}
function makeDoc() {
  const byId = new Map();
  return {
    _byId: byId,
    getElementById(id) { if (!byId.has(id)) byId.set(id, makeEl('input')); return byId.get(id); },
    createElement(tag) { return makeEl(tag); },
    querySelectorAll() { return []; },
  };
}

// ---- load the real script out of index.html -------------------------------------------------------------------
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const script = (html.match(/<script>([\s\S]*?)<\/script>/) || [])[1];
assert.ok(script, 'could not find the inline script in index.html');

const FLEET_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAATESTKEY tester@bench';
const FLEET_PASS_SENTINEL_LEN = 16;

// Read the model picker straight out of index.html: the first <option> is what a real browser selects before any
// JS runs, and the option set is what loadFleetDefaults() is allowed to switch to. Parsing it here (rather than
// hardcoding) means this test fails if someone removes or reorders the models in the markup.
const SELECT_BLOCK = (html.match(/<select id="piModel">([\s\S]*?)<\/select>/) || [])[1] || '';
const MODEL_OPTIONS = [...SELECT_BLOCK.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
assert.ok(MODEL_OPTIONS.length >= 2, 'index.html should offer at least two Pi models');

function boot(opts) {
  const calls = { flash: [], confirmBatch: [], dryRun: [] };
  let progressCb = null;
  const flashPromises = new Map(); // jobId -> {resolve}
  const document = makeDoc();
  // mirror a real browser: the <select> knows its options, and starts on the FIRST one
  const sel = document.getElementById('piModel');
  sel._options = new Set(MODEL_OPTIONS);
  sel.value = MODEL_OPTIONS[0];
  const flasher = {
    fleetDefaults: async () => Object.assign({
      hasFleetKey: true, fleetKeyLabel: 'tester@bench', fleetKey: FLEET_KEY,
      hasFleetPass: true, fleetPassWeak: false, benchSsid: 'Bench-WiFi',
      usbGadgetForcedOff: false, defaultPiModel: 'zerow', elevated: true,
    }, opts && opts.fleet),
    resolveImage: async () => ({ label: 'Raspberry Pi Zero W', imagePath: 'C:\\x\\autopost-golden-zerow.img.xz', exists: true }),
    scanDrives: async () => ({ ok: true, drives: (opts && opts.drives) || [] }),
    dryRun: async (form) => { calls.dryRun.push(form); return { ok: true, files: [], imagePath: 'x', imageIsGolden: true }; },
    confirmBatch: async (targets) => { calls.confirmBatch.push(targets); return { ok: true, token: 'TOKEN-1', count: targets.length }; },
    flash: (form) => { calls.flash.push(form); return new Promise((resolve) => flashPromises.set(form.jobId, resolve)); },
    verifyCard: async () => ({ ok: true, files: {} }),
    onProgress: (cb) => { progressCb = cb; },
  };
  const ctx = vm.createContext({
    document, window: { flasher }, console,
    setTimeout, clearTimeout, setInterval, clearInterval, setImmediate,
  });
  // top-level let/const in a vm Script are not reachable as globals — export the bindings we need to drive.
  const probe = '\n;globalThis.__t = { getLanes: () => lanes, readForm, laneReady, refreshGate, scan, getFleet: () => fleet };\n';
  vm.runInContext(script + probe, ctx, { filename: 'index.html<script>' });
  return { ctx, document, calls, flashPromises, prog: (m) => progressCb && progressCb(m), api: () => ctx.__t };
}

const DRIVES = [
  { raw: '\\\\.\\PhysicalDrive2', size: 32e9, description: 'Generic SD Reader', isCard: true, isUSB: false, mountpoints: ['E:'], label: 'E: Generic SD Reader (32 GB)' },
  { raw: '\\\\.\\PhysicalDrive3', size: 32e9, description: 'Realtek USB Reader', isCard: true, isUSB: true, mountpoints: ['F:'], label: 'F: Realtek USB Reader (32 GB)' },
];
// a lane-shaped object for the pure readForm() checks
const mkLane = (o) => Object.assign({
  drive: DRIVES[0], dealership: '', code: '', ssid: '', pass: '', ssid2: '', pass2: '', hidden: false, tz: 'America/New_York',
}, o);

// Fill a lane row the way an operator would: type into the real DOM inputs and fire the real listeners.
function fill(lane, v) {
  const set = (field, val) => {
    if (val === undefined) return;
    lane.el[field].value = val;
    lane.el[field].fire(field === 'tz' ? 'change' : 'input');
  };
  set('dealership', v.dealership); set('ssid', v.ssid); set('pass', v.pass);
  set('ssid2', v.ssid2); set('pass2', v.pass2); set('tz', v.tz); set('code', v.code);
  if (v.hidden !== undefined) { lane.el.hidden.checked = v.hidden; lane.el.hidden.fire('change'); }
}

(async () => {
  // ============ fleet prefill =====================================================================================
  {
    const h = boot({ drives: DRIVES });
    await settle();
    const d = h.document;
    t('the fleet SSH key is really filled into the form, not just hinted', () => {
      assert.strictEqual(d.getElementById('devSshPubKey').value, FLEET_KEY);
      assert.strictEqual(d.getElementById('keyChip').style.display, '');
    });
    t('the password field shows as filled without the renderer holding the secret', () => {
      const p = d.getElementById('piPass');
      assert.strictEqual(p.value.length, FLEET_PASS_SENTINEL_LEN);
      assert.strictEqual(p.dataset.fleet, '1');
      assert.ok(!/[A-Za-z0-9]/.test(p.value), 'the sentinel must not look like a real password');
    });
    t('an untouched fleet password field submits EMPTY so the env value is applied', () => {
      const form = h.api().readForm(mkLane({ code: 'K7QP3M2R' }));
      assert.strictEqual(form.piPass, '', 'the sentinel bullets must never be sent as the password');
      assert.strictEqual(form.devSshPubKey, FLEET_KEY);
    });
    t('the model picker defaults to the original Zero W', () => {
      // both halves matter: the markup must LIST zerow first (what a browser picks with JS off / before load),
      // and the fleet default must resolve to it too.
      assert.strictEqual(MODEL_OPTIONS[0], 'zerow', 'zerow must be the first <option> in index.html');
      assert.strictEqual(d.getElementById('piModel').value, 'zerow');
    });
    t('focusing the password field clears the sentinel for a real override', () => {
      const p = d.getElementById('piPass');
      p.fire('focus');
      assert.strictEqual(p.value, '');
      assert.strictEqual(p.dataset.fleet, undefined);
      p.value = 'my-one-off-pass';
      assert.strictEqual(h.api().readForm(mkLane({ code: 'K7QP3M2R' })).piPass, 'my-one-off-pass');
    });
  }

  // ============ two cards, one confirmation, concurrent writes ====================================================
  {
    const h = boot({ drives: DRIVES });
    await settle();
    const d = h.document;
    const lanes = h.api().getLanes();

    t('one lane appears per detected card', () => {
      assert.strictEqual(lanes.length, 2);
      assert.strictEqual(lanes[0].raw, DRIVES[0].raw);
      assert.strictEqual(lanes[1].raw, DRIVES[1].raw);
    });

    // TWO DIFFERENT DEALERSHIPS, written at the same time. This is the whole point of the lane model: each card
    // is a complete independent job, so a batch is not "one dealership, N cards" but "N unrelated cards".
    d.getElementById('dry').checked = false;
    fill(lanes[0], { dealership: 'Merchant Auto', ssid: 'Merchant-WiFi', pass: 'merchantpass1', tz: 'America/Denver', code: 'K7QP-3M2R' });
    fill(lanes[1], { dealership: "Bob's Cars", ssid: 'Bobs-Guest', pass: 'bobspass22', tz: 'America/New_York', code: 'QB1C-1YVD' });

    t('filling a card in auto-includes it in the batch', () => {
      assert.strictEqual(lanes[0].include, true);
      assert.strictEqual(lanes[1].include, true);
    });
    t('both lanes are ready and the button offers the whole batch', () => {
      h.api().refreshGate();
      assert.strictEqual(lanes.filter(h.api().laneReady).length, 2);
      assert.strictEqual(d.getElementById('go').disabled, false);
      assert.match(d.getElementById('go').textContent, /Flash 2 cards/);
    });

    d.getElementById('go').onclick();
    await settle();

    t('exactly ONE confirmation covers the whole batch', () => {
      assert.strictEqual(h.calls.confirmBatch.length, 1, 'must not pop a dialog per card');
      assert.strictEqual(h.calls.confirmBatch[0].length, 2);
    });
    t('both writers start concurrently, each with the batch token', () => {
      assert.strictEqual(h.calls.flash.length, 2, 'the second card must not wait for the first to finish');
      h.calls.flash.forEach((f) => assert.strictEqual(f.confirmToken, 'TOKEN-1'));
    });
    t('each card is sent its OWN one-time setup code', () => {
      const codes = h.calls.flash.map((f) => f.claimCode);
      assert.deepStrictEqual(codes.sort(), ['K7QP-3M2R', 'QB1C-1YVD']);
    });
    t('each card gets a distinct job id and its own device', () => {
      const [a, b] = h.calls.flash;
      assert.notStrictEqual(a.jobId, b.jobId);
      assert.notStrictEqual(a.target.raw, b.target.raw);
    });
    // ---- THE POINT OF THE LANE MODEL: no per-dealership value crosses between cards -------------------------
    // Getting this wrong ships a card to one dealership carrying another dealership's WiFi, which is both a
    // dead unit and a credential leak. Assert the FULL per-card payload, matched by device, not just that the
    // two differ — a bug that swapped the two lanes' details wholesale would still "differ".
    t('each card carries its OWN dealership, WiFi and timezone — nothing bleeds across', () => {
      const byRaw = Object.fromEntries(h.calls.flash.map((f) => [f.target.raw, f]));
      const a = byRaw[DRIVES[0].raw]; const b = byRaw[DRIVES[1].raw];
      assert.ok(a && b, 'both devices were written');
      assert.strictEqual(a.dealership, 'Merchant Auto');
      assert.strictEqual(a.primary.ssid, 'Merchant-WiFi');
      assert.strictEqual(a.primary.pass, 'merchantpass1');
      assert.strictEqual(a.tz, 'America/Denver');
      assert.strictEqual(a.claimCode, 'K7QP-3M2R');
      assert.strictEqual(b.dealership, "Bob's Cars");
      assert.strictEqual(b.primary.ssid, 'Bobs-Guest');
      assert.strictEqual(b.primary.pass, 'bobspass22');
      assert.strictEqual(b.tz, 'America/New_York');
      assert.strictEqual(b.claimCode, 'QB1C-1YVD');
    });
    t('genuinely fleet-wide settings stay identical across the batch', () => {
      const [a, b] = h.calls.flash;
      assert.strictEqual(a.piModel, b.piModel);
      assert.strictEqual(a.devSshPubKey, b.devSshPubKey);
      assert.strictEqual(a.piUser, b.piUser);
      assert.strictEqual(a.country, b.country);
    });

    // ---- progress must be routed per lane, not broadcast ----------------------------------------------------
    const jobA = h.calls.flash[0].jobId;
    h.prog({ jobId: jobA, type: 'progress', phase: 'writing', percentage: 40 });
    t('a progress event only moves the bar of the job it belongs to', () => {
      assert.ok(lanes[0].pct > 0 && lanes[0].pct < 50, 'lane A should have advanced, got ' + lanes[0].pct);
      assert.strictEqual(lanes[1].pct, 0, 'lane B must NOT move on lane A traffic');
    });
    const beforeA = lanes[0].pct; const beforeB = lanes[1].pct;
    h.prog({ jobId: 'job-that-does-not-exist', type: 'progress', phase: 'verifying', percentage: 100 });
    t('an unknown job id is ignored, not applied to some arbitrary lane', () => {
      assert.strictEqual(lanes[0].pct, beforeA, 'lane A must be untouched by traffic that is not its own');
      assert.strictEqual(lanes[1].pct, beforeB, 'lane B must be untouched by traffic that is not its own');
    });
    t('an error for an unknown job does not mark a real lane failed', () => {
      h.prog({ jobId: 'job-that-does-not-exist', type: 'error', reason: 'boom' });
      assert.notStrictEqual(lanes[0].status, 'error');
      assert.notStrictEqual(lanes[1].status, 'error');
    });
    h.prog({ jobId: h.calls.flash[1].jobId, type: 'progress', phase: 'verifying', percentage: 50 });
    t('the verify phase maps into the top half of that lane\'s bar', () => {
      assert.ok(lanes[1].pct >= 50 && lanes[1].pct <= 100, 'got ' + lanes[1].pct);
    });

    // ---- completion ------------------------------------------------------------------------------------------
    h.flashPromises.get(jobA)({ ok: true, bootDir: null });
    await settle();
    t('a finished lane is marked done, untickable, and not flashable again', () => {
      assert.strictEqual(lanes[0].status, 'done');
      assert.strictEqual(lanes[0].include, false);
      // the code stays VISIBLE on a finished row on purpose — it records which code went on the card the
      // operator is about to pull out of the reader — but the row can no longer be flashed
      assert.strictEqual(lanes[0].code, 'K7QP-3M2R');
      assert.strictEqual(h.api().laneReady(lanes[0]), false);
    });
    t('the other card keeps writing — no restart, no reset', () => {
      assert.strictEqual(lanes[1].status, 'writing');
    });

    h.flashPromises.get(h.calls.flash[1].jobId)({ ok: false, reason: 'rpi-imager write/verify failed (exit 1)' });
    await settle();
    t('a failed lane reports its own error without touching the successful one', () => {
      assert.strictEqual(lanes[1].status, 'error');
      assert.match(lanes[1].msg, /write\/verify failed/);
      assert.strictEqual(lanes[0].status, 'done');
    });
    t('the summary counts successes and failures separately', () => {
      assert.match(d.getElementById('msg').textContent, /1 card failed/);
    });

    // ---- the app is immediately reusable: swap a card in and go again -----------------------------------------
    // "Another card for this dealership": keeps the WiFi, drops only the spent one-time code.
    lanes[0].el.again.fire('click');
    t('“another card for this dealership” keeps the WiFi and clears only the code', () => {
      assert.strictEqual(lanes[0].status, 'idle');
      assert.strictEqual(lanes[0].code, '', 'a one-time code must never be reused on the next card');
      assert.strictEqual(lanes[0].dealership, 'Merchant Auto', 'no retyping the same dealership');
      assert.strictEqual(lanes[0].ssid, 'Merchant-WiFi');
      assert.strictEqual(lanes[0].pass, 'merchantpass1');
    });
    fill(lanes[0], { code: 'ZZ12-ZZ34' });
    t('and it is immediately flashable again — no restart', () => {
      assert.strictEqual(h.api().laneReady(lanes[0]), true);
    });

    // "Different dealership": wipes the lot, so the next card cannot inherit this site's WiFi.
    lanes[1].el.fresh.fire('click');
    t('“different dealership” wipes the WiFi so it cannot leak onto the next card', () => {
      assert.strictEqual(lanes[1].dealership, '');
      assert.strictEqual(lanes[1].ssid, '');
      assert.strictEqual(lanes[1].pass, '');
      assert.strictEqual(lanes[1].code, '');
      assert.strictEqual(lanes[1].el.ssid.value, '', 'and the visible field is cleared too, not just the model');
      assert.strictEqual(h.api().laneReady(lanes[1]), false);
    });
  }

  // ============ a SPENT code can never be carried onto the next card =============================================
  // The subtle one: a finished row keeps showing its code, and editing any field re-arms the row. Without an
  // explicit rule, changing the dealership on a finished row would leave the burned code sitting there and the
  // next card would ship with a code that can never claim — a dead unit that looks perfectly written.
  {
    const h = boot({ drives: DRIVES });
    await settle();
    const d = h.document;
    const lanes = h.api().getLanes();
    d.getElementById('dry').checked = false;
    fill(lanes[0], { dealership: 'Merchant Auto', ssid: 'Merchant-WiFi', pass: 'p1', code: 'K7QP-3M2R' });
    d.getElementById('go').onclick();
    await settle();
    h.flashPromises.get(h.calls.flash[0].jobId)({ ok: true, bootDir: null });
    await settle();
    assert.strictEqual(lanes[0].status, 'done', 'precondition: the write succeeded');

    fill(lanes[0], { dealership: "Bob's Cars" }); // operator starts the next card by retyping the dealership
    t('re-arming a WRITTEN lane drops its spent code', () => {
      assert.strictEqual(lanes[0].status, 'idle', 'the row is live again');
      assert.strictEqual(lanes[0].code, '', 'the burned code must not be carried onto the next card');
      assert.strictEqual(lanes[0].el.code.value, '', 'and the field is visibly empty, so it is obvious one is needed');
      assert.strictEqual(h.api().laneReady(lanes[0]), false, 'so it cannot be flashed until a fresh code is entered');
    });
  }

  // ============ a FAILED lane keeps its code, because nothing was written ========================================
  {
    const h = boot({ drives: DRIVES });
    await settle();
    const d = h.document;
    const lanes = h.api().getLanes();
    d.getElementById('dry').checked = false;
    fill(lanes[0], { dealership: 'Merchant Auto', ssid: 'Merchant-WiFi', pass: 'p1', code: 'K7QP-3M2R' });
    d.getElementById('go').onclick();
    await settle();
    h.flashPromises.get(h.calls.flash[0].jobId)({ ok: false, reason: 'rpi-imager write/verify failed' });
    await settle();
    assert.strictEqual(lanes[0].status, 'error', 'precondition: the write failed');
    fill(lanes[0], { pass: 'p1-corrected' });
    t('a failed lane keeps its code for the retry — the hub never burned it', () => {
      assert.strictEqual(lanes[0].code, 'K7QP-3M2R', 'nothing was written, so the code is still good');
      assert.strictEqual(h.api().laneReady(lanes[0]), true, 'and the row is immediately retryable');
    });
  }

  // ============ copying between lanes copies the dealership but NEVER the one-time code ===========================
  {
    const h = boot({ drives: DRIVES });
    await settle();
    const lanes = h.api().getLanes();
    fill(lanes[0], { dealership: 'Merchant Auto', ssid: 'Merchant-WiFi', pass: 'merchantpass1', tz: 'America/Denver', code: 'K7QP-3M2R' });
    lanes[1].el.copy.fire('click');
    t('copy-from-above brings the dealership and WiFi across', () => {
      assert.strictEqual(lanes[1].dealership, 'Merchant Auto');
      assert.strictEqual(lanes[1].ssid, 'Merchant-WiFi');
      assert.strictEqual(lanes[1].pass, 'merchantpass1');
      assert.strictEqual(lanes[1].tz, 'America/Denver');
      assert.strictEqual(lanes[1].el.ssid.value, 'Merchant-WiFi', 'and shows in the field');
    });
    t('copy-from-above never copies the setup code', () => {
      assert.strictEqual(lanes[1].code, '', 'codes are one-time — copying one would ship a dead card');
      assert.strictEqual(h.api().laneReady(lanes[1]), false, 'so the lane is not yet ready to flash');
    });
  }

  // ============ a ticked card with no WiFi cannot be flashed =====================================================
  {
    const h = boot({ drives: DRIVES });
    await settle();
    const d = h.document;
    const lanes = h.api().getLanes();
    d.getElementById('dry').checked = false;
    fill(lanes[0], { code: 'K7QP-3M2R' }); // code but no SSID
    t('a code with no WiFi is not flashable', () => {
      assert.strictEqual(h.api().laneReady(lanes[0]), false, 'a card with no network would never claim');
      assert.strictEqual(d.getElementById('go').disabled, true);
    });
    fill(lanes[0], { ssid: 'Merchant-WiFi' });
    t('adding the WiFi arms it', () => {
      assert.strictEqual(h.api().laneReady(lanes[0]), true);
      assert.strictEqual(d.getElementById('go').disabled, false);
    });
  }

  // ============ a reused setup code is refused BEFORE anything is erased ==========================================
  {
    const h = boot({ drives: DRIVES });
    await settle();
    const d = h.document;
    const lanes = h.api().getLanes();
    d.getElementById('dry').checked = false;
    fill(lanes[0], { dealership: 'Merchant Auto', ssid: 'Merchant-WiFi', pass: 'p1', code: 'K7QP-3M2R' });
    fill(lanes[1], { dealership: "Bob's Cars", ssid: 'Bobs-Guest', pass: 'p2', code: 'k7qp3m2r' }); // same code, different formatting
    d.getElementById('go').onclick();
    await settle();
    t('the same code on two cards is caught, and NOTHING is confirmed or written', () => {
      assert.strictEqual(h.calls.confirmBatch.length, 0, 'must refuse before the erase dialog');
      assert.strictEqual(h.calls.flash.length, 0);
      assert.match(d.getElementById('msg').textContent, /more than one card/);
    });
  }

  // ============ a cancelled confirmation writes nothing ===========================================================
  {
    const h = boot({ drives: DRIVES });
    await settle();
    const d = h.document;
    const lanes = h.api().getLanes();
    d.getElementById('dry').checked = false;
    fill(lanes[0], { dealership: 'Merchant Auto', ssid: 'Merchant-WiFi', pass: 'p1', code: 'K7QP-3M2R' });
    h.ctx.window.flasher.confirmBatch = async () => ({ ok: false, reason: 'cancelled' });
    d.getElementById('go').onclick();
    await settle();
    t('cancelling the batch dialog starts no writers', () => {
      assert.strictEqual(h.calls.flash.length, 0);
      assert.strictEqual(lanes[0].status, 'idle');
    });
  }

  // ============ rescanning mid-batch must not lose typed codes ====================================================
  {
    const h = boot({ drives: DRIVES });
    await settle();
    const lanes0 = h.api().getLanes();
    fill(lanes0[0], { dealership: 'Merchant Auto', ssid: 'Merchant-WiFi', pass: 'p1', code: 'K7QP-3M2R' });
    await h.api().scan();
    await settle();
    const lanes1 = h.api().getLanes();
    t('a rescan keeps codes already typed for cards that are still present', () => {
      assert.strictEqual(lanes1.length, 2);
      assert.strictEqual(lanes1[0].code, 'K7QP-3M2R');
      assert.strictEqual(lanes1[0].include, true);
    });
  }

  // ============ not-elevated is surfaced, because it silently kills concurrency ===================================
  {
    const h = boot({ drives: DRIVES, fleet: { elevated: false } });
    await settle();
    t('running unelevated is called out in the UI', () => {
      const hint = h.document.getElementById('concurrencyHint');
      assert.match(hint.textContent, /not running as Administrator/i);
    });
  }

  console.log(`ui-batch.test: ${pass} passed, ${fail.length} failed`);
  if (fail.length) { fail.forEach((f) => console.error('  FAIL: ' + f)); process.exit(1); }
})();
