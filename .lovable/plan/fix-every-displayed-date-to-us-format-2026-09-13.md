# Fix every displayed date to US format

## What is wrong

The dashboard’s shared date helper still explicitly builds dates as `DD/MM/YYYY`, which is why the screenshot shows `10/09/2026` and `13/09/2026`. The Fleet Manager alerts, releases, card keys, admin actions, and calendar also contain European or browser-dependent formatting.

## What will change

- Change the shared dashboard date and date-time helpers to always display **MM/DD/YYYY** while retaining UTC times and the `UTC` label.
- Update every Fleet Manager date formatter—alerts, releases, card keys, and admin actions—to use **MM/DD/YYYY** consistently.
- Make calendar dates explicitly use the US locale so they cannot switch back based on the viewer’s device settings.
- Keep the real underlying timestamps unchanged: the release published on September 10 remains **09/10/2026**, while the September 13 check remains **09/13/2026**.
- Update formatter documentation and add focused tests covering September 10 versus October 9, null dates, date-times, and leading zeroes.

## Verification

- Scan the complete source tree for remaining `DD/MM/YYYY`, `en-GB`, and manual day-first formatters.
- Run the relevant tests and linter.
- Open the live dashboard at mobile and desktop sizes and confirm the release card and image cards show `09/10/2026` and `09/13/2026` in US order.
- Check the Fleet Manager package screens for the same format in their source-level output.