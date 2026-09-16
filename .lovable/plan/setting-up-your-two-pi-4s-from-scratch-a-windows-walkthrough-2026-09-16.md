# Setting up your two Pi 4s from scratch — a Windows walkthrough

You have two Pi 4s with SIM cards in them, a Windows laptop, a card slot, and no
prior experience. This plan produces a written walkthrough you can follow line by
line, and it fixes the one thing that currently stops a Windows user cold.

## First, the honest part

Two things have to be true before a Pi can "come online", and one of them is not
done yet:

1. **The fleet database has to be switched on first.** Each card is given a
   one-time ticket at the moment you prepare it, and the fleet system has to
   exist to hand that ticket out. That work is written and tested but lives in
   the other project (QConnect Fleet Manager) and can only be switched on from
   inside it. Until that happens, a card can be prepared but will have nothing
   to report to.
2. **The preparation tool is currently Mac/Linux only.** The step-by-step script
   that writes the setup files onto the card does not run on Windows as-is.

So the walkthrough below has a short "get ready" part that I do, and then the
part you do with the cards.

## What I will do

**1. A Windows version of the card-preparation step.**
A small `qconnect/flash/Prepare-Card.ps1` that does exactly what the existing
Mac/Linux script does — asks the ticket, writes the setup files and the card's
identity onto the memory card, points the Pi at them, and records the card in the
fleet list. Same checks, same refusals (it will not write a half-good card), just
runnable by double-click on Windows. Nothing about how the Pi behaves changes.

**2. The walkthrough document:** `docs/PI4-FIRST-TIME-SETUP.md`, plus a printable
PDF, written for someone who has never done this. In order:

1. **What you are actually doing** — the Pi keeps everything on a little memory
   card; wiping the card wipes the Pi. Nothing is stored anywhere else.
2. **What you need on the table** — the two Pis, their memory cards, a card
   reader, power supplies, and optionally a network cable. Note: the USB-C lead
   you have is the power lead; it is not how you set the Pi up.
3. **Getting the card out** — where the slot is, how to push-release it safely,
   and which way round it goes back.
4. **Erasing it completely** — using the free Raspberry Pi Imager on Windows:
   choose Erase, pick the card (with a hard warning about picking the wrong
   drive), confirm. This is the "remove everything" step.
5. **Writing the fresh system** — same tool, choose Raspberry Pi OS Lite
   (64-bit), write, wait, verify.
6. **Adding our code** — run `Prepare-Card.ps1`, answer four plain questions
   (a name for this Pi, which dealership, Wi-Fi name and password if you have
   them, and whether the SIM should be used). It prints a summary of what it
   wrote.
7. **Both Pis, side by side** — do card one, then card two, with a warning that
   each card must be prepared separately and never copied; two copies of the
   same card means the second Pi never connects.
8. **First power-on** — what the lights do, how long to wait, and the three ways
   it can get online: cable (nothing to do), Wi-Fi (the QConnect-Setup page), or
   the AT&T SIM already inside.
9. **Confirming it worked** — where it appears in the fleet list, and what
   "online" looks like.
10. **When it doesn't** — a plain-words symptom table: no lights, red light only,
    never appeared in the list, SIM never connected — each with what to try.
11. **Who to call** — QCAI Support · 1-855-782-6824 · support@quantumconnectai.com.

**3. A one-page checklist** you can keep next to the laptop with tick boxes for
each of the two Pis, so you never lose your place.

Since you're not sure yet what internet the Pis will have, the walkthrough covers
all three (cable, Wi-Fi, SIM) and tells you to put the Wi-Fi details in even if
you expect to use the cable — extra options cost nothing and are the difference
between a Pi that recovers itself and one you have to visit.

## What I will not do

- No changes to how the Pi software behaves — only a Windows way to run the
  existing preparation step.
- No invented technical terms in the walkthrough: no file paths, no commands you
  have to type by hand beyond double-clicking one file.
- I cannot switch on the fleet database from here. The walkthrough will say
  clearly which step depends on it.

## Technical notes

- `Prepare-Card.ps1` mirrors `qconnect/flash/provision-sd.sh`: issues the
  enrolment ticket via `qconnect_issue_enrolment` before writing, generates the
  40-hex device token and 48-hex ticket, writes `qconnect/` payload plus
  `provision.json` to the boot partition, appends the `systemd.run=` first-run
  hook to `cmdline.txt` with the Bookworm `/boot/firmware` mount path, records
  the per-card Tailscale key via `qconnect_record_card_key`, and keeps the
  used-key ledger so one key can never be reused across cards.
- Cellular defaults to the AT&T APN `broadband`, with `m2m.com.attz`,
  `att.mvno`, `nxtgenphone` as retries — same as the Bash path.
- Pi 4 target means the full-size golden image / Bookworm 64-bit Lite; the
  5 GHz Wi-Fi caveat that applies to the Zero 2 W does not apply here.
- PDF rendered with `docs/pdf/render-design-pdfs.py`, dated to today, QA'd page
  by page as images.
