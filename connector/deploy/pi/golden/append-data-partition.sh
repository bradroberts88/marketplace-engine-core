#!/bin/bash
set -euo pipefail
# Append a 3rd ext4 partition LABEL=AUTOPOST-DATA to a pi-gen .img, and MOVE the connector code + data seeded at
# /var/lib/autopost (on the rootfs, from the chroot stage) onto that new partition. After this, fstab (baked in
# the chroot stage) mounts the partition at /var/lib/autopost, so the connector code + claim token live OUTSIDE
# the read-only overlay and survive power cuts.
#
# Usage: sudo append-data-partition.sh <image.img> <data_mb>
# Requires root + loop devices + parted + e2fsprogs. This is the piece that most needs a real test run + a Pi.
IMG="${1:?image path}"; DATA_MB="${2:-2048}"
command -v parted >/dev/null || { echo "need parted"; exit 1; }
command -v mkfs.ext4 >/dev/null || { echo "need e2fsprogs"; exit 1; }

echo "[data] growing image by ${DATA_MB}MB"
dd if=/dev/zero bs=1M count="${DATA_MB}" >> "${IMG}"

echo "[data] creating the AUTOPOST-DATA partition in the free space"
# rootfs is partition 2; append partition 3 from the end of p2 to the end of the disk.
START="$(parted -sm "${IMG}" unit s print | awk -F: '/^2:/{gsub("s","",$3); print $3+1}')"
parted -s "${IMG}" unit s mkpart primary ext4 "${START}" 100%

echo "[data] mapping partitions"
LOOP="$(losetup --show -fP "${IMG}")"    # -P exposes ${LOOP}p1/p2/p3
trap 'set +e; umount "${MNT_DATA}" 2>/dev/null; umount "${MNT_ROOT}/var/lib/autopost" 2>/dev/null; umount "${MNT_ROOT}" 2>/dev/null; losetup -d "${LOOP}" 2>/dev/null; rmdir "${MNT_DATA}" "${MNT_ROOT}" 2>/dev/null' EXIT
sleep 1
P3="${LOOP}p3"; P2="${LOOP}p2"
[ -e "${P3}" ] || { echo "ERROR: ${P3} not exposed (loop -P / partprobe issue)"; exit 1; }

echo "[data] formatting AUTOPOST-DATA (ext4)"
mkfs.ext4 -q -L AUTOPOST-DATA "${P3}"

MNT_ROOT="$(mktemp -d)"; MNT_DATA="$(mktemp -d)"
mount "${P2}" "${MNT_ROOT}"
mount "${P3}" "${MNT_DATA}"

echo "[data] moving /var/lib/autopost (connector code + runtime) onto the data partition"
if [ -d "${MNT_ROOT}/var/lib/autopost" ] && [ -n "$(ls -A "${MNT_ROOT}/var/lib/autopost" 2>/dev/null)" ]; then
  cp -a "${MNT_ROOT}/var/lib/autopost/." "${MNT_DATA}/"          # -a preserves the autopost:autopost ownership
  rm -rf "${MNT_ROOT}/var/lib/autopost/"* "${MNT_ROOT}/var/lib/autopost/".[!.]* 2>/dev/null || true
else
  echo "[data] WARN: /var/lib/autopost empty on rootfs — connector may not have installed in the chroot stage"
fi
# leave /var/lib/autopost as an empty mountpoint (fstab mounts the partition here at boot)

sync
echo "[data] done. Partitions:"
parted -s "${IMG}" unit MB print
# trap cleans up mounts + loop
