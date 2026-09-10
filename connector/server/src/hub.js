'use strict';

/*
 * Hub — the shared state between the WS control server (talks to dealership agents) and the HTTP CONNECT
 * proxy (talks to GoLogin/rep clients). It owns:
 *   - the agent registry (one live control connection per dealership) + liveness,
 *   - the open tunnel streams (proxy client <-> agent), keyed by a server-assigned id.
 *
 * FAIL-CLOSED is enforced here: the proxy asks isLive()/openStream() before opening anything (both re-check
 * heartbeat staleness), and whenever an agent connection is replaced OR drops, EVERY stream riding it is
 * destroyed immediately — a replaced/dead agent's far sockets are gone, so its client sockets must be dropped,
 * never left hanging. There is NO fallback path to any other egress.
 *
 * Wire protocol (must match ../../src/agent.js exactly):
 *   server -> agent : {type:'open', id, host, port} | {type:'data', id, b64} | {type:'close', id}
 *   agent  -> server: {type:'hello'|'heartbeat', ...} | {type:'opened', id} | {type:'data', id, b64} | {type:'close', id, error?}
 */

const WS_OPEN = 1; // ws.readyState === OPEN (avoid importing ws here)

// Human outage duration — seconds under 90s (so a 15s blip is not rounded up to "1m"), else minutes/hours.
function fmtDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

class Hub {
  constructor({ heartbeatTimeoutMs = 60000, maxStreamsPerDealership = 256, maxEvents = 500, offlineGraceMs = 45000, alertOnRootfsWritable = false, onAlert = () => {}, log = () => {}, agentConfig = { plannedReconnectMs: 120000 } } = {}) {
    this.agents = new Map();   // dealershipId -> { ws, lastSeen, connectedAt, host, version }
    this.streams = new Map();  // streamId -> { dealershipId, clientSocket, established, onOpened, onFailed }
    this.events = new Map();   // dealershipId -> [{ ts, kind, detail }] (rolling, for the super-admin log view)
    this.pausedIds = new Set(); // dealershipIds the super-admin turned OFF (egress fail-closed, agent stays connected)
    this.offlineTimers = new Map(); // dealershipId -> pending "offline" alert timer (grace window, see removeAgent)
    // POST-MORTEM STATE (why did a device go offline?) — a PERSISTENT per-device record that OUTLIVES the live
    // agent entry (which removeAgent deletes). It holds the last vitals we saw + when the box dropped, so the
    // super-admin can see a device's last-known temp/power/uptime WHILE it is still offline, and — on reconnect —
    // a plain-English verdict of whether it REBOOTED (power cut) or just lost its link (dealership internet/WiFi).
    this.lastKnown = new Map(); // dealershipId -> { host, version, telemetry, telemetryAt, connectedAt, offlineAt, lastReason, recovery }
    this.nextId = 1;
    // Floor the timeout so it can never dip below ~2x the heartbeat/ping cadence (15-20s) and flap healthy
    // agents to "down" (over-refusal). It only ever fails CLOSED, never open.
    this.heartbeatTimeoutMs = Math.max(40000, heartbeatTimeoutMs);
    this.maxStreamsPerDealership = Math.max(1, maxStreamsPerDealership);
    this.maxEvents = maxEvents;
    // A brief disconnect that RECONNECTS within this grace window is NOT alerted — it's the agent's proactive
    // pre-cap link refresh (or a momentary network blip), not a real outage. Egress still fails CLOSED during the
    // gap (safety unchanged); we just don't spam "offline" for a sub-second reconnect. A genuine outage (no
    // reconnect within the grace) still alerts.
    this.offlineGraceMs = Math.max(0, offlineGraceMs);
    // Page when a Pi reports a WRITABLE rootfs? Off until the read-only overlay actually ships — see the
    // 'rootfs' alert in _checkTelemetryAlerts for why it is otherwise a permanent per-device false positive.
    this.alertOnRootfsWritable = !!alertOnRootfsWritable;
    // Tuning knobs pushed to EVERY agent on (re)connect so they survive an agent restart. plannedReconnectMs=120s
    // (was the agent default 240s) keeps the control link young enough that a post always finishes before the
    // ~600s dealership-network middlebox cut — the root cause of the recurring tunnel SESSION_LOST. Env-overridable.
    this.agentConfig = agentConfig && typeof agentConfig === 'object'
      ? { ...agentConfig, ...(process.env.HUB_AGENT_PLANNED_RECONNECT_MS ? { plannedReconnectMs: parseInt(process.env.HUB_AGENT_PLANNED_RECONNECT_MS, 10) } : {}) }
      : { plannedReconnectMs: 120000 };
    this.onAlert = onAlert;    // (kind, dealershipId, message) -> notify (email/webhook/platform)
    this.log = log;
  }

