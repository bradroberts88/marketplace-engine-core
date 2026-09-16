# Wipe the old card and set it up fresh

## What we know

The micro SD card shows as **D:** with an `overlays` folder and `autopost` files. That is the old AutoPost software. The new QConnect system must never be mixed with the old files (leftovers are a known cause of cards that boot but never finish setup), so this card gets a full wipe and a fresh write — not a cleanup.

## What the user will do (guided, step by step in chat)

1. **Erase the card** with the free Raspberry Pi Imager (the "Erase" option), drive D:.
2. **Write a fresh system** with the same tool: Raspberry Pi OS Lite (64-bit), drive D:.
3. **Add our software** by right-clicking `Prepare-Card.ps1` and answering the four plain questions.
4. **First power-on** of the Pi and confirm it comes online (cable first, then Wi-Fi, then the SIM).

These exact steps, in plain English with pictures-in-words, already exist in the walkthrough I built (`docs/PI4-FIRST-TIME-SETUP.md`) with its tick sheet. I will walk the user through them one step at a time in chat, starting with installing Raspberry Pi Imager.

## Small changes I'll make

- **`docs/PI4-FIRST-TIME-SETUP.md`**: add a short "how to tell an old card from a new card" note (overlays/autopost files = old, wipe it; qconnect folder = new) so this is self-serve next time, plus a "checking what's on the card" step before erasing. Re-render the PDF and refresh the copy in Files.
- **`docs/PI-BATCH-TRACKER.md`**: add a row entry for these two Pi 4s so results get logged as we go.

## Before step 3 can succeed

The fleet database must be switched on inside the **QConnect Fleet Manager** project (written and tested, still not applied). If it isn't on, the card-prep step stops with a clear message instead of writing a bad card. If we hit that wall, the user opens that project and says "continue".

## Out of scope

- No changes to Pi behaviour or the fleet software itself.
- The second Pi 4: same steps afterwards, never copying one card to the other.
