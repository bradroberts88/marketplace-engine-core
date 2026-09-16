# Wipe the old card and set it up fresh

## What we know

The micro SD card shows as **D:** with an `overlays` folder and `autopost` files. That is the old AutoPost software. The new QConnect system must never be mixed with the old files (leftovers are a known cause of cards that boot but never finish setup), so this card gets a full wipe and a fresh write — not a cleanup.

## Where we are

The walkthrough documents are already updated and printed (the setup guide now has the "old card vs new card" check; the bench tracker has rows QCN-0001 and QCN-0002). The user says Raspberry Pi Imager is installed ("done"). The remaining work is purely guided, step by step in chat — no further document or code changes expected.

## What the user will do (guided, one step at a time in chat)

1. **Erase the card** with the Raspberry Pi Imager ("Erase" option), choosing drive D:. Windows must never be allowed to format the card instead — always answer No to any format prompt.
2. **Write a fresh system** with the same tool: Raspberry Pi OS Lite (64-bit), drive D:.
3. **Add our software** by right-clicking `Prepare-Card.ps1` and answering the four plain questions (Pi name QCN-0001, dealership, Wi-Fi name and password — filled in even when using a cable).
4. **First power-on** of the Pi and confirm it comes online (cable first, then Wi-Fi, then the AT&T SIM), then check the dashboard.

After the first Pi passes, repeat the same steps for the second Pi (QCN-0002) — never copying one card to the other.

## Before step 3 can succeed

The fleet database must be switched on inside the **QConnect Fleet Manager** project (written and tested, still not applied). If it isn't on, the card-prep step stops with a clear message instead of writing a bad card. If we hit that wall, the user opens that project and says "continue".

## Out of scope

- No changes to Pi behaviour, documents, or the fleet software itself.
