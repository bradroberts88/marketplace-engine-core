# Date format: switch everything to US format, current stamps to 09/13/2026

## What changes

The project currently mixes European dates (13/09/2026, 2026-08-30) with prose dates. Per your instruction, every date moves to US format **MM/DD/YYYY**, and anything presented as "current" reads **09/13/2026**.

## Rules

- Historical dates keep their real day and month, only the format flips: `bug found 2026-07-15` becomes `bug found 07/15/2026`; `30 August 2026` becomes `08/30/2026`. The timeline of what was fixed and when stays truthful.
- Stamps that mean "this document is current as of now" (`Last updated`, cover dates, `Date:` headers on the defect register and failure analysis) are set to **09/13/2026**.
- `connector/deploy/pi/golden/README.md` says the release was published 10/09/2026 — that becomes `09/10/2026` (real date, US format).

## Files touched

- `README.md` — doc-table dates (13/09/2026, 2026-08-17, 2026-08-30) → US format.
- `docs/PI-CONNECT-FAILURE-ANALYSIS.md` and `docs/PI-CONNECT-DEFECT-REGISTER.md` — `Date:` headers → 09/13/2026.
- `qconnect/README.md` — the 13/09/2026 stamp → 09/13/2026.
- `src/lib/email-templates/device-alert.tsx` — preview `occurredAt` → `09/13/2026 07:30`.
- `connector/deploy/pi/PI-SETUP-GUIDE.md` and `connector/deploy/pi/PI-SHIP-TEST-PLAN.md` — `Last updated` stamps → 09/13/2026.
- `docs/read-me-first.txt`, `docs/autopost-overview.md`, `docs/SOFTWARE-DESIGN.md`, `docs/TECHNICAL-DESIGN.md`, and all code comments / test files with historical dates — format flip only, real dates preserved.
- `docs/pdf/render-design-pdfs.py` run with `09/13/2026` so all six PDF covers and footers re-render in US format, then visually QA'd page by page.

## Verification

- `rg` scan after the edits: no `DD/MM/YYYY` or `YYYY-MM-DD` strings remain in docs; the only date format left is MM/DD/YYYY.
- Re-render PDFs and check each cover shows 09/13/2026.
