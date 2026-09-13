#!/bin/bash
set -euo pipefail
# ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
# Build the AutoPost GOLDEN image by baking the connector + WiFi-recovery service into the STOCK Raspberry Pi OS
# Lite image, inside an armhf/ARMv6 chroot (fast: reuses the proven stock image; no full pi-gen rebuild).
#
#   PI ZERO W (ORIGINAL) VARIANT: the stock upstream build (see the sibling 64-bit script history) targets
#   Raspberry Pi OS Lite 64-bit (arm64) for Pi 4-class hardware. The original Pi Zero W's SoC (BCM2835,
#   ARM1176JZF-S) is ARMv6 and CANNOT execute AArch64 at all — a 64-bit image will not boot on it, full stop.
#   This variant instead uses Raspberry Pi OS Lite 32-bit (armhf), which Raspberry Pi Ltd specifically compiles
#   against the ARMv6 baseline so it runs on every Pi ever made, Zero/Pi 1 included. Grab "Raspberry Pi OS Lite
#   (32-bit)" from https://www.raspberrypi.com/software/operating-systems/ — NOT the 64-bit one. Note that
#   deploy/pi/install.sh has a matching ARMv6 patch for the Node.js install step (NodeSource doesn't ship
#   ARMv6 builds); this script and that patch must travel together.
#
#   v1 SCOPE: connector + recovery baked in, rootfs stays WRITABLE (WiFi/config persist normally — the proven
#   behavior). The read-only power-cut OVERLAY is a certified follow-up (an unproven overlay could evaporate a
#   recovered WiFi profile — the opposite of what we want).
#
#   NOTHING per-dealership is baked: WiFi, claim code, and password are still injected by the flasher onto the
#   FAT /boot partition at flash time. This image only bakes the connector CODE + generic services.
#
# Run in WSL2 Ubuntu as ROOT:   wsl -d Ubuntu -u root -- bash <this>
# ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
LOG(){ echo "[golden $(date +%H:%M:%S)] $*"; }

# ARCH: which Raspberry Pi OS this bake targets. Both variants run the SAME install.sh — it branches on
# `dpkg --print-architecture` internally (NodeSource on arm64, unofficial-builds on armhf), so nothing below
# needs to know the difference beyond the emulator, the ELF magic used to register binfmt, and the defaults set
# here.
#   armhf (default) -> Pi Zero W / Pi 1, ARMv6 32-bit. Boots on EVERY Pi ever made, including the 4.
#   arm64           -> Pi 4-class only. Will NOT boot on an original Zero W.
# Every arch-dependent default is derived HERE rather than left to the caller: a wrong SRC_XZ silently bakes a
# 32-bit rootfs into a file named as the 64-bit build (or vice versa), and the result only fails later, on
# hardware, as an image that will not boot at all.
ARCH="${ARCH:-armhf}"
case "$ARCH" in
  armhf) QEMU="${QEMU:-/usr/bin/qemu-arm}";     BINFMT_NAME=qemu-arm
         DEF_STOCK=raspios-lite-armhf.img.xz;   DEF_OUT_NAME=autopost-golden-zerow
         # ELF32 little-endian, e_machine = 0x28 (EM_ARM)
         ELF_MAGIC='\x7f\x45\x4c\x46\x01\x01\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00\x02\x00\x28\x00'
         ELF_MASK='\xff\xff\xff\xff\xff\xff\xff\x00\xff\xff\xff\xff\xff\xff\xff\xff\xfe\xff\xff\xff' ;;
  arm64) QEMU="${QEMU:-/usr/bin/qemu-aarch64}"; BINFMT_NAME=qemu-aarch64
         DEF_STOCK=raspios-lite-arm64.img.xz;   DEF_OUT_NAME=autopost-golden
         # ELF64 little-endian, e_machine = 0xb7 (EM_AARCH64)
         ELF_MAGIC='\x7f\x45\x4c\x46\x02\x01\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00\x02\x00\xb7\x00'
         ELF_MASK='\xff\xff\xff\xff\xff\xff\xff\x00\xff\xff\xff\xff\xff\xff\xff\xff\xfe\xff\xff\xff' ;;
  *)     echo "ERROR: ARCH must be armhf or arm64 (got '$ARCH')"; exit 1 ;;
