# Claim-code onboarding + DB-backed identity (scaling slice)

**Goal:** turn dealership onboarding from *hand-built* (a per-dealership tunnel process + an nginx route + a
hand-written `config.json` + a `.cmd` to place it — what Idaho needed) into **self-serve**: the operator creates
a dealership and gets a short code; the dealership types that code into the app once and it configures itself.

This is the highest-leverage scaling slice — it removes the manual step that does not scale.

## What changed

Dealership identity used to live in `config.dealerships[]` (static, restart-to-change — a restart drops every
*other* dealership's live agent). It now lives in a hot **`DealershipStore`** (a JSON file), so dealerships are
added / rotated / revoked **live, with no restart and no impact on anyone else**.

| Piece | File | Role |
|---|---|---|
| Identity store | `server/src/dealership-store.js` | create / claim / resolve / list / rotate / reissue / revoke; atomic JSON persistence |
| Public claim endpoint | `server/src/claim-server.js` | `POST /claim {code}` → the agent's config, one-time; `GET /health`; per-IP + global rate limits |
| Admin management | `server/src/admin-api.js` | `POST/GET /admin/dealerships`, `…/rotate`, `…/reissue`, `…/revoke` (localhost, `x-admin-token`) |
| Wiring | `server/src/index.js` | control WS + proxy now resolve through the store; starts the claim server when `claimPort` is set |
| Agent claim client | `src/claim.js` | first-run: POST the code → write `config.json` (used by the app's first-run screen; also a CLI) |
| End-to-end test | `server/test-claim-flow.js` | spins up the real tunnel on loopback and drives the whole flow (17 checks) |

## The flow

1. **Operator** (super-admin dashboard → the tunnel's localhost admin API): create a dealership →
   `POST /admin/dealerships {name,city,state}` → returns a **claim code** (e.g. `K7QP-3M2R`, expires 24h) plus the
   **proxyAuth** the operator uses to point that rep's GoLogin at the tunnel.
2. **Dealership**: install the app, type the claim code on first run.
3. **App**: `POST https://…/claim {code}` → gets `{controlUrl, dealershipToken, dashboard, allowedPorts, …}` →
   writes `config.json` → connects. No hand-edited file, no per-dealership tunnel process.

## Security

- Claim code = 8 Crockford-base32 chars (~40 bits), **one-time**, **expiring**, behind **per-IP + global rate
  limits** (a single source is capped, so it can neither brute-force nor alone exhaust onboarding). `agentToken`
  = 24 random bytes.
- The public `/claim` response carries **only** what the agent needs — never `proxyAuth` or the admin token — and
  it includes the same `allowedHostSuffixes` allowlist a hand-configured agent gets.
- Fail-closed is preserved: a bad / rotated / revoked token is rejected at the control WS (`4001`), and rotate /
  revoke **force-disconnect a live agent immediately** (drop the socket + in-flight streams) so a stolen token
  stops egressing at once, not just at the next reconnect.
- A legacy `config.dealerships[]` is imported once (marked already-claimed) so existing configs keep working.

## Verified

`node server/test-claim-flow.js` → **17/17 pass**: create → claim → connect, plus wrong-token reject, re-claim
(409), bogus code (404), rotate (old dead / new live), per-IP rate limit (429), revoke (token dead). All loopback,
zero VPS/production dependency.

## Not yet done (next steps to make it live)

- **Deploy:** an nginx route `/claim` → `127.0.0.1:<claimPort>` (same TLS pattern as the control route), and set
  `claimPort` + `publicControlUrl` in the tunnel config. **Not deployed** — this is scaling-repo code only.
- **App first-run screen:** an electron first-run UI that calls `src/claim.js` (a "enter your setup code" box)
  instead of the manual `Configure-AutoPost.cmd`.
- **Super-admin dashboard:** a "New dealership" button that calls `POST /admin/dealerships` and shows the code.
