#!/bin/bash
set -euo pipefail
# Orchestrate the AutoPost golden image build:
#   1) tar the connector code (what the image bakes in), 2) fetch pi-gen + drop our stage in, 3) build the rootfs
#   image, 4) append + seed the AUTOPOST-DATA partition. Run from the repo root on Linux (Docker or WSL2 Ubuntu).
# STATUS: recipe — run + iterate in a Linux build env; certify on a Pi (see README).

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${HERE}/../../.." && pwd)"        # .../desktop-connector
PIGEN_DIR="${PIGEN_DIR:-${HERE}/pi-gen}"
OUT_DIR="${HERE}/out"
FILES="${HERE}/stage-autopost/00-install-connector/files"
DATA_MB="${DATA_MB:-2048}"                          # AUTOPOST-DATA partition size (grows on first boot anyway)

echo "[golden] 1/4 packaging connector code -> ${FILES}/connector.tar.gz"
mkdir -p "${FILES}" "${OUT_DIR}"
tar -czf "${FILES}/connector.tar.gz" -C "${REPO_ROOT}" \
  --exclude node_modules --exclude _e2e --exclude _fe2e --exclude _cl --exclude build \
  --exclude 'flasher' --exclude 'deploy/pi/golden/pi-gen' --exclude 'deploy/pi/golden/out' \
  src package.json
cp "${REPO_ROOT}/deploy/pi/autopost-claim.service" "${FILES}/autopost-claim.service"
cp "${REPO_ROOT}/deploy/pi/50-autopost-nm.rules"   "${FILES}/50-autopost-nm.rules"

echo "[golden] 2/4 fetching pi-gen"
if [ ! -d "${PIGEN_DIR}" ]; then
  git clone --depth 1 https://github.com/RPi-Distro/pi-gen "${PIGEN_DIR}"
fi
cp "${HERE}/pi-gen.config" "${PIGEN_DIR}/config"
rm -rf "${PIGEN_DIR}/stage-autopost"
cp -r "${HERE}/stage-autopost" "${PIGEN_DIR}/stage-autopost"
# pi-gen skips a stage unless it has an EXPORT marker or is in STAGE_LIST; ours is in STAGE_LIST (pi-gen.config).
touch "${PIGEN_DIR}/stage-autopost/SKIP_IMAGES" 2>/dev/null || true   # we export the .img ourselves post-build
chmod +x "${PIGEN_DIR}/stage-autopost/prerun.sh" "${PIGEN_DIR}"/stage-autopost/*/*.sh 2>/dev/null || true

echo "[golden] 3/4 building rootfs image with pi-gen (this takes ~45-90 min)"
cd "${PIGEN_DIR}"
if command -v docker >/dev/null 2>&1; then
  echo "[golden]   using pi-gen Docker build"
  CONTINUE=1 ./build-docker.sh
else
  echo "[golden]   Docker not found -> native build (needs: qemu-user-static binfmt-support debootstrap kpartx)"
  [ -e /dev/loop0 ] || echo "[golden]   WARN: no /dev/loop* — loop devices are required (WSL2: 'sudo modprobe loop' or use Docker)"
  sudo ./build.sh
fi

IMG="$(ls -t "${PIGEN_DIR}/deploy/"*.img 2>/dev/null | head -1 || true)"
[ -n "${IMG}" ] || { echo "[golden] ERROR: pi-gen produced no .img in ${PIGEN_DIR}/deploy"; exit 1; }
echo "[golden] rootfs image: ${IMG}"

echo "[golden] 4/4 appending + seeding the AUTOPOST-DATA partition"
FINAL="${OUT_DIR}/autopost-golden-$(date +%Y-%m-%d 2>/dev/null || echo build).img"
cp "${IMG}" "${FINAL}"
sudo bash "${HERE}/append-data-partition.sh" "${FINAL}" "${DATA_MB}"

echo "[golden] compressing"
xz -T0 -f "${FINAL}"
echo "[golden] DONE -> ${FINAL}.xz"
echo "[golden] Flash it with the AutoPost flasher (rpi-imager verify ON), then CERTIFY on a Pi (README checklist)."
