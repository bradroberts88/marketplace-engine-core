# Handoff — installing this package into QConnect Fleet Manager

This folder is the finished, tested package. It cannot be installed from the
Marketplace Engine project: from here the Fleet Manager project is readable
only. Open **QConnect Fleet Manager** and the work continues there.

What already exists in Fleet Manager (checked at commit `f3b7b049`):

- Screens: `fleet.index`, `fleet.$deviceId`, `alerts`, `activity`, `dealers`,
  an auth gate and an app shell. The existing `alerts` screen computes health
  warnings in the browser; this package adds the server-raised alert inbox
  (`qconnect_alerts`) behind it.
- Seven applied migrations covering the original fleet schema and the
  August security hardening (group roles, audit view, admin kill switch).

Compatibility is verified, not assumed: the exact seven Fleet Manager
migrations (all fifteen, re-checked at commit `83bdec4e`, including the
September realtime-broadcast and provisioning work) were applied to a
throwaway Postgres, then `install-all.sql` (scripts 01–10) was
run twice and both smoke suites passed with zero errors. The install carries
Fleet Manager's history forward instead of breaking it:

- The legacy `qconnect_audit` **view** is replaced by the real audit table;
  the legacy columns (`at`, `actor_role`, `dealer_id`) exist on the table so
  the current Activity screen keeps working, and every row of the old
  `qconnect_audit_log` is copied across.
- The kill switch keeps Fleet Manager's group boundary: `admin` toggles any
  box, `group_admin` toggles only its own group's boxes, everything is
  audited.
- The old 4-argument `qconnect_register` is removed so only the
  connection-aware signature remains.

## Step 1 — Sending domain

Done. Alert emails send from `notify.automarketplaceengine.com` (verified) and
land at `support@quantumconnectai.com`. Note this is a new sending domain —
deliverability improves over the first 2–4 weeks.

## Step 2 — Database

Apply `qconnect/supabase/install-all.sql` as a single migration. It is the
files `01`–`09` concatenated in order, and every one of them is idempotent, so
it is safe over the existing Fleet Manager schema.

It adds: hardened fleet schema, admin kill switch with an audit log, device
token hashing, the bench test definitions including the AT&T cellular phase,
connectivity attempt tracking, the command and release/rollout tables, the
per-card onboarding step tracker, and the alert tables plus the background
workers and their `pg_cron` schedule.

## Step 3 — Verify against the live database

Run `qconnect/supabase/_test/smoke.sql` and `smoke-ops.sql` against the live
database. Expected: 47 bench steps total, 17 of them in phase 8, all ops
checks green, and the worker time gate returning false outside 07:00–20:00
America/Denver.

## Step 4 — Screens

Copy in from `qconnect/app/`:

- `routes/_authenticated/bench.tsx` — new page. It opens with the live batch
  tracker: one row per card with cable, Wi-Fi and AT&T SIM shown as pass or
  "fail — plain-words reason", filled in by the cards themselves as they
  report. It mirrors the paper sheet in `docs/PI-BATCH-TRACKER.md`.
- `routes/_authenticated/releases.tsx` — new page.
- `routes/_authenticated/keys.tsx` — new page: one remote-access key per card,
  how long each has left, and an admin-only button to retire one.
- `lib/qconnect.functions.ts`, `lib/qconnect-ops.functions.ts` — server
  functions behind them.

Then extend the two screens Fleet Manager already has: add the bench timeline
and the connection-attempt history to `fleet.$deviceId`, and the connection
type / signal / SIM columns to `fleet.index`. Keep the existing `AppShell`
and `StatusDot`; add the two new pages to the shell's navigation with the
unread alert badge.

## Step 5 — Email dispatcher

The dispatcher lives in Marketplace Engine, not Fleet Manager: the
`device-alert` email template and the route
`/api/public/qconnect/device-alert` are built, tested and branded there. The
route is locked with a shared secret (`QCONNECT_ALERT_SECRET`, already set in
Marketplace Engine).

In Fleet Manager: set a `QCONNECT_ALERT_SECRET` secret with a fresh value,
then update the same-named secret in Marketplace Engine to match (values are
never displayed, so generate in one place and copy into the other at creation
time). The alerter worker POSTs each pending alert as JSON
(`alertId`, `deviceId`, `alertType`, `severity`, `message`, optional
`detail`/`occurredAt`) to
`https://gain-craft-flow.lovable.app/api/public/qconnect/device-alert` with
`Authorization: Bearer <secret>`, and marks the alert emailed on a 200. The
send is deduplicated per `alertId`, so a retry cannot double-send. Alerts keep
appearing on the dashboard regardless of email. Send one test alert to confirm
it lands.

## Step 6 — Automatic pre-registration

Ship `qconnect/flash/provision-sd.sh` as the only way to prepare a card. It
calls `qconnect_preregister` directly and exits non-zero if registration
fails, so an unregistered card can no longer be flashed by accident. Only the
hash of the device token is stored.

## Step 7 — Bench

Hand `qconnect/docs/BENCH-RUNBOOK.md` to whoever is at the bench. Each phase
in it maps to a step on the Bench page.

## Worth knowing

- Workers run every 30 minutes and only between 07:00 and 20:00 Mountain time,
  every day. The window is checked inside the worker against `America/Denver`,
  so daylight saving is handled. An overnight fault surfaces at the 07:00 run.
- Nothing in this package touches the Marketplace Engine database.
