# Dealership Tunnel Server (test-mode)

> **Standalone. Does NOT import from `../../production` and is NOT wired into the VPS/pm2 stack.**
> This is the VPS-side counterpart to the connector agent in `../` (`desktop-connector/src/agent.js`).
> Proven end-to-end locally on 2026-07-04 (see the smoke test below).

## What it does
A rep's GoLogin session points its proxy (`custom_proxy = host:port:user:pass`) at this server's **fail-closed
HTTP CONNECT proxy**. For every request the server:
1. authenticates the proxy user + resolves which dealership it belongs to,
2. checks that dealership's **agent is LIVE**, and
3. if live, relays the byte stream over the WS control channel to the agent, which opens the connection to
   Facebook **locally** so the traffic egresses from the **dealership's own IP**.

If the agent is **not** live (never connected, heartbeat stale, or it dies mid-request), the proxy **REFUSES**
(HTTP 503) and never falls back to any other egress. That is the one hard guarantee: **no live tunnel = no
traffic.**

```
  rep's GoLogin session ──► proxy (HTTP CONNECT, :1080)          Dealership PC
   custom_proxy=127.0.0.1     │  fail-closed gate                ───────────────
   :1080:user:pass            ▼                                   connector agent
                        control server (WS, :8443) ◄══ agent dials OUT ══  src/agent.js
                                                                          └► Facebook (egress = dealership IP)
```

## Prove it on your own computer (one command, zero VPS)
From the `desktop-connector/` folder:
```
npm install          # installs `ws` (covers the agent and this server)
node test-local.js
```
It starts the server + agent locally, sends a real request through the proxy, and checks:
- **TEST 1** the exit IP is **your computer's own public IP** (traffic really went out through the agent), and
- **TEST 2** with the agent killed, the proxy **refuses** (fail-closed).

Expected tail: `=== SMOKE PASSED ===`.

## Run it manually
1. `cd desktop-connector/server && cp config.example.json config.json` and fill in a dealership `id`, a long
   random `agentToken`, and a `proxyAuth` user/pass. For a local test set `controlBindHost` to `127.0.0.1`.
2. Start the server: `npm start` (or `node src/index.js`). You get a control WS on `:controlPort` and the
   fail-closed proxy on `bindHost:proxyPort`.
3. Point the agent at it: in `desktop-connector/`, `cp config.example.json config.json`, set
   `controlUrl` to `ws://<server-host>:<controlPort>/agent` and `dealershipToken` to the same token, then
   `npm start`.
4. Point any client at the proxy as `bindHost:proxyPort:proxyUser:proxyPass`. For example, from `production/`:
   `node scripts/proxy-test.js "127.0.0.1:1080:<proxyUser>:<proxyPass>"` — it should report your own IP.

## Config
| key | meaning |
|---|---|
| `controlPort` | WS port the agent dials into. In prod this must be reachable by the remote dealership (put it behind TLS/cloudflared and use `wss://`). |
| `controlBindHost` | interface for the control WS. `127.0.0.1` for a fully-local test; `0.0.0.0` (behind a firewall) in prod. |
| `proxyPort` / `bindHost` | the fail-closed HTTP CONNECT proxy. Keep `bindHost` at `127.0.0.1` — in prod GoLogin runs on the SAME host, so localhost is correct and safe. |
| `heartbeatTimeoutMs` | an agent with no heartbeat/pong for longer than this is considered down (fail-closed). Default 60s; the server also pings every 15s. |
| `dealerships[]` | `{ id, agentToken, proxyAuth:{user,pass} }` per dealership. `agentToken` authenticates the agent; `proxyAuth` authenticates the rep's proxy client. |

## Test vs production topology
- **Local test (this):** server + agent + client all on your PC, everything on `127.0.0.1`.
- **Production:** this server runs on the VPS (proxy on `127.0.0.1` next to GoLogin; control WS reachable by the
  dealership behind TLS). The agent runs on an always-on PC at the dealership and dials OUT. Then a rep's
  `custom_proxy` is set to the local proxy endpoint. That wiring is a later step — this build is the isolated,
  provable core.
