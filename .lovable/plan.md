# Remote repair, step tracking, and instant alerts

Yes — a box can be fixed remotely, including replacing its own software. Today the boxes only report in; nothing can be sent back down to them. This plan adds a two-way channel, a strict step checklist for every box, background workers that watch those steps, and an alert the moment anything fails.

## 1. Two-way command channel

Each box already checks in every few minutes. That check-in starts returning a short to-do list:

- Restart a service, re-run setup, reboot
- Switch to cable, Wi-Fi, or cellular
- Replace saved Wi-Fi details or the cellular APN
- Install a new version of its own software

Every command is recorded with who issued it, when it was picked up, and what the box reported back, so there is a full history per box.

## 2. Self-update with safety net

- The server publishes a numbered software bundle plus a signature.
- The box refuses any bundle whose signature does not match — nothing unsigned is ever installed.
- Install goes into a new folder; the old version stays on disk.
- After install the box must prove it is still online and still checking in within a set window. If it cannot, it automatically reverts to the previous version and reports the failed update.
- Updates can be aimed at one box, a dealership, or the whole fleet, with a staged rollout (first a few boxes, then the rest) so a bad release cannot take everything down.

## 3. Strict step checklist per box

Every box gets a run with named steps: power on, network up, tunnel up, registered, first heartbeat, first listing posted. Each step has an expected time limit.

- The box reports each step as it passes.
- A step not reported inside its limit is marked overdue.
- A failed or overdue step marks the box as needing attention and raises an alert.
- The whole run is visible as a timeline on the box's page.

## 4. Background queue workers

Scheduled workers run on the server every minute:

- **Step watchdog** — finds overdue steps, marks them failed, raises alerts.
- **Silence watchdog** — flags boxes that stopped checking in.
- **Command reaper** — retries commands that were never picked up, gives up after a set number of tries and alerts.
- **Update watchdog** — catches updates that installed but never came back healthy.
- **Alert dispatcher** — sends the email for new alerts, groups repeats so one flapping box cannot flood the inbox.

## 5. Alerts: dashboard + email

- A live alerts page listing every open problem: which box, which dealership, which step, the plain-English reason, when it started, and a one-click "acknowledge" or "resolve".
- Badge count in the navigation so an open alert is visible from any screen.
- Email to the team the moment an alert opens, with the box name, the failed step, and a direct link. A resolved alert closes itself and stops repeat emails.

Email needs a sending domain you own to be set up first. If one is not configured yet, I will prompt for it when we build this step; the dashboard side works regardless.

## Technical notes

- New tables: `device_commands`, `device_software_releases`, `device_update_attempts`, `onboarding_runs`, `onboarding_steps`, `alerts`, `alert_deliveries`. All with RLS: admins full, dealership staff read-only on their own rows, device role reaches its own rows only through security-definer functions.
- New RPCs for devices: `qconnect_poll_commands`, `qconnect_ack_command`, `qconnect_report_step`, `qconnect_report_update`. Heartbeat return value extended to carry pending commands and the target release.
- Workers as `pg_cron` jobs calling security-definer functions, plus a `/api/public/*` route guarded by the existing cron secret for the alert email dispatcher.
- Device side: `qconnect-agent-update.sh` (fetch, verify signature, atomic symlink swap, health probe, rollback), a command executor invoked from the heartbeat, and a step reporter used by `qconnect-setup.sh` at each stage.
- Signing: detached signature over the bundle, public key baked into the image; private key held as a server secret only.
- Dashboard: alerts page, per-device timeline, release/rollout page; React Query for data, service layer for calls, no direct fetch in components.
