# AutoPost Pi — Golden Image build kit

Turns [../GOLDEN-IMAGE-SPEC.md](../GOLDEN-IMAGE-SPEC.md) into a runnable **pi-gen** build. Output is a single
`.img` the flasher writes with verify-on. It bakes in the connector, a **separate `AUTOPOST-DATA` ext4
partition** (so identity/claim/updates survive the read-only overlay), and the overlay itself.

> **STATUS: RECIPE — NOT YET BUILT OR CERTIFIED.** These scripts encode the spec; they have not been run through
> pi-gen or certified on hardware yet. Building needs a Linux env (Docker **or** WSL2 Ubuntu) and ~45–90 min;
> certifying needs a real Pi + two hard power cuts (see the checklist at the bottom). Do not ship an image from
> this kit until `selftest.sh` passes AND the power-cut canary passes on a physical unit.

## Why a separate partition (the whole point)
With the rootfs overlay ON, every write to the rootfs evaporates on reboot (that's the corruption-proofing).
So the one-time claim token, `config.json`, self-updates, and WiFi profiles **must** live on a real partition
that is NOT under the overlay — otherwise the first dealership power-cut bricks the unit. A bind-mount does not
escape the overlay; it has to be its own partition. This kit gives it `LABEL=AUTOPOST-DATA` at
`/var/lib/autopost`, and puts the **updatable connector code there too** so self-update + rollback survive.

## Layout
```
golden/
  build-golden.sh                     # orchestrates: fetch pi-gen -> build rootfs -> append data partition
  append-data-partition.sh            # post-image: add the 3rd AUTOPOST-DATA partition + seed it + fstab/overlay
  pi-gen.config                       # pi-gen config (hostname, locale, arm64, stages)
  stage-autopost/
    prerun.sh                         # pi-gen stage guard
    00-install-connector/
      00-packages                     # nodejs deps installed in the image
      01-run-chroot.sh                # create autopost user, install connector into /opt, enable services
      files/                          # connector tarball + service units copied in at build time
    01-data-and-overlay/
      00-run-chroot.sh                # fstab entry, RequiresMountsFor, enable overlay, pin EEPROM, wifi-country
```

## Build (on a machine with Docker, or WSL2 Ubuntu)
```bash
# 1. from the repo root, stage the connector code the image will bake in:
bash deploy/pi/golden/build-golden.sh
# -> produces deploy/pi/golden/out/autopost-golden-YYYY-MM-DD.img (+ .img.xz)
```
`build-golden.sh` clones pi-gen, drops `stage-autopost` in, runs the build (Docker if present, else native), then
runs `append-data-partition.sh` on the resulting `.img` to add + seed the AUTOPOST-DATA partition.

### WSL2 notes (no Docker)
pi-gen native needs loop devices + binfmt (ARM emulation). In WSL2 Ubuntu:
```bash
sudo apt-get update && sudo apt-get install -y qemu-user-static binfmt-support debootstrap kpartx zerofree
# ensure loop devices exist: `ls /dev/loop*` — if missing, the build script probes and warns.
```
Docker mode (recommended, most reproducible) needs Docker Desktop with WSL2 backend.

## Certification — a unit is SHIP-CERTIFIED only when ALL pass
1. `sudo autopost-selftest` → every CRITICAL gate green (incl. `data_partition_persistent`, `overlay_active`).
2. **Power-cut canary (×2):** write a canary file to the ROOTFS, hard-cut power, reboot →
   - the rootfs canary is **GONE** (overlay working), AND
   - `config.json` + claim identity + a self-update marker + the WiFi profile on AUTOPOST-DATA are **INTACT**, AND
   - the unit returns to **Live within ~180s** with no re-claim.
3. Field telemetry heartbeat arrives at the hub after claim.

Only `burninPassed && overlayPassed && canaryPassed` → mark **SHIP-CERTIFIED**.

## Strongly recommended for PAID ships: CM4 + eMMC
An eMMC Compute Module removes the counterfeit-SD, wear, card-eject, and partition-class problems entirely. The
same image flashes to eMMC via `rpiboot`. Do the SD path first to prove the recipe, then move paid units to CM4.
