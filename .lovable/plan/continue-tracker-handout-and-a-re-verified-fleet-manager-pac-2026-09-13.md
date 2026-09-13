# Continue: tracker, handout, and a re-verified Fleet Manager package

Three pieces of work, all done inside this project. Nothing here touches QConnect
Fleet Manager — that still needs you to open it and say "continue".

## 1. Card-by-card tracker for the batch of Pis

A printable, fill-in tracker plus the matching live page so the same batch can be
followed either on paper or on screen.

- `docs/PI-BATCH-TRACKER.md`: one row per card — card name, date, who ran it, and
  a pass/fail box for each of the three ways online: cable, Wi-Fi, AT&T SIM.
  Each box has the exact thing to look for and what it means when it fails.
- A failure legend in plain words: "joined but no internet", "wrong Wi-Fi band",
  "SIM not registering", "never checked in" — with the one action for each.
- The Bench page already in the handoff package gains a batch view: every card
  that has reported, its three connection results, and a red flag on anything
  that failed. It fills itself in from the cards' own check-ins, so nobody has to
  type results twice. This ships as part of the Fleet Manager package, ready to
  apply when you open that project.

## 2. Owner's guide handout with real contacts

- Print the support details you gave into `docs/PI-OWNERS-GUIDE.md`:
  QCAI Support, support@quantumconnectai.com, 1-855-782-6824.
- Put them in the "who to contact" section and repeat them on the cover, so a
  single page is enough to get help.
- Re-render `docs/pdf/Pi-Owners-Guide.pdf`, plus a new one-page
  `docs/pdf/Pi-Owners-Handout.pdf`: the essentials only — plug in, get online,
  how to tell it worked, who to call.
- Check every rendered page as an image before handing it over.

## 3. Re-verify the Fleet Manager package end to end

So the live install is a formality when you open that project:

- Rebuild `qconnect/supabase/install-all.sql` from scripts 01-10.
- Apply Fleet Manager's own seven migrations to a throwaway database, then apply
  the installer twice, and run both smoke suites.
- Re-check the screens and server functions for anything that drifted, and update
  the handoff document with the batch tracker view.

## Technical notes

- Tracker page: extends `qconnect/app/routes/_authenticated/bench.tsx` with a
  batch grid fed by a new `listBatchConnectivity` server function reading the
  connectivity attempt rows from `05-connectivity.sql`; no schema change needed.
- Handout: new build call in `docs/pdf/render-design-pdfs.py` reusing the
  `brand`/`cover_meta`/`footer_note` parameters added for the owner's guide.
- Verification: throwaway Postgres 17 on a spare port, `_test/run-local-tests.sh`,
  expecting 47 bench steps (17 in phase 8) and a false time gate outside
  07:00-20:00 America/Denver.

## Still blocked on you

Applying the database, the screens and the email dispatcher — and setting up the
sending domain — all have to happen inside QConnect Fleet Manager. Open that
project and say "continue" there.
