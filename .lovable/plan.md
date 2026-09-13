# Zero-touch cards: self-registration, secure keys, visible failures

Five pieces of work. Four are things I can build and test here; the fifth (a real batch of cards with SIMs) needs hardware, so I build the tooling and the automated bench run, and you run the cards.

## 1. Push everything to GitHub

Now that the connection works and the budgets are raised, sync the full package to `marketplace-engine-core`: the QConnect handoff folder (database scripts, card scripts, dashboard pages, release signing tool), the design documents and their PDFs, and the connectivity, remote-ops, security and bench guides.

Anything that stays out stays out on purpose: installed packages, build output, and real secrets (Tailscale keys, tokens, service keys). The two large card images stay in the existing release rather than the repository. After the push I list exactly what landed and what was skipped.

## 2. Cards register themselves on first boot

Today a card can only register if someone ran a line of SQL for it beforehand. That is the single biggest reason "identical cards" behave differently.

Change: the flashing tool writes a short-lived, single-use enrolment ticket onto the card instead of relying on a manual step. On first boot the card presents the ticket, the server creates its record, and the ticket is burned. If the ticket is missing, expired, or already used, the card says so on its setup screen and in the fleet view rather than sitting silently unregistered.

The old manual path keeps working, so cards already in the field are unaffected.

## 3. Tailscale keys: one per card, tagged, batch key rotated

With your Tailscale token stored securely, the flashing tool will:

- mint a fresh key per card, single-use, expiring, tagged so a card can only ever be a card (no admin rights, reachable only by the server);
- record the tag policy to apply in Tailscale so those tags are enforced;
- revoke the shared batch key once the run finishes, and refuse to reuse any key already spent;
- fall back to a clear error (never a silent half-provision) if the token is missing or rejected.

Each card still wipes its key from disk once it is joined and registered.

I will request the token through the secure form; it never appears in chat or in the repository. Please also tell me your tailnet name (for example `example.com` or `tail1234.ts.net`).

## 4. Network failures become visible

Right now a failed join is swallowed. After this change:

- the card's setup screen shows the last failure in plain words (wrong password, network not in range, this card is 2.4 GHz only, joined but no internet, SIM locked, no tower, wrong APN), with the time it happened and a retry button;
- if the network service itself is broken or missing, the screen says that instead of pretending nothing is wrong;
- the same words appear in the fleet view per card, plus the last few attempts, so you can triage without touching the card;
- every failure also raises an alert, so a stuck card surfaces on the alerts page and by email.

## 5. The batch, and benching it

At 100,000 cards the bench is a sampling exercise, not a per-card one. Plan:

- **Batch tooling**: the flashing tool gains a batch mode — feed it a list (or a count) and it provisions cards in parallel, each with its own identity, token, Tailscale key and SIM APN, writing a manifest CSV and a per-card log. A batch dashboard shows how far along the run is and which cards failed.
- **Automated bench**: of the tracked 8-phase, 47-step checklist, everything that can be judged from the card's own reports is checked automatically as each card comes online — it either passes the step or raises a failure with the reason. Only steps that need human eyes (physical LED, screen, unplug the cable) stay manual.
- **Pilot first**: run 10–25 cards end to end, fix whatever fails, then scale. I cannot insert SIMs or power cards, so the pilot results come from you; I will read the fleet data, diagnose failures and fix the code.

## Technical notes

- New database objects: `qconnect_enrolments` (ticket hash, expiry, single-use, issued-by), `qconnect_batches` and `qconnect_batch_cards`, `qconnect_net_events` (rolling per-device failure log). RPCs `qconnect_issue_enrolment`, `qconnect_self_register` (security definer, ticket-scoped, no service key on the card), `qconnect_report_net_event`. GRANTs and RLS on every new table: admins full, dealership staff read-only on their own rows, cards reach their own rows only through the definer functions.
- `provision-sd.sh`: `--batch-file` / `--count`, Tailscale API key minting with `tag:qconnect-device`, batch-key revocation at the end of the run, enrolment ticket written to `provision.json` in place of the printed SQL line, manifest output.
- Device side: `qconnect-setup.sh` calls `qconnect_self_register` on the ticket path; `qconnect-netmanager.sh` writes each failed attempt to `net-events.json` and posts it on the next heartbeat; a missing/broken NetworkManager is detected explicitly and reported as `netmanager_unavailable`.
- `qconnect-portal.py`: failure banner with timestamp, attempt history, retry action, network-service health line.
- Fleet view: last failure column, per-card attempt history, alert link. Alerts reuse the existing dedupe so one flapping card cannot flood email.
- Tailscale ACL: tag owner plus a rule allowing the server to reach `tag:qconnect-device` and nothing card-to-card; shipped as a JSON snippet in the docs for you to paste into Tailscale.
- Secrets: `TAILSCALE_API_KEY`, `TAILSCALE_TAILNET`.
- Also fixing while in here: the home page currently renders a clock-based line that differs between server and browser, which throws a hydration warning on every load.
