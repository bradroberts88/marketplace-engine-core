# Remote repair, step tracking and instant alerts

Everything here is in the portable QConnect package. Run the SQL in order, copy
the device scripts onto the card image, and drop the app files into the fleet
dashboard.

## What you get

1. **A to-do list the box picks up.** Every check-in (5 minutes) the box asks
   the server what it should do. Restart, reboot, reconnect, switch to cable /
   Wi-Fi / mobile data, replace the Wi-Fi details, change the APN, send its
   logs, install a new version. Each instruction is recorded with who issued
   it, when the box collected it and what it answered.
2. **Self-update with a safety net.** The box only installs a bundle whose
   fingerprint matches and whose signature verifies against the key baked into
   its image. The previous version stays on the card. If the new one does not
   check in within 10 minutes, the box puts the old one back by itself.
3. **A strict checklist per card.** Pre-registering a card at the bench opens a
   run: powered on, internet up, tunnel up, registered, first check-in, first
   listing — each with a deadline. Nothing silently never happens any more.
4. **Five workers, once a minute.** Overdue steps, boxes gone quiet (20
   minutes), instructions never collected, updates that never reported healthy,
   and the email hand-off.
5. **Alerts on the dashboard and by email.** Repeats fold into one row and one
   email, so a flapping box cannot flood the inbox.

## Install order

```
supabase/01-schema-hardened.sql
supabase/02-admin-killswitch-audit.sql
supabase/03-token-hashing.sql
supabase/04-bench-tests.sql
supabase/05-connectivity.sql
supabase/06-commands-updates.sql     <- command queue, releases, rollouts
supabase/07-onboarding-steps.sql     <- checklist per card
supabase/08-alerts-workers.sql       <- alerts + the once-a-minute workers
```

All eight are idempotent and safe on a live fleet.

## Card image

Copy into `/opt/qconnect/`:

- `device/qconnect-steps.sh` — reports each step as it is cleared
- `device/qconnect-command-exec.sh` — drains the to-do list after each check-in
- `device/qconnect-agent-update.sh` — signed update plus automatic rollback

and the release public key to `/opt/qconnect/etc/qconnect-release.pub`. The
heartbeat calls the last two itself, so no new systemd unit is needed.

## Publishing a version

```
release/make-release.sh 2026.09.13-1 ~/keys/qconnect-release.key
```

Upload the bundle over HTTPS, then paste the address, fingerprint and signature
into the Releases screen and start a rollout — one box, one dealership, or a
percentage of the fleet. The percentage is a stable split, so the same boxes
stay in the first wave.

Keep the private key out of the repository. The public half belongs in the
golden image.

## Scheduling

The workers are scheduled by `pg_cron` as `qconnect-workers`, every minute.
The email leg is an app route; point a scheduler at it every minute with the
shared cron secret:

```
POST https://<your-app>/api/public/qconnect-alert-emails
x-cron-secret: <LOVABLE_CRON_SECRET>
```

Set `QCONNECT_ALERT_EMAIL` to the address alerts should go to. Email needs a
sending domain you own; until that is verified the dashboard still shows every
alert and only the email is skipped.

## Deadlines

| Step | Must be cleared within |
| --- | --- |
| Powered on | 10 minutes |
| Internet up | 15 minutes |
| Tunnel up | 20 minutes |
| Registered | 25 minutes |
| First check-in | 30 minutes |
| First listing posted | 24 hours (not required for a pass) |

Change them in `qconnect_step_defs`; new runs pick the new values up.

## Safety rules kept intact

- A disabled box gets no instructions and no updates — the kill switch outranks
  every queue.
- Instructions are only accepted from the fixed list; anything else is reported
  back as unsupported rather than run.
- A bundle with a bad signature is refused and reported, never installed.
- Dealership staff can read their own boxes' alerts, steps and instructions;
  only admins can issue anything.