  // Rolling per-dealership event log (surfaced to the super-admin platform via the admin API).
  // Alert on FIELD health drift (undervoltage / overheating / low disk) — the things that kill a shipped Pi
  // slowly. De-duped: alert once per condition until it clears, so it never spams. telemetry = { throttled,
  // tempC, diskFreeMb, memFreeMb, uptimeS, rssMb } sent by the agent's heartbeat.
  _checkTelemetryAlerts(dealershipId, t) {
    if (!t || typeof t !== 'object') return;
    const a = this.agents.get(dealershipId); if (!a) return;
    // De-dupe + accumulator state MUST live on the PERSISTENT per-device record, never on the live agent entry:
    // registerAgent() builds a brand-new agent object on every (re)connect (it carries over only host/version),
    // and the agent refreshes its control link every ~2 min BY DESIGN. State parked on `a` was therefore wiped
    // every couple of minutes, which silently defeated both guarantees below. On 2026-08-17 one device re-fired
    // the same rootfs alert ~30 times in 100 minutes — enough to bury a real alert behind the noise.
    const lk = this._lk(dealershipId);
    lk.alerted = lk.alerted || {};
    const fire = (key, on, msg) => {
      if (on && !lk.alerted[key]) { lk.alerted[key] = true; this.recordEvent(dealershipId, 'health-alert', msg); try { this.onAlert('device-health', dealershipId, msg); } catch (_) { /* ignore */ } }
      else if (!on) lk.alerted[key] = false;
    };
    // throttled bit0/bit16 = undervoltage now/since-boot; bit2/bit18 = throttled; bit3 = soft temp limit.
    // OR-ACCUMULATE the word so a brownout-induced reboot (which clears the "now" bits) can't erase its own
    // evidence — which only actually holds now that the accumulator outlives the reconnect that used to reset it.
    const th = Number(t.throttled) || 0;
    lk.throttledAccum = (lk.throttledAccum || 0) | th;
    fire('undervolt', (lk.throttledAccum & 0x10001) !== 0, `Pi UNDERVOLTAGE (get_throttled accumulated=0x${lk.throttledAccum.toString(16)}) — the dealership's PSU/cable is failing. It will crash/corrupt. Ship a replacement 27W PSU.`);
    fire('throttle', (th & 0x4) !== 0, `Pi is THROTTLING (get_throttled=0x${th.toString(16)}) — overheating or undervolt. Check the fan / ventilation.`);
    fire('hot', Number(t.tempC) >= 82, `Pi running HOT (${t.tempC}C) — cooling is failing; it will throttle then shut down.`);
    fire('disk', Number(t.diskFreeMb) > 0 && Number(t.diskFreeMb) < 300, `Pi disk nearly FULL (${t.diskFreeMb}MB free) — logs not rotating; it will wedge.`);
    // Post-ship durability drift: the corruption-safe overlay was lost, or the SD remounted read-only.
    // OFF BY DEFAULT, because it is not drift on the current fleet — it is the shipping configuration. The v1
    // golden image deliberately leaves the rootfs WRITABLE (see deploy/pi/golden/customize-stock-image.sh: the
    // read-only overlay is a certified follow-up), so on every v1 Pi this condition is true from first boot and
    // can never clear. Firing it fleet-wide means a permanent alert per device that carries no information.
    // Turn it on (alertOnRootfsWritable: true) once the overlay actually ships, at which point a writable rootfs
    // IS drift and is worth paging about.
    fire('rootfs', this.alertOnRootfsWritable && t.rootfsOverlay === false, `Pi rootfs is WRITABLE (overlay lost/never enabled) — a power cut can now corrupt this device. Re-image or re-enable overlay.`);
    fire('storage', t.dataWritable === false, `Pi STORAGE FAILED — the data partition is not writable (SD likely remounted read-only). The device will wedge; plan a swap.`);
  }

  recordEvent(dealershipId, kind, detail) {
    let arr = this.events.get(dealershipId);
    if (!arr) { arr = []; this.events.set(dealershipId, arr); }
    arr.push({ ts: Date.now(), kind, detail: detail || '' });
    if (arr.length > this.maxEvents) arr.splice(0, arr.length - this.maxEvents);
    this.log(`[${dealershipId}] ${kind}${detail ? ' — ' + detail : ''}`);
  }

  getEvents(dealershipId, limit = 200) {
    return (this.events.get(dealershipId) || []).slice(-limit);
  }

  // Get-or-create the persistent post-mortem record for a device (survives disconnect; see this.lastKnown).
  _lk(dealershipId) {
    let r = this.lastKnown.get(dealershipId);
    if (!r) { r = {}; this.lastKnown.set(dealershipId, r); }
    return r;
  }

