# Leave SSH off during the card write — answer the question in the guide

## Decision

Do **not** enable SSH in Raspberry Pi Imager. When the Imager offers
"Use OS customisation?" (including the SSH option), the user picks
**"No, clear settings"** — exactly as the setup guide already says.

Why no:

- Support already reaches every Pi through the card's own secure remote-access
  tunnel, which `qconnect-setup.sh` switches on automatically at first boot
  (`tailscale up --ssh`). Bench test 2.5 verifies it.
- Imager's SSH option would add an unused password login on the local network —
  an extra door with no benefit.
- Two sets of settings (Imager customisation + our own card preparation) are a
  known cause of a Pi that never connects.

## Changes

1. `docs/PI4-FIRST-TIME-SETUP.md`, section 5, step 4: add one plain-English
   sentence — if the Imager asks about remote access (SSH), leave it off; the
   same "No, clear settings" choice covers it, and support reaches the Pi
   securely on its own after it connects.
2. `docs/PI4-SETUP-CHECKLIST.md`: add the same reminder as a one-line note at
   the "write the fresh system" step.
3. Re-render both PDFs with `docs/pdf/render-design-pdfs.py "09/16/2026"`,
   QA the changed pages as images, and refresh the copies in Files.
4. Reply in chat with the immediate instruction for the step the user is on
   (writing the OS): when the customisation box appears, click
   **No, clear settings** and carry on.

No changes to any Pi code, the card preparation tool, or the Imager steps.
