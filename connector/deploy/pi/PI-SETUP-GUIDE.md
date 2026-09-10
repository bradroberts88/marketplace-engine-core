# AutoPost Pi — full setup guide (flash → Live), repeatable for every dealership

A Raspberry Pi that routes a dealership's Facebook traffic out through **their own internet** (a fixed, local,
un-metered IP that never drifts). Prep it in-house, ship it, they plug in power — it runs 24/7 with no babysitting.
This is the exact end-to-end process; follow it top to bottom for each new device.

---

## 0. What you need (once)
- **Hardware:** Raspberry Pi 4 kit (CanaKit 4GB): the Pi, official 27W USB-C power supply, case + fan + heatsinks,
  microSD card + USB card reader. (For the fleet later: Compute Module 4 w/ eMMC — no card to corrupt.)
- **On your PC:** Raspberry Pi Imager (`raspberrypi.com/software`).
- **A Tailscale account + reusable auth key** (`tailscale.com` → Settings → Keys → Generate → **Reusable** +
  **Pre-approved**, ~90-day expiry). This is our remote terminal into every shipped device. Copy the `tskey-…`.
- **The dealership's WiFi** SSID + password (collect at onboarding) and their **market location** (for the WiFi
  country code + the rep geo). The WiFi **must have a 2.4GHz band** — the Pi joins **2.4GHz only**, not 5GHz.
  Most routers broadcast both under one name (fine); a **5GHz-only** network cannot be used (rare — fall back to a
  2.4GHz network or a phone hotspot set to 2.4GHz). 2.4GHz is also more reliable for a 24/7 headless device.

---

## 1. Flash the SD card (Raspberry Pi Imager, ~10 min)
1. Card into the USB reader → into your PC.
2. Imager → **Choose Device:** Raspberry Pi 4.
3. **Choose OS:** *Raspberry Pi OS (other)* → **Raspberry Pi OS Lite (64-bit)** (no desktop = headless).
4. **Choose Storage:** the SD card. ⚠️ It shows as a generic *"Mass Storage Device USB Device"* at ~29.8 GB (a
   32 GB card's real size) — pick THAT, never a large external drive. Writing erases it (that's expected).
5. **Next → Edit Settings (⚙️)** BEFORE writing — this is what makes it come up headless + ready:
   - **Hostname:** `autopost-pilot` (or `autopost-<dealership>` for a real one).
   - **User:** username **`pi`** + a password (SSH password auth uses this account).
   - **Wi-Fi:** the dealership's SSID + password. **Country = where the Pi will physically sit** (Toronto test =
     CA; a US dealership = US). This is the radio's legal-channel setting — NOT where the customers are.
   - **Localisation:** their time zone (cosmetic — only affects log timestamps).
   - **Remote access / Services:** **Enable SSH → Use password authentication.**
   - Leave **Raspberry Pi Connect OFF** (we use Tailscale instead).