  // Fold every fresh telemetry sample into BOTH the live agent entry and the persistent last-known record, then
  // (if the device is returning from an outage) work out WHY it was offline. Called for hello + heartbeat.
  // Fully guarded: this now runs on EVERY heartbeat inside the (un-try/catch'd) control-channel message handler, so
  // a throw here would crash the hub and fail-closed EVERY live stream fleet-wide. It must never throw.
  _ingestTelemetry(dealershipId, a, telemetry) {
    try {
      a.telemetry = telemetry; a.telemetryAt = Date.now();
      const lk = this._lk(dealershipId);
      lk.telemetry = telemetry; lk.telemetryAt = Date.now();
      lk.host = a.host || lk.host; lk.version = a.version || lk.version; lk.connectedAt = a.connectedAt || lk.connectedAt;
      this._maybeDiagnoseRecovery(dealershipId, telemetry);
    } catch (e) { try { this.log(`telemetry ingest error [${dealershipId}]: ${e && e.message}`); } catch (_) { /* never let logging throw either */ } }
  }

  // Record that WE just asked this agent to restart (remote restart / update / config apply). Such a restart leaves
  // the OS uptime unchanged, exactly like a pure link drop — so without this flag _maybeDiagnoseRecovery would
  // wrongly blame the dealership ISP for a restart the operator triggered. Consumed once on the next recovery.
  _markPlannedRestart(dealershipId) { try { this._lk(dealershipId).plannedRestartAt = Date.now(); } catch (_) { /* ignore */ } }

  // POST-MORTEM: the box just sent telemetry after having been offline. Compare the outage length against the
  // device's CURRENT uptime to tell a REBOOT (power cut / unplug — uptime resets near zero) from the box staying
  // POWERED (uptime spans the outage: a dealership link drop, OR a software restart of the connector). We do NOT
  // over-accuse the ISP: a restart/update/config WE sent, or the agent's own self-heal, also leaves uptime intact.
  // Records at most one 'recovered' event, and only for outages that crossed the same grace the offline ALERT uses
  // (shorter = a self-healed blip = noise). Additive only — never touches egress/streams; must never throw.
  _maybeDiagnoseRecovery(dealershipId, t) {
    const lk = this._lk(dealershipId);
    if (!lk.offlineAt) return;                 // wasn't offline (fresh boot or already diagnosed)
    const downMs = Date.now() - lk.offlineAt;
    lk.offlineAt = null;                       // consume so we diagnose an outage exactly once
    const planned = lk.plannedRestartAt && (Date.now() - lk.plannedRestartAt) < (downMs + 120000);
    lk.plannedRestartAt = null;
    if (downMs < 8000) return;                 // sub-8s = the agent's planned pre-cap link refresh — never a real event
    const upMs = (Number(t && t.uptimeS) || 0) * 1000;
    const uptimeKnown = upMs > 0;
    const th = Number(t && t.throttled) || 0;
    const uvSinceBoot = (th & 0x10001) !== 0;  // bit0 undervolt now | bit16 undervolt since boot
    const rebooted = uptimeKnown && upMs < downMs + 60000; // uptime shorter than the outage (+1min slack) => it rebooted
    const dur = fmtDur(downMs);
    let reason;
    if (rebooted) {
      // A confirmed reboot is always meaningful (power event) — record it regardless of the outage length.
      reason = uvSinceBoot
        ? `Recovered after ${dur} offline — the box REBOOTED and reports UNDERVOLTAGE since boot (get_throttled=0x${th.toString(16)}). Its power supply or USB-C cable is failing; ship an official 27W PSU.`
        : `Recovered after ${dur} offline — the box REBOOTED (uptime ${fmtDur(upMs)} < the ${dur} outage). It lost power (unplugged / power cut) or was restarted.`;
    } else if (planned) {
      reason = `Recovered after ${dur} offline — the connector software restarted (after a restart / update / config you pushed). The box stayed powered; this is expected.`;
    } else if (downMs < this.offlineGraceMs) {
      return;                                  // 8-45s, not a reboot, not a known restart = self-healed blip = noise
    } else if (!uptimeKnown) {
      reason = `Recovered after ${dur} offline — cause could not be determined (the connector did not report its uptime). Check whether the box lost power or the dealership internet dropped.`;
    } else {
      reason = `Recovered after ${dur} offline — the box stayed POWERED (no reboot). Most likely the dealership internet / WiFi dropped, or the connector restarted itself (update / self-heal). If it repeats, check the router / WiFi / ISP.`;
    }
    lk.lastReason = reason;
    lk.recovery = { at: Date.now(), downMs, upMs, rebooted, planned: !!planned, uptimeKnown, undervoltSinceBoot: uvSinceBoot };
    this.recordEvent(dealershipId, 'recovered', reason);
  }