esac

REPO="${REPO:-/mnt/c/Users/Roger/Fbtool-Scaling/desktop-connector}"
SRC_XZ="${SRC_XZ:-/mnt/c/Users/Roger/AppData/Local/AutoPost/images/$DEF_STOCK}"
OUT_DIR="${OUT_DIR:-/mnt/c/Users/Roger/AppData/Local/AutoPost/images}"
OUT_NAME="${OUT_NAME:-$DEF_OUT_NAME}"
WORK="${WORK:-$HOME/autopost-golden-build}"
GROW_MB="${GROW_MB:-1800}"

# Guard the two outputs against each other BEFORE doing any work: the 32-bit and 64-bit golden images are
# DIFFERENT products, and silently overwriting one with the other ships an image that cannot boot the target
# hardware at all. Cheap check, so fail here rather than 12 minutes into a bake.
case "$ARCH:$OUT_NAME" in
  armhf:autopost-golden)       echo "ERROR: ARCH=armhf must not write OUT_NAME=autopost-golden (that is the 64-bit Pi 4 image)"; exit 1 ;;
  arm64:autopost-golden-zerow) echo "ERROR: ARCH=arm64 must not write OUT_NAME=autopost-golden-zerow (that is the 32-bit Zero W image)"; exit 1 ;;
esac

# Is the build host already the target arch? If so the chroot runs natively and qemu is not involved at all — so
# do not demand it. (See the binfmt section below for why registering one anyway would be actively harmful.)
HOST_ARCH="$(dpkg --print-architecture 2>/dev/null || echo unknown)"

[ "$(id -u)" = 0 ] || { echo "ERROR: run as root (wsl -u root)"; exit 1; }
[ -f "$SRC_XZ" ] || { echo "ERROR: stock image not found: $SRC_XZ"; exit 1; }
[ -d "$REPO" ]   || { echo "ERROR: repo not found: $REPO"; exit 1; }
[ "$HOST_ARCH" = "$ARCH" ] || [ -x "$QEMU" ] || { echo "ERROR: $QEMU missing (apt-get install qemu-user-static)"; exit 1; }

LOG "target architecture: $ARCH (host $HOST_ARCH, out $OUT_NAME)"

mkdir -p "$WORK"; IMG="$WORK/autopost-golden.img"; MNT="$WORK/mnt"

# 1) binfmt: let the target ARM binaries run under emulation, F flag so qemu works INSIDE the chroot -----------
# NATIVE vs EMULATED. If the build host is ALREADY the target architecture, the chroot runs natively and no
# binfmt entry is needed — registering one anyway is actively destructive: the handler would match the host's own
# binaries and route them through an interpreter that is itself such a binary, so every exec recurses until the
# kernel gives up with ELOOP and the whole environment stops working until it is unregistered. That is exactly
# what happened on 2026-08-17 building arm64 on an ARM64 Windows/WSL host (`sed`, `head`, `/bin/true` all died).
if [ "$HOST_ARCH" = "$ARCH" ]; then
  LOG "host is already $ARCH — running the chroot NATIVELY (no emulation, much faster)"
else
LOG "registering binfmt for $ARCH ($BINFMT_NAME) — host is $HOST_ARCH"
mountpoint -q /proc/sys/fs/binfmt_misc || mount -t binfmt_misc none /proc/sys/fs/binfmt_misc 2>/dev/null || true
[ -e /proc/sys/fs/binfmt_misc/register ] || { echo "ERROR: binfmt_misc is not available — cannot emulate $ARCH"; exit 1; }
# NOTE: these registrations are RUNTIME-ONLY. `wsl --shutdown` (or a WSL idle-timeout restart) wipes every entry,
# so never assume an earlier build left one behind — always re-register.
if ! grep -qs enabled "/proc/sys/fs/binfmt_misc/$BINFMT_NAME" 2>/dev/null; then
  # Try the packaged definition first, but do NOT branch on its exit status: for qemu-aarch64 it exits non-zero
  # with "not in database of installed binary formats", and it can equally exit 0 without registering anything.
  # Re-check the actual kernel state instead, then hand-register. (Branching on that exit code is exactly what
  # left arm64 unregistered on 2026-08-17 and aborted the first Pi 4 bake.)
  update-binfmts --enable "$BINFMT_NAME" >/dev/null 2>&1 || true
  if [ ! -e "/proc/sys/fs/binfmt_misc/$BINFMT_NAME" ]; then
    printf '%s' ":$BINFMT_NAME:M::$ELF_MAGIC:$ELF_MASK:$QEMU:F" \
      > /proc/sys/fs/binfmt_misc/register 2>/dev/null || true
  fi
