# QConnect zero-touch — hand-off package

Everything needed to run the QConnect fleet in the **QConnect Fleet Manager** project. This folder is
self-contained and deliberately not wired into this repository's app: copy it across, run the SQL in
order, and drop the two screens into `src/`.

Source material: the uploaded `qconnect-zero-touch` kit, plus the fixes required by
`docs/SECURITY-REVIEW.md` and `docs/BENCH-TEST-CHECKLIST.md`.

## Layout

```
qconnect/
  supabase/01-schema-hardened.sql      devices table, RLS, preregister/register/heartbeat RPCs
  supabase/02-admin-killswitch-audit.sql  admin-only on/off switch, audit trail, scoped fleet views
  supabase/03-token-hashing.sql        store only a SHA-256 fingerprint of each device token
  supabase/04-bench-tests.sql          bench runs + the 7-phase checklist, with the go/no-go rule
  supabase/05-connectivity.sql         connection path / fault columns, fleet health verdict, bench phase 8
  supabase/06-commands-updates.sql     two-way instruction queue, signed releases and rollouts
  supabase/07-onboarding-steps.sql     strict per-card checklist with deadlines
  supabase/08-alerts-workers.sql       alerts plus the five once-a-minute background workers
  app/lib/qconnect.functions.ts        -> src/lib/qconnect.functions.ts
  app/lib/qconnect-ops.functions.ts    -> src/lib/qconnect-ops.functions.ts
  app/lib/email-templates/qconnect-alert.tsx  -> src/lib/email-templates/
  app/routes/_authenticated/alerts.tsx    -> src/routes/_authenticated/alerts.tsx
  app/routes/_authenticated/releases.tsx  -> src/routes/_authenticated/releases.tsx
  app/routes/api/public/qconnect-alert-emails.ts -> src/routes/api/public/
  release/make-release.sh              builds and signs an agent bundle
  app/routes/_authenticated/fleet.tsx  -> src/routes/_authenticated/fleet.tsx
  app/routes/_authenticated/bench.tsx  -> src/routes/_authenticated/bench.tsx
  device/qconnect-netmanager.sh        cable -> Wi-Fi -> cellular -> hotspot, with real-internet checks
  device/, boot-payload/, flash/       the rest of the card-side scripts
  docs/CONNECTIVITY.md                 how a box gets online, and what to do when it does not
  docs/REMOTE-OPS.md                   remote repair, step tracking, self-update and alerts
  docs/                                the security review and bench checklist, as markdown
```

## Order of operations

1. Run `supabase/01` … `08` in the SQL editor, in that order. Each file is idempotent and safe to
   re-run.
2. Make yourself an admin (the on/off switch and the bench screens require it):
   ```sql
   update auth.users
      set raw_app_meta_data = coalesce(raw_app_meta_data,'{}'::jsonb) || '{"role":"admin"}'::jsonb
    where email = 'you@example.com';
   ```
   Sign out and back in so the new token carries the claim. For dealership staff, set
   `{"dealer_id":"their-dealer-id"}` instead — they then see only their own boxes.
3. Copy the app files into `src/` and add links to `/fleet`, `/bench`, `/alerts` and `/releases` in
    your navigation. For alert emails, set `QCONNECT_ALERT_EMAIL` and point a scheduler at
    `/api/public/qconnect-alert-emails` every 30 minutes — see `docs/REMOTE-OPS.md`.
    The workers themselves run every 30 minutes between 7am and 8pm Mountain time.
4. Flash a card with `flash/provision-sd.sh` (it pre-registers the device itself now) and work
   through the bench screen. See `docs/CONNECTIVITY.md` for the connection options.

## What changed versus the uploaded kit

| Review finding | State |
|---|---|
| 1 — offline view readable with the public key | Already fixed in the kit; `02` re-applies the same lock to the new fleet view |
| 2 — open self-registration | Already fixed in the kit: registration requires a preregistered row |
| 3 — stolen card exposes the Tailscale key | Already fixed in the kit: the key is redacted from disk after the first join |
| 4 — anyone signed in could flip the kill switch | **Fixed in `02`**: admin claim checked inside the RPC, every action written to `qconnect_audit` |
| 5 — device tokens stored in plaintext | **Fixed in `03`**: only a SHA-256 fingerprint is stored; no device-side change needed |

Beyond the review, the card-side scripts were rebuilt to fix the "identical cards, different outcome"
failures catalogued in `../docs/PI-CONNECT-FAILURE-ANALYSIS.md`: automatic pre-registration, one
Tailscale key per card, the correct boot mountpoint for the first-run hook, `RequiresMountsFor=` on
every unit that tests a file on a mounted partition, a hard NetworkManager check at install time, and
a connection manager that falls back between cable, Wi-Fi, AT&T cellular (APN `broadband` by default)
and hotspot and reports why it failed.

Two things the review calls out that software cannot fix for you, both in `docs/SECURITY-REVIEW.md`:
create Tailscale keys as `tag:qconnect` with a 90-day expiry and ACLs that cage those nodes, and
rotate the batch key when a device is reported stolen.

## Verified

`supabase/_test/run-local-tests.sh` runs all eight files against a throwaway local Postgres — twice
each, to prove they can be re-run safely — then two smoke tests. Last run: everything passed on
13/09/2026.

- token stored only as a fingerprint, plaintext column empty
- wrong token rejected; unknown device rejected
- correct token registers and heartbeats
- non-admin blocked from the kill switch
- fleet and offline views return nothing to an unscoped user, everything to an admin
- kill switch writes an audit row with the actor's email
- a disabled box is told `enabled=false` on its next check-in
- a bench run seeds all 47 steps (including the connectivity and cellular/AT&T phases); open or failed steps
  give `no_go`, a clean sweep gives `go`
- a heartbeat carrying connection path, signal and fault lands in real columns; the fleet view turns
  them into one health verdict, and a recovered box clears its own fault
- AT&T SIM cards are the cellular default: APN falls back to `broadband`, with `m2m.com.attz` and
  `att.mvno` selectable at the bench or from the rescue portal

All card-side shell scripts pass `bash -n` and the captive portal passes a Python syntax check. They
have not been run on physical hardware in this environment.

## Not yet done

No card has been through the bench test — the checklist is recorded, not passed. Phases 1, 2 and 4
clean, zero corruption in phase 3, and a clean burn-in are the gate before batch production.
- a pre-registered card opens a full checklist; reporting a later step back-fills the earlier ones
- an instruction can be issued by an admin, collected by the box and acknowledged; unknown
  instructions are refused and a disabled box is handed no work at all
- a box silent for an hour raises exactly one alert no matter how often the worker runs, and its next
  check-in clears it
- required steps past their deadline alert; the optional "first listing" step does not
- a rollout aimed at one dealership reaches its boxes, and stopping it withdraws the offer
- an update that never reports healthy is failed and alerted, and each alert is queued for exactly
  one email

## Installing into QConnect Fleet Manager

- `supabase/install-all.sql` — files 01–09 concatenated in order, idempotent, apply as one migration.
- `docs/HANDOFF-FLEET-MANAGER.md` — the seven install steps, written against Fleet Manager's
  existing screens and migrations.
- `docs/BENCH-RUNBOOK.md` — printable per-card runbook: prep, wireless, Ethernet, AT&T cellular,
  remote-fix proof, go/no-go.
