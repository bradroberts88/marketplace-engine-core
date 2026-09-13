# Pi connection defect register — one document, all 27

`docs/PI-CONNECT-FAILURE-ANALYSIS.md` already holds the review, but the findings
are spread across six lettered sections and mixed in with commentary. You want
one document that simply lists every defect, including the five that explain
identical cards behaving differently.

## What gets created

**`docs/PI-CONNECT-DEFECT-REGISTER.md`** — a single register, in two parts:

1. **The five that explain "identical cards, different outcome"** — kept at the
   top, each with what goes wrong, what you see when it happens, and the fix.
2. **The full numbered list** — every defect in one continuous table:
   ID, severity, area, where it lives, what's wrong in a sentence, the fix, and
   a **status** column saying whether it's already fixed in the current code or
   still open.

The status column is the new part. Since the review was written, the connection
stack was rebuilt, so a number of these should now be closed. Before writing a
single status, each defect gets checked against the code as it stands today —
nothing is marked fixed on memory.

Anything found still open is listed again at the end as a short "what's left"
list in the order it should be tackled.

**`docs/pdf/PI-CONNECT-DEFECT-REGISTER.pdf`** — the same register as a clean PDF,
alongside the two design PDFs you already have.

The original analysis document stays exactly as it is, as the dated record of
the review. The new register links back to it.

## Technical notes

- Verification pass first: re-read `qconnect/flash/provision-sd.sh`,
  `qconnect/boot-payload/qconnect-firstrun.sh`, `qconnect/device/*.sh`,
  `qconnect-portal.py`, the systemd units, `connector/deploy/pi/*.service` and
  `connector/src/{agent,claim}.js`, checking each of A1–A5, B1–B6, C1–C7,
  D1–D4, E1–E4 and the three F notes against what the files actually contain.
- Register IDs stay identical to the analysis document so the two cross-read.
- PDF generated with the same toolchain used for the existing `docs/pdf/` files.
