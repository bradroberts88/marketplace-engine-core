# Clean up the code, then finish the fleet dashboard

Two provisioning recipes exist side by side today. The Windows card writer still
writes the old AutoPost payload onto cards, while the new QConnect payload is
written only by a separate script. That is the most likely reason cards written
on different days behave differently. We settle on QConnect everywhere.

## 1. One card recipe, one quarantine folder

- Point the Windows card writer at the QConnect payload: it writes the QConnect
  provisioning file and setup scripts instead of the old claim/Tailscale env files.
- Create `/attic` at the top level, with a README explaining nothing inside is
  live and how to pull something back. It is excluded from builds, tests,
  packaging and the card writer, so nothing in it can run by accident.
- Move into `/attic/autopost-pi/`: the old AutoPost services (claim, Tailscale,
  connector, Bluetooth setup, Wi-Fi recovery), the Bluetooth setup page and
  script, the old captive-portal config and the old drive-letter write path.
- Nothing is deleted. Every move is listed in the attic README with the reason.

## 2. Email alerts on the real sending domain

- Confirm the Fleet Manager sending domain, then wire the alert dispatcher to it.
- Failed bench steps, heartbeat drops and admin actions each send one email,
  once, with the device name, what failed and when.
- The dispatcher runs on the same 30-minute window you set (7am-8pm Mountain).
  Alerts raised overnight go out at the start of the next window.

## 3. Screens in Fleet Manager

- **Bench**: every card, its seven-step checklist, green/red per step, and the
  reason text when a step fails.
- **Releases**: current agent version per card, what is rolling out, who is
  behind and rollback status.
- **Admin actions**: the audit trail - who switched a box off, when, and why.
- **Key rotation**: one row per card showing its own Tailscale key, when it
  expires, and a button to mint a fresh one and retire the old.

## 4. Per-card Tailscale keys

Card writing already mints a fresh single-use key per card. Missing piece is
visibility and renewal: record each card's key id and expiry in the database at
registration, surface it on the key rotation screen, and alert when a key is
within 14 days of expiry.

## 5. Boot-mount race

The QConnect setup service already waits for the boot partition. The remaining
gap is in the old AutoPost services, which move to `/attic` in step 1. I will
re-check every remaining unit so each one that reads a file on a mounted
partition waits for that mount.

## 6. The real batch of Pis

I cannot touch hardware. Instead:

- A printable bench runbook: exact steps for Wi-Fi, Ethernet and AT&T cellular
  per card.
- A live tracker on the Bench screen that fills itself in as each card reports,
  so a card that fails cellular flags itself in red without anyone typing it in.

## What I need from you

The dashboard work, the database install and the email dispatcher all live in
the **QConnect Fleet Manager** project, which I can only read from here. I will
prepare everything as ready-to-apply files in this project; you then open Fleet
Manager and say "continue" and I apply it there in one pass.

## Technical notes

- Attic enforced via `.gitattributes` export-ignore, tsconfig/vite exclude,
  eslint ignore, test glob exclusion and a card-writer path guard.
- Flasher: `connector/flasher/inject.js` payload builder swapped to emit
  `qconnect/provision.json` + the `qconnect/` boot payload consumed by
  `qconnect-firstrun.sh`; legacy `claimEnv`/tailscale env writers move to attic.
- Email: `qconnect/app/routes/api/public/qconnect-alert-emails.ts` plus a
  React Email template, keyed by `idempotencyKey` per alert id.
- Keys: new `tailscale_key_id` / `tailscale_key_expires_at` columns on the
  device row, populated by `qconnect_self_register`; rotation screen calls a
  server function that mints and revokes via the Tailscale API.
- Screens: TanStack routes under `_authenticated/`, React Query, role-scoped by
  the existing `app_metadata` model.
