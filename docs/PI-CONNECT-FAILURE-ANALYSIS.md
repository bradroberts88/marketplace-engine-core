# Why some Pis connect and some don't — full defect review

Date: 2026-09-13. Scope: `qconnect/` (the new zero-touch kit) and `connector/` (the AutoPost
claim/tunnel path). Findings are ordered by how likely they are to explain a card that looks
identical to a working one and never comes online.

Legend: **BLOCKER** = card never connects. **FLAKY** = works on some hardware/images/runs.
**RISK** = wrong or silent behaviour that hides the real cause.

---

## A. The top five causes of "identical cards, different outcome"

### A1. BLOCKER — a card that was never pre-registered can never register
`qconnect_register` only updates a row that already exists with a matching token hash, and raises
`registration rejected` otherwise (`qconnect/supabase/03-token-hashing.sql`). `provision-sd.sh` does
**not** run the pre-registration — it only *prints* the SQL at the end:

```
select public.qconnect_preregister('QCN-0042', 'dealer', '<token>');
```

If the operator forgets that one line, `qconnect-setup.sh` loops `Registration failed. Retrying in
60s` forever. The card has Wi-Fi, has Tailscale, and is still "dead" to the fleet. This is a
per-card manual step, which is exactly the shape of "some work, some don't".

**Fix:** have `provision-sd.sh` call the pre-register RPC itself (service-role key) and refuse to
finish if it fails. Until then, treat the printed SQL as mandatory, not optional.

### A2. BLOCKER — one Tailscale auth key reused across a batch
`join_tailnet` calls `tailscale up --authkey` with the key baked into `provision.json`. If the
operator pastes the *same* single-use key into several cards, only the first one joins; every other
card loops `Tailscale join failed. Retrying in 60s` and never reaches registration. Worse, the
first successful card then rewrites the key to `REDACTED-AFTER-JOIN`, so a re-image of that card
also fails.

**Fix:** one key per card, or a reusable pre-approved tagged key with a generous expiry. Log the
`tailscale up` stderr instead of swallowing it.

### A3. FLAKY — 2.4 GHz-only radios vs 5 GHz dealer Wi-Fi
Pi Zero W and Pi 3 are 2.4 GHz only; Pi 4/5 are dual band. The same `provision.json` with a 5 GHz
(or band-steered 5 GHz-preferred) dealer SSID connects on one model and never sees the network on
another. Nothing in `qconnect-setup.sh` reports "SSID not found" — it just waits 180 s and drops to
the hotspot, which staff usually never see.

**Fix:** record the Pi model in the heartbeat, and have the portal say "network not in range"
rather than showing an empty scan list.

### A4. FLAKY — boot-partition mount race on the AutoPost units
`autopost-claim.service` and `autopost-tailscale.service` gate on files under `/boot/firmware` via
`ConditionFileNotEmpty=` / `ConditionPathExists=`, but neither unit declares
`RequiresMountsFor=/boot/firmware`. If the vfat partition is not mounted yet when systemd evaluates
the condition, a `Type=oneshot` unit is **condition-skipped for the whole boot** — `Restart=` never
applies to a skipped unit. The card then never claims and never joins the tailnet, and the journal
shows a benign "Condition check resulted in ... being skipped". Timing-dependent, so it hits a
minority of boots and a minority of cards.

**Fix:** add `RequiresMountsFor=/boot/firmware` to both units (the golden-image connector unit
already does this for `/var/lib/autopost`; the shipped
`connector/deploy/pi/autopost-connector.service` does **not** and has the same exposure).

### A5. BLOCKER — NetworkManager is assumed but not required
Every network action in `qconnect-setup.sh`, `qconnect-portal.py` and `qconnect-firstrun.sh` is
`nmcli`, and almost all of them end in `>/dev/null 2>&1`. On a Bullseye/legacy Lite image (dhcpcd +
wpa_supplicant, no NetworkManager) every one of those calls fails silently: no dealer profile, no
hotspot, no portal, no log line. The card boots, looks healthy over HDMI, and never connects.

**Fix:** assert `command -v nmcli` and that `NetworkManager` is active at the top of firstrun; fail
loudly to the log and the console if not. Pin the OS release in the build instructions.

