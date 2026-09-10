# AutoPost Pi — Golden Master Image spec (the P0 that makes a device non-brickable)

The deep-analysis found ONE fault that dominates all others: today `/var/lib/autopost` is a **directory on the
rootfs**, and the read-only overlay is a **prose-only manual last step** (`install.sh`). The moment overlay is
enabled, the first dealership **power cut evicts** `config.json` + the **one-time claim token** + signed
self-updates + `.bak` rollbacks + WiFi corrections → the device boots **inactive and cannot re-claim** → a
**permanently bricked, non-recallable** unit at exactly the moment fail-closed was supposed to protect you.

**This cannot be fixed in `install.sh` — it is an image-time change.** `selftest.sh` now HARD-BLOCKS shipping any
device whose `/var/lib/autopost` is not a separate writable partition (`data_partition_persistent` gate), so a
device built the old way will correctly refuse to ship until the golden image exists.

## What the golden `.img` must contain
1. **A separate ext4 DATA partition** `LABEL=AUTOPOST-DATA`, mounted at `/var/lib/autopost` via `/etc/fstab`:
   `LABEL=AUTOPOST-DATA  /var/lib/autopost  ext4  defaults,noatime,nofail,x-systemd.growfs  0  2`
   It holds: `config.json` (identity/claim), the runtime dir, `heartbeat.json`, AND the updatable code (below).
2. **The connector code lives ON the data partition** (or at least `agent.js` + the updatable files + their `.bak`
   targets), with the systemd unit's `WorkingDirectory`/`ExecStart`/`__dirname` pointing there. A rootfs-subdir
   bind-mount does NOT escape the overlay — it must be the real partition. This single move fixes the whole
   overlay-eviction class: identity, self-updates, rollback, and WiFi profiles all survive a power cut.
3. **Overlay pre-baked ON** for the rootfs (`boot=overlay` in cmdline). Verified by the `rootfs_overlay` /
   `overlay_active` gates.
4. **`RequiresMountsFor=/var/lib/autopost`** in `autopost-connector.service` (don't start the agent before the
   data partition is mounted).
5. **EEPROM pinned** to a known-good version; **locale + `WiFi-country`** set; **first-boot resize** of the data
   partition done automatically (`x-systemd.growfs`).
6. **NetworkManager connections** (WiFi profiles) stored on the data partition so a remote change-WiFi survives.

## Build pipeline (open question for the operator)
Produce the custom `.img` with **pi-gen** or **CustomPiOS** in CI (baked partition + overlay + pinned EEPROM),
flashable by Raspberry Pi Imager with "verify after write" ON. **Strongly prefer CM4/eMMC** for the first PAID
dealerships — it deletes the counterfeit-SD, wear, card-screen, and separate-partition problems entirely.

## Phase-2 persistence canary (before certifying a batch — unattended on the bench rack)
After overlay is active, `pre-ship-overlay-check.sh` (to build) must prove, across **2 hard power cuts** (smart
plug or manual):
- a canary written to the ROOTFS is GONE after reboot (proves writes evaporate = corruption-proof), AND
- `config.json` + the claim identity + a self-update marker + the WiFi profile are ALL INTACT on the data
  partition, AND the device returns to **Live within ~180s** with no re-claim.
Only a device with `burninPassed && overlayPassed && canaryPassed` may be marked **SHIP-CERTIFIED**.

## Claim-code self-recovery (kills the last brick path)
Make the hub able to **re-issue a consumed claim** so an overlay-wiped or reflashed device can self-recover
instead of a truck-roll. After a successful claim, copy the env off `/boot` to the data partition and delete the
`/boot` copy; repoint `autopost-claim.service` at the data-dir copy.
