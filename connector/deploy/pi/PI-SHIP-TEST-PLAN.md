# AutoPost Pi — full ship certification test plan (flash → certified → ship)

Run **top to bottom** on each new device. Every stage has: **what it proves**, **do this**, **PASS**, and **if it
fails**. Nothing is "done" until observed live on the hardware. The device is only **SHIP-CERTIFIED** after Stage 10.

Goal being certified: the dealership **just plugs in the box** — no commands, no phone-in — and it comes online,
routes their reps' Facebook traffic out **their own IP**, stays reachable to us (Platform + SSH), self-rescues a
wrong WiFi, and **never corrupts** on a power cut.

---

## Stage 0 — One-time setup (before the first flash)
**Proves:** the flash has everything it needs to be fully hands-off.
- [ ] **Tailscale key:** in the Tailscale admin console → Keys → generate a **Reusable + Pre-approved**, tagged
      (`tag:autopost`) key. This is the fleet SSH-recall key.
- [ ] Set it for the flasher: `AUTOPOST_TS_AUTHKEY=tskey-…` (or paste it into the flasher's Tailscale field).
- [ ] **Golden image present:** `autopost-golden.img.xz` in `%LOCALAPPDATA%\AutoPost\images\`. (The flasher now
      **refuses to flash** without it, and refuses without a Tailscale key — so a half-provisioned card can't ship.)
- [ ] **Create the dealership + claim code** on the super-admin **Connectors** page (Provision / "Ship a Pi" →
      `createDevice`), or reissue a fresh code. Copy the claim code.

## Stage 1 — Flash the card
**Proves:** the card carries the golden build + this dealership's identity.
- **Do:** AutoPost flasher → pick the SD card → enter dealership WiFi (SSID + password), the claim code, a login
      password → **ERASE + FLASH**. The confirm dialog names the **GOLDEN image**.
- **PASS:** the read-back panel shows `autopost-claim.env` (your claim code), `firstrun.sh`, `autopost-tailscale.env`
      (the key + `autopost-<dealership>`), and `cmdline.txt` with the firstrun hook. No errors.
- **Fail:** "golden image not found" / "no Tailscale key" → fix Stage 0. Wrong card → re-insert + reselect.

## Stage 2 — First boot & provisioning (the "just plug it in" test)
**Proves:** unattended bring-up — WiFi, hostname, claim, Tailscale — with **zero** commands.
- **Do:** card into the Pi → plug in power → wait ~3–4 min (first boot writes WiFi, reboots once, then claims).
      Watch on an HDMI monitor if you have one; otherwise go straight to Stage 3.
- **PASS:** it reaches a login prompt showing hostname `autopost-<dealership>` and prints a real `10.x`/`192.168.x`
      IP (NOT `127.0.1.1`). No manual steps taken.
- **Fail:** stuck at `127.0.1.1` = WiFi didn't join → go to Stage 7 (wrong-WiFi rescue). No claim yet = check Stage 3.

## Stage 3 — Platform connection (Live on the website)
**Proves:** the box claimed its identity and the super-admin platform can see + control it.
- **Do:** open the super-admin **Connectors** page.
- **PASS:** the device shows **Live** within ~1–2 min, correct **Host** (`autopost-<dealership>`), fresh heartbeat,
      a **Version**, and the action buttons (Log, Turn off, Restart, **Update**, Set WiFi).
- **Fail:** never appears = claim didn't land (bad code / no internet). SSH in (Stage 4) and check
      `journalctl -u autopost-claim -u autopost-connector`.

## Stage 4 — SSH recall, off-LAN (fully hands-off)
**Proves:** we can reach the box from anywhere with **no command run at the dealership** (the thing we just baked in).
- **Do:** from a DIFFERENT network (phone hotspot / your laptop off their LAN): `tailscale ssh autopost-<dealership>`
      (or the Connectors "terminal"). 
- **PASS:** you get a root/login shell over Tailscale without ever having touched the box. `tailscale status` on it
      shows it joined as `autopost-<dealership>`.
- **Fail:** not in the tailnet = the auth key was missing/expired → check `journalctl -u autopost-tailscale` and the
      key in Stage 0.
- [ ] **Disable key expiry** for this node in the Tailscale console (Machines → ⋯ → Disable key expiry) so a shipped
      box doesn't drop off the tailnet in ~180 days.

## Stage 5 — Egress & posting (the whole point)
**Proves:** reps' Facebook traffic actually leaves through the **dealership's** IP, and a real post publishes.
- **Do:** point a **test rep** at the tunnel (`custom_proxy = 127.0.0.1:<proxyPort>:<user>:<pass>`) → geo-check the
      exit (e.g. `geo.myip.link`) → run one real Marketplace post through that rep.
- **PASS:** the exit IP + geo = the **dealership's** location (not GoLogin's, not yours); the car **publishes** and
      the FB item link is captured.
- **Fail:** exit IP wrong = proxy/tunnel mis-wired. Post fails = separate posting issue (check the post's error text).

## Stage 6 — Remote control levers (from the Platform)
**Proves:** every management button actually drives the box.
- **Restart:** click Restart → the event log shows `restart-sent` and the connector reconnects.
- **Turn off (fail-closed):** Turn off → the rep's egress **stops immediately** (a post attempt gets nothing, HTTP
      000 — never a wrong IP) and Connectors shows **Off**. Turn on → egress resumes.
- **Update:** click **Update** → toast shows the pushed build hash/size and the device restarts on it. *(Known
      caveat: once the overlay is on in Stage 9, a pushed update runs now but reverts on the next reboot until the
      connector-on-data-partition follow-up. Config/claim/WiFi are unaffected.)*
- **Set WiFi:** push a WiFi from the modal → event log confirms; the box saves it as an additional network.
- **PASS:** all four behave as above.

## Stage 7 — Wrong-WiFi self-rescue (never-strand)
**Proves:** a mistyped WiFi fixes itself from a phone, with no SSH/card-pull (SSH is unavailable when offline).
- **Do:** flash a card with a **WRONG** WiFi password (or, on a live box, change the router password). Boot it and
      wait through the offline grace (~5–7 min).
- **PASS:** an **`AutoPost-Setup-XXXX`** WiFi appears; join it from a phone → the captive **AutoPost** setup page
      pops → pick the real network + correct password → the box joins, the AP disappears, it returns **Live**. Repeat
      with a **wrong** password → after the verify timeout the AP **reappears** with an error (it never strands).
- **Fail:** no AP after grace = check `journalctl -u autopost-wifi-recovery`.

## Stage 8 — Power outage & resilience (no overlay yet)
**Proves:** a power cut can't leave a rep on the wrong IP, and the box self-recovers.
- **Do:** pull the power for ~20s while a rep is routing → restore.
- **PASS:** while down, the rep **holds** (fail-closed, no egress) and Connectors flips **Offline** + alerts; on
      restore the box boots (~1–2 min) and reconnects on its own to **Live** — no touch. Do 2–3 hard cuts.
- **Diagnose (if it stays Offline):** Tailscale reachable + low uptime = power was lost; reachable + high uptime =
      internet loss; unreachable but hub back = connector issue (Restart). (Table in PI-SETUP-GUIDE.)

## Stage 9 — Corruption-proof: enable the overlay + persistence canary  ⟵ **the certification gate**
**Proves:** the read-only overlay stops SD corruption AND the identity/WiFi/Tailscale survive it. Hardware-only.
- **Do:** `sudo raspi-config nonint enable_overlayfs` (golden card only — `/var/lib/autopost` is its own partition,
      stays writable) → reboot → re-verify **Live**.
- [ ] `sudo autopost-selftest` → must print **SHIP** (all gates: data-partition persistent, clock/NTP, thermal,
      agent loads, EEPROM, video-group telemetry).
- [ ] **2× hard power-cut canary:** with the overlay ON, pull power twice. After **each** restore confirm: it comes
      back **Live**, on the **right WiFi**, as the **same** Tailscale node (`autopost-<dealership>`, not a new one),
      and the claim/config is intact. *(This is the only real proof the corruption-proofing holds.)*
- **PASS:** SHIP verdict + both power-cuts return a fully-intact box.
- **Fail:** a power-cut loses WiFi/claim/Tailscale = a persistence symlink didn't land → do NOT ship; capture
      `findmnt /var/lib/autopost`, `ls -l /etc/NetworkManager/system-connections /var/lib/tailscale`, and the
      selftest output.

## Stage 10 — Final ship gates
**Proves:** it's genuinely field-ready and recall-able for the life of the box.
- [ ] Tailscale key expiry **disabled** for this node (Stage 4).
- [ ] Undervoltage/thermal telemetry sane on Connectors (no under-volt flag — proves the PSU + video-group fix).
- [ ] `autopost-selftest` = **SHIP**; both power-cut canaries passed.
- [ ] Reboot once more (`sudo reboot`) → returns Live on the right network, same node, overlay on.
- **→ Mark shipped.** They plug in power at the dealership and un-pause their reps once the FB session is confirmed.

---

## Safeguards & resilience — what protects a shipped box
Every safeguard is baked in. **✅ = proven on real hardware** (2026-07-21, Rickys-Dealership test).

**Never routes through the wrong IP**
- ✅ **Fail-closed egress** — if the box can't reach us (wrong WiFi, offline, powered off) it routes **nothing**. Reps hold + retry; they never fall back to a wrong IP.

**Never a stranded or unreachable box**
- ✅ **Wrong-WiFi self-rescue** — offline past the grace window → the box raises an `AutoPost-Setup` WiFi + captive portal so the dealership re-enters the correct WiFi from a phone (password `autopost212`). No SSH, no card pull; a wrong password just re-raises the AP — it never strands.
- ✅ **WiFi-flap auto-recovery** — WiFi drops then returns → the connector **and** Tailscale reconnect on their own, no touch.
- ✅ **Unattended Tailscale SSH** — every box auto-joins the tailnet at first boot as `autopost-<dealership>`, so we can always reach it off-LAN through their NAT (no port-forwarding) to fix / update / restart.
- **Remote Set-WiFi** — push a corrected or new WiFi from the Connectors screen with nobody on site.
- ⚠️ **Key-expiry:** disable Tailscale key-expiry per node (Stage 4 / 10) **or** use a tagged key that auto-disables it — else a shipped box drops off the tailnet in ~180 days.

**Never ships a box we can't stand behind**
- ✅ **Flasher refuses a bad card** — won't flash without the provisioned golden image **and** a Tailscale key, so a card can never ship unclaimable or unreachable. The claim code is normalized (dash-safe) and the Tailscale key is sanitized to a single token.
- **Burn-in self-test gate** — `autopost-selftest` must pass; the Ship-a-Pi page blocks shipping a failed unit.
- **Undervoltage / thermal telemetry** — a dying PSU or blocked fan shows on Connectors before it takes a dealership offline.

**Never corrupts / never loses identity**
- ✅ **Zero-touch provisioning** — WiFi + claim code + Tailscale + hostname all baked at flash; the dealership only plugs in power.
- ✅ **One-time claim code** — consumed on claim; a used code can't re-onboard. Reissue a fresh code to re-provision.
- **AUTOPOST-DATA partition** — the claim token + WiFi live on a separate partition so they survive power cuts (and the read-only overlay once it's enabled + certified in Stage 9).
- (pending cert) **Read-only overlay + 2× power-cut canary** — Stage 9, hardware-only.

**Remote control (Connectors screen)** — Turn on/off (fail-closed pause), Restart, Set WiFi, Update (signed build push) — all over the control channel; nothing typed at the dealership.

---

## Stages worth adding later (not blockers for a pilot)
- **Router change after ship:** dealership changes their WiFi → the box auto-raises the setup AP again (Stage 7) OR
  you push the new WiFi from Connectors (Set WiFi). Verify once.
- **Durable remote updates under overlay:** relocate the connector onto AUTOPOST-DATA so a pushed Update survives a
  reboot (today it reverts under the overlay — Stage 6 caveat). Then re-run Stage 6 + Stage 9.
- **Automated canary:** `pre-ship-overlay-check.sh` to make Stage 9's 2× power-cut a single scripted verdict.
- **Per-device Tailscale keys:** have the hub mint a per-device tagged key at `createDevice` (instead of one fleet
  key) so a single card can't re-auth others.
- **Multi-rep concurrency:** if a dealership runs several reps through one box, confirm N concurrent sessions egress
  correctly under load.

_Last updated: 2026-07-21._