  // Persistent last-known record for EVERY device ever seen (connected or not) — the source for showing a
  // disconnected device's last vitals + why it went offline. The tunnel server folds this into /admin/status.
  getLastKnown() {
    const out = [];
    for (const [id, lk] of this.lastKnown) {
      out.push({
        dealershipId: id, host: lk.host || null, version: lk.version || null,
        telemetry: lk.telemetry || null, telemetryAt: lk.telemetryAt || null,
        connectedAt: lk.connectedAt || null, offlineAt: lk.offlineAt || null,
        reason: lk.lastReason || null, recovery: lk.recovery || null,
      });
    }
    return out;
  }

  listAgents() {
    const out = [];
    for (const [id, a] of this.agents) {
      out.push({ dealershipId: id, live: this.isLive(id), paused: this.isPaused(id), host: a.host || null, version: a.version || null, connectedAt: a.connectedAt || null, lastSeen: a.lastSeen, streams: this.countStreams(id), telemetry: a.telemetry || null, telemetryAt: a.telemetryAt || null, selftest: a.selftest || null, selftestAt: a.selftestAt || null });
    }
    return out;
  }

  // Super-admin ON/OFF switch. Pause = fail-closed egress OFF for this dealership: the agent stays connected
  // (so it can be turned back ON remotely), but the proxy refuses new streams AND every in-flight stream is
  // dropped so egress stops immediately. Resume clears it. Returns the new paused state.
  setPaused(dealershipId, on) {
    const was = this.pausedIds.has(dealershipId);
    if (on) {
      this.pausedIds.add(dealershipId);
      if (!was) {
        const killed = this._dropStreams(dealershipId);
        this.recordEvent(dealershipId, 'paused', `turned OFF by super-admin${killed ? `, ${killed} stream(s) dropped` : ''}`);
      }
    } else {
      this.pausedIds.delete(dealershipId);
      if (was) this.recordEvent(dealershipId, 'resumed', 'turned ON by super-admin');
    }
    // Tell the agent so its local dashboard reflects On/Off (best-effort; the egress gate above is authoritative).
    const a = this.agents.get(dealershipId);
    if (a) this._send(a.ws, { type: 'paused', on: this.pausedIds.has(dealershipId) });
    return this.pausedIds.has(dealershipId);
  }

  isPaused(dealershipId) {
    return this.pausedIds.has(dealershipId);
  }

  // Super-admin/operator remote restart: ask the agent to relaunch (its Windows service starts a fresh one).
  restartAgent(dealershipId, reason) {
    const a = this.agents.get(dealershipId);
    if (!a || a.ws.readyState !== WS_OPEN) return false;
    this._send(a.ws, { type: 'restart', reason: reason || 'operator' });
    this._markPlannedRestart(dealershipId); // so the ensuing reconnect is not misdiagnosed as an ISP outage
    this.recordEvent(dealershipId, 'restart-sent', reason || 'operator');
    return true;
  }

  // Super-admin SET WIFI: push the dealership's WiFi creds down the control channel; the agent applies them via
  // nmcli (polkit-authorized) and keeps the old WiFi as a fallback, so the box auto-joins when the network is in
  // range. This is the onboarding flow — creds typed in super-admin, no per-device terminal.
  // MULTI-NETWORK: a box can hold several WiFi networks (dealership WiFi + a phone hotspot) and auto-fail-over
  // between them. action 'set' adds/updates WITHOUT removing the others; 'prefer' switches to one; 'remove' drops it.
  // priority: higher wins when both are in range.
  setWifi(dealershipId, ssid, password, { action = 'set', priority = 10, hidden = false, enterpriseUser = '' } = {}) {
    const a = this.agents.get(dealershipId);
    if (!a || a.ws.readyState !== WS_OPEN) return false;
    this._send(a.ws, { type: 'wifi', ssid, password, action, priority, hidden, enterpriseUser });
    const tags = [action === 'set' ? `priority ${priority}` : null, hidden ? 'hidden' : null, enterpriseUser ? 'enterprise' : null].filter(Boolean).join(', ');
    this.recordEvent(dealershipId, 'wifi-' + action, `ssid ${ssid}${tags ? ` (${tags})` : ''}`); // creds are NOT logged, only the SSID
    return true;
  }

  // Super-admin REMOTE UPDATE: push a new agent build (already SHA-256'd by the admin API) INLINE over the
  // authenticated control channel. The agent verifies the hash + compiles it before swapping its own code, so a
  // bad push cannot brick the machine. Returns false if the agent is not currently connected.
  updateAgent(dealershipId, payload) {
    const a = this.agents.get(dealershipId);
    if (!a || a.ws.readyState !== WS_OPEN) return false;
    this._send(a.ws, { type: 'update', version: payload.version || null, sha256: payload.sha256, sigB64: payload.sigB64, codeB64: payload.codeB64 });
    this._markPlannedRestart(dealershipId);
    this.recordEvent(dealershipId, 'update-sent', `version ${payload.version || '?'} (${payload.bytes || '?'} bytes)`);
    return true;
  }

