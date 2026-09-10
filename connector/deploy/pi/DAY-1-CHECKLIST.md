# Day-1 checklist — from box to "Live" (~30 min)

Follow top to bottom. Steps that need decisions or our VPS values are marked **[with Claude]** — do those
together so nothing is guessed.

## A. Do NOW (while it ships) — 3 quick things
1. **Tailscale account + auth key** (this is our remote terminal / reach into every device).
   - Sign up free at `tailscale.com` (the free plan covers 100 devices).
   - Settings → **Keys** → **Generate auth key**: make it **Reusable**, **Pre-approved**, expiry ~90 days, and
     add a tag like `tag:autopost`. Copy the `tskey-...` string somewhere safe — that's the `TS_AUTHKEY` we bake in.
2. **Install Raspberry Pi Imager** on your Windows PC: `raspberrypi.com/software` (free).
3. **Decide the pilot target [with Claude]:** the safest first test is a **throwaway test tunnel** (does not
   touch Brad/Roger/Jasmine who are live). We'll create that tunnel entry + config the day the Pi is here so it
   never disturbs the live reps.

## B. When the box arrives — assemble (5 min, no tools)
1. Stick the heatsinks on the three chips (peel-and-stick).
2. Snap the Pi into the case; clip the fan onto the top and push its plug onto the GPIO pins (red=5V, black=GND —
   the case guide shows it).
3. Put the SD card in the slot (bottom of the board).
4. **Skip the PiSwitch** — plug the power supply straight into the Pi later (nothing to accidentally switch off).

## C. Flash the card (10 min, on your PC)
1. Put the SD card into the included USB card reader → into your PC.
2. Open Raspberry Pi Imager:
   - **Device:** Raspberry Pi 4
   - **OS:** Raspberry Pi OS **Lite (64-bit)** (under "Raspberry Pi OS (other)")
   - **Storage:** the SD card
3. Click the **gear / Edit Settings** before writing and set:
   - **Hostname:** e.g. `autopost-pilot`
   - **Enable SSH** → "Use password authentication", set a username `pi` + a password you'll remember
   - **Configure WiFi:** your OWN test WiFi (SSID + password) + country `US`
   - Locale/timezone: your zone
4. **Write**, then eject and put the card in the Pi.

## D. First boot + install (10 min)
1. Plug in Ethernet if you have it (optional), then plug the **power supply into the Pi** — it boots.
2. From your PC, SSH in: `ssh pi@autopost-pilot.local` (or its IP). First boot takes a couple minutes.
3. Get the connector onto it, then run the installer **[with Claude for TS_AUTHKEY + copy method]**:
   ```bash
   # (Claude will give the exact copy/clone command for the connector)
   TS_AUTHKEY=tskey-XXXX  sudo bash desktop-connector/deploy/pi/install.sh
   ```
   This installs Node, the connector, the 24/7 auto-restart service, and joins Tailscale.

## E. Give it its identity + WiFi
1. **Identity (config.json) [with Claude]:** we drop `/var/lib/autopost/config.json` with the test tunnel's
   `controlUrl` (wss://...) + `dealershipToken` + proxy creds. (Claude prepares these from the VPS tunnel server
   when the Pi is here, without touching the live tunnel.)
2. **WiFi (already pre-set in Imager, but to confirm/change):**
   ```bash
   sudo bash desktop-connector/deploy/pi/set-wifi.sh "YourWiFiName" "your-wifi-password"
   ```
3. Start it: `sudo systemctl start autopost-connector && journalctl -u autopost-connector -f`

## F. Verify it's Live
1. It should show **Live** on the super-admin **Connectors** screen within ~1 min (fresh heartbeat, correct host).
2. Point a **test rep** at the tunnel and confirm a post egresses the Pi's IP (geo-verified). **[with Claude]**
3. **Pull the power** for 20s → the rep is held (fail-closed) + Connectors goes Offline. **Power back** → it
   auto-reconnects. Then a couple of hard power-cuts to prove nothing corrupts.
4. From your phone/another network: **restart** it from Connectors, and `tailscale ssh autopost-<host>` to get a
   terminal — proving super-admin can always reach it.

## G. Make it bulletproof — LAST, only after F passes

⛔ **Do NOT run `enable_overlayfs` on a card set up this way (sections C-D = plain Pi OS + `install.sh`).** On this
layout `/var/lib/autopost` (the claim token) and the saved WiFi live on the ROOTFS, so the read-only overlay would
EVICT both on the first power cut = a permanent, physical-recovery-only brick (`install.sh` refuses it for exactly
this reason). The overlay is ONLY safe on the **golden image** flashed with the AutoPost flasher, which bakes a
separate `AUTOPOST-DATA` partition and symlinks the WiFi store onto it.

On a **golden** card, enable it as the last step — and the guard below refuses to run on any other layout:
```bash
# GOLDEN CARDS ONLY. Refuses unless /var/lib/autopost is its OWN partition (i.e. AUTOPOST-DATA is mounted):
if mountpoint -q /var/lib/autopost; then sudo raspi-config nonint enable_overlayfs; echo "overlay enabled"; \
  else echo "NOT a golden card — /var/lib/autopost is not a separate mount. Do NOT enable the overlay (it will brick this card)."; fi
```
On a golden card `/var/lib/autopost` (config + claim token + WiFi) stays writable under the overlay. Reboot,
re-verify Live, then run `sudo autopost-selftest` (must print SHIP) + a 2x hard power-cut persistence check.
**For production, use the golden flasher flow — not this manual path.**

---
**What Claude handles (so you don't guess):** the connector copy command, the test-tunnel config values, pointing
a test rep at it, and the live post/geo verification — all without disturbing the 3 live tunnel reps.
