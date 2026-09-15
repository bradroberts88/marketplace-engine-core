# Facebook Marketplace playbook — one plain-English document

A single reference covering what Facebook Marketplace rewards and punishes, what our system does
today, and everything still missing to fully automate vehicle posting on individual sales rep
accounts. Written in plain English, no direction change to the existing build.

Delivered as `docs/FACEBOOK-MARKETPLACE-PLAYBOOK.md` plus a printable
`docs/pdf/Facebook-Marketplace-Playbook.pdf` (same cover, contents page and footer style as the
other guides, dated 09/13/2026), with a copy attached in chat.

## What the document covers

**Part 1 — How Marketplace actually works**
What the listing feed ranks on (freshness, engagement, response speed, local relevance, photo
quality, price realism), what makes a listing rank well, and what quietly suppresses it.

**Part 2 — What gets accounts flagged**
The real triggers: new or thin accounts, shared or drifting IP addresses, identical text across
sellers, burst posting, repeated re-listing of the same vehicle, copy-paste chat replies, browser
fingerprint reuse, commerce policy strikes. Warning signs to watch and what each one means.

**Part 3 — Behaving like a person**
Posting time windows, spacing between posts on one account and across the rep team, per-rep daily
caps, natural variation in wording and photo order, typing and scroll pacing, reply latency,
weekend and holiday patterns, how a real rep marks a vehicle sold and adjusts a price.

**Part 4 — The listing itself**
Title formula, description generation rules, price update cadence and how price drops are treated,
photo count/order/size/uniqueness, vehicle field mapping (year, make, model, trim, mileage, VIN),
how sold is marked, and how a stale listing is refreshed rather than duplicated.

**Part 5 — Rep accounts and profiles**
What a credible rep profile looks like, warm-up period before first post, one identity per browser
profile per IP, keeping rep accounts off the dealership Business Manager, and what to do when one
rep gets restricted.

**Part 6 — AI chat with buyers**
Response time targets, tone, what the AI may and may not say (price negotiation, availability,
financing, holds), varied phrasing, when to hand off to a human, and the record it must keep.

**Part 7 — 50-state FTC compliance**
The federal rules first (FTC Used Car Rule / Buyers Guide, CARS Rule advertising and add-on rules,
truth-in-advertising, dealer license and "dealer" disclosure), then a state-by-state table: what
each state requires in an advertised price and disclosure, doc fee rules, and any
Marketplace-specific wording. Plus the disclaimer text that goes in every description.

**Part 8 — What we have today vs. what is missing**
Clearly split into two lists.

*Built today:* the dealership connector agent, the VPS tunnel and fail-closed proxy so each rep's
browser leaves from the dealership's own trusted IP, claim onboarding, signed agent updates, the Pi
golden image and flasher, fleet monitoring, and a listings/payments/device database with
dealership, vehicle, price, photo, status and sold fields plus read/write functions.

*Not built yet:* the posting worker itself (nothing in this repo drives a browser or creates a
listing), the description and title generator, the scheduler and throttle, the price-update and
sold-sync loop, the AI chat responder, the compliance text engine, the per-rep behavior profile,
and the health checks that pause a rep before Facebook does. Each gets a short note on what it
depends on.

**Part 9 — Build order**
The order those missing pieces should be built in, and what must be proven at each step before the
next one starts.

## Technical notes

- Marketplace and FTC/state facts are researched and each claim cited in the document, with a
  "last checked 09/13/2026" note, since these rules change.
- Current-state claims are drawn from the code as it stands: `connector/`, `connector/server/`,
  `src/lib/fleet.functions.ts` and the operations schema migration. Anything that only exists as a
  README sentence is listed as not built.
- PDF rendered through the existing `docs/pdf/render-design-pdfs.py` builder, cover meta and QCAI
  footer consistent with the other guides, dates MM/DD/YYYY.
- Every PDF page is converted to an image and checked before delivery.
- No application code, schema or screens change in this task.