  // Push a signed build of a whitelisted NON-agent file (dashboard.js …). The agent verifies signature +
  // syntax-checks + fail-closed-backs-up + swaps + restarts, same guarantees as updateAgent.
  updateAgentFile(dealershipId, payload) {
    const a = this.agents.get(dealershipId);
    if (!a || a.ws.readyState !== WS_OPEN) return false;
    this._send(a.ws, { type: 'update-file', filename: payload.filename, sha256: payload.sha256, sigB64: payload.sigB64, codeB64: payload.codeB64 });
    this._markPlannedRestart(dealershipId);
    this.recordEvent(dealershipId, 'update-file-sent', `${payload.filename} (${payload.bytes || '?'} bytes)`);
    return true;
  }

  // Super-admin REMOTE CONFIG: push a whitelisted config patch (the agent ignores anything but its tuning knobs).
  pushConfig(dealershipId, config) {
    const a = this.agents.get(dealershipId);
    if (!a || a.ws.readyState !== WS_OPEN) return false;
    this._send(a.ws, { type: 'config', config: config || {} });
    this._markPlannedRestart(dealershipId); // an operator config push may restart the agent to apply — not an outage
    this.recordEvent(dealershipId, 'config-sent', Object.keys(config || {}).join(',') || '(none)');
    return true;
  }

  // Force-evict a dealership's LIVE control connection and drop its streams — used by revoke/rotate so a removed
  // or rotated token takes effect IMMEDIATELY, not just at the agent's next reconnect. The agent token is only
  // checked once (at WS connect), and a hostile agent ignores the cooperative 'restart', so a stolen token could
  // otherwise keep egressing indefinitely. A server-side ws.close() cannot be ignored. Fails closed: streams are
  // dropped even if the socket is already gone. (The later 'close' event no-ops past removeAgent's identity guard
  // because we delete the registry entry first.)
  disconnectAgent(dealershipId, reason = 'revoked') {
    const killed = this._dropStreams(dealershipId);
    const a = this.agents.get(dealershipId);
    if (a) {
      this.agents.delete(dealershipId);
      try { a.ws.close(4001, reason); } catch (_) { /* ignore */ }
    }
    if (a || killed) this.recordEvent(dealershipId, 'force-disconnect', `${reason}${killed ? `, ${killed} stream(s) dropped` : ''}`);
    return { hadAgent: !!a, killed };
  }

  _dropStreams(dealershipId) {
    let killed = 0;
    for (const [id, s] of this.streams) {
      if (s.dealershipId === dealershipId) {
        try { s.clientSocket.destroy(); } catch (_) { /* ignore */ }
        this.streams.delete(id);
        killed += 1;
      }
    }
    return killed;
  }

  registerAgent(dealershipId, ws) {
    const prev = this.agents.get(dealershipId);
    if (prev && prev.ws !== ws) {
      // Replacing an agent connection (reconnect after a half-open death): the OLD connection's far sockets
      // are dead, so fail its streams closed BEFORE swapping in the new one — otherwise they orphan and the
      // client hangs (and the old ws's late 'close' would no-op past removeAgent's identity guard).
      // SECURITY: a replace while the previous agent was STILL LIVE (fresh heartbeat) is the fingerprint of a
      // stolen-token takeover — surface it loudly so the operator can investigate an unexpected one.
      if (Date.now() - prev.lastSeen < this.heartbeatTimeoutMs) {
        this.recordEvent(dealershipId, 'security-alert', 'agent replaced while still live — possible stolen-token takeover');
        try { this.onAlert('security', dealershipId, 'Connector was replaced while still live — possible stolen-token takeover. Investigate; rotate the token if unexpected.'); } catch (_) { /* ignore */ }
      }
      const dropped = this._dropStreams(dealershipId);
      try { prev.ws.close(4000, 'replaced'); } catch (_) { /* ignore */ }
      if (dropped) this.log(`agent REPLACED: ${dealershipId} — dropped ${dropped} orphaned stream(s)`);
      // The old link died without a clean 'close' (half-open reconnect), so removeAgent never stamped the outage.
      // Stamp it here from the last time we heard from the old socket, so the ensuing hello can still diagnose why
      // it dropped. (A trivially-fast reconnect just yields a sub-grace downMs and is correctly ignored.)
      this._lk(dealershipId).offlineAt = prev.lastSeen || Date.now();
    }
    this.agents.set(dealershipId, { ws, lastSeen: Date.now(), connectedAt: Date.now(), host: (prev && prev.host) || null, version: (prev && prev.version) || null });
    // Reconnected within the grace window -> cancel the pending "offline" alert (it was a refresh/blip, not an outage).
    const pending = this.offlineTimers.get(dealershipId);
    if (pending) { clearTimeout(pending); this.offlineTimers.delete(dealershipId); }
    this.recordEvent(dealershipId, 'connected', '');
    // Push the tuning config on EVERY connect so it survives an agent restart (plannedReconnectMs=120s keeps
    // the link young → posts finish before the ~600s middlebox cut; the agent ignores anything but its hot keys).
    if (this.agentConfig && Object.keys(this.agentConfig).length) {
      this._send(ws, { type: 'config', config: this.agentConfig });
      this.recordEvent(dealershipId, 'config-sent', Object.keys(this.agentConfig).join(',') + ' (on-connect)');
    }
    // If this dealership is currently turned OFF, tell the (re)connecting agent so its dashboard shows paused.
    if (this.pausedIds.has(dealershipId)) this._send(ws, { type: 'paused', on: true });
  }