6. **Save → Write → confirm erase (red button).** Let it write + verify (don't pull the card). When it says
   **Done**, it auto-ejects.

## 2. Boot the Pi
1. Card into the Pi (slot on the **underside**). Assemble the case/fan if you want.
2. Plug in **power** (USB-C). **Ethernet** too if handy = the most reliable first boot. No power button — plug = on.
3. Wait **~2–3 min** (first boot expands the filesystem + joins WiFi). If you have a monitor you'll see it reach a
   `autopost-pilot login:` prompt and print `My IP address is 10.x.x.x` — no need to log in there.

## 3. SSH in from your PC
Same-network only for now (a private `10.x` address is reachable only from inside the dealership's LAN — that's
why we add Tailscale next for anywhere-access):
```
ssh pi@autopost-pilot.local        # or the IP it printed, e.g. ssh pi@10.0.0.55
```
Type `yes` to trust the host on first connect, then the `pi` password. You land at `pi@autopost-pilot:~ $`.

## 4. Get the connector onto the Pi + install (`[with the AutoPost team]`)
**The Fbtool-Scaling repo is PRIVATE**, so a plain `git clone` on the Pi prompts for GitHub creds and fails — and
we do NOT want GitHub credentials on a shipped device. Two supported ways to land the code:

- **Fleet (the real way):** bake the connector into the **master image** at build time, so a flashed Pi already has
  `/opt/autopost/connector` — zero copying, zero creds. Standardize this once the image is locked.
- **Pilot / one-off:** copy `desktop-connector/` onto the Pi from a machine that has the repo, over the LAN, without
  `node_modules`:
  ```
  # on the machine that has the repo:
  tar czf connector.tgz --exclude=node_modules --exclude=_cl --exclude=_e2e --exclude=_fe2e --exclude=build -C /path/to/Fbtool-Scaling desktop-connector
  scp connector.tgz pi@<pi-ip>:/home/pi/
  # on the Pi:
  tar xzf ~/connector.tgz && cd ~/desktop-connector
  ```
  (An agent driving via an SSH key it added to `~pi/.ssh/authorized_keys` does all of this directly, headless.)

Then run the installer (passwordless `sudo` is the Pi-OS default, so an authorized key can run it):
```
sudo TS_AUTHKEY=tskey-XXXXXXXX bash deploy/pi/install.sh
```
`install.sh` is idempotent: installs Node 20, copies the connector to `/opt/autopost/connector`, installs its one
dependency (`ws`), creates the **self-restarting systemd service** (`autopost-connector`), and **joins Tailscale**.
Takes **~5-10 min** (Node download). Without `TS_AUTHKEY` it still installs — join Tailscale after with
`sudo tailscale up --ssh --authkey tskey-… --hostname "$(hostname)" --accept-dns=false`.
> If a script errors with `\r` / "bad interpreter", it has Windows line endings — `sed -i 's/\r$//' deploy/pi/*.sh` and re-run.

## 5. Give it a tunnel identity (claim code)
The connector self-provisions from a one-time claim code (generic image + code = nothing hand-edited per device).
1. **AutoPost team mints a code** on the tunnel's admin API (loopback on the VPS; test tunnel = Idaho on `:8791`).
   Header is **`x-admin-token: <adminToken>`** (NOT `Authorization: Bearer` — that returns 401):
   ```
   curl -s -X POST -H "x-admin-token: <adminToken>" -H "content-type: application/json" \
     -d '{"name":"<Dealership>","city":"<City>"}' http://127.0.0.1:8791/admin/dealerships
   # → { id, claimCode, proxyUser, proxyAuth:{user,pass} }  (claim valid 24h)
   ```
2. On the Pi, redeem it — `claim.js` takes **`<claimUrl> <code> <configPath>`** and writes the config (control URL
   + token + proxy creds). **The service runs as the `autopost` user, so chown the config to it** (claim.js writes
   it as whoever ran it — root):
   ```
   sudo node /opt/autopost/connector/src/claim.js https://<host>/<tunnel>-claim <CLAIM_CODE> /var/lib/autopost/config.json
   sudo chown autopost:autopost /var/lib/autopost/config.json
   ```
   (Idaho test-tunnel claim URL: `https://marketplaceautopost.com/idaho-claim`.)
3. Start it:
   ```
   sudo systemctl start autopost-connector
   journalctl -u autopost-connector -f      # watch it dial the hub + go online
   ```

## 6. Verify it's Live
1. Super-admin **Connectors** screen → the device shows **Live** within ~1 min (fresh heartbeat, correct host).
2. Point a **test rep** at the tunnel (`custom_proxy = 127.0.0.1:<proxyPort>:<user>:<pass>`) and confirm a post
   egresses the Pi's dealership IP (geo-verify, e.g. `geo.myip.link`).
3. **Resilience:** pull the power for 20s → the rep is held (fail-closed, never falls back) + Connectors flips
   Offline + alerts. Power back → it auto-reconnects. Repeat as a hard cut to prove nothing corrupts.

## 7. Make it bulletproof (LAST — only after 6 passes)
```
sudo raspi-config nonint enable_overlayfs   # read-only OS: power cuts can never corrupt the card
```
`/var/lib/autopost` (the AUTOPOST-DATA partition) stays writable, so the **claim token + heartbeat + corrected WiFi
persist** across power cuts. Reboot, re-verify Live. Ship-ready.

> **Known limitation (tracked):** the connector CODE lives on the rootfs (`/opt/autopost/connector`), so a *pushed
> code update* runs immediately but does NOT survive a reboot once the overlay is on — it reverts to the baked
> build. Config/claim/WiFi are unaffected. Until the connector is relocated onto AUTOPOST-DATA (GOLDEN-IMAGE-SPEC
> item 2), push durable code changes by re-flashing, or apply updates before enabling the overlay.

---

## Remote management (every shipped device, from anywhere)
- **Terminal:** `tailscale ssh autopost-<host>` (or from the super-admin Connectors screen).
- **Restart / pause / update:** buttons on the Connectors screen (over our control channel).
- **Change WiFi** (if onboarding got it wrong or the dealership changes networks):
  `sudo bash /opt/autopost/connector/deploy/pi/set-wifi.sh "NewSSID" "new-password"` — or push it from Connectors.
- **Reach it via Tailscale:** each device gets a stable `100.x` IP + name `autopost-<host>.<tailnet>.ts.net`
  (pilot: `100.82.76.52` / `autopost-pilot.tail36ac34.ts.net`). `tailscale ssh pi@autopost-<host>` from any tailnet
  member reaches it off the dealership's LAN, through their NAT, with no port-forwarding.
- **Disable Tailscale key expiry per device** (else its node key expires in ~180 days and the device drops off
  needing re-auth — bad for a shipped box): admin console → **Machines → the device → ⋯ → Disable key expiry**.
  For the fleet, use a **tagged** auth key (auto-disables expiry) — needs a one-time ACL tag definition. Note: the
  *auth key's* own 90-day expiry does NOT disconnect already-joined devices; it only limits using that key to
  onboard NEW ones.
- Fail-closed means a dropped device **never** silently routes a rep through the wrong IP — those reps just hold
  until it's back, and Connectors alerts.

## Health & analytics on the Connectors screen (live vitals + why-offline verdict)
Every device on the super-admin Connectors / Ship-a-Pi screen reports live host telemetry (refreshes on a
selectable **5 / 10 / 30 / 60s** interval, with a "vitals updated Ns ago" stamp), so a device's condition is visible
at a glance instead of SSHing in:
- **CPU heat** — `CPU NN°C` (amber ≥ 70 °C, red ≥ 80 °C: the Pi throttles, then shuts down).
- **Power** — undervoltage now / since-boot (a failing PSU or USB-C cable — the #1 cause of Pi instability).
- **CPU load, memory (free / total), swap, disk free** — a memory leak or disk-full shows here before the box wedges.
- **Uptime** — flags "rebooted Nm ago" (a short uptime means it recently power-cycled).
- **Network** — WiFi signal (dBm) or ethernet; a weak / roaming WiFi explains silent drops.
- **Storage durability** — SD-read-only (card failing) and overlay-off (a power cut can now corrupt the card).
- Plus the burn-in **self-test** verdict and the agent **version**.

**Why-offline verdict.** When a device drops and returns, the hub compares the outage length against the box's new
uptime and records a plain-English reason — a **reboot / power-cut** (undervoltage pins it on the PSU) vs the box
**staying powered** (a dealership internet / WiFi drop, or a software restart). An operator-triggered restart /
update / config is labelled *expected*, not blamed on the ISP. A **health-history timeline** per device shows the
connect / drop / health-alert / recovery trail, so a flapping or brown-out pattern is visible; and a device that is
STILL offline shows its last-known vitals + the likely cause. This automates the manual table below.

New agent telemetry fields (network type, WiFi signal, CPU load, total RAM, swap, model) reach a device on its next
**re-flash** (unsigned agent code is not remote-pushed); temperature, power, disk, uptime and the verdict work on
the current fleet today.

## Troubleshooting: a device is Offline — power vs internet vs connector
**Now largely automated** — the Connectors screen shows a computed why-offline verdict (see *Health & analytics*
above). This table is the underlying logic and the fallback when diagnosing by hand.
Three DIFFERENT causes look similar on the Connectors screen. Diagnose with the **two independent channels** —
the tunnel hub and Tailscale — plus the device's uptime when it returns:

| Tunnel hub | Tailscale reachable (`tailscale ssh`)? | Uptime on return | Diagnosis | Action |
|---|---|---|---|---|
| down | **YES** | (still up) | **Connector/tunnel issue** — device is POWERED + online | Restart it remotely: Connectors screen, or `sudo systemctl restart autopost-connector` over Tailscale |
| down | **NO** | **low** (`up 0 min` after it returns) | **Power was lost** — it rebooted when power came back | On-site: check the power brick / the site's power. Reps held safely the whole time. |
| down | **NO** | **high** (never rebooted) | **Internet lost** — device stayed up but couldn't reach us | On-site: check the dealership WiFi / router / ISP. |

Proven behaviour (power-cut test 2026-07-12):
- **Fail-closed while down:** a rep request through the tunnel returns nothing (HTTP `000`) — **no egress, never a wrong IP**. Reps just hold + retry.
- **Auto-recovery:** on power restore the Pi boots (~1-2 min) and the connector reconnects on its own — no touch (verified: down 23:41 → reconnected 23:44, clean boot, no corruption).
- Fully telling "power off" apart from "total internet loss" while the device is unreachable needs either a UPS that signals power-loss before dying, or the dealership confirming (LEDs off = power; their other devices offline = internet). Tailscale reachability + reconnect-uptime narrow it — see the super-admin TODO in the roadmap.

## Per-dealership checklist (the repeatable bit)
1. Collect their **WiFi + market location** at onboarding.
2. Flash an image with **their WiFi + country = their location**, hostname `autopost-<dealership>`.
3. Install (clone + `install.sh` with the Tailscale key), mint + redeem a **claim code** for that dealership.
4. Verify **Live** + a geo-checked test post, run the power-cut checks, enable the read-only rootfs.
5. Ship. They plug in power. Point their reps at the tunnel + un-pause once the FB session is confirmed.

_Last updated: 2026-08-02 (added Health & analytics: live vitals + why-offline verdict)._
