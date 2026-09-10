# AutoPost

Everything for programming AutoPost Pi cards, in one folder.

## To flash cards

Double-click **`START-HERE.bat`**. That is the only file you need.

It checks that every required file is present, installs Raspberry Pi Imager if it is missing,
loads the bench settings, and starts the app. If anything is missing it lists all of it at once
and stops without changing anything.

---

## What is in here

| | |
|---|---|
| `START-HERE.bat` | **The launcher.** Preflight check → prereqs → bench settings → start the app. |
| `bench-settings.cmd` | WiFi, fleet SSH key, Pi password, Tailscale key, default hardware model. **Contains real secrets** — see below. |
| `app\` | The packaged flasher application. Runs as-is; no build step, no `npm install`. |
| `images\` | The golden Pi images that get written to cards. Rebuilds land here directly; the previous one is kept as `...ARCHIVED-<date>.img.xz`. |
| `imager_latest.exe` | Raspberry Pi Imager installer. This is the actual write engine — the app shells out to it. |
| `source\` | Editable source for everything: the flasher, the Pi connector, and the VPS hub. |
| `tools\` | Occasional-use utilities. Not needed to flash a card. |

### tools\

| | |
|---|---|
| `VERIFY-PI.cmd` | Check a freshly-flashed Pi actually came up and claimed. |
| `USB-SSH.cmd` / `USB-LINK.cmd` | Reach a Pi over the USB gadget link. |
| `RUN-TESTS.cmd` | Run the whole test suite. Pure Node, no install needed. |

---

## Secrets

`bench-settings.cmd` holds the fleet Pi password and the Tailscale auth key. They are **the same on
every unit shipped**, and sshd listens on the dealership LAN — anyone who obtains that file can log
into any Pi already in the field.

Keep this folder off shared drives and out of git. To rotate, change the values in that file and
re-flash; cards already shipped keep the old ones.

---

## Where each piece actually runs

This matters, because only one of the three runs on this PC.

| Component | Source | Runs on | How a change ships |
|---|---|---|---|
| **Flasher** | `source\flasher\`, `source\electron-main.js` | **This PC** | `app\resources\app\` is loose JS, so copying changed `flasher\*.js` there takes effect with no rebuild. |
| **Connector agent** | `source\src\agent.js` | Each **Pi in the field** | Baked into the golden image, *or* pushed live as a signed update. See below. |
| **Hub / tunnel server** | `source\server\` | The **VPS** (`marketplaceautopost.com`) | Deployed to the VPS. Nothing here starts it. |

The agent gets its `controlUrl` and dealership token from the claim flow on first boot — it is not
configured from this PC, and there is deliberately no way to point it at a local server.

### Getting an agent change to the fleet

Two paths, and they are independent:

1. **New cards** — rebuild the golden image, which writes straight into `images\`. Archive the current
   image first if you want a way back. Run under WSL as root, from a Git Bash / WSL shell:

   Pi Zero W, 32-bit (the fleet default; emulated, ~12 min):
   ```
   wsl -d Ubuntu -u root -- env ARCH=armhf \
     REPO=/mnt/c/Users/wills/Desktop/AutoPost/source \
     SRC_XZ=/mnt/c/Users/wills/Desktop/AutoPost/stock-images/raspios-lite-armhf.img.xz \
     OUT_DIR=/mnt/c/Users/wills/Desktop/AutoPost/images \
     bash /mnt/c/Users/wills/Desktop/AutoPost/source/deploy/pi/golden/customize-stock-image.sh
   ```
   Pi 4, 64-bit (native on this machine, faster):
   ```
   wsl -d Ubuntu -u root -- env ARCH=arm64 \
     REPO=/mnt/c/Users/wills/Desktop/AutoPost/source \
     SRC_XZ=/mnt/c/Users/wills/Desktop/AutoPost/stock-images/raspios-lite-arm64.img.xz \
     OUT_DIR=/mnt/c/Users/wills/Desktop/AutoPost/images \
     bash /mnt/c/Users/wills/Desktop/AutoPost/source/deploy/pi/golden/customize-stock-image.sh
   ```
   `ARCH` picks the emulator, the default stock image and the output name. The script refuses to write
   one variant's filename from the other's build, and asserts the stock rootfs really is the
   architecture claimed — a card flashed with the wrong one does not boot at all.

   Stock base images live in `stock-images\`. They are build **inputs**, deliberately kept out of
   `images\` so nobody flashes a bare Raspberry Pi OS onto a card by mistake.
2. **Pis already in the field** — the hub pushes a signed build over the control channel. That
   payload is `source\agent-build.js` + `.sig`, signed by `source\scripts\sign-build.js` with the
   private key that pairs with `UPDATE_PUBKEY_PEM` pinned in `agent.js`. The agent refuses anything
   unsigned.

> **`agent-build.js` has been regenerated** from the fixed `src\agent.js` (2026-08-17) and is now
> byte-identical to it. It was previously 514 lines against 657 — stale enough to predate
> `hostTelemetry`, `rootfsOverlay` and the data-plane wedge self-heal.
>
> **It is not signed.** The signing key lives off this machine (`sign-build.js` defaults to
> `C:\Users\Roger\.autopost-signing\autopost-agent-ed25519.key`), so it could not be signed here. The
> old signature signed the *old* bytes, so it was parked as `agent-build.js.STALE-DO-NOT-USE.sig`
> rather than left in place — otherwise the admin API would cheerfully push a build that every agent
> then rejects as a bad signature.
>
> To make it pushable:
> ```
> node scripts\sign-build.js agent-build.js <path-to-private-key>
> ```
> then upload `agent-build.js` **and** the new `.sig` to the VPS `agentBuildPath`.

---

## Current production images

**Both** were rebuilt 2026-08-21. They contain the link-refresh fix (fix 1 below) **and** the
capture-WiFi-on-first-boot support, so a no-WiFi card raises its AP straight away rather than after ~105s.

| File | Hardware | Notes |
|---|---|---|
| `autopost-golden-zerow.img.xz` | Pi Zero W (32-bit) — **fleet default** | Boots on every Pi ever made, including the 4. |
| `autopost-golden.img.xz` | Pi 4-class (64-bit) | Will **not** boot on an original Zero W. |

Each was verified after its bake by mounting the image and checking the connector actually inside it:
`agent.js` byte-identical to `source\src\agent.js` (md5 `fed7eb141682…`), the old faulty gate gone,
and the connector / claim / wifi-recovery / tailscaled services enabled. The 64-bit rootfs was also
confirmed to really be aarch64 rather than trusting the filename.

The previous images are kept as `...ARCHIVED-20260821.img.xz` (one generation back). If a build turns out bad
on hardware, rename the archived file back over the live one and carry on shipping while it is sorted out.

The `...ARCHIVED-20260817.img.xz` pair is the ORIGINAL pre-fix build. It still carries the session-cutting bug,
so it is not a rollback target — safe to delete.

> **This build machine is ARM64.** WSL reports `aarch64` / `arm64`. That means the 64-bit image builds
> **natively** (fast, no emulation) while the 32-bit Zero W image needs qemu. The build script detects
> this. Do not "fix" it by registering an aarch64 binfmt handler — on this host that handler matches
> WSL's own binaries and routes them through an interpreter that is itself one, so every process launch
> recurses until the kernel returns ELOOP and the whole WSL environment stops working.

## Capture WiFi on first boot

Tick **"No WiFi yet - set up on the Pi"** on a card's row to ship it with **no network credentials at all**.
For a dealership whose WiFi you cannot know in advance.

On first boot the Pi has nothing to join, so it raises its own **"AutoPost-Setup"** WiFi immediately. Someone
on site joins that network, the captive portal opens, they pick the dealership's network and type the password,
and the Pi saves it, reconnects and tears the AP down. Everything else on the card is written exactly as normal
- setup code, login password, SSH key, Tailscale key, timezone.

Two consequences worth knowing, both stated in the confirmation dialog:

- **The card cannot claim on the bench.** It has no network to reach the hub with, so `VERIFY-PI.cmd` will not
  see it. The bench network is deliberately withheld too - adding it would give the box a profile to chase,
  which is the exact wait this mode removes.
- **Someone has to be on site** with the Pi to finish setup. It will sit on its own AP indefinitely otherwise.

The Pi-side half lives in `source\src\wifi-recovery.js` (`noSavedWifi`): it detects "no saved profiles" from
live NetworkManager state rather than a flag baked on the card, so it is self-clearing the instant any network
is saved, and it equally rescues a box that lost its profiles some other way.

> Requires a golden image built on or after 2026-08-21 — both current images qualify. On an older image a
> no-WiFi card still works, but waits out the first-run graces (~105s) before the AP appears.

## Fixes applied 2026-08-17

All three came out of the connection logs for a device that was reconnecting every ~2 minutes and
alerting on every reconnect. Covered by `tools\RUN-TESTS.cmd` (26 new assertions).

### 1. The pre-cap link refresh never ran during a session — `source\src\agent.js`

The agent refreshes its control link before the dealership network's ~600s hard cap can sever it.
The gate was `streams.size > 0 → wait for idle`. But a rep's browser holds HTTP keep-alive sockets
to Facebook open for the whole session, so the socket count never fell back to zero while anyone was
working. The refresh only ever fired when nobody was posting; during real sessions the link aged
into the cap and the middlebox cut it, dropping every live stream.

The logs show this exactly — four cuts at ~10m13s of link age with 8–10 streams dropped each, versus
clean sub-second refreshes for the whole hour the box sat idle.

Now the gate is **byte quiet-time**, not socket count: refresh at the first lull with no bytes moving
on any stream (`streamQuietMs`, default 5s), and if no lull ever comes, refresh anyway at
`plannedReconnectMaxMs` (default 8 min, deliberately under the ~600s cap). A controlled 250ms blip we
choose beats an uncontrolled cut we do not. Both knobs are remotely tunable — no reflash needed.

### 2. Health alerts re-fired on every reconnect — `source\server\src\hub.js`

The de-dupe state (`_alerted`) and the throttled-word accumulator lived on the live agent entry,
which `registerAgent()` rebuilds from scratch on every connect — while the agent reconnects every
~2 minutes by design. So "alert once per condition until it clears" was reset every couple of
minutes: one device re-fired the identical alert ~30 times in 100 minutes, enough to bury a real one.
The accumulator, whose entire purpose is to outlive a brownout reboot, was being wiped just as often.

Both now live on the persistent per-device record, which survives reconnects.

### 3. The rootfs alert was a false positive — `source\server\src\hub.js`

It fires when a Pi reports a writable rootfs. But the v1 golden image ships the rootfs writable **on
purpose** — the read-only overlay is a certified follow-up (`customize-stock-image.sh`). So it was
true from first boot on every Pi in the fleet and could never clear.

Now off by default, behind `alertOnRootfsWritable` in the server config. Turn it on once the overlay
actually ships, at which point a writable rootfs really is drift worth paging about.

### 4. Reps got 503s for ~8s after every cut — `source\server\src\proxy-server.js`

When no Pi is live, the proxy refuses rather than falling back to the VPS's own network — leaking a
datacenter IP to Facebook is worse than a failed post. To avoid punishing reps for the routine
2-minute refresh, it waits a grace period for the Pi to re-dial before refusing.

That grace was **8 seconds**, sized against an estimate of "2-7s" written in the comment. The gaps
actually measured in the field are **8-9 seconds** — landing exactly on the limit, so reps were
still collecting `503 Tunnel Offline` for a few seconds after every cut.

Raised to 15s. The cost of being generous is one-sided: it only delays how quickly a genuinely
offline dealership is reported as offline, and stays well inside normal browser timeouts. The cost
of being tight is a failed post.

### Also: planned refreshes no longer page as outages

Because fix 1 can now close the link with streams still open, the hub would have paged "connector
went offline" on every forced refresh. The agent's close code and reason are now passed through, so a
clean `1000 / planned-refresh` is logged as `planned link refresh` instead of `failed closed` and
does not raise an immediate alert.

This grants no trust: streams still fail closed either way, and a "planned" close that does not come
back still alerts via the normal grace timer. Only the instant page is suppressed. As a side benefit
the event log now distinguishes the agent's own housekeeping from a real drop — in the original logs
the two were indistinguishable.

---

## Older copies

Nothing was deleted. These still exist and are now superseded:

- `Downloads\AutoPost-PI-DesktopApp-forDev\...\1-SOURCE-AutoPost-Pi-DesktopApp\` — the source this
  folder was built from. Byte-identical at the time of the copy, but **does not** have the fixes above.
- `Downloads\AutoPost-Pi-Setup-updated\AutoPost-Pi-Setup\` — the previous production bench.
- `Downloads\AutoPost-PI-DesktopApp-forDev\...\3-INSTALLER-...-portable-LATEST\` — despite the name,
  an older build that had already diverged. Ignore it.
- `Desktop\old\AutoPost-Pi-Programmer\` — byte-identical to 1-SOURCE.

Edit here from now on, so the copies stop diverging.