  touchAgent(dealershipId) {
    const a = this.agents.get(dealershipId);
    if (a) a.lastSeen = Date.now();
  }

  // Only remove if THIS ws is still the registered one (guards the reconnect race where a new connection
  // already replaced the old, and the old socket's late 'close' must NOT tear down the new one's streams).
  removeAgent(dealershipId, ws, closeInfo = {}) {
    const a = this.agents.get(dealershipId);
    if (!a || a.ws !== ws) return;
    // Did the AGENT close this link on purpose (its pre-cap refresh), or did it just die? A clean 1000 carrying
    // the 'planned-refresh' reason is the agent telling us it is coming straight back — worth distinguishing,
    // because the refresh may now close with streams still open (it forces one before the ~600s cap rather than
    // letting the middlebox sever the link), and that must not page as an outage every couple of minutes.
    // NOT a trust decision: streams below still fail CLOSED either way, and a "planned" close that does NOT
    // reconnect still alerts via the grace timer. All this suppresses is the instant page.
    const planned = closeInfo && closeInfo.code === 1000 && /planned-refresh/.test(closeInfo.reason || '');
    this.agents.delete(dealershipId);
    // POST-MORTEM: stamp the moment it dropped + freeze the last vitals we saw, so the super-admin can read a
    // still-offline device's last temp/power/uptime and _maybeDiagnoseRecovery can size the outage on reconnect.
    const lk = this._lk(dealershipId);
    lk.offlineAt = Date.now();
    lk.host = a.host || lk.host; lk.version = a.version || lk.version;
    if (a.telemetry) { lk.telemetry = a.telemetry; lk.telemetryAt = a.telemetryAt || lk.telemetryAt; }
    lk.connectedAt = a.connectedAt || lk.connectedAt;
    const killed = this._dropStreams(dealershipId);
    // Say WHICH kind of drop this was in the event log. The 2026-08-17 log read `failed closed, 8 live stream(s)
    // dropped` for both the agent's own refresh and the middlebox severing the link, which made a real recurring
    // outage look identical to routine housekeeping.
    this.recordEvent(dealershipId, 'disconnected', `${planned ? 'planned link refresh' : 'failed closed'}${killed ? `, ${killed} live stream(s) dropped` : ''}`);
    // GRACE: don't alert immediately. The agent refreshes its link proactively (before a ~10min network cap) and
    // may briefly drop + reconnect; alerting on that is noise. Fire the "offline" alert only if it is STILL down
    // after offlineGraceMs (a genuine outage). registerAgent cancels this timer on reconnect. Egress is fail-closed
    // throughout the gap regardless. If a live post stream WAS dropped, alert now (that is a real interruption).
    const fire = () => {
      this.offlineTimers.delete(dealershipId);
      if (this.isLive(dealershipId)) return; // reconnected -> not an outage
      try { this.onAlert('offline', dealershipId, `Connector went offline. Posting for this dealership is paused until it reconnects.`); } catch (_) { /* ignore */ }
    };
    if ((killed > 0 && !planned) || this.offlineGraceMs === 0) {
      try { this.onAlert('offline', dealershipId, `Connector went offline${killed ? ` (${killed} active session(s) dropped)` : ''}. Posting for this dealership is paused until it reconnects.`); } catch (_) { /* ignore */ }
      return;
    }
    const prev = this.offlineTimers.get(dealershipId);
    if (prev) clearTimeout(prev);
    const t = setTimeout(fire, this.offlineGraceMs);
    if (t.unref) t.unref();
    this.offlineTimers.set(dealershipId, t);
  }

  isLive(dealershipId) {
    const a = this.agents.get(dealershipId);
    if (!a) return false;
    if (!a.ws || a.ws.readyState !== WS_OPEN) return false;
    if (Date.now() - a.lastSeen > this.heartbeatTimeoutMs) return false;
    return true;
  }

  countStreams(dealershipId) {
    let n = 0;
    for (const s of this.streams.values()) if (s.dealershipId === dealershipId) n += 1;
    return n;
  }

