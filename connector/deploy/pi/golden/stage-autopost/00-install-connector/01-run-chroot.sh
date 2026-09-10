#!/bin/bash -e
# ==============================================================================================================
# NOT THE SHIPPING BUILD PATH. The golden images that actually get flashed are built by
# deploy/pi/golden/customize-stock-image.sh, which runs deploy/pi/install.sh inside the image chroot and
# hard-asserts the result. This pi-gen stage is an older, parallel route that has drifted: it installs the
# connector and the claim service but NOT autopost-wifi-recovery.service and NOT autopost-ble-setup.service,
# so an image built from here would boot with NO WiFi rescue and NO Bluetooth rescue at all - and would look
# completely normal until the day a card was mis-typed, which is the one day it matters.
#
# Rather than maintain two copies of the same install logic and let them diverge again, this refuses to run.
# If pi-gen is ever revived, make it call deploy/pi/install.sh the way customize-stock-image.sh does.
if [ "${ALLOW_STALE_PIGEN_STAGE:-0}" != 1 ]; then
  echo "ERROR: this pi-gen stage is stale and would build an image with no WiFi/Bluetooth rescue." >&2
  echo "       Build with deploy/pi/golden/customize-stock-image.sh instead." >&2
  exit 1
fi
# ==============================================================================================================
# CHROOT side: install Node + the connector INTO /var/lib/autopost/connector (a rootfs dir for now;
# append-data-partition.sh moves this whole dir onto the real AUTOPOST-DATA partition after the image is built,
# and fstab mounts that partition here at runtime). This is what makes self-update + the claim token survive the
# read-only overlay. Mirrors deploy/pi/install.sh, adapted for the pi-gen chroot + the data-partition layout.

DATA_DIR=/var/lib/autopost
APP_DIR="${DATA_DIR}/connector"

# 1) Node 20 (NodeSource arm64).
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
node --version

# 2) service user (home on the data dir; no shell).
id autopost >/dev/null 2>&1 || useradd --system --home "${DATA_DIR}" --shell /usr/sbin/nologin autopost

# 3) connector code onto the (future) data partition + runtime dir.
install -d "${APP_DIR}" "${DATA_DIR}/runtime"
tar -xzf /tmp/autopost/connector.tar.gz -C "${APP_DIR}"
( cd "${APP_DIR}" && npm install --omit=dev --no-audit --no-fund ws )
chown -R autopost:autopost "${DATA_DIR}"

# 4) claim service (reads /boot/firmware/autopost-claim.env injected at flash time) + NetworkManager polkit rule.
install -m 0644 /tmp/autopost/autopost-claim.service /etc/systemd/system/autopost-claim.service
# GOLDEN LAYOUT FIX: the shipped autopost-claim.service ExecStart points at /opt/autopost/connector, but on the
# golden image the connector lives at /var/lib/autopost/connector (above). Left as-is, first-boot claim runs a
# NON-EXISTENT file -> claim.js never writes /var/lib/autopost/config.json -> the connector unit is
# ConditionPathExists-skipped forever -> the box never phones home (invisible to super-admin). Repoint it here.
sed -i 's#/opt/autopost/connector#/var/lib/autopost/connector#g' /etc/systemd/system/autopost-claim.service
# Assert it now points at a path that exists in the image (fail the build loudly if the layout drifts again).
grep -q '/var/lib/autopost/connector/src/claim.js' /etc/systemd/system/autopost-claim.service || { echo "ERROR: claim service ExecStart not repointed to the data-partition path"; exit 1; }
install -d /etc/polkit-1/rules.d
install -m 0644 /tmp/autopost/50-autopost-nm.rules /etc/polkit-1/rules.d/50-autopost-nm.rules

# 5) connector service — points at the DATA-PARTITION code and refuses to start before that partition is mounted.
cat > /etc/systemd/system/autopost-connector.service <<'UNIT'
[Unit]
Description=AutoPost dealership tunnel connector
After=network-online.target
Wants=network-online.target
# Do NOT start before the persistent data partition (identity/claim/code) is mounted.
RequiresMountsFor=/var/lib/autopost
ConditionPathExists=/var/lib/autopost/config.json
StartLimitIntervalSec=0

[Service]
Type=simple
User=autopost
Group=autopost
WorkingDirectory=/var/lib/autopost/connector
Environment=CONNECTOR_CONFIG=/var/lib/autopost/config.json
Environment=CONNECTOR_RUNTIME_DIR=/var/lib/autopost/runtime
ExecStart=/usr/bin/node /var/lib/autopost/connector/src/agent.js
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/autopost
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX

[Install]
WantedBy=multi-user.target
UNIT

systemctl enable autopost-connector.service
systemctl enable autopost-claim.service 2>/dev/null || true
systemctl enable NetworkManager 2>/dev/null || true

rm -rf /tmp/autopost
