# Facebook Marketplace playbook

Everything we know about how Facebook Marketplace treats vehicle listings, what it takes to post
them automatically from individual sales rep accounts without getting those accounts shut down,
what the law requires the wording of a car advert to say in each state, and an honest list of what
our system does today versus what still has to be built.

Written in plain English. No prior knowledge assumed.

**Facts about Marketplace and about the law were last checked 09/13/2026.** Both change without
notice. Anything marked *reported* is what sellers and vendors say happens, not something Facebook
has ever confirmed in writing.

---

## 1. How Facebook Marketplace actually decides what people see

Facebook has published a plain description of how Marketplace picks what to show a shopper. It
works in four steps.

1. It gathers roughly a thousand candidate listings. Newer listings and listings that look relevant
   to that particular shopper are favoured at this stage. Anything the shopper has blocked, and
   anything already rejected under the commerce rules, never makes it into the pool.
2. It looks at basic facts about each listing: where it is, what category it is in, what condition
   it is in, what it costs, and what that shopper has done on Marketplace before.
3. It runs safety and quality checks. Facebook says outright that it "reduces the distribution" of
   anything that looks fraudulent, low quality, or against its commerce rules. This is the quiet
   killer: a listing can stay up and simply be shown to almost nobody.
4. It scores and orders what is left, per shopper, by guessing what that person is likely to do.

That last step is the important one. Facebook does not score a listing once and give it a rank.
It predicts, for each shopper separately, how likely they are to click it, save it, share it,
message the seller, or hide it — and orders accordingly.

### What Facebook itself says feeds those predictions

These are named in Facebook's own published description:

- The **price** of the vehicle, and **how far it is from the shopper**.
- How long people spend looking at the listing page, and how far down it they scroll.
- How many times people click through the **photos** in the carousel.
- Saves, shares, profile clicks, and messages started with the seller.
- Whether people have hidden similar listings before.
- Keywords in the listing, matched against what the shopper searches and engages with.

Two things follow from that. First, **photos are a ranking input, not decoration** — photo clicks
are explicitly counted. Second, **a listing that gets hidden or ignored is actively demoted**, so
posting more is not automatically better.

Paid boosts and adverts are inserted separately and are not part of this ranking. Buying a boost
does not teach the system anything about your organic listing.

### What is widely believed but not confirmed

Sellers and marketing vendors consistently claim that recency, photo count and quality, a price in
line with the local market, fast replies, and filling in every field (mileage, trim, condition) all
lift a listing. This is consistent with what Facebook describes, but Facebook has never published
weights or anything car-specific. Treat these as sensible defaults, not as facts.

---

## 2. What gets listings suppressed and accounts restricted

### The rules that are written down

- **Marketplace is officially for person-to-person selling.** Facebook's commerce rules say so
  plainly, and say that people or businesses selling commercially in certain regions may have
  listings removed or access suspended.
- **Since 30 January 2023, vehicles can no longer be listed from a Facebook business page** in the
  US, Canada, UK, France, Mexico, Brazil, Indonesia, Germany and Australia. The vehicles tab and
  the inventory tab went with it. Dealers were pointed at paid automotive adverts instead. This is
  precisely why the whole approach depends on individual sales rep profiles.
- **Breaking the commerce rules escalates.** Listings get rejected or removed, then warnings are
  issued, then Marketplace access itself is suspended. A rejected listing can be appealed, but not
  after 180 days, not twice, and not for every rule.
- **Automated collection of data from Facebook is forbidden** without written permission, and
  programmatic access is supposed to go through official interfaces. There is no carve-out for
  posting tools. This is a real, permanent business risk that no amount of careful engineering
  removes — it can only be managed.
- **Vehicle services cannot be sold on Marketplace at all**, and certain parts (catalytic
  converters, airbags, emissions defeat devices) are banned outright.

### What sellers report triggers trouble

None of this is confirmed by Facebook. It is what people who do this at volume consistently say.