  // Proxy asks to tunnel to host:port for a dealership. Returns a streamId, or null (=> the proxy refuses)
  // when the agent is gone/stale or the per-dealership stream cap is hit. Re-checks staleness itself so it is
  // fail-closed independent of the caller.
  openStream(dealershipId, host, port, clientSocket, { onOpened, onFailed }) {
    if (this.pausedIds.has(dealershipId)) return null; // super-admin turned this dealership OFF => fail closed
    const a = this.agents.get(dealershipId);
    if (!a || a.ws.readyState !== WS_OPEN) return null;
    if (Date.now() - a.lastSeen > this.heartbeatTimeoutMs) return null;
    if (this.countStreams(dealershipId) >= this.maxStreamsPerDealership) return null;
    const id = String(this.nextId++);
    this.streams.set(id, { dealershipId, clientSocket, established: false, onOpened, onFailed });
    this._send(a.ws, { type: 'open', id, host, port });
    return id;
  }

  // DATA-PLANE SELF-TEST: open a REAL test stream to Facebook through this dealership's agent and resolve whether
  // the far socket actually establishes. This is how the watchdog catches a WEDGED agent — one whose control
  // channel is healthy (live=true) but that can no longer open outbound sockets (the 2026-07-13 failure that took
  // Roger's tunnel down for hours with no error). A no-op sink stands in for a rep browser; we relay zero bytes
  // and close the instant the far socket opens. Target MUST be Facebook — the agent's own allow-list refuses
  // anything else, so a non-FB probe would false-fail.
  // Target is geo.myip.link (NOT Facebook): it is on the agent's ALWAYS_ALLOW_EXACT list so a Facebook-only
  // allow-list never false-fails it, AND probing a non-FB host means an FB-side IP block (which a restart can't
  // fix) is not mistaken for a wedge. timeoutMs is set ABOVE the agent's own 20s connect timeout (tunnel.js) so a
  // slow-but-working open is not clipped to a false wedge. Returns {ok} on establish, {ok:false,wedged:true} on a
  // genuine far-socket failure, or {ok:false,skip:true} when the agent is not-live/paused/at-cap (NOT a wedge).
  // WEDGE PROBE — must target the host the reps ACTUALLY use. It probed geo.myip.link until 2026-07-15, which
  // let a real wedge hide: Roger's agent opened geo.myip.link fine ("established" => watchdog saw healthy) while
  // www.facebook.com returned 000 for hours, so the auto-restart never fired and his reps silently couldn't post.
  // Probing Facebook itself makes the probe as strong as reality (facebook.com is in the agent's host allowlist).
  selfTest(dealershipId, host = process.env.HUB_SELFTEST_HOST || 'www.facebook.com', port = 443, timeoutMs = 25000) {
    return new Promise((resolve) => {
      let done = false; let id = null; let timer = null;
      const finish = (res) => {
        if (done) return; done = true;
        if (timer) clearTimeout(timer);
        if (id) { try { this.closeStream(id); } catch (_) { /* ignore */ } }
        resolve(res);
      };
      const sink = { write() {}, destroy() {}, end() {}, on() {}, once() {} }; // never relays bytes
      id = this.openStream(dealershipId, host, port, sink, {
        onOpened: () => finish({ ok: true, detail: 'established' }),
        onFailed: (e) => {
          const msg = String(e || '');
          // A POLICY refusal (agent paused via super-admin, off-allowlist, blocked/private target) is the agent
          // CORRECTLY refusing — NOT a wedge. Mark it skip so the watchdog treats it as inconclusive and never
          // restarts a merely-paused agent. Only a genuine connect failure is a wedge.
          const policy = /access paused|not allowed|blocked non-public|resolved to private|bad port/i.test(msg);
          finish(policy
            ? { ok: false, skip: true, detail: 'refused (policy): ' + msg.slice(0, 80) }
            : { ok: false, wedged: true, detail: 'far-socket open failed' + (e ? ': ' + msg.slice(0, 80) : '') });
        },
      });
      // openStream returns null when the agent is not live / paused / at the per-dealership stream cap — NONE of
      // which is a wedge, so mark it skip: the watchdog then treats it as inconclusive and never restarts.
      if (!id) return finish({ ok: false, skip: true, detail: 'agent not live / paused / at stream cap' });
      timer = setTimeout(() => finish({ ok: false, wedged: true, detail: 'timeout after ' + timeoutMs + 'ms' }), timeoutMs);
    });
  }

  sendData(id, buf) {
    const s = this.streams.get(id);
    if (!s) return;
    const a = this.agents.get(s.dealershipId);
    if (!a) return;
    this._send(a.ws, { type: 'data', id, b64: buf.toString('base64') });
  }

