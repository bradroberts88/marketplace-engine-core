# Worker schedule: every 30 minutes, 7am–8pm Mountain time

## What changes

The background workers (step watchdog, silence watchdog, command reaper, update watchdog, alert email dispatcher) currently run **every minute, around the clock**. They will instead run **every 30 minutes, only between 7:00 and 20:00 Mountain time, every day of the week**.

## How it works

- The scheduler (`pg_cron`) wakes the worker entry point every 30 minutes as today, but the cron pattern changes from `* * * * *` to `*/30 * * * *`.
- Inside `qconnect_run_workers()`, the first thing it does is check the current time in `America/Denver`. If the local hour is before 7 or at/after 20, it returns immediately with zero work done.
- Gating inside the function (rather than in the cron pattern) keeps the window correct through daylight-saving changes automatically, since `America/Denver` handles DST.

## Consequences to be aware of

- A box that goes silent at 8:05pm will not raise an alert until 7:00am the next morning; alerts during the day can take up to 30 minutes to appear (previously up to 1 minute).
- Email alerts are sent by the same worker, so overnight problems arrive in the morning batch rather than overnight.

## Files touched

- `qconnect/supabase/08-alerts-workers.sql` — change the cron pattern to `*/30 * * * *` and add the Mountain-time hour gate at the top of `qconnect_run_workers()`.
- `qconnect/supabase/_test/smoke-ops.sql` — add checks that the gate is a no-op outside the window and runs workers inside it (by calling the individual worker functions directly, which stay ungated).
- `qconnect/docs/REMOTE-OPS.md` and `qconnect/README.md` — update the documented cadence from "every minute" to "every 30 minutes, 7am–8pm Mountain".

## Verification

- Re-run the local throwaway-Postgres test suite (`qconnect/supabase/_test/run-local-tests.sh`) and confirm all existing smoke checks still pass plus the new window-gate checks.

## Technical details

- Gate expression: `extract(hour from now() at time zone 'America/Denver') between 7 and 19`.
- Cron pattern stored as `*/30 * * * *` under job name `qconnect-workers` (unschedule-then-reschedule stays idempotent).