- Brand-new accounts posting in bulk. New profiles appear to sit in a probation period — *reported*
  as roughly five to ten active listings, with everything reviewed, and higher-value categories
  such as vehicles gated behind an unpublished trust threshold.
- Listing velocity: posting many vehicles within a few minutes. *Reported* thresholds are around
  ten vehicles a day per account and at least five minutes between posts.
- Identical text and identical photos appearing across several sellers.
- Repeatedly deleting and re-posting the same vehicle instead of editing it.
- Stock photography, or photos that have already appeared elsewhere on the platform.
- Prices that are obviously not real, including placeholder prices used to get attention.
- Copy-paste chat replies sent to many buyers.
- Reused browser fingerprints and shared or shifting network addresses. Firms that scrape
  Marketplace describe device fingerprinting, rate limiting and machine-learning detection as the
  defences they run into. This is the single area our existing system already addresses.
- Leaving sold vehicles up. *Reported* expectation is removal within a day.

### Warning signs to watch, and what each means

| What you see | What it usually means |
| --- | --- |
| Views collapse on one rep's listings while others are fine | That account is being quietly demoted, not banned |
| A new listing sits at almost zero views for a day | It is being held for review, or was filtered at the safety step |
| "Listing rejected" with no useful reason | A commerce rule tripped; appeal once, do not re-post the same thing |
| A warning appears in account status | The next violation can remove Marketplace access entirely |
| Buyers stop replying after one message | Replies are landing in the filtered inbox, or the account is limited |
| Every rep degrades at once | Something shared broke — network route, text template, or photo set |

---

## 3. Behaving like a person

Everything in this section exists to make automated posting indistinguishable from a busy sales rep
with a phone. The rules are simple to state and unforgiving to get wrong.

- **Post inside human hours only.** Listings go up when a rep would plausibly be at work. Nothing
  posts at three in the morning.
- **Space posts out.** Minutes apart at minimum, with the gap varied rather than fixed. A perfectly
  regular interval is itself a tell.
- **Cap each account daily**, and vary the cap. Ten vehicles from one rep every single day, seven
  days a week, is a pattern no human produces.
- **Stagger across the team.** Two reps must not post at the same second, and the same vehicle must
  never appear from two reps.
- **Vary the writing.** The same vehicle described by two reps must read like two people wrote it.
  Sentence order, length, and phrasing all change.
- **Vary the photos.** Order changes, and the same image file should not be reused byte for byte
  across accounts.
- **Pace the typing and the scrolling.** Actions inside the browser take human time, with pauses,
  corrections, and occasional idle moments.
- **Reply like a person.** Not instantly, not identically, and not at four in the morning.
- **Respect weekends and holidays.** Volume drops, it does not vanish; reps still answer messages
  on a Sunday.
- **Mark sold the way a rep does** — promptly, and by marking it sold rather than deleting it.
- **Adjust prices occasionally, not on a schedule.** A price that moves by the same amount every
  Tuesday is a machine.

---

## 4. The listing itself

### Title

A Marketplace vehicle title should read the way a private seller writes one: year, make, model,
trim, and one distinguishing fact. It should not be stuffed with keywords, dealer branding, or
punctuation tricks. Keywords do matter to ranking, but they matter inside a title that reads
naturally.

### Description

Generated per vehicle, from the vehicle's own data, with:

- the honest condition and history;
- the equipment a buyer actually asks about;
- the mileage and the price stated plainly;
- the legally required wording for the state the dealership sells in (section 7);
- no two vehicles sharing a paragraph word for word.

### Price

The advertised price must be the number the buyer actually pays, apart from government charges.
That is a legal requirement in most of the country, not a style preference (section 7). Price
changes should be occasional, modest, and applied by editing the listing rather than re-posting it.

### Photos

- Real photos of the actual vehicle, taken by the dealership.
- Enough of them to cover exterior, interior, dashboard with mileage, and any damage.
- Order varied between reps; the leading photo chosen for impact, since photo clicks are counted.
- Correctly sized and not degraded, because photo engagement is a measured signal.
- Never a manufacturer stock image.

### Marking sold, and refreshing stale listings

