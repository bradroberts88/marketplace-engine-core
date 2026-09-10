# QConnect bench test — first physical card

Prove the full zero-touch cycle on one real Pi Zero 2 W before producing a batch. Budget about two
hours and work in order; each phase builds on the last. The `/bench` screen records the same steps,
so the paper copy is only for the bench itself.

## On the bench

- Pi Zero 2 W and a known-good 5V/2.5A micro USB supply
- MicroSD card (32GB+, A1/A2) and a reader
- A Wi-Fi network you control that stands in for dealer guest Wi-Fi (a phone hotspot for round one, a
  real router for round two)
- A second phone for the hotspot fallback test
- Your laptop on the same Tailscale account, as admin
- SQL editor open, with `01` through `04` already run
- A reusable, `tag:qconnect`, expiring Tailscale pre-auth key

Optional: a USB power meter and a stopwatch.

## Phase 1 — Flash and provision (under 10 min)

1.1 Flash Raspberry Pi OS Lite 64-bit. In OS customisation set **only** username and password — no
Wi-Fi, no SSH toggle.
1.2 Run `provision-sd.sh` with a test identity (`--device-id QCN-TEST-001 --dealer-id bench-test`),
your real Tailscale key, Supabase values and bench Wi-Fi. **Pass:** it prints the device summary and
the preregister line.
1.3 Run the printed `qconnect_preregister(...)` line. **Pass:** the row exists with `registered_at`
still empty.
1.4 Inspect the card before ejecting. **Pass:** `qconnect/` holds 8 files and `cmdline.txt` is one
line containing `systemd.run=/boot/qconnect/qconnect-firstrun.sh`.

## Phase 2 — First boot, happy path (online in under 6 min)

2.1 Insert, power up, start the stopwatch, touch nothing. It boots, runs firstrun, reboots itself
once, then provisions.
2.2 **Pass:** a node named `qcn-test-001` appears in Tailscale with `tag:qconnect`.
2.3 **Pass:** `registered_at` is set and `tailscale_ip` matches the admin console.
2.4 After six minutes, **pass:** `last_seen_at` advanced and `last_status` carries temperature, free
disk, free memory and uptime.
2.5 `tailscale ssh <user>@qcn-test-001`. **Pass:** shell opens; the firstrun log ends with
"complete", the setup log with "Provisioning complete", and the heartbeat timer is active.
2.6 Secrets hygiene. **Pass:** no `provision.json` on the boot partition, the authkey reads
`REDACTED-AFTER-JOIN`, and `stat -c %a` on `provision.json` prints `600`.
2.7 **Pass:** the box shows Online on the fleet screen.

## Phase 3 — Reboot and power-cut resilience

3.1 Clean reboot. **Pass:** back within three minutes, heartbeats resume, the setup log says "Already
provisioned".
3.2 Yank the power mid-operation, wait ten seconds, restore. Three times. **Pass:** it returns every
time and `dmesg | grep -i "ext4 error"` is empty.
3.3 Kill the bench Wi-Fi for ten minutes. **Pass:** it reappears unaided; the offline view showed it
while down and dropped it after.

## Phase 4 — Setup hotspot fallback (the money test)

Use a second card, `--device-id QCN-TEST-002`, with no Wi-Fi arguments, preregistered.

4.1 **Pass:** `QConnect-Setup-QCN-TEST-002` appears within about four minutes.
4.2 Join from a phone. **Pass:** the setup page pops by itself within about 15 seconds. If not, note
the phone model and try `http://10.42.0.1`.
4.3 **Pass:** the dropdown lists nearby networks including your bench SSID.
4.4 Enter a wrong password deliberately. **Pass:** the hotspot disappears and returns within about 15
minutes — this proves the retry loop.
4.5 Enter the right password. **Pass:** the hotspot disappears and phase 2 completes unaided.
4.6 Repeat 4.2 on both iPhone and Android; captive popup behaviour differs by OS.

## Phase 5 — Remote control and kill switch

5.1 Disable the box from the fleet screen. **Pass:** the heartbeat starts returning `enabled=false`
and the action appears in the audit log.
5.2 Re-enable. **Pass:** the audit shows both actions with your email.
5.3 Delete the node in Tailscale. **Pass:** SSH drops. Recovery in the field is a reflash.

## Phase 6 — Stolen-card simulation (five minutes, worth it)

6.1 Power off and mount the card on your laptop.
6.2 **Pass:** the FAT32 boot partition contains no `provision.json`.
6.3 **Pass:** the ext4 copy shows `REDACTED-AFTER-JOIN`. The device token and anon key are visible by
design; confirm the token only works for that one device, then disable the test row.

## Phase 7 — Burn-in (overnight)

7.1 Leave it running 24 h in a case.
7.2 **Pass:** no heartbeat gap over 15 minutes, temperature stayed under 70 C, free memory above
100 MB.
7.3 Record the steady-state temperature and free memory.

## Judgment calls

- Phone hotspots sometimes isolate clients or rotate MAC addresses. If phase 2 misbehaves on a
  hotspot, rerun against a real router before blaming the box.
- If your router can simulate a click-through portal, check that the box reports `captive_portal` in
  `/opt/qconnect/state/last_block_reason` and keeps cycling into hotspot fallback. That is correct
  behaviour and mirrors the real dealership case.
- First boot is the slowest boot: firstrun, a self-reboot and a Tailscale install over 2.4GHz. Five to
  eight minutes is normal on a Zero 2 W — do not panic before ten.

## Go / no-go

**Go** if phases 1, 2 and 4 pass clean, phase 3 shows zero corruption, and burn-in shows no heartbeat
gaps. **Fix and rerun** if any secrets check in 2.6 or 6.2 fails, the hotspot never pops on either
phone OS, or the box fails to survive a power cut.