---

## B. Boot / provisioning defects

| # | Severity | File | Defect |
|---|---|---|---|
| B1 | BLOCKER | `qconnect/flash/provision-sd.sh:99` | Kernel cmdline hardcodes `systemd.run=/boot/qconnect/qconnect-firstrun.sh`, while `qconnect-firstrun.sh` itself correctly probes `/boot/firmware` first. On any image where the boot partition is mounted at `/boot/firmware`, the path in the cmdline does not exist and firstrun never runs — the card boots as stock Pi OS. The AutoPost flasher already uses the proven `for BOOTDIR in /boot/firmware /boot` pattern; provision-sd does not. |
| B2 | FLAKY | `qconnect/flash/provision-sd.sh:61` | `head -c 32 /dev/urandom \| base64 \| tr -dc … \| head -c 40` under `set -euo pipefail`. The trailing `head` can close the pipe and SIGPIPE `tr` (exit 141), which `pipefail` turns into an abort mid-provision. It also yields a variable-length token (often <40 chars) because `tr` strips `+/=`. |
| B3 | RISK | `qconnect/flash/provision-sd.sh` | No validation that `--supabase-url` has no trailing slash. `"$SB_URL/rest/v1/rpc/…"` with a trailing slash produces a `//rest` path that some gateways 404 — registration then fails forever with no clue why. |
| B4 | RISK | `qconnect/boot-payload/qconnect-firstrun.sh:68` | The cmdline cleanup strips `systemd.run*` tokens but the `sed` only matches `systemd.unit=kernel-command-line.target` exactly; if provision-sd's line ordering ever changes the card re-runs firstrun on every boot. |
| B5 | RISK | `qconnect-firstrun.sh` | Runs with `set +e` and never checks a single install; a missing `/boot/firmware/qconnect/provision.json` produces a half-installed device that enables services with no identity. |
| B6 | BLOCKER (stale path) | `connector/deploy/pi/golden/stage-autopost/00-install-connector/01-run-chroot.sh` | Installs to `/var/lib/autopost/connector` while the shipped `autopost-connector.service` and `autopost-claim.service` point at `/opt/autopost/connector`. The stage patches the claim unit but not the connector unit. The stage is now guarded so it refuses to run — but any card built from it before the guard has a connector unit pointing at a non-existent path. Cards from different image vintages behave differently. |

## C. Wi-Fi / rescue defects

| # | Severity | File | Defect |
|---|---|---|---|
| C1 | FLAKY | `qconnect/device/qconnect-portal.py:31` | `nmcli device wifi list --rescan yes` while `wlan0` is in AP mode fails on brcmfmac (Zero W, Pi 3) — the chip cannot scan and host an AP at once. Staff see "(scan found nothing)" and usually stop there, even though manual entry works. |
| C2 | FLAKY | `qconnect-setup.sh:69` | The hotspot is created with `802-11-wireless.band bg` and no `wifi-sec` at all — an **open** AP. Some phones refuse to auto-open a captive portal on an open network with no internet, and iOS in particular may drop off after ~15 s. |
| C3 | RISK | `qconnect-setup.sh:87` | `apply_new_wifi` never verifies the new credentials. A mistyped password brings the profile "up" (NM returns 0 on activation attempt paths), the AP window closes, and the card sits offline for a full `WIFI_WAIT` + `AP_WINDOW` cycle (13 min) before staff get another chance. No wrong-password feedback ever reaches the portal. |
| C4 | RISK | `qconnect-setup.sh:42` | Captive-portal detection writes `last_block_reason` to local disk only. A dealership with a guest portal never connects and nobody upstream ever learns why. |
| C5 | RISK | `qconnect-setup.sh:65` | `QConnect-Setup-${DEVICE_ID}` is not length-checked; an SSID over 32 bytes silently fails to create the hotspot. |
| C6 | RISK | firstrun | Wi-Fi country is applied via `raspi-config nonint do_wifi_country` only. If `raspi-config` is absent (minimal/third-party images) the regdomain stays unset and the radio may be soft-blocked. The AutoPost flasher does this properly (modprobe conf + kernel cmdline + `rfkill unblock`); the QConnect firstrun does not. |
| C7 | RISK | `qconnect-setup.sh` | Hidden SSIDs are not supported at all — `nmcli connection add` without `802-11-wireless.hidden yes` never associates with a hidden dealer network. |

