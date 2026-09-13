# Getting a QConnect box online — cable, Wi-Fi or mobile data

The box tries every way it has, in order, forever. Nobody has to choose a mode,
and nothing needs a keyboard or a screen.

```text
  power on
     |
  1. network cable        plugged in?      -> online, done
     |  no
  2. Wi-Fi (flashed)      joins?           -> online, done
     |  no
  3. mobile modem         fitted + APN?    -> online, done
     |  no
  4. saved phone hotspot  in range?        -> online, done
     |  no
  5. its own setup hotspot: "QConnect-Setup-<id>", password qconnect123
     staff join with a phone, the page opens by itself, they pick a network
     |
     back to 1
```

"Online" means real internet: the box checks for an HTTP 204 response. A hotel
or guest network that shows a sign-in page is reported as `captive_portal`
instead of being mistaken for a working connection.

## What the person on site does

| Their situation | What they do |
| --- | --- |
| There is a spare network socket | Plug in the cable. Nothing else. |
| Wi-Fi details were given at the bench | Plug in power. Nothing else. |
| Wi-Fi password changed, or was wrong | Join `QConnect-Setup-<id>` on a phone (password `qconnect123`), the page opens by itself, pick the network, type the password. The page says straight away whether the password was right. |
| No Wi-Fi and no cable | Fit a USB modem with an AT&T SIM. The APN defaults to `broadband`; for IoT/M2M plans use `m2m.com.attz`, for MVNOs use `att.mvno`. |
| Nothing works yet | Tether to a phone hotspot once; it is remembered as a permanent fallback. |

## What you do at the bench

`qconnect/flash/provision-sd.sh` writes the card. Everything is optional except
identity, Tailscale key and database details:

```bash
./provision-sd.sh \
  --boot /Volumes/bootfs \
  --device-id QCN-0042 --dealer-id kendall-ford-meridian \
  --tailscale-key tskey-auth-...   `# ONE FRESH KEY PER CARD` \
  --supabase-url https://xyz.supabase.co \
  --supabase-anon-key sb_publishable_... \
  --supabase-service-key sb_secret_... \
  --wifi-ssid "DealerGuest" --wifi-pass "guestpass123" \
  --cellular-apn broadband \
  --hotspot-ssid "Sales iPhone" --hotspot-pass "..."
```

The writer now refuses to produce a card that cannot work:

- it **pre-registers the device itself** and stops if that fails. A card that
  was never pre-registered can never register later, no matter how good its
  Wi-Fi is — that was the single biggest cause of "identical cards, different
  outcome";
- it **refuses a Tailscale key it has already used**. A reused single-use key
  means only the first card of a batch joins and the rest loop forever;
- it points the first-boot hook at the **right boot mountpoint** for the OS
  version on the card (`/boot/firmware` on Bookworm, `/boot` on older), and
  warns loudly if the card is not Bookworm, which this kit requires because
  every network command is NetworkManager.

## Two Pi models, one real difference

| | Pi Zero 2 W | Pi 4 |
| --- | --- | --- |
| 2.4 GHz Wi-Fi | yes | yes |
| 5 GHz Wi-Fi | **no** | yes |
| Ethernet | via USB adapter | built in |

A 5 GHz-only dealer network is invisible to a Zero 2 W. It is not a fault and
no amount of retrying fixes it, so the box now says
`ssid_not_in_range_2g_radio` and the dashboard prints "This box only sees
2.4 GHz networks". Ask for the 2.4 GHz SSID, use a cable, or send a Pi 4.

## What the dashboard shows

Each box reports its path every five minutes, so the fleet page answers "why is
it offline?" without an SSH session:

- **Connected by** — cable, Wi-Fi (with the network name), mobile data, or the
  setup hotspot;
- **Signal** — percentage, flagged red below 30 %;
- a plain-English fault line: wrong password, network not in range, 5 GHz only,
  joined but no internet, sign-in page, no APN, and so on;
- **stuck at** — whether it is stuck getting online, joining the private
  network, or registering. A box that is online but not yet registered used to
  look identical to a dead box.

Faults clear themselves on the next good check-in, so nothing stale lingers.

## Failing over while running

`qconnect-netwatch.service` keeps watching after setup finishes. Unplug the
cable and it moves to Wi-Fi within about two minutes; plug it back in and it
returns to the cable. No reboot, no gap in check-ins, and the dashboard follows
along. Phase 8 of the bench checklist proves each of these before a card ships.
