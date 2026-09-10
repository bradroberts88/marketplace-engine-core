# AutoPost dealership tunnel on a Raspberry Pi — plug-and-forget 24/7

Turn a Raspberry Pi into the always-on device that routes a dealership's reps out through the dealership's own
internet. We prep it, ship it, they plug it in, it joins their WiFi, and it runs 24/7 with no babysitting.
Super-admin can always reach it remotely (restart, change WiFi, terminal) via Tailscale.

The relay itself (`src/agent.js`) is unchanged and cross-platform — this folder is only the Linux "wrapper"
(auto-start, read-only rootfs, WiFi, remote access).

## 1. Hardware to buy (per device)
- **Raspberry Pi 4 Model B (4GB)** — search Amazon: `Raspberry Pi 4 Model B 4GB`. (2GB works for the relay; 4GB
  is what's reliably in stock and leaves headroom for Tailscale + logging.)
- **Case with active cooling — Argon NEO 5 (or Argon ONE V2)** — search: `Argon NEO 5 Raspberry Pi 4` /
  `Argon ONE V2 Raspberry Pi 4`. Aluminum, excellent 24/7 cooling, rugged, looks professional on a dealer's shelf.
- **Official 27W USB-C power supply** — search: `Raspberry Pi 27W USB-C power supply` (under-voltage is the #1 Pi
  failure; use the real PSU, not a random phone charger).
- **microSD** — search: `SanDisk High Endurance 32GB microSD` (endurance card; with the read-only rootfs, wear is
  minimal anyway).
- Fastest single purchase: a **CanaKit Raspberry Pi 4 4GB Starter Kit** bundles the Pi + PSU + case/fan + SD.
- **At fleet scale (later): Compute Module 4 (eMMC)** on a carrier board — no microSD to ever corrupt.

There is no power button: **plug in = on**, designed for continuous 24/7 operation. With the read-only rootfs a
power cut just reboots it clean, so **no battery/UPS is needed**.

## 2. Image a device (one-time prep, in-house)
1. Flash **Raspberry Pi OS Lite (64-bit)** with Raspberry Pi Imager. In Imager's settings, pre-set the hostname,
   enable SSH, and (optionally) the dealership WiFi so it's reachable on first boot.
2. Copy this `desktop-connector` checkout onto the Pi (or `git clone`), then:
   ```bash
   TS_AUTHKEY=tskey-...   sudo bash deploy/pi/install.sh
   ```
   Installs Node 20, the connector at `/opt/autopost/connector`, the self-restarting systemd service, and joins
   Tailscale (super-admin remote access).
3. **Provision the dealership WiFi** (pre-load what we got at onboarding):
   ```bash
   sudo bash deploy/pi/set-wifi.sh "DealerWiFiName" "their-wifi-password"
   ```
4. **Give it its identity** — either:
   - **Pilot:** drop the pre-made `config.json` (controlUrl + dealershipToken + proxy creds) at
     `/var/lib/autopost/config.json`, OR
   - **Fleet:** put a one-time claim on the boot partition `/boot/firmware/autopost-claim.env`
     (`CLAIM_URL=...` + `CLAIM_CODE=...`); `autopost-claim.service` self-provisions on first boot.
5. Start + verify locally: `sudo systemctl start autopost-connector && journalctl -u autopost-connector -f`.
6. **LAST step, only after everything works:** make the OS read-only so power cuts can't corrupt it:
   ```bash
   sudo raspi-config nonint enable_overlayfs
   ```
   `/var/lib/autopost` stays writable (the claim token, heartbeat, and signed self-updates persist there).

## 3. Ship + go live (the plug-and-forget flow)
1. **Ship the device.** The dealership plugs in **power** (and Ethernet if handy; otherwise the pre-loaded WiFi).
2. It boots, joins the network, Tailscale comes up, the connector dials our VPS hub, and appears **Live** on the
   super-admin **Connectors** screen within ~1 minute. No sign-in, no config, nothing for the dealership to do.
3. Super-admin points that dealership's reps' GoLogin profiles at the tunnel
   (`custom_proxy = 127.0.0.1:<port>:<user>:<pass>`) and un-pauses them once the FB session is confirmed live.
   Those reps now egress the dealership's own IP — gate-exempt (always green), un-metered, never drifts.
4. **Forever after:** it just runs. If it drops offline, the tunnel is **fail-closed** (those reps do not post,
   never fall back to another IP) and Connectors flips to Offline + alerts.

## 4. Super-admin remote control (always reachable)
- **Restart / pause / config / signed update:** from the **Connectors** screen (rides our own control channel).
- **Change WiFi** (onboarding gave the wrong password): SSH in via Tailscale and run `set-wifi.sh` (a
  Connectors-screen "Change WiFi" button that pushes this down the control channel is the follow-up build).
- **Terminal:** `tailscale ssh autopost-<hostname>` from an admin machine — a real shell on the Pi from anywhere.

## 5. Security posture (why this is safe to put on a dealer's network)
- **Outbound-only:** the Pi dials OUT to our VPS over encrypted `wss://`. No inbound ports are opened on the
  dealership's network, so it can't be reached/attacked from the outside.
- **Locked to Facebook + LAN-isolated:** the relay only forwards to the Facebook host allowlist on port 443 and
  is blocked from touching the dealership's internal/RFC1918 network.
- **Fail-closed:** device off = those reps don't post; traffic never leaks to any other IP.
- **Remote access is WireGuard** (Tailscale/Headscale): modern audited crypto, device-authenticated, admin-only
  — not a hand-rolled remote shell. Cost is free up to 100 devices; self-host **Headscale** on our VPS for
  $0/device + zero third-party dependency once we scale.
- **Signed updates:** the fleet only accepts Ed25519-signed builds (private key held off-server), so nobody can
  push malicious code to the devices.

## 6. Verify before shipping to a real dealership
1. Headless boot → **Live** on Connectors with a fresh heartbeat.
2. A test rep posts → the listing's egress IP is the Pi's dealership IP (geo-verified, e.g. geo.myip.link).
3. **Pull the plug** mid-idle → tunnel 503s, rep held, Connectors Offline + alert. **Power back** → auto-recovers.
   Repeat as a **hard power-cut** → read-only rootfs survives with no corruption.
4. From off-site: **restart** it, **change its WiFi** to a second network and confirm it re-joins, and **SSH a
   terminal** in via Tailscale — all without touching the device.
5. Run 24/7 for a week (watch the ~240s keep-alive hold the link) before calling the image fleet-ready.

---
_Files here: `install.sh` (one-shot installer), `autopost-connector.service` (24/7 auto-restart),
`autopost-claim.service` (fleet self-provisioning), `set-wifi.sh` (pre-load / remote-change WiFi)._
