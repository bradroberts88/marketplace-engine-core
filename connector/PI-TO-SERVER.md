# Pi → server: how a device actually connects

The full path from a freshly flashed Raspberry Pi to a rep's traffic leaving the dealership's own
line, and how to prove it works before any hardware is involved.

## The journey

```text
  1. Super-admin mints a dealership   -> POST /admin/dealerships     (returns a one-time claim code)
  2. VA flashes a card                -> claim code injected into autopost-claim.env on the boot partition
  3. Pi first boot                    -> autopost-claim.service runs src/claim.js
                                         POST /claim {code}  ->  config.json (controlUrl + dealershipToken)
  4. autopost-connector.service       -> src/agent.js dials OUT: WSS to controlUrl, x-agent-token header
  5. Hub marks the dealership LIVE    -> heartbeat every 20 s, server pings every 15 s
  6. Rep's browser profile            -> HTTP CONNECT to the proxy with the dealership's proxy user/pass
  7. Proxy checks liveness            -> LIVE: relay bytes over the WS to the agent, which opens the
                                         connection locally, so egress = the dealership's IP
                                      -> NOT LIVE: HTTP 503, no fallback, ever
```

Nothing at the dealership needs an inbound port, a static IP, or a firewall change: the agent always
dials out.

## What crosses each boundary

| Value | Who issues it | Where it lives | Ever on the device? |
|---|---|---|---|
| Claim code | Admin API, one-time | Boot partition at flash time | Yes, consumed once |
| `dealershipToken` | Claim response | `config.json` (0600, fsynced, `.bak` seeded) | Yes |
| `controlUrl` | Claim response | `config.json` | Yes |
| Proxy user/password | Admin API | Server + the rep's browser profile | **No** — deliberately withheld from the claim response |
| Admin token | Operator config | VPS only, admin API bound to localhost | No |

## Prove it end to end — `npm run e2e:pi`

```bash
cd connector
npm install          # once, for ws
npm run e2e:pi
```

`e2e-pi.js` runs the real server, the real claim client and the real agent on ephemeral loopback
ports with a throwaway store, in the same order as the journey above. It needs outbound internet for
step 6 and touches nothing in production.

Verified run:

```text
[1] booting the real tunnel server                  PASS
[2] minting a dealership + one-time claim code      PASS
[3] redeeming the code with the real claim client   PASS  (config.json written, .bak seeded,
                                                           proxy password never reached the device)
[4] starting the real agent from that config only
[5] waiting for the agent to register LIVE          PASS
[6] real HTTPS request through the proxy            PASS  exit IP == this machine's own public IP
[7] killing the agent                               PASS  hub marks it down; proxy answers 503, no reroute
[8] restarting the agent from the on-disk config    PASS  reconnects, no re-claim

ALL CHECKS PASSED — 12 passed, 0 failed
```

Step 6 is the one that matters: the tunnelled request reports the **same** public IP as a direct
request from the same machine. That is the whole product claim, measured rather than asserted.

Step 7 is the safety claim: with the agent dead the proxy refuses. There is no second route.

### Options

| Variable | Purpose |
|---|---|
| `E2E_IP_HOST` | Echo host used for the egress check (default `api.ipify.org`) |

## Related suites

| Command | Covers |
|---|---|
| `node server/test-claim-flow.js` | Every claim rejection path, token rotate/revoke, forced disconnect |
| `node test-local.js` | Shorter loopback smoke test with hand-written configs |
| `npm run flasher:test` | Never-flash-the-wrong-drive predicates and boot-file injection |
| `tools/RUN-TESTS.cmd` | All pure-Node suites in one go |

## Going against a real VPS instead of loopback

1. On the VPS: `cd connector/server && cp config.example.json config.json`, set `publicControlUrl`
   to the `wss://` address reps' agents will dial, and keep `adminPort` bound to localhost.
2. Mint the dealership over an SSH tunnel to the admin port, not over the public internet.
3. Flash a card with that claim code (see `deploy/pi/PROVISIONING-GUIDE.md`).
4. Boot the Pi, then confirm from the VPS: `curl -H "x-admin-token: …" localhost:<adminPort>/admin/status`
   lists the dealership, and the Pi's local dashboard shows the tunnel up with its public IP.

## When it does not connect

| Symptom | Cause | Fix |
|---|---|---|
| Claim service exits `setup code was not accepted: already_claimed` | Card re-flashed with a used code | Mint a fresh code; codes are strictly one-shot |
| Agent logs `connecting…` then closes 4001 | Token rotated or revoked server-side | Re-claim the device with a new code |
| Agent never reaches the server | Device on the wrong WiFi | `AutoPost-Setup` captive page or BLE rescue — see `deploy/pi/WIFI-RESCUE.md` |
| Proxy returns 503 while the Pi looks online | Heartbeat older than `heartbeatTimeoutMs` | Check the Pi's uplink; this is fail-closed working as designed |
| Proxy returns 407 | Wrong rep proxy credentials | Re-read them from the admin API; they never live on the device |

## Reporting device status to the hub

Separately from the tunnel control channel, a unit reports its health to the Marketplace Engine hub
so the fleet is visible without SSH:

```
POST /api/public/device-heartbeat
{
  "deviceToken": "<64-hex, injected at flash time>",
  "status": "online",
  "agentVersion": "0.1.0",
  "publicIp": "203.0.113.9",
  "latencyMs": 42,
  "event": { "type": "claim", "severity": "info", "message": "first boot claim" }
}
```

The token is stored hub-side only as a SHA-256 hash; the plain value is shown once, when the device
is registered. Responses: `200 {ok, deviceId, receivedAt}`, `400 invalid_payload`,
`401 unknown_device`, `403 device_retired`. Each call refreshes the device row and appends an
immutable row to its event history.
