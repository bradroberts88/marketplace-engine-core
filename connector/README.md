# Dealership Connector (Phase 1 — ISOLATED, not production)

> **Status: scaffold / in development. NOT wired into the production stack and NOT deployed anywhere.**
> This folder is completely standalone — it does not import from `../production` and the running VPS
> knows nothing about it yet. Safe to build + iterate without touching the live system.

## What it is
A small Windows program installed on **one always-on PC at a dealership**. It lets the cloud automation
post that dealership's cars to Facebook **through the dealership's own internet connection** (their real,
local, trusted IP) instead of a shared residential-proxy pool.

## Why (the whole point)
Shared proxy-pool IPs are dirty, drift to the wrong city, and get flagged — which is what triggers
Facebook's captcha walls and account lockouts. The dealership's own connection is clean, local, stable,
and trusted (it's a real business). See the decision doc: `../../.claude/plans/harmonic-doodling-clarke.md`.

## How it works (architecture)
```
  VPS worker (GoLogin session for rep)                     Dealership PC
  ─────────────────────────────────────                   ─────────────────────────
  rep's FB traffic ─► proxy endpoint  ══ WSS control ══►  connector agent ─► Facebook
                     (per dealership)   (agent dials OUT)  (egress = dealership IP)
```
1. The agent runs as a **Windows service** (auto-start, always-on) and **dials OUT** to the VPS control
   server over an encrypted WebSocket — so there is **no inbound port-forward / firewall change** at the
   dealership (works behind their NAT).
2. The VPS assigns this dealership's reps a proxy endpoint that **tunnels through this agent**; the agent
   opens the outbound connection to Facebook locally, so the traffic **egresses from the dealership's IP**.
3. **Heartbeat** every ~20s so the VPS knows the agent is alive (and pauses that dealership's posting if it
   goes offline — never post through a dead tunnel).
4. **Remote config**: the agent pulls per-dealership settings from the VPS (enable/disable, allowed hours,
   throttle) so behavior is tuned centrally, no reinstall.
5. **Silent auto-update**: the agent checks the VPS for a newer signed build and self-updates — the
   dealership never has to do anything.

## Safeguards (baked in)
- **LAN isolation**: the tunnel REFUSES private/RFC1918/loopback/link-local destinations — it can only reach
  public hosts (Facebook). The VPS can never reach the dealership's internal network through the agent.
- **Token auth**: each dealership has a unique agent token; the control channel is rejected without it.
- **Poisoning mitigations** (we ride the dealership's MAIN IP — operator decision): reps keep distinct
  GoLogin fingerprints, rep accounts stay OFF the dealership's Business Manager, volume stays low + varied.
  The egress is config-swappable to a dedicated 4G modem later with no rearchitecture (escape hatch).

## VPS-side counterpart (to build later, separately from production until tested)
- A control server (WSS) that authenticates agents by dealership token and multiplexes rep streams to them.
- A per-dealership proxy endpoint the GoLogin session points at (replaces the NodeMaven string).
- A config endpoint + a signed update feed.
- Health: mark a dealership's reps un-postable while its agent is offline.

## Layout
- `src/agent.js`   — the connector agent (control channel, heartbeat, config, auto-update, egress).
- `src/tunnel.js`  — the data-plane: open/relay TCP streams to public targets (LAN-isolation guard).
- `config.example.json` — copy to `config.json` and fill in the VPS URL + dealership token.
- `package.json`   — isolated deps (no link to ../production).
- `install/install-connector.ps1` — admin PowerShell installer: registers the `DealershipConnector` scheduled task (at boot, hidden, SYSTEM, restart-on-failure). Requires Node.js LTS installed for all users and a filled-in `config.json`.
- `install/run-agent.cmd` — supervisor loop the task launches; relaunches `src/agent.js` 5s after any exit.
- `install/uninstall-connector.ps1` — removes the task and stops any running agent.
- `scripts/sign-build.js` — signs an agent build with the operator's Ed25519 private key and writes a detached `<build>.sig`. Upload the build **and** the `.sig`; the agent verifies against the public key pinned in `src/agent.js` (`UPDATE_PUBKEY_PEM`) before applying a remote update. Key path comes from `$AUTOPOST_SIGNING_KEY` (default `%USERPROFILE%/.autopost-signing/...`) and must never be copied to the VPS.

## Run (dev, once implemented)
```
cd desktop-connector
npm install
cp config.example.json config.json   # fill in controlUrl + dealershipToken
npm start                             # runs the agent in the foreground for testing
```
Packaging to a single `.exe` + Windows-service install come after the data-plane + VPS side are proven.

## Server (VPS side)
`server/` holds the tunnel server this agent dials into: control WS, fail-closed CONNECT proxy,
claim-code onboarding, hot dealership store and a localhost admin API. See `server/README.md`.
End-to-end claim test: `cd server && npm install && node test-claim-flow.js` (21/21 passing).

## Packaging assets (`build/`)

- `build/icon.png` — 256x256 app icon used by `package.json` (`build.win.icon`) and `electron-builder-flasher.json`.
- `build/installer.nsh` — NSIS hooks. On install it runs `Install-KeepAlive.ps1` as the installing user (no admin); on uninstall it runs `Uninstall-KeepAlive.ps1`.

Known mismatch to resolve before the first real build: the installer script and `package.json`'s `files` list expect the supervisor at `resources/app/supervisor/`, but the scripts currently live in `connector/keep-alive/`. Either rename the folder to `supervisor/` or update both references.