fi
grep -qs "$QEMU" "/proc/sys/fs/binfmt_misc/$BINFMT_NAME" 2>/dev/null \
  && LOG "binfmt: $BINFMT_NAME -> $QEMU active" \
  || { echo "ERROR: could not register binfmt for $ARCH ($BINFMT_NAME -> $QEMU)."
       echo "       Registrations are runtime-only and are wiped by 'wsl --shutdown'."
       echo "       Inspect with: cat /proc/sys/fs/binfmt_misc/$BINFMT_NAME"; exit 1; }
fi

# 2) work on a WSL-native copy (loop-mount on /mnt/c 9p is unreliable) --------------------------------------------
LOG "decompressing stock image -> $IMG"
rm -f "$IMG"; xz -dc "$SRC_XZ" > "$IMG"

# 3) grow the image + rootfs (p2) for node + connector + deps -----------------------------------------------------
LOG "growing image +${GROW_MB}MB and expanding the rootfs partition"
truncate -s "+${GROW_MB}M" "$IMG"
parted -s "$IMG" resizepart 2 100%

LOOP="$(losetup --show -fP "$IMG")"
cleanup(){ set +e; for d in dev/pts dev sys proc boot/firmware boot ''; do umount "$MNT/$d" 2>/dev/null; done; umount "$MNT" 2>/dev/null; losetup -d "$LOOP" 2>/dev/null; }
trap cleanup EXIT
sleep 1
e2fsck -fy "${LOOP}p2" >/dev/null 2>&1 || true
resize2fs "${LOOP}p2"

# 4) mount rootfs + FAT boot -------------------------------------------------------------------------------------
mkdir -p "$MNT"; mount "${LOOP}p2" "$MNT"

# 4a) ASSERT the stock rootfs really is the architecture we were told. The filename is not evidence — a
#     mislabelled or wrongly-pointed SRC_XZ otherwise bakes cleanly all the way to a compressed image, and only
#     fails much later on real hardware, as a card that does not boot at all. ELF byte 4: 01 = 32-bit, 02 = 64-bit.
ELFCLASS="$(od -An -tx1 -j4 -N1 "$MNT/bin/bash" 2>/dev/null | tr -d ' \n')"
case "$ARCH:$ELFCLASS" in
  armhf:01|arm64:02) LOG "stock rootfs confirmed $ARCH (ELF class $ELFCLASS)" ;;
  *:'')              LOG "WARN: could not read $MNT/bin/bash to confirm the rootfs architecture — continuing" ;;
  *) echo "ERROR: SRC_XZ is NOT an $ARCH image (its /bin/bash is ELF class '$ELFCLASS'; expected $([ "$ARCH" = armhf ] && echo 01 || echo 02))."
     echo "       Point SRC_XZ at the correct stock image: $DEF_STOCK"; exit 1 ;;
esac
# The FAT boot partition is best-effort: nothing in this script or install.sh reads/writes it (WiFi/claim
# injection happens later, on the block device, by the flasher app). Some hosts' kernels (e.g. the stock WSL2
# kernel) don't ship the vfat driver at all — don't let that abort an otherwise-good bake.
if [ -d "$MNT/boot/firmware" ]; then
  mount "${LOOP}p1" "$MNT/boot/firmware" 2>/dev/null || LOG "WARN: could not mount boot/firmware (vfat unsupported on this host?) — not required by this bake, continuing"
