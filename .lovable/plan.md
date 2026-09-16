# Finish setting up Pi #1 (QCN-0001) — add our software, power on, verify

The card is wiped and has the fresh system on it (step 2 done). This plan covers
everything left to get the first Pi online, then the second one.

## What stands between you and step 3

The card-preparation tool (Prepare-Card.ps1) refuses to write a card unless two
things are in place. Both are by design — it will not write a card that can
never register.

1. **A settings file for your laptop.** The tool needs the fleet's address and
   keys to hand out each card's one-time registration ticket. That settings file
   does not exist yet.
   - I will create `bench-settings.ps1` in the card-preparation folder and give
     it to you as a download. You save it next to Prepare-Card.ps1 and run it
     once; it stays quiet and the tool picks the settings up from then on.
   - The fleet address and public key go in as-is. The private keys inside it
     are real access codes — the file delivers them to your laptop, but they
     will never be printed in this chat.
   - If any value genuinely is not available to me, I will say so plainly
     rather than put a guess in the file.

2. **The fleet system switched on.** Each card registers itself against the
   fleet database, and that database (with the registration, connectivity and
   key-rotation pieces we built and tested) still has to be applied inside the
   **QConnect Fleet Manager** project — I can only read that project from here.
   - You open QConnect Fleet Manager and say "continue" there, and the install
     gets applied in one pass. Then cards can register.
   - If you prepare a card before this is done, the tool stops with a clear red
     message and writes nothing. Nothing breaks; you just retry after.

## The steps, in order

1. **Settings file.** I build `bench-settings.ps1`, check every value it needs
   against what this project actually has, and attach it here for you to
   download into the card-preparation folder.
2. **You run it once** (right-click → Run with PowerShell). No output expected.
3. **Get the tool onto the laptop.** If you have not already, download the
   project from GitHub (green Code button → Download ZIP) and unpack it — the
   tool lives in the card-preparation (`flash`) folder inside `qconnect`.
4. **Prepare the card** — right-click Prepare-Card.ps1 → Run with PowerShell:
   - it lists the small drives; type the letter of **bootfs**;
   - name this Pi **QCN-0001**;
   - dealership short name;
   - Wi-Fi name and password (fill them in even if you plan to use a cable —
     press Enter twice to skip if you don't have them);
   - it should end with **"This card is ready."** A red message means nothing
     was written — tell me what it says and I'll decode it.
5. **Eject** the card in Windows, put it in the Pi.
6. **First power-on** — cable in before power if you have one; red light stays
   on, green flickers, it restarts itself once, then give it four minutes.
7. **Check the fleet dashboard** — QCN-0001 should appear and turn online,
   showing whether it connected by cable, Wi-Fi or cellular. That is the whole
   test.
8. **Second Pi (QCN-0002)** — same steps, its own card, its own name. Never
   copy one card to the other; that is the classic way a second Pi never comes
   online.
9. **Tick the tracker and checklist** as each step passes; anything that fails
   gets flagged with the plain-words reason from the troubleshooting table.

## Small document touch-ups

- The setup guide (section 6) gets one added line: run the settings file once
  before the first card. The tick sheet gets the same line.

## Honest limits

- The fleet install happens inside QConnect Fleet Manager, not here — step 0 of
  your walkthrough until you say "continue" over there.
- I cannot see your laptop's screen; you read me what the tool prints and I
  translate. If the tool stops in red, that is the design working, not a failure
  — nothing half-written ever reaches a Pi.
