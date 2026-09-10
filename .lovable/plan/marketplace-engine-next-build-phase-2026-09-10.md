# Marketplace Engine — next build phase

Six asks, grouped by what I can finish here and what needs your machine.

## 1. Design documents as PDFs
Generate `Marketplace-Engine-Technical-Design.pdf` and `Marketplace-Engine-Software-Design.pdf`
from the existing markdown, styled with a cover page, section numbering, page headers/footers and
a table of contents. Saved into the repo under `docs/pdf/` and also delivered as downloadable
attachments in chat. Each page is rendered to an image and visually checked before delivery.

## 2. Golden image README — release links
Update `connector/deploy/pi/golden/README.md` with:
- a link to the published `autpost-golden` release
- direct, versioned download links for `autopost-golden.img.xz` (Pi 4 class, arm64) and
  `autopost-golden-zerow.img.xz` (Pi Zero W, armhf)
- the published SHA256 for each, plus the verify command a VA runs before flashing

## 3. Running the golden image build — what is actually possible
The bake cannot run here. It needs a Linux host with root, loop devices, ARM binfmt emulation and
a ~1.2 GB stock Raspberry Pi OS image; it runs 12–90 minutes. This environment has none of those
and caps commands at 10 minutes.

What I will do instead:
- run every build script through a syntax + logic check
- dry-run the parts that do not need root
- write `connector/deploy/pi/golden/BUILD-RUNBOOK.md`: the exact copy-paste command sequence for
  WSL2 Ubuntu, expected output at each step, timings, disk needs, and the failure messages you are
  likely to hit with the fix for each

You run the runbook on your Windows box; it produces the `.img.xz`. I cannot certify it for you.

## 4. Build status dashboard
Replace the placeholder home page with a real dashboard page showing the latest golden image
build: release tag, published date, both assets with size, SHA256 (click to copy) and download
button, plus a build-status banner. Data comes from the public GitHub releases API for
`bradroberts88/marketplace-engine-core`, fetched server-side and cached, so no token is needed and
the hashes are always whatever the release actually holds.

## 5. Agent and flasher — connect a Pi to the server
The agent (`connector/src/agent.js`), tunnel (`tunnel.js`), claim client (`claim.js`) and the
tunnel server (`connector/server/`) already exist and pair with each other. Rather than rewrite
them, I will close the gaps that stop a real Pi from connecting:
- a single `npm run e2e:pi` harness that starts the server, runs an agent as a Pi would, claims a
  code, opens a proxied request and proves egress plus fail-closed 503
- fix whatever that harness surfaces
- a one-page `connector/PI-TO-SERVER.md` describing the wire-up: server URL, claim code, expected
  log lines, and how to tell a claim failure from a WiFi failure

## 6. Server database and API
Needs a backend, so this turns on Lovable Cloud (Postgres + auth + server functions, no external
account). Schema:
- `dealerships` — the tenant, one per site
- `devices` — one row per Pi/desktop: claim state, last heartbeat, public IP, version, online flag
- `listings` — marketplace listings: vehicle fields, price, status, posted/expiry timestamps
- `payments` — amount in cents, currency, provider reference, status, period covered
- `device_events` — append-only heartbeat/claim/update/error log

Every table gets row-level security scoped to the signed-in operator, explicit grants, and typed
server functions for read/write. Device heartbeat ingest lands on a public endpoint that verifies
the device token before writing.

## Technical notes
- PDFs: ReportLab Platypus, DejaVu Sans registered for full Unicode, `docs/pdf/` output.
- Dashboard: TanStack Start route with a `createServerFn` GitHub fetch, React Query, shadcn cards.
- Cloud tables: `CREATE TABLE` → `GRANT` → `ENABLE RLS` → policies, in that order, one migration.
- Payments here is a records table only — no payment provider is wired up in this phase.

## Order of work
1 and 2 first (fast, self-contained), then 4, then 3's runbook, then 5, then 6 last since it
changes the backend.
