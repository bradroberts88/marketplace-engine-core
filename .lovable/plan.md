# QConnect Fleet Manager — live fleet, alerts and email

All of this gets built in your **QConnect Fleet Manager** project, not here. This project stays untouched. To start, open QConnect Fleet Manager and I'll pick up from this plan there.

Everything below already exists as a tested, portable package in the `qconnect/` folder of this project (database scripts, worker logic, device scripts, screen layouts). The work is installing it for real and finishing the parts that need a live database.

## What you'll get

**1. A real fleet dashboard**
- Fleet list: every card, whether it's online, how it's connected (wireless / Ethernet / cellular), last check-in, signal and SIM state.
- Card detail: its bench progress as a timeline with a tick or a cross on each step, its connection attempt history, and every admin action taken on it.
- Bench checklist page: the full phase-by-phase list including the AT&T cellular steps, with pass/fail you record as you go.
- Alerts page: live list with an unread badge, one-click acknowledge and resolve.
- Releases page: publish an update, roll it out to one card, one dealership or the whole fleet, and watch it land.

**2. Background workers that catch every problem**
Running every 30 minutes between 7:00 and 20:00 Mountain time, seven days a week (your earlier choice — kept as is):
- a step watchdog that flags any bench step that's overdue or failed,
- a silence watchdog that flags a card that stopped checking in,
- a command watchdog for instructions a card never picked up,
- an update watchdog for a self-update that didn't take,
- an alert dispatcher that groups repeats so one flapping card can't flood you.

Every heartbeat, bench step and admin action feeds these, and anything wrong becomes an alert on the dashboard.

**3. Automatic pre-registration (no manual SQL)**
Today the card-prep script only *prints* a line for you to paste — which is the single biggest reason some cards connect and some never can. This gets replaced: preparing a card calls the backend directly and registers it before it ever boots, and the prep script refuses to finish if registration didn't succeed. Each card gets its own one-time join secret instead of one shared key.

**4. Email alerts to you**
Failed bench steps, cards that go silent and admin actions get emailed the moment the alert opens, with a link straight to the card. This needs your domain set up as the sending address first — I'll walk you through that as the first step in the build, and the dashboard alerts work whether or not email is ready.

**5. A bench runbook for the batch of Pis**
I can't flash or plug in hardware, so you get a printable step-by-step: prep a card, boot it, then verify wireless, then Ethernet, then cellular on the AT&T SIM — with the exact expected result at each point and what to do when it doesn't match. Each step maps to a tick box on the bench page so the app tracks the whole batch for you.

## Order of work

1. Set up your sending domain.
2. Install the database: fleet tables, bench steps, commands and releases, alerts and workers, connectivity tracking.
3. Run the test suite against the live database and confirm every check passes.
4. Build the five screens.
5. Wire the email dispatcher and send a test alert to you.
6. Swap in automatic pre-registration and publish the runbook.

## Technical detail

- Scripts applied in order: `01-schema-hardened`, `02-admin-killswitch-audit`, `03-token-hashing`, `04-bench-tests`, `05-connectivity`, `06-commands-updates`, `07-onboarding-steps`, `08-alerts-workers`. All are idempotent and have been validated twice each locally.
- Workers run via `pg_cron` every 30 minutes; the time gate is evaluated inside the worker against `America/Denver` so daylight saving stays correct.
- Screens are TanStack Start routes under `_authenticated/`, reading through server functions with `requireSupabaseAuth`; admin-only actions re-check the admin role server-side.
- Email uses the managed send helper with a per-alert idempotency key so retries can't duplicate; the dispatcher drains `qconnect_pending_alert_emails` from a worker-triggered public route.
- Pre-registration moves from printed SQL to an authenticated call from `provision-sd.sh` against `qconnect_preregister`, storing only a hash of the device token.

## Known limits

- Alerts are batched: an overnight fault surfaces at the 7:00 run, and during the day an alert can take up to 30 minutes to appear. Say the word if you'd rather have instant alerts at higher database cost.
- Physical flashing, plugging in and SIM activation are yours to do; the app tracks the result.
