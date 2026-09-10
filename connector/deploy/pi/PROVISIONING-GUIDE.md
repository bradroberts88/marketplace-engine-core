# Ship a Pi — 10-minute Virtual-Assistant guide

Goal: take a blank Raspberry Pi 4 and a dealership, and produce a **tested, ready-to-ship** tunnel device in ~10
minutes. **A Pi may NEVER ship unless the burn-in self-test is green** — once it's at a dealership we cannot
recall it, so every hardware/OS/thermal/power/network flaw must be caught HERE.

## What you need (per unit)
- Raspberry Pi 4B (4GB) **kit**: the **official 27W USB-C PSU** (under-voltage is the #1 failure — do not
  substitute a phone charger), a **case with a fan + heatsinks** (required for 24/7), a **fresh SD card**.
- An **Ethernet cable** for the bring-up bench (Wi-Fi is set later for the dealership).
- The pre-built **AutoPost Pi image** and the platform → **Ship a Pi** page open.

## Steps
1. **Create the device.** On the platform → **Ship a Pi** → enter the dealership name → **Create device**. Copy
   the **claim code** (valid 24h).
> **Before you touch a box:** the dealership's WiFi answers must already be collected — exact SSID, password,
> **hidden?**, **corporate/enterprise (username+password)?**, captive portal?, IT contact, backup network.
> The full intake questionnaire is **fb-tool `docs/ONBOARDING.md` § H**. A site with a **captive portal**, or one
> whose IT won't allow **outbound 443**, is a **NO-SHIP** until resolved — the box would arrive dead and we cannot
> recall it.

2. **Flash** the AutoPost image to the SD card (Raspberry Pi Imager).
3. **Drop the claim code.** On the SD card's boot partition, create **`autopost-claim.env`** (the device reads
   `/boot/firmware/autopost-claim.env` — nothing reads `claim.txt`) containing exactly two lines:
   ```
   CLAIM_URL=https://marketplaceautopost.com/claim
   CLAIM_CODE=<the code from step 1>
   ```
4. **Boot on the bench.** Insert the card, then the **official 27W PSU**. Power on. **WiFi-first** — the WiFi you
   set in the Imager is how it connects; Ethernet is only an optional fallback (dealerships rarely have a spare port).
5. **Wait ~2 min.** The Pi claims its config and appears **online** on the Ship-a-Pi page. The **burn-in runs
   automatically** (~4–6 min: power, RAM, SD integrity, thermals under load, network, services).
6. **Read the verdict on the page** (to re-run manually on the Pi: `sudo autopost-selftest`):
   - **✅ READY TO SHIP** → go to step 7.
   - **⛔ DEFECTIVE — do not ship** → open **Details**, fix the flagged item (usually swap the PSU/cable or the
     SD card, or fix the fan), then `sudo autopost-selftest` again. If it still fails → **quarantine the unit**.
7. **Set the dealership's Wi-Fi.** On the device row → **Set WiFi** → enter the dealership SSID + password (so it
   auto-joins on arrival). It stays fail-closed until it reconnects there.
8. **Label + box.** Put the dealership name + device ID on the case. Unplug. Ship.

## The pre-ship gate (what "DEFECTIVE" means) — any CRITICAL fail blocks shipping
| Check | Pass condition | Why it blocks shipping |
|---|---|---|
| power_undervoltage | `vcgencmd get_throttled` == `0x0` | a weak PSU/cable crashes + corrupts the SD in the field |
| ram_integrity | `memtester 200M` passes | bad RAM = random crashes |
| sd_write_read / sd_io_errors | 32MB write/verify OK; 0 mmc/EXT4 errors in dmesg | a failing card bricks the device |
| temp_under_load / no_throttle_under_load | peak < **70°C** and no throttle during a 2-min stress (tightened from 80°C for ~15°C of closet headroom) | marginal cooling/PSU only shows under load |
| os_arch / kernel_clean | aarch64; no panics/oops | wrong/corrupt image |
| node_version | Node ≥ 18 | connector won't run |
| connector_service | enabled + active | won't auto-start 24/7 |
| tailscale | up | **we could not reach the device after ship (cannot recall!)** |
| connector_config | valid config.json | not claimed to a dealership |
| net_link / hub_reachable | has a route; can reach the hub over 443 | a firewall would block the tunnel |

Non-blocking warnings (ship, but note): weak Wi-Fi signal, low disk, clock not NTP-synced (fix on the bench).

## In the field (after ship) — the platform watches these automatically
The connector sends **telemetry every ~20s** (temperature, undervoltage, disk, memory, uptime). The hub raises a
**health-alert** the first time a shipped Pi shows **undervoltage**, **overheating (≥82°C)**, **throttling**, or
**low disk** — so a dying PSU or a blocked fan at a dealership is caught before it takes the rep offline. Remote
**restart / change-WiFi / re-test / terminal (Tailscale)** all work without touching the device.

## Recovery (cannot-recall discipline)
- Every device MUST pass the `tailscale` gate — that is the guaranteed out-of-band way to SSH in, restart,
  re-provision, or wipe a shipped unit. If Tailscale is down at burn-in, DO NOT SHIP.
- If a device never phones home after ship: it's the dealership's Wi-Fi/power, not the device (the burn-in
  proved the hardware). Change-WiFi remotely once it's briefly on Ethernet, or walk the dealership through power.