Mark it sold, same day. For a vehicle that has gone stale, edit and adjust it rather than deleting
and re-posting — a delete-and-repost cycle is one of the most commonly reported flag triggers.

---

## 5. Sales rep accounts and profiles

- A credible profile has a real photo, a real history, some friends, and some ordinary activity.
  An empty profile created this week will not sell cars.
- New accounts need a warm-up period of ordinary use before the first vehicle goes up.
- One identity, one browser profile, one network route. These three must never be mixed between
  reps, and must never change unexpectedly for a given rep.
- Sales reps stay off the dealership's business manager. Linking a personal selling profile to the
  dealership's advertising account connects the two in Facebook's eyes.
- When a rep gets restricted: stop that account entirely, appeal once, do not create a replacement
  from the same machine or the same network, and check whether anything shared caused it before
  assuming it was bad luck.

---

## 6. Talking to buyers

- **Reply fast, but not instantly.** The only response standard Facebook publishes is for business
  pages — a 90% response rate and a 15-minute median reply time earns the "very responsive" badge.
  There is no published equivalent for personal profiles, but fast replies clearly help, and
  messages started with the seller are a counted ranking signal.
- **Phrasing must vary.** Identical opening lines across buyers is one of the clearest automation
  tells there is.
- **What the assistant may do:** confirm the vehicle is available, answer questions the listing
  data already answers, give the advertised price, offer appointment times, and collect a name and
  a callback number.
- **What it must never do:** negotiate the price, promise financing terms or approval, promise to
  hold a vehicle, state anything about the vehicle's history that is not in its record, or claim a
  warranty.
- **Hand off to a human** on any mention of a trade-in, financing, a deposit, a complaint, or
  anything the assistant has not been given an answer for.
- **Keep the record.** Every conversation stored against the vehicle and the rep, because a
  disputed statement about price or condition is a consumer protection problem, not a chat problem.
- **Consent before you text or email.** Following a Marketplace lead up by text message without
  documented consent is the most expensive mistake available here — US telephone consumer law
  carries statutory damages per message, and dealerships are currently an active target.

---

## 7. What the law requires a vehicle advert to say

This section is a working summary, not legal advice, and a dealer's own counsel should sign off the
wording before it goes live. Last checked 09/13/2026.

### The federal position

- **The advertised price must be the real price.** The FTC's dedicated car-dealer rule (the CARS
  Rule) would have made an all-in "offering price" mandatory nationwide, but it was struck down in
  full by a federal appeals court on 27 January 2025 and has never taken effect. That did not make
  hidden-fee pricing legal. The FTC continues to treat an advertised price that omits mandatory
  dealer charges as deceptive under general consumer protection law, and in March 2026 it sent
  warning letters to 97 dealer groups saying exactly that: the advertised price must be what the
  buyer actually pays, apart from required government charges such as tax.
- **The used car rule (the Buyers Guide).** The window sticker is a requirement at the lot, not in
  the advert. But if an advert mentions a warranty, it must not contradict the Buyers Guide.
- **Payment advertising triggers disclosure.** Under federal truth-in-lending rules, the moment an
  advert states a monthly payment, a down payment, a number of payments, or a finance charge, it
  must also state the down payment terms, the repayment terms, and the annual percentage rate. The
  practical rule for Marketplace: **do not put payments in listings.** Advertise the price.
- **Follow-up messaging is separately regulated.** Marketing texts and calls to a mobile number
  require prior express written consent; marketing email requires an accurate sender, a postal
  address, and a working unsubscribe.

### State by state

<!--STATE-TABLE-->

### The disclaimer that goes in every description

A single block, assembled per state, that states: the advertised price excludes tax, title, license
and registration; whether a documentary fee applies and its amount; that the vehicle is sold as-is
unless a written warranty is provided; that the price is subject to prior sale; and the dealership's
name and licence identification. Any state-specific wording from the table above is appended to it.

---

## 8. What exists today, and what does not

This is the part worth being blunt about.

### Built and working