else
  mount "${LOOP}p1" "$MNT/boot" 2>/dev/null || LOG "WARN: could not mount boot (vfat unsupported on this host?) — not required by this bake, continuing"
fi

# 5) chroot prep: DNS + kernel fs (qemu is used from the HOST via the binfmt F flag — no copy needed) ------------
cp /etc/resolv.conf "$MNT/etc/resolv.conf" 2>/dev/null || true
for d in proc sys dev dev/pts; do mount --bind "/$d" "$MNT/$d"; done

# 6) drop the connector repo in (install.sh rsyncs it to /opt/autopost/connector) --------------------------------
LOG "copying connector repo into the image"
rm -rf "$MNT/root/desktop-connector"
rsync -a --exclude node_modules --exclude .git --exclude 'dist-flasher' --exclude 'dist' --exclude 'flasher/node_modules' \
  "$REPO/" "$MNT/root/desktop-connector/"

# 7) run install.sh in the armhf/ARMv6 chroot — bakes node + connector + WiFi-recovery + BLE rescue + dnsmasq-base + polkit + services
#    + Tailscale (recall path) + the video-group telemetry fix. SKIP_SELFTEST=1 (no hardware in a chroot). Tailscale
#    is INSTALLED + enabled here; the actual `tailscale up` join happens on the real Pi with a per-device auth key.
LOG "running install.sh inside the chroot (apt under emulation — the slow part, be patient)"
chroot "$MNT" /usr/bin/env SKIP_SELFTEST=1 bash /root/desktop-connector/deploy/pi/install.sh

# 8) verify the bake landed --------------------------------------------------------------------------------------
LOG "verifying the baked image"
test -f "$MNT/opt/autopost/connector/src/wifi-recovery.js" || { echo "ERROR: recovery code not installed"; exit 1; }
test -f "$MNT/etc/systemd/system/autopost-wifi-recovery.service" || { echo "ERROR: recovery service not installed"; exit 1; }
test -L "$MNT/etc/systemd/system/multi-user.target.wants/autopost-wifi-recovery.service" || echo "WARN: recovery service may not be enabled"
chroot "$MNT" dpkg -s dnsmasq-base >/dev/null 2>&1 && LOG "dnsmasq-base present" || echo "WARN: dnsmasq-base missing"
# The Bluetooth onboarding channel is RETIRED (see attic/autopost-pi/). Card onboarding is now the QConnect
# captive portal, which needs no extra packages, no D-Bus policy, and no radio a config.txt line can switch off.
# The old hard assertions are removed rather than downgraded: an image is no longer expected to carry that channel.
chroot "$MNT" node --version >/dev/null 2>&1 && LOG "node present" || echo "WARN: node missing"
[ -x "$MNT/usr/bin/tailscale" ] && LOG "tailscale present (recall path)" || echo "WARN: tailscale missing"
chroot "$MNT" id -nG autopost 2>/dev/null | grep -qw video && LOG "autopost in 'video' group (telemetry)" || echo "WARN: autopost not in video group"

# 8a) FORCE-ENABLE the services. `systemctl enable` inside a qemu-emulated chroot does NOT reliably create the
#     multi-user.target.wants symlinks, so a box built this way would boot and start NOTHING (no connector, no WiFi
#     rescue, no Tailscale). Create the wants symlinks directly (works regardless of systemctl) and HARD-ASSERT.
LOG "force-enabling services (connector, wifi-recovery, tailscaled)"
install -d "$MNT/etc/systemd/system/multi-user.target.wants"
# hciuart is deliberately NOT in this list. It is triggered by dev-serial1.device appearing - the pi-bluetooth
# package installs that wants-link itself - and forcing it into multi-user.target as well makes systemd run it
# before the UART device node exists, which fails, logs a failed unit, and then succeeds when the device shows
# up. Harmless, but a spurious failed unit in the journal of a box whose diagnostics are supposed to mean
# something is exactly the noise this work is trying to remove. Verified below instead.
for svc in autopost-connector autopost-wifi-recovery tailscaled; do
  U="/etc/systemd/system/${svc}.service"; [ -f "$MNT$U" ] || U="/usr/lib/systemd/system/${svc}.service"
  [ -f "$MNT$U" ] && ln -sf "$U" "$MNT/etc/systemd/system/multi-user.target.wants/${svc}.service"
