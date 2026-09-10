# Golden image build runbook

Exact, copy-paste command sequence that turns a stock Raspberry Pi OS Lite image into the shipped
`autopost-golden*.img.xz`. Follow it top to bottom; every step lists the output you should see.

> **Where this must run.** A Linux host with **root**, **loop devices**, **binfmt ARM emulation**
> and ~25 GB free disk. WSL2 Ubuntu on your Windows box is the supported host. It cannot run in a
> container sandbox or on Windows directly — those have no `/dev/loop*` and no `binfmt_misc`, and
> `losetup` fails immediately with `could not find any free loop device`.

Two products, built separately, never overwriting each other:

| Output | `ARCH` | Stock image to download | Hardware |
|---|---|---|---|
| `autopost-golden.img.xz` | `arm64` | Raspberry Pi OS Lite (64-bit) | Pi 4 class only |
| `autopost-golden-zerow.img.xz` | `armhf` | Raspberry Pi OS Lite (32-bit) | Pi Zero W / Pi 1 — boots on every Pi |

---

## Step 0 — one-time host setup (~5 min)

```bash
wsl -d Ubuntu -u root
apt-get update
apt-get install -y qemu-user-static binfmt-support parted kpartx dosfstools \
                   e2fsprogs rsync xz-utils zerofree
```

Confirm the host is usable:

```bash
ls /dev/loop0 && mountpoint -q /proc/sys/fs/binfmt_misc || mount -t binfmt_misc none /proc/sys/fs/binfmt_misc
df -h ~   # need ~25 GB free
```

Expected: `/dev/loop0` exists and the mount command returns silently.

> binfmt registrations are **runtime only**. `wsl --shutdown`, a reboot, or a WSL idle timeout wipes
> them. The build script re-registers on every run, so never skip it "because last time worked".

## Step 1 — get the stock image (~4 min, ~500 MB)

Download from <https://www.raspberrypi.com/software/operating-systems/> and place it where the
build can see it. Keep the exact filenames:

```bash
mkdir -p /mnt/c/Users/<you>/AppData/Local/AutoPost/images
# 64-bit (Pi 4)      -> raspios-lite-arm64.img.xz
# 32-bit (Zero W)    -> raspios-lite-armhf.img.xz
```

Verify the download against Raspberry Pi's published SHA256 before baking it.

## Step 2 — point the build at your paths

The script defaults assume one workstation layout. Override them for yours:

```bash
export REPO=/mnt/c/Users/<you>/marketplace-engine-core/connector
export SRC_XZ=/mnt/c/Users/<you>/AppData/Local/AutoPost/images/raspios-lite-armhf.img.xz
export OUT_DIR=/mnt/c/Users/<you>/AppData/Local/AutoPost/images
```

`REPO` must be the **connector** folder (the one holding `deploy/pi/install.sh`), not the repo root.

## Step 3 — bake the Zero W (32-bit) image (~25–60 min)

```bash
cd "$REPO/deploy/pi/golden"
ARCH=armhf bash customize-stock-image.sh 2>&1 | tee /tmp/bake-armhf.log
```

Expected checkpoints in the log, in order:

```text
[golden HH:MM:SS] target architecture: armhf (host amd64, out autopost-golden-zerow)
[golden HH:MM:SS] binfmt: qemu-arm -> /usr/bin/qemu-arm active
[golden HH:MM:SS] decompressing stock image -> ~/autopost-golden-build/autopost-golden.img
[golden HH:MM:SS] growing image +1800MB and expanding the rootfs partition
[golden HH:MM:SS] stock rootfs confirmed armhf (ELF class 01)
[golden HH:MM:SS] copying connector repo into the image
[golden HH:MM:SS] running install.sh inside the chroot (apt under emulation — the slow part)
[golden HH:MM:SS] node present
[golden HH:MM:SS] BLE rescue channel present and enabled
[golden HH:MM:SS] persistence prep OK (fstab + NM symlink + mount ordering)
[golden HH:MM:SS] appending the AUTOPOST-DATA persistence partition (2048MB)
[golden HH:MM:SS] compressing final image
[golden HH:MM:SS] DONE -> .../autopost-golden-zerow.img.xz  (NNNNNNNNN bytes; ...)
```

