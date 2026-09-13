# A plain-English owner's guide for anyone who receives a Pi

All current documentation is written for engineers (bench runbooks, design docs, defect registers). Nothing tells a non-technical person what to do when a box with a Pi inside shows up at their door. This plan adds that document.

## What I will build

**`docs/PI-OWNERS-GUIDE.md`** + a matching PDF at **`docs/pdf/Pi-Owners-Guide.pdf`** — "Getting started with your Pi", written for someone who has never heard the words "flash", "image", "SSH" or "APN".

Contents, in order, all in plain English with numbered steps:

1. **What's in the box** — the Pi, the memory card (already prepared, nothing to install), power cable, optional screen/antenna.
2. **Plugging it in** — where power goes, what the little lights mean (red = power, green = thinking), and "give it two minutes the first time".
3. **Getting it online — pick one:**
   - **Wi-Fi:** on a phone or laptop, join the Pi's own "QConnect-Setup" network, a setup page opens by itself, type your Wi-Fi name and password, done.
   - **Cable (easiest):** plug the network cable into the office router before powering on — nothing else to do.
   - **Cell phone SIM (AT&T):** already set up; just power it on with a view of a window if the signal is weak.
4. **How to know it worked** — the setup page shows "Connected" and the device appears on the fleet dashboard within a few minutes; if it's listed there, everything is fine.
5. **Everyday use** — leave it plugged in; it updates and reports by itself; nothing to press.
6. **If something seems wrong** — a plain-words table: "no lights", "red light only", "setup page won't open", "was working, now offline" → what to check (power plug, Wi-Fi password changed, move it near a window for SIM) and when to call support, including exactly what to say ("the box labelled device …").
7. **The one rule** — never pull the memory card out while it's powered, and never wipe/rewrite the card; that's what makes it stop working.
8. **Returning or moving it** — how to unplug safely and who to notify so the dashboard doesn't raise a false alert.

Style rules: numbered steps, short sentences, no technical terms without an everyday explanation, no code blocks, no file paths. Where a step touches the setup page, describe what the person sees ("a page that says QConnect Setup") rather than naming software.

**PDF:** same content rendered with the existing `docs/pdf/render-design-pdfs.py` script, visually checked page by page before delivery.

**Linking:** add the guide to `README.md` and the top of `qconnect/docs/BENCH-RUNBOOK.md` ("receiving a box? start here instead").

## What I will not do

- No changes to the Pi software, flasher, database, or Fleet Manager — this is documentation only.
- No invented contact details: support contact stays as "your installer / the person who shipped the box" unless you give me a name, email or phone to print.

## Verification

Render the PDF, convert every page to an image, and check each one for clipped text, broken layout or empty pages; fix and re-render until clean.