done
for svc in autopost-connector autopost-wifi-recovery tailscaled; do
  [ -L "$MNT/etc/systemd/system/multi-user.target.wants/${svc}.service" ] || { echo "ERROR: ${svc}.service not enabled in the image"; exit 1; }
done
# bluetooth/hciuart ship their own [Install] wants and some releases enable them via a different target, so they
# are force-linked above but only WARNED on here - a missing symlink is usually a packaging difference, not a
# broken image, and failing the whole build over it would be wrong.
[ -L "$MNT/etc/systemd/system/multi-user.target.wants/bluetooth.service" ]   || chroot "$MNT" systemctl is-enabled bluetooth.service >/dev/null 2>&1   || echo "WARN: bluetooth.service may not start - check Bluetooth comes up on the first test card"
# hciuart must be wired to its OWN trigger, which is what actually attaches the radio at the right moment.
[ -L "$MNT/etc/systemd/system/dev-serial1.device.wants/hciuart.service" ]   || { echo "ERROR: hciuart is not hooked to dev-serial1.device - the Bluetooth radio would never be attached"; exit 1; }
LOG "hciuart wired to its dev-serial1.device trigger" 

# 8b) CORRUPTION-PROOF-READY: mount the AUTOPOST-DATA partition at /var/lib/autopost + move NetworkManager's saved
#     connections there, so the claim token AND WiFi survive the read-only overlay + power cuts. The overlay itself
#     is enabled + certified ON THE PI (PI-SETUP-GUIDE step 7). Degrade-safe: fstab is nofail and firstrun.sh mounts
#     the partition before writing WiFi — if the partition is ever missing, the box still boots on the writable rootfs.
LOG "baking data-partition fstab + NM-connection persistence (overlay-ready)"
grep -q 'AUTOPOST-DATA' "$MNT/etc/fstab" 2>/dev/null || \
  echo 'LABEL=AUTOPOST-DATA  /var/lib/autopost  ext4  defaults,noatime,nofail,x-systemd.growfs  0  2' >> "$MNT/etc/fstab"
install -d -m 0700 "$MNT/var/lib/autopost/nm-system-connections"
chroot "$MNT" chown -R autopost:autopost /var/lib/autopost 2>/dev/null || true
rm -rf "$MNT/etc/NetworkManager/system-connections"
ln -s /var/lib/autopost/nm-system-connections "$MNT/etc/NetworkManager/system-connections"
install -d "$MNT/etc/systemd/system/NetworkManager.service.d"
printf '[Unit]\nRequiresMountsFor=/var/lib/autopost\n' > "$MNT/etc/systemd/system/NetworkManager.service.d/10-autopost-data.conf"
[ -L "$MNT/etc/NetworkManager/system-connections" ] || { echo "ERROR: NM system-connections symlink not created"; exit 1; }
grep -q 'AUTOPOST-DATA' "$MNT/etc/fstab" || { echo "ERROR: AUTOPOST-DATA fstab entry missing"; exit 1; }
# NOTE (2026-07-21, verified on hardware): do NOT symlink /var/lib/tailscale onto AUTOPOST-DATA. tailscaled's own
# unit uses `StateDirectory=tailscale`, which REQUIRES /var/lib/tailscale to be a REAL directory — a symlink there
# makes systemd refuse to set up the state dir, so tailscaled never starts and the whole Tailscale/SSH join dies in
# a crash loop. So tailscale state stays on the rootfs via StateDirectory: it persists fine WITHOUT the overlay
# (current ships). Overlay-time tailscale persistence is a TRACKED FOLLOW-UP — do it together with enabling the
# overlay, via a tailscaled drop-in that clears StateDirectory and sets `--state=/var/lib/autopost/tailscale/...`
# + ReadWritePaths=/var/lib/autopost (NOT a symlink).
LOG "persistence prep OK (fstab + NM symlink + mount ordering)"