The apt step under emulation is where the time goes. Ten silent minutes there is normal.

## Step 4 — bake the Pi 4 (64-bit) image (~15–40 min)

```bash
export SRC_XZ=/mnt/c/Users/<you>/AppData/Local/AutoPost/images/raspios-lite-arm64.img.xz
ARCH=arm64 bash customize-stock-image.sh 2>&1 | tee /tmp/bake-arm64.log
```

Same checkpoints, with `qemu-aarch64`, `ELF class 02`, and `out autopost-golden`.

## Step 5 — confirm the artefacts exist and are intact

```bash
cd "$OUT_DIR"
ls -lh autopost-golden.img.xz autopost-golden-zerow.img.xz
xz -t autopost-golden.img.xz && xz -t autopost-golden-zerow.img.xz && echo "both archives intact"
sha256sum autopost-golden.img.xz autopost-golden-zerow.img.xz
```

A build is only finished when: both files exist, both pass `xz -t`, and each is roughly 600–700 MB.
Record the two SHA256 values — they go in the release notes and in `README.md`.

## Step 6 — publish

```text
https://github.com/bradroberts88/marketplace-engine-core/releases/new
```

Tag `autpost-golden`, attach both `.img.xz` files, paste the SHA256 values, publish (not draft — a
draft is invisible to everyone but you). Then update the hash table in `README.md`.

## Step 7 — certify on hardware (nothing ships without this)

Building is not certifying. Per `README.md`, a unit is SHIP-CERTIFIED only when `sudo
autopost-selftest` is fully green, the two hard power-cut canaries pass, and a heartbeat lands at
the hub. That requires a physical Pi and cannot be done from any build host.

---

## Failures you are likely to hit

| Message | Cause | Fix |
|---|---|---|
| `ERROR: run as root (wsl -u root)` | Started WSL as your user | `wsl -d Ubuntu -u root` |
| `ERROR: stock image not found` | `SRC_XZ` wrong or download incomplete | Re-check the path from Step 2; re-download |
| `ERROR: repo not found` | `REPO` points at the repo root | Point it at the `connector` folder |
| `ERROR: could not register binfmt for arm64` | binfmt wiped by `wsl --shutdown` | Re-run Step 0's mount line, then the bake |
| `ERROR: SRC_XZ is NOT an armhf image` | 64-bit stock image with `ARCH=armhf` | Download the matching stock image |
| `ERROR: ARCH=armhf must not write OUT_NAME=autopost-golden` | Guard against overwriting the other product | Leave `OUT_NAME` unset |
| `losetup: could not find any free loop device` | Host has no loop devices | Use WSL2/Linux, not a container |
| `WARN: could not mount boot/firmware (vfat unsupported)` | WSL kernel without vfat | Harmless — nothing in the bake writes the boot partition |
| Everything dies after registering binfmt (`sed`, `head` all fail) | Registered emulation on a host already of that arch | `update-binfmts --disable qemu-aarch64`; the script now detects this and skips registration |
| `No space left on device` mid-chroot | Under 25 GB free | Free space; the work copy lives in `$HOME/autopost-golden-build` |

## Why this was not run for you

The environment these scripts were reviewed in has no loop devices (`/dev/loop*` absent), no
`binfmt_misc`, no `qemu-user-static`, and a 10-minute command ceiling against a 25–60 minute bake.
What was verified here instead: all build scripts pass `bash -n` syntax checks, the arch/output
guards and the ELF-class assertion are present and correct, and the published release assets match
the hashes recorded in `README.md`. The bake itself must run on your WSL2 host via this runbook.
