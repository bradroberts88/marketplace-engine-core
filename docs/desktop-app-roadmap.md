# AutoPost Desktop App — Roadmap to 1,000 Clients

Scope: the **desktop app** a dealership installs (the tray app + tunnel agent). Server/control-plane scaling
(HA, browser farm, DB) lives in the main plan; this doc is only the app on the dealership's PC.

## The theme
Three things break when you go from 3 installs to 1,000:
1. **You can't hand-configure installs** → onboarding must be self-serve (a code, not a file).
2. **You can't manually update or watch 1,000 machines** → signed auto-update + a fleet view are mandatory.
3. **An unsigned / inefficient / weakly-secured app multiplies every problem by 1,000** → trust + hardening.

Everything below serves one of those.

## Done (shipped this build cycle)
- [x] Electron tray app: per-user install (no admin), single-instance lock, auto-start at login, X-to-tray
- [x] Unsigned NSIS installer built in GitHub Actions CI
- [x] Claim-code onboarding **backend** (identity store + one-time claim endpoint + admin create/rotate/revoke) — 21/21 tested, adversarially reviewed
- [x] Agent-side claim client (`src/claim.js`) — redeems a code, writes its own `config.json`
- [x] **Always-on supervisor** (scheduled-task keep-alive) — restarts the app within ~2 min of any crash/quit/reboot (verified live)
- [x] Pause/resume (super-admin On/Off), reconnect jitter, persistent login, resilient geo, fail-closed egress

---

## TODO — prioritized

### Phase 1 — Installable, self-serve, trusted  (blocks real dealership rollout)
- [ ] **First-run "enter setup code" screen** — the UI that calls `src/claim.js` so a dealership self-configures. Kills the manual `config.json` + `.cmd`. *(backend already done)*
- [ ] **NSIS installer wiring** — bundle the supervisor (`Install-KeepAlive.ps1`) on install; remove the task on uninstall; ship the first-run flow.
- [ ] **Code-signing** (Azure Trusted Signing or EV) → sign the installer + app in CI. Removes "Windows protected your PC" for every dealership. *(you procure the cert; I wire CI)*
- [ ] **Auto-update** — `electron-updater` + a signed release feed + your **force-after-2-days** policy. You publish once; all 1,000 update themselves. *(needs signing first)*

### Phase 2 — Operate the fleet  (managing 1,000 installs)
- [ ] **Fleet dashboard at scale** — DB-backed online/offline, version, last-seen, IP, and health for *every* dealership (extend the super-admin Connectors screen past the single-tunnel view).
- [ ] **Offline + health alerting** — wire the tunnel's `onAlert` → operator email/Slack + dashboard, so a down dealership pages you instead of you finding out from the dealer.
- [ ] **Fleet remote controls** — pause / resume / restart / rotate-token / revoke from the dashboard, plus **bulk actions** and search/filter across 1,000.
- [ ] **Version compliance + staged rollout** — see who's on old versions; roll an update to a canary % before the whole fleet (so a bad build can't brick everyone).
- [ ] **Remote diagnostics** — pull a dealership's connector log and run a connectivity/egress self-test from the dashboard, without calling them.

### Phase 3 — Harden + optimize at scale
- [ ] **Binary WS frames + backpressure** — replace the base64-over-JSON relay (~33% bandwidth waste + CPU per byte); at 1,000× residential relays this is real money and lag.
- [ ] **Tunnel-server capacity / sharding** — one process won't hold 1,000 live agents + their streams; plan horizontal sharding + connection limits.
- [ ] **Egress-verified health** — "Connected" ≠ "posting works." A periodic real-egress check (per the project's no-false-success rule) so a silently-broken tunnel is caught.
- [ ] **Keep-awake during business hours** — prevent sleep so the tunnel stays up while reps are active.
- [ ] **Crash reporting / telemetry** — know when installs are unhealthy across the fleet without contacting each dealer.
- [ ] **Config-secret hardening** — encrypt `config.json` at rest (Windows DPAPI); token-rotation UI + revoke-on-compromise *(rotate/revoke backend already done)*.
- [ ] **Uninstall cleanup** — NSIS uninstall removes the scheduled task + `%LOCALAPPDATA%\AutoPost` runtime dir.
- [ ] **Per-machine install option** — for dealerships where several people share one office PC (per-user install + per-user supervisor doesn't cover a shared login).

---

## Feature recommendations by area (why each matters at 1,000)

**Onboarding & provisioning** — self-serve is non-negotiable at scale.
- First-run setup-code screen (Phase 1) + a dashboard "New dealership → here's the code" button. One person can onboard dozens/day with zero file editing.

**Distribution & trust** — dealership IT won't run an unknown-publisher app 1,000 times.
- Code-signing (instant SmartScreen trust) + signed auto-update. This is the difference between "IT blocks it" and "it just installs."

**Reliability & always-on** — every hour an app is down is a dealership not posting.
- Supervisor (done) + keep-awake + egress-verified health + the agent's own self-heal-exit (done) all stack so a machine recovers itself.

**Fleet observability & control** — you cannot babysit 1,000 machines by hand.
- The fleet dashboard + alerting + bulk controls turn "call each dealer" into "one screen, filter to the 4 that are down, click restart."

**Security** — 1,000 tokens sitting on 1,000 dealership PCs is a real surface.
- Signed updates (no one can push a malicious build), token rotation/revoke, encrypted config at rest, and the agent's Facebook-only host allowlist (done) keep a single compromised PC from becoming an open relay.

**Performance & footprint** — small inefficiencies multiply by 1,000.
- Binary frames + backpressure + tunnel sharding keep bandwidth cost and latency sane as the fleet grows.

**Support & lifecycle** — reduce per-dealer touch to near zero.
- Remote diagnostics, clean uninstall, staged rollout, and telemetry mean support scales sub-linearly with client count.

---

## Suggested order
Phase 1 top-to-bottom first (it's what makes tomorrow's installs self-serve and trusted), then Phase 2 the moment
you pass ~20–30 live dealerships (that's when manual fleet-watching stops working), then Phase 3 as volume and
bandwidth cost climb. Signing + auto-update are the long pole because the cert takes days to obtain — **start that
clock now** even though the code work comes after.
