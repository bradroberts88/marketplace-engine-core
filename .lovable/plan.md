# Look at the card first, then decide

Two things to clear up before anything gets erased.

## First: that card is not in Google Drive

BOOTFS is the small visible part of the memory card sitting in your laptop's card
reader. Google Drive is storage on the internet — it cannot see a card plugged
into your laptop, and I cannot reach your laptop at all from here. So everything
below is you clicking, me telling you what it means.

There is one thing worth ruling out: if a backup or sync program on the laptop
has started copying the card into the cloud by itself, we want to know that
before we erase anything. The first step below settles it in about thirty
seconds.

## What we will do, in order

### Step 1 — find out where BOOTFS actually is (2 minutes)

You open the drive listing on your laptop, look at one line of text, and read it
back to me. That tells us whether it is the card reader (expected and fine) or
something syncing it (stop and think). I will give you the exact clicks, written
for someone who has never done this.

### Step 2 — read what is on the card (5 minutes)

Rather than guessing what the previous person put on these Pis, you open the card
and read me back what you see. I only need the names of the things in the top
level of that drive — no file contents, nothing to interpret. From those names I
can tell you exactly which of three situations you are in:

- **Our current software, already correct.** Nothing to do but check a version.
- **Our software, but an older version.** This is where the known card-killing
  bug lives — a card can look perfectly healthy, boot, and never finish setting
  itself up. Fixable in place, or by starting fresh.
- **Someone else's setup, or the factory system.** Start fresh; nothing on it is
  worth keeping.

One caution: I will ask you **not** to open or read one particular file out loud.
It holds this card's private access code, and anything read into a chat should be
treated as public from then on.

### Step 3 — decide, together

Once I know what is actually on the card, I will tell you plainly which of these
to do and why:

- **Wipe and start fresh.** Slower (about 40 minutes per card, mostly waiting),
  but you end up with a card whose history you know. My default recommendation
  for hardware that arrived from someone else.
- **Clean up in place.** Faster, only sensible if the card already holds our
  software and the only problem is that it is out of date.

Either way the actual work is already written for you: the step-by-step guide and
the tick sheet from the last session, plus the Windows preparation tool that does
the fiddly part by itself.

## The blocker I have to repeat

Whichever route we take, the final step registers each card with the fleet system
so the Pi can phone home. **That system is not switched on yet.** It is written
and tested, but it lives in the QConnect Fleet Manager project and can only be
activated from inside there.

The preparation tool knows this: rather than write a card that could never
register, it stops and tells you. So we can do all of the looking and deciding
now, and the writing as soon as that is on.

## What I will not do

- Not tell you to erase anything before we have looked.
- Not touch the second Pi's card until the first one is proven end to end.
- Not have you read the card's private access code into this chat.