  // Drop a stream. tellAgent=true also asks the agent to close its far socket (client-initiated close).
  closeStream(id, tellAgent = true) {
    const s = this.streams.get(id);
    if (!s) return;
    this.streams.delete(id);
    if (tellAgent) {
      const a = this.agents.get(s.dealershipId);
      if (a) this._send(a.ws, { type: 'close', id });
    }
  }

  // Route one message received from a dealership's agent.
  onAgentMessage(dealershipId, msg) {
    if (!msg || typeof msg.type !== 'string') return;
    switch (msg.type) {
      case 'hello': {
        this.touchAgent(dealershipId);
        const a = this.agents.get(dealershipId);
        if (a) {
          a.host = msg.host || a.host; a.version = msg.version || a.version;
          if (msg.telemetry) this._ingestTelemetry(dealershipId, a, msg.telemetry);
          if (msg.selftest) { a.selftest = msg.selftest; a.selftestAt = Date.now();
            this.recordEvent(dealershipId, msg.selftest.pass ? 'selftest-pass' : 'selftest-fail', `${msg.selftest.ok || '?'}/${msg.selftest.total || '?'} ok, ${msg.selftest.criticalFails || 0} critical fail(s)`); }
        }
        return;
      }
      case 'heartbeat': {
        this.touchAgent(dealershipId);
        const a = this.agents.get(dealershipId);
        if (a && msg.telemetry) { this._ingestTelemetry(dealershipId, a, msg.telemetry); this._checkTelemetryAlerts(dealershipId, msg.telemetry); }
        return;
      }
      // On-demand burn-in / self-test report (Pi runs selftest.sh, agent forwards the JSON result).
      case 'selftest': {
        const a = this.agents.get(dealershipId);
        if (a && msg.result) { a.selftest = msg.result; a.selftestAt = Date.now();
          this.recordEvent(dealershipId, msg.result.pass ? 'selftest-pass' : 'selftest-fail', `${msg.result.ok || '?'}/${msg.result.total || '?'} ok, ${msg.result.criticalFails || 0} critical fail(s)`); }
        return;
      }
      case 'update-result':
        // recordEvent already logs `[id] update-applied — version …` / `update-failed — …` to the console, so a
        // push is not a black box (a no-op push from an agent too old to have onUpdate simply produces NO
        // update-result, which is itself the tell). Failures additionally fire an alert.
        this.recordEvent(dealershipId, msg.ok ? 'update-applied' : 'update-failed', msg.ok ? `version ${msg.version || '?'}` : String(msg.reason || 'unknown'));
        if (!msg.ok) { try { this.onAlert('update', dealershipId, `Remote update was REJECTED by the connector (${msg.reason || 'unknown'}). It kept its current version.`); } catch (_) { /* ignore */ } }
        return;
      case 'update-file-result':
        this.recordEvent(dealershipId, msg.ok ? 'update-file-applied' : 'update-file-failed', `${msg.filename || '?'}${msg.ok ? '' : ' ' + (msg.reason || 'unknown')}`);
        if (!msg.ok) { try { this.onAlert('update', dealershipId, `Remote file update (${msg.filename || '?'}) was REJECTED (${msg.reason || 'unknown'}). It kept the current file.`); } catch (_) { /* ignore */ } }
        return;
      case 'config-result':
        this.recordEvent(dealershipId, msg.ok ? 'config-applied' : 'config-failed', msg.ok ? (msg.applied || []).join(',') : String(msg.reason || 'unknown'));
        return;
      case 'opened': {
        const s = this.streams.get(msg.id);
        if (s && s.dealershipId === dealershipId && !s.established) {
          s.established = true;
          if (s.onOpened) { try { s.onOpened(); } catch (_) { /* ignore */ } }
        }
        return;
      }
      case 'data': {
        const s = this.streams.get(msg.id);
        if (s && s.dealershipId === dealershipId && s.established) {
          try { s.clientSocket.write(Buffer.from(String(msg.b64 || ''), 'base64')); } catch (_) { /* ignore */ }
        }
        return;
      }
      case 'close': {
        const s = this.streams.get(msg.id);
        if (!s || s.dealershipId !== dealershipId) return;
        this.streams.delete(msg.id);
        if (!s.established && s.onFailed) {
          if (msg.error) this.log(`[${dealershipId}] far-socket open failed: ${String(msg.error).slice(0, 120)}`);
          try { s.onFailed(msg.error); } catch (_) { /* ignore */ }
        }
        else { try { s.clientSocket.end(); } catch (_) { /* ignore */ } } // graceful half-close preserves the final bytes
        return;
      }
      default:
    }
  }

  _send(ws, obj) {
    try { if (ws && ws.readyState === WS_OPEN) ws.send(JSON.stringify(obj)); } catch (_) { /* dropped; liveness handles it */ }
  }
}

module.exports = { Hub };