# 9) clean the image (remove the repo temp; leave the installed /opt/autopost/connector) -------------------------
LOG "cleaning up"
rm -rf "$MNT/root/desktop-connector"
: > "$MNT/etc/resolv.conf" 2>/dev/null || true

# 9a) SLIM the rootfs. Same reasoning as DATA_MB below: rpi-imager writes and then VERIFIES every byte of the
#     declared partition, so anything left in here is paid for on every single card, twice. None of this is used
#     by a headless appliance that is never apt-upgraded in the field and runs in one locale.
#       apt cache + lists ~200MB · locales ~140MB · docs/man ~40MB
#     Set SLIM=0 to skip (e.g. when debugging an image by hand).
if [ "${SLIM:-1}" = 1 ]; then
  LOG "slimming the rootfs (apt cache, lists, non-English locales, docs)"
  BEFORE_KB=$(du -xs "$MNT" 2>/dev/null | cut -f1)
  chroot "$MNT" apt-get clean >/dev/null 2>&1 || true
  rm -rf "$MNT"/var/lib/apt/lists/* 2>/dev/null || true
  rm -rf "$MNT"/var/cache/apt/archives/*.deb 2>/dev/null || true
  # keep en* only — the box has no UI and its logs are English
  find "$MNT/usr/share/locale" -mindepth 1 -maxdepth 1 -type d ! -name 'en*' -exec rm -rf {} + 2>/dev/null || true
  rm -rf "$MNT"/usr/share/doc/* "$MNT"/usr/share/man/* "$MNT"/usr/share/info/* 2>/dev/null || true
  AFTER_KB=$(du -xs "$MNT" 2>/dev/null | cut -f1)
  LOG "  rootfs $((BEFORE_KB/1024))MB -> $((AFTER_KB/1024))MB (freed $(( (BEFORE_KB-AFTER_KB)/1024 ))MB)"
fi

sync
trap - EXIT; cleanup

# 9a-2) SHRINK the rootfs PARTITION to fit what is actually in it, plus headroom.
#     The build grew p2 to fill the image so apt had room to work; leaving it that size means every flash writes
#     ~1.6GB of empty space and then verifies it. p2 is currently the LAST partition (the data partition is
#     appended next), so shrinking it here shrinks the whole image file with no partition juggling.
#     ROOT_HEADROOM_MB is real, working headroom: journald is capped at 50MB, the connector code and its .bak
#     self-update targets live on the DATA partition, so the rootfs only needs room for apt-less day-to-day
#     operation. 512MB is generous for that.
#     Uses sfdisk, not parted: parted's `resizepart` refuses to shrink non-interactively in some builds and its
#     failure mode here was silent-in-script, which combined with an unconditional truncate to leave p2 running
#     PAST the end of the file ("Can't have a partition outside the disk"). sfdisk rewrites the table
#     declaratively, and every step below is checked — on ANY failure we restore the original table and ship the
#     larger image rather than a broken one. A slow flash is an annoyance; a corrupt partition table is a brick.
if [ "${SHRINK_ROOT:-1}" = 1 ]; then
  ROOT_HEADROOM_MB="${ROOT_HEADROOM_MB:-512}"
  LOG "shrinking the rootfs partition (headroom ${ROOT_HEADROOM_MB}MB)"
  TABLE_BAK="$WORK/parttable.bak"
  IMG_BYTES_BEFORE=$(stat -c %s "$IMG")
  sfdisk -d "$IMG" > "$TABLE_BAK" 2>/dev/null

  shrink_failed(){
    LOG "  WARN: $1 — restoring the original partition table, continuing WITHOUT the shrink"
    truncate -s "$IMG_BYTES_BEFORE" "$IMG" 2>/dev/null || true
    sfdisk --no-reread --force "$IMG" < "$TABLE_BAK" >/dev/null 2>&1 || true
    SHRINK_OK=0
  }
  SHRINK_OK=1

  SLOOP="$(losetup --show -fP "$IMG")" || SLOOP=""
  if [ -z "$SLOOP" ]; then
    shrink_failed "could not attach a loop device"
  else
    e2fsck -fy "${SLOOP}p2" >/dev/null 2>&1 || true
    if ! resize2fs -M "${SLOOP}p2" >/dev/null 2>&1; then
      losetup -d "$SLOOP"; shrink_failed "resize2fs -M failed"
    else
      MIN_4K=$(dumpe2fs -h "${SLOOP}p2" 2>/dev/null | awk -F: '/^Block count/{gsub(/[^0-9]/,"",$2);print $2}')
      if ! [ "$MIN_4K" -gt 0 ] 2>/dev/null; then
        losetup -d "$SLOOP"; shrink_failed "could not read the shrunken block count"
      else
        TARGET_4K=$(( MIN_4K + ROOT_HEADROOM_MB * 256 ))     # 256 x 4K blocks per MB
        resize2fs "${SLOOP}p2" "${TARGET_4K}" >/dev/null 2>&1 || true
        # trust the FILESYSTEM's own reported size, never our arithmetic
        FS_4K=$(dumpe2fs -h "${SLOOP}p2" 2>/dev/null | awk -F: '/^Block count/{gsub(/[^0-9]/,"",$2);print $2}')
        e2fsck -fy "${SLOOP}p2" >/dev/null 2>&1 || true
        losetup -d "$SLOOP"
        FS_SECTORS=$(( FS_4K * 8 ))                          # 4K block = 8 x 512B sectors
        P2_START_S=$(awk '/^[^ ]*2 :/{for(i=1;i<=NF;i++) if($i=="start=") {print $(i+1)} }' "$TABLE_BAK" | tr -d ',')
        [ -n "$P2_START_S" ] || P2_START_S=$(sed -n 's/.*2 : start=[[:space:]]*\([0-9]*\).*/\1/p' "$TABLE_BAK" | head -1)
        if ! [ "${P2_START_S:-0}" -gt 0 ] 2>/dev/null; then
          shrink_failed "could not determine p2 start sector"
        else
          # rewrite the table with p2's new size; p2 is the LAST partition here so nothing else moves.
          NEWTABLE="$WORK/parttable.new"
          awk -v s="$FS_SECTORS" '
            /^[^ ]*2 :/ { sub(/size=[[:space:]]*[0-9]+/, "size= " s); }
            { print }
          ' "$TABLE_BAK" > "$NEWTABLE"
          if sfdisk --no-reread --force "$IMG" < "$NEWTABLE" >/dev/null 2>&1; then
            NEW_END_S=$(( P2_START_S + FS_SECTORS ))
            truncate -s $(( NEW_END_S * 512 )) "$IMG"
            # PROVE the table is consistent with the file before accepting it: re-read the table and confirm
            # every partition ends INSIDE the truncated file. This is the exact invariant the first attempt
            # violated, so it is checked arithmetically rather than trusting a tool's exit code.
            IMG_SECTORS=$(( $(stat -c %s "$IMG") / 512 ))
            OVERRUN=$(sfdisk -d "$IMG" 2>/dev/null | awk -v tot="$IMG_SECTORS" '
              /start=/ {
                st=0; sz=0;
                for(i=1;i<=NF;i++){ if($i=="start=") st=$(i+1)+0; if($i=="size=") sz=$(i+1)+0 }
                if (st+sz > tot) print "overrun"
              }' | head -1)
            if [ -z "$OVERRUN" ] && [ "$IMG_SECTORS" -gt 0 ]; then
              # apparent size, NOT `du` — the image is sparse, so du reports allocated blocks and reads as if the
              # partition overran the file. That looked like a corruption bug on the first run and was not one.
              LOG "  rootfs partition now $(( FS_SECTORS / 2048 ))MB; image $(( $(stat -c %s "$IMG") / 1048576 ))MB apparent before the data partition"
            else
              shrink_failed "a partition would end past the end of the file after shrink"
            fi
          else
            shrink_failed "sfdisk could not write the new table"
          fi
        fi
      fi
    fi
  fi
fi

# 9b) APPEND the AUTOPOST-DATA partition (3rd ext4 partition) + move /var/lib/autopost onto it. The image is now
#     unmounted; append-data-partition.sh does its own loop mount. This is what makes the claim token + WiFi persist
#     under the read-only overlay. Assert the partition landed (fail the build loudly if it didn't).
# 768MB, not the upstream 2048MB default: at flash time this partition is essentially empty (config/logs/WiFi
# profiles only accumulate after the device is claimed and running) — imager writes the FULL declared partition
# size regardless of what's actually used, so every unnecessary MB here is pure added flash+verify time on every
# single card. 768MB still leaves generous headroom for config.json, heartbeat/logs, self-update .bak files, and
# WiFi profiles over the device's life — this is not "shrink to the bone," just no longer paying to write ~1.3GB
# of empty space on every flash. Override with DATA_MB=<n> if a future need genuinely requires more.
DATA_MB="${DATA_MB:-768}"
LOG "appending the AUTOPOST-DATA persistence partition (${DATA_MB}MB)"
bash "$(cd "$(dirname "$0")" && pwd)/append-data-partition.sh" "$IMG" "$DATA_MB"
parted -sm "$IMG" unit s print | grep -q '^3:' || { echo "ERROR: AUTOPOST-DATA partition (p3) was not created"; exit 1; }
LOG "AUTOPOST-DATA partition present"

# 10) deliver ----------------------------------------------------------------------------------------------------
LOG "compressing final image"
# COMPRESS ON THE WSL-NATIVE DISK, THEN COPY THE RESULT ACROSS. Compressing in OUT_DIR meant xz doing millions of
# small reads and writes against a ~4GB file on /mnt/c, i.e. over the 9p bridge to the Windows filesystem (with
# Defender inspecting it): measured 2026-08-21 at ~35 minutes, against ~3 minutes for the identical image
# compressed on the ext4 side. Same bytes either way, one big sequential copy at the end instead.
# Compress with -c, straight OUT of $IMG into a staging file, and never move or delete $IMG itself. An earlier
# version staged via `STAGE="$WORK/${OUT_NAME}.img"` + `rm -f "$STAGE"` -- and for ARCH=arm64, OUT_NAME really is
# "autopost-golden", which is the exact name $IMG already has, so that rm DELETED the freshly built image and the
# build then "succeeded" having produced nothing. Deriving the staging name from OUT_NAME is the trap; the
# assertion below makes any future collision fail loudly instead of silently destroying the build.
mkdir -p "$OUT_DIR"
FINAL="$OUT_DIR/${OUT_NAME:-autopost-golden-zerow}.img.xz"
STAGE_XZ="$WORK/staging-output.img.xz"
[ "$STAGE_XZ" != "$IMG" ] || { echo "ERROR: staging path collides with the build image"; exit 1; }
rm -f "$STAGE_XZ"
xz -T0 -c "$IMG" > "$STAGE_XZ"
[ -s "$STAGE_XZ" ] || { echo "ERROR: compression produced an empty file"; exit 1; }
xz -t "$STAGE_XZ" || { echo "ERROR: the compressed image failed its own integrity check"; exit 1; }
rm -f "$OUT_DIR/${OUT_NAME:-autopost-golden-zerow}.img"   # stale raw .img from an older interrupted run
cp "$STAGE_XZ" "$FINAL"
[ -s "$FINAL" ] || { echo "ERROR: copying the image into $OUT_DIR produced nothing"; exit 1; }
rm -f "$STAGE_XZ"
LOG "DONE -> ${FINAL}  ($(stat -c %s "$FINAL") bytes; flash with the AutoPost flasher; nothing dealership-specific is baked in)"
if [ "$ARCH" = armhf ]; then
  LOG "NOTE: this is the 32-bit/ARMv6 build for Pi Zero W (original). It boots on EVERY Pi including the 4."
  LOG "      It is a DIFFERENT file from the 64-bit autopost-golden.img.xz used for Pi 4 — never overwrite one"
  LOG "      with the other; a card flashed with the wrong one does not boot at all."
else
  LOG "NOTE: this is the 64-bit/aarch64 build for Pi 4-class hardware. It will NOT boot on an original Pi Zero W."
  LOG "      It is a DIFFERENT file from the 32-bit autopost-golden-zerow.img.xz — never overwrite one with the"
  LOG "      other; a card flashed with the wrong one does not boot at all."
fi