## D. Server / control-channel defects (AutoPost path)

| # | Severity | File | Defect |
|---|---|---|---|
| D1 | FLAKY | `connector/deploy/pi/autopost-connector.service` | No `RequiresMountsFor=/var/lib/autopost`. On data-partition images the `ConditionFileNotEmpty=/var/lib/autopost/config.json` can be evaluated before the partition mounts → unit skipped for the boot → the dealership shows offline until the next reboot. The golden variant has the guard; the shipped one does not. |
| D2 | RISK | `connector/src/agent.js` | Heartbeat floor is 5 s / default 20 s; the hub floors `heartbeatTimeoutMs` at 40 s. A dealership on a lossy uplink that misses two heartbeats is marked not-live and the proxy returns 503 with no retry — correct fail-closed behaviour, but indistinguishable from "the Pi is broken". |
| D3 | RISK | `connector/src/claim.js` | Non-2xx claim responses are collapsed into one message. `already_claimed` (re-flashed card with a used code) and a network failure look the same in the journal. Claim codes are strictly one-shot, so a re-flashed card is permanently dead until a new code is minted — a very common "this one Pi won't connect". |
| D4 | RISK | `autopost-claim.service` | Runs as `User=autopost` but reads `EnvironmentFile=` from the vfat boot partition. If the partition is mounted with restrictive `umask`/`uid` options the unit fails to start with a confusing `Failed to load environment files` rather than a claim error. |

## E. Telemetry defects that hide all of the above

| # | Severity | File | Defect |
|---|---|---|---|
| E1 | BLOCKER for diagnosis | `qconnect/device/qconnect-heartbeat.sh:31` | `curl -s -o /dev/null` and `exit 0`. HTTP 400/401/403 from the RPC is discarded. A device with a bad token heartbeats forever into the void and shows as "never seen". |
| E2 | RISK | same file | `temp_c`/`disk_free_mb` default to `0` when the read fails, so a genuinely failing sensor is indistinguishable from a healthy 0. |
| E3 | RISK | `qconnect-heartbeat.timer` | `OnBootSec=2min` with a 5-minute interval, but the setup service can legitimately take 15+ minutes (AP window). The first heartbeats are `ConditionPathExists`-skipped, so the fleet view stays empty long after the card is fine. |
| E4 | RISK | `qconnect-setup.sh` | Everything goes to `/var/log/qconnect-setup.log` on the card only. There is no "I am alive but stuck at step N" beacon, so a stuck card is indistinguishable from a dead one without physical access. |

## F. Security / correctness notes (not connection-related)

- `qconnect_register` and `qconnect_heartbeat` are granted to `anon`; the device token is the only
  credential and travels in the request body. Correct by design here, but it means token rotation
  is the only revocation path — pair it with the kill switch in `02-admin-killswitch-audit.sql`.
- `join_tailnet` redacts the auth key *before* registration succeeds. If the card is powered off
  between those two steps and later re-imaged from the same `provision.json`, the key is gone.
  Redact after `provisioned` is written instead.
- `qconnect-portal.py` binds `0.0.0.0:80` unconditionally — it is reachable on the dealer LAN too
  during the brief window the dealer profile and the hotspot overlap.

---

## G. Recommended order of work

1. Make pre-registration automatic in `provision-sd.sh` and fail the flash if it does not return 200 (A1).
2. Fix the `/boot` vs `/boot/firmware` cmdline path (B1) and add `RequiresMountsFor=` to the three units (A4, D1).
3. Make the heartbeat and registration report their HTTP status, locally and upstream (E1, E4).
4. One Tailscale key per card, redact after `provisioned` (A2).
5. Assert NetworkManager + regdomain at firstrun, and add hidden-SSID and band reporting (A5, C6, C7, A3).
6. Give the portal real feedback: scan failure vs empty, and wrong-password retry (C1, C3).