- **The network side is done.** A connector agent runs at the dealership, dials out to our server,
  keeps a heartbeat, updates itself with signed updates, and enforces where traffic may go. Each
  sales rep's browser leaves the internet from the dealership's own address, consistently, which is
  the thing Facebook notices first and the thing most people get wrong.
- **The server side is done.** A tunnel server that fails closed, restricting traffic to Facebook's
  own domains once configured.
- **The hardware side is done.** A prepared card image, a card writer, first-run setup, and
  wireless, wired and AT&T cellular connection handling.
- **Fleet management is done.** Registration, heartbeats, bench testing, alerts, an on/off switch
  with an audit trail, and per-card access key rotation.
- **The database understands vehicles.** There is a table of listings with dealership, title,
  description, VIN, make, model, year, mileage, price, currency, photos, an external listing
  reference, status (draft, queued, posted, paused, sold, removed, failed), posted and sold
  timestamps, and the last error. There are functions to list, create and update them.

### Not built

None of the following exists anywhere in this code today.

| Missing piece | What it has to do | What it needs first |
| --- | --- | --- |
| Posting worker | Actually drive a browser through creating a Marketplace vehicle listing and record the resulting listing reference | The network stack (done) and a per-rep browser profile |
| Scheduler and throttle | Decide which vehicle goes up, from which rep, at what minute, respecting hours, spacing and daily caps | The posting worker |
| Description and title generator | Produce per-vehicle wording that is accurate, varied, and never duplicated | The vehicle data and the compliance engine |
| Compliance text engine | Assemble the correct legal wording for the dealership's state and attach it to every description | The state table in section 7, signed off by counsel |
| Photo pipeline | Take dealership photos, order and vary them, size them correctly, avoid reuse across accounts | Photo storage |
| Price and sold sync | Push price changes to live listings and mark vehicles sold promptly | The posting worker |
| Chat assistant | Answer buyers within the limits in section 6, vary phrasing, hand off to a human, log everything | The posting worker and a consent record |
| Per-rep behaviour profile | Give each rep consistent, individual habits — hours, pace, phrasing, volume | The scheduler |
| Health checks | Detect a rep being demoted and pause them before Facebook restricts them | Posting and chat, plus visibility data |

The connector documentation says this plainly: it is phase one, isolated, and deliberately not
wired into a posting stack. The technical design document lists posting automation as out of
scope. Both are accurate.

---

## 9. The order to build it in

Each step has to be proven before the next one starts. Skipping the proof is how a whole fleet of
accounts gets lost at once.

1. **Prove the network route.** One rep, one dealership, one browser profile, sitting behind the
   connector for a week of ordinary human use with no posting at all. Prove the address never
   changes and never leaks.
2. **Build the compliance engine and get it signed off.** Nothing should post before a lawyer has
   read the wording it produces. This is cheap now and ruinous later.
3. **Build the description, title and photo generators.** Run them over the real inventory and read
   the output by hand. Check that no two vehicles read alike.
4. **Build the posting worker, and post by hand-trigger only.** One vehicle at a time, one rep,
   watched. Confirm each listing appears, ranks, and receives views.
5. **Add the scheduler, throttle and per-rep behaviour.** Raise volume slowly — a few vehicles a
   day, then more, over weeks. Stop the moment views drop.
6. **Add price updates and sold synchronisation.** Prove a listing can be edited without being
   re-posted.
7. **Add the chat assistant**, human-reviewed at first, with every reply read before it sends,
   until the limits in section 6 are clearly holding.
8. **Add health checks and automatic pausing**, so a rep in trouble is pulled off before Facebook
   acts.
9. **Only then scale to more reps and more dealerships**, one at a time.

### The risk to keep in view

Automated posting to Marketplace runs against Facebook's own terms. Careful engineering reduces the
chance of being caught and reduces the blast radius when it happens; it does not make the activity
permitted. The system should therefore be built so that losing one rep account is a routine
inconvenience rather than an outage — separate identities, separate browser profiles, no shared
text, no shared photos, and no single change that can be applied to every account at once.
