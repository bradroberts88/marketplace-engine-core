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

## Run (dev, once implemented)
```
cd desktop-connector
npm install
cp config.example.json config.json   # fill in controlUrl + dealershipToken
npm start                             # runs the agent in the foreground for testing
```
Packaging to a single `.exe` + Windows-service install come after the data-plane + VPS side are proven.
