#!/usr/bin/env bash
# AutoPost connector — one-shot installer for a fresh Raspberry Pi OS Lite (Debian bookworm, arm64 or armhf/ARMv6).
# Turns a blank Pi into a plug-and-forget 24/7 tunnel device: Node + the connector + a self-restarting systemd
# service + Tailscale (super-admin remote terminal / restart / change-WiFi) + a read-only-rootfs pointer.
#
# Run once, as root, on the Pi:   sudo bash install.sh
# It is idempotent — safe to re-run.
set -euo pipefail

# CRLF guard: a Windows checkout can leave \r in shipped scripts/units — bash and systemd choke on them. Strip it
# from every sibling file this installer copies/executes (install.sh itself is kept LF by the repo .gitattributes).
for f in "$(dirname "$0")"/*.sh "$(dirname "$0")"/*.service "$(dirname "$0")"/*.rules "$(dirname "$0")"/*.conf; do [ -f "$f" ] && sed -i 's/\r$//' "$f" 2>/dev/null || true; done

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"   # the desktop-connector checkout copied onto the Pi
APP_DIR=/opt/autopost/connector
DATA_DIR=/var/lib/autopost
SVC=/etc/systemd/system/autopost-connector.service

echo "[install] AutoPost connector -> Raspberry Pi"

# 1) Node 18+ (NodeSource keeps Pi/arm64 current; skip if a good node is already present).
#    NodeSource's setup_20.x repo has DROPPED 32-bit ARM entirely ("Unsupported architecture: armhf. Only amd64,
#    arm64 are supported" — confirmed 2026-08-12), which is why it fails on the original Pi Zero W / Pi 1
#    (BCM2835, ARM1176JZF-S = ARMv6, armhf userspace). Detect via `dpkg --print-architecture` rather than
#    `uname -m` — under qemu-user emulation (e.g. building the golden image in a chroot) uname reports the
#    emulated CPU model, not the actual armhf userspace, so it's not reliable here. On armhf, pull the same
#    Node.js release from the community "unofficial builds" mirror instead
#    (https://unofficial-builds.nodejs.org), which exists specifically to keep current Node versions running on
#    Pi Zero/Pi 1.
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  if [ "$(dpkg --print-architecture 2>/dev/null)" = "armhf" ]; then
    echo "[install] armhf detected (Pi Zero/Pi 1, ARMv6) — installing Node.js 20 from unofficial-builds.nodejs.org"
    # No "latest-v20.x" alias on this mirror (unlike nodejs.org) — resolve the newest v20.x release that still
    # ships a linux-armv6l build from the release index instead. Download to a file (not a pipe into curl), and
    # use grep -m1 (not `| head -1`) — the index lists dozens of matching v20.x releases, and head closing the
    # pipe after the first one sends the still-writing grep a SIGPIPE, which `pipefail` turns into a failure
    # even though the right answer was already found.
    curl -fsSL "https://unofficial-builds.nodejs.org/download/release/index.json" -o /tmp/node-index.json
    NODE_VER="$(grep -m1 -o '"version":"v20\.[0-9]*\.[0-9]*"[^}]*linux-armv6l[^}]*' /tmp/node-index.json | grep -o 'v20\.[0-9]*\.[0-9]*')"
    rm -f /tmp/node-index.json
    [ -n "$NODE_VER" ] || { echo "[install] ERROR: could not resolve a Node.js 20 ARMv6 build from unofficial-builds.nodejs.org"; exit 1; }
    curl -fsSL "https://unofficial-builds.nodejs.org/download/release/${NODE_VER}/node-${NODE_VER}-linux-armv6l.tar.gz" -o /tmp/node.tar.gz
    tar -xzf /tmp/node.tar.gz -C /usr/local --strip-components=1
    rm -f /tmp/node.tar.gz
    # The systemd units (autopost-connector/-claim/-wifi-recovery.service) hardcode ExecStart=/usr/bin/node,
    # matching where NodeSource's apt package puts it on the 64-bit path. This tarball install lands in
    # /usr/local/bin instead — `node --version` on the command line still finds it via PATH (which is why this
    # was missed during the image build), but systemd's absolute path does not, so every node-based service
    # fails immediately with status=203/EXEC. Symlink so both paths resolve to the same binary.
    ln -sf /usr/local/bin/node /usr/bin/node
    ln -sf /usr/local/bin/npm /usr/bin/npm
    ln -sf /usr/local/bin/npx /usr/bin/npx
  else
    echo "[install] installing Node.js 20 LTS"
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
  fi
fi
node --version

# 2) Dedicated unprivileged service user + writable data dir (kept OFF the read-only rootfs).
id autopost >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin autopost
# CRITICAL: the agent reads vcgencmd (undervoltage/thermal telemetry) AS the autopost user — that needs the video
# group, or every field power/temp reading silently fails and a dying PSU/fan at a dealership goes unseen.
usermod -aG video autopost 2>/dev/null || true
mkdir -p "$APP_DIR" "$DATA_DIR/runtime"

# 3) Copy the connector code (relay only — no Electron/Windows bits needed).
echo "[install] copying connector to $APP_DIR"
# --chmod: the repo is copied off a Windows filesystem, which carries no POSIX modes, so plain `rsync -a` lands
# EVERY file 0777 -- world-writable connector code any local user could rewrite and have run on the next restart.
# That also silently voided the signed-update chain: forging an Ed25519 signature is pointless when the file can
# simply be edited. Pin the modes explicitly instead of inheriting nonsense from the source filesystem.
# The tree stays OWNED by `autopost` (chown below) because the agent legitimately rewrites its own code when the
# hub pushes a signed update -- making it read-only to its owner would break remote updates.
#
# --exclude flasher/ + _test/: the flasher is a WINDOWS app and none of it runs on a Pi. It was being copied
# anyway, and its test fixtures carried the real fleet SSH password in plaintext -- so every shipped card held,
# world-readable, the one credential that unlocks every other card. Excluded at the source, not scrubbed after.
rsync -a --delete --chmod=D750,F640 \
  --exclude node_modules --exclude _e2e --exclude _fe2e --exclude _cl --exclude build \
  --exclude 'flasher/' --exclude '_test/' --exclude '*.test.js' \
  --exclude 'install/' --exclude '*.ps1' --exclude '*.vbs' --exclude '*.cmd' --exclude 'electron-main.js' \
  "$REPO_DIR"/ "$APP_DIR"/
# Shell helpers under deploy/ are executed directly in places, so restore their execute bit after the 0640.
find "$APP_DIR" -name '*.sh' -exec chmod 0750 {} + 2>/dev/null || true
# ws is the ONLY runtime dependency.
( cd "$APP_DIR" && npm install --omit=dev --no-audit --no-fund ws )
chown -R autopost:autopost "$APP_DIR" "$DATA_DIR"

# 4) systemd service (24/7 auto-start + restart-forever).
cp "$(dirname "$0")/autopost-connector.service" "$SVC"
cp "$(dirname "$0")/autopost-claim.service" /etc/systemd/system/autopost-claim.service 2>/dev/null || true
# POLKIT rule — authorizes the unprivileged `autopost` user to drive nmcli. WITHOUT this the remote change-WiFi
# path (agent onWifi -> set-wifi.sh) silently fails, which is the ONE lever we have when a box is on the wrong
# network. (Bug found 2026-07-15: the rule file documented itself as installed here, but nothing copied it.)
if [ -f "$(dirname "$0")/50-autopost-nm.rules" ]; then
  mkdir -p /etc/polkit-1/rules.d
  cp "$(dirname "$0")/50-autopost-nm.rules" /etc/polkit-1/rules.d/50-autopost-nm.rules
  systemctl restart polkit 2>/dev/null || true
  echo "[install] polkit rule installed (autopost user may drive nmcli)"
fi
systemctl daemon-reload 2>/dev/null || true   # (image-bake chroot has no running systemd — harmless to skip there)
systemctl enable autopost-connector.service 2>/dev/null || true
# SELF-CLAIM at first boot: double-gated by the unit itself (runs ONLY if config.json is absent AND a claim env
# was dropped on the boot partition), so enabling it is safe for a pre-baked pilot box — it just no-ops there.
# (Bug found 2026-07-15: the unit was copied but never enabled, so a shipped card would NEVER self-claim.)
systemctl enable autopost-claim.service 2>/dev/null || true

# 4b) WiFi-RECOVERY service — the on-device rescue when a box is flashed with the WRONG WiFi credentials. It is
# headless with no internet, so there is no SSH/Tailscale/remote fix; this raises an "AutoPost-Setup" hotspot +
# captive portal so the DEALERSHIP re-enters the correct WiFi from a phone. Runs with NO config gate (a wrong-WiFi
# box never claims) as the autopost user (nmcli authorized by the polkit rule above). The captive DNS conf makes
# every phone auto-pop the setup page. See src/wifi-recovery.js.
cp "$(dirname "$0")/autopost-wifi-recovery.service" /etc/systemd/system/autopost-wifi-recovery.service 2>/dev/null || true
if [ -f "$(dirname "$0")/autopost-captive-dnsmasq.conf" ]; then
  mkdir -p /etc/NetworkManager/dnsmasq-shared.d
  cp "$(dirname "$0")/autopost-captive-dnsmasq.conf" /etc/NetworkManager/dnsmasq-shared.d/autopost-captive.conf
fi
# NetworkManager's AP "shared" mode (ipv4.method=shared) needs dnsmasq-base to hand out DHCP + DNS on the setup AP;
# a minimal Pi OS Lite image may lack it, and without it the recovery AP raises but no phone can get an IP or reach
# the portal. Install the -base package ONLY (the full `dnsmasq` package runs a conflicting daemon on :53).
if ! dpkg -s dnsmasq-base >/dev/null 2>&1; then
  echo "[install] installing dnsmasq-base (required for the WiFi-recovery setup AP)"
  # Same stale-index hazard as the Bluetooth deps below: refresh, and retry once with --fix-missing.
  apt-get update -y >/dev/null 2>&1 || true
  apt-get install -y dnsmasq-base     || apt-get install -y --fix-missing dnsmasq-base     || echo "[install] WARN: dnsmasq-base install failed — the recovery AP DHCP/DNS may not work"
fi
systemctl daemon-reload 2>/dev/null || true
systemctl enable autopost-wifi-recovery.service 2>/dev/null || true

# 4c) BLUETOOTH SETUP service - the REDUNDANT front door onto the same rescue.
# The WiFi rescue above needs the WiFi radio, and the Pi has exactly one: it cannot host the setup AP and test
# the real network at the same time, so there are always windows where the "AutoPost-Setup" network is not in
# the air. Every field report of "we watched the WiFi list for twenty minutes and it never appeared" lands in
# that gap. Bluetooth is a separate controller with its own link layer, so this channel is reachable while the
# WiFi radio is scanning, associating, failing, hosting the AP, or torn down mid-probe. It writes a request file
# that wifi-recovery.js applies - it never drives nmcli itself. See deploy/pi/autopost-ble-setup.py.
if [ "${SKIP_BLE:-0}" != 1 ]; then
  # python3-dbus + python3-gi are the BlueZ GATT path (the one BlueZ itself documents and ships examples for).
  # bluez brings bluetoothd; pi-bluetooth carries the hciuart attach that the Pi Zero W's UART-attached radio
  # needs before an adapter exists at all.
  # FORCE THE RASPBERRY PI ARCHIVE ONTO HTTPS BEFORE ANY FETCH.
  # Raspberry Pi OS ships its own archive as PLAIN HTTP. Filtering appliances on corporate/retail networks
  # routinely intercept that: a Meraki on this build network answers archive.raspberrypi.com with a 302 to
  # blocked.cgi and a ~3KB HTML page. apt does not see a block - it sees a .deb of the wrong length, and reports
  # "File has unexpected size (3010 != 5488). Mirror sync in progress?", which sends you to look at the mirror.
  # The mirror is fine. HTTPS is not interceptable the same way and was verified to pass straight through, so
  # rewrite the sources rather than teaching every future builder to recognise that error.
  # Idempotent, and deb.debian.org is deliberately left alone - it is not the one being filtered, and rewriting
  # sources nobody complained about is how you break somebody's internal mirror.
  for SRC in /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources; do
    [ -f "$SRC" ] || continue
    grep -q 'http://archive.raspberrypi.com' "$SRC" 2>/dev/null || continue
    sed -i 's|http://archive\.raspberrypi\.com|https://archive.raspberrypi.com|g' "$SRC"
    echo "[install] switched $(basename "$SRC") to https (plain HTTP to the Pi archive is commonly intercepted)"
  done
  # apt speaks HTTPS natively since 1.5, but it still needs the trust store to verify the certificate.
  dpkg -s ca-certificates >/dev/null 2>&1 || apt-get install -y ca-certificates || true

  # REFRESH THE INDEX FIRST. The stock image ships a months-old apt index, and this is the first place install.sh
  # actually fetches a .deb (node comes over curl, and dnsmasq-base is normally already present), so nothing had
  # ever exercised it. A stale index points at package VERSIONS the mirror has since replaced, which apt reports
  # as "File has unexpected size (3011 != 5488). Mirror sync in progress?" - confusing, because the mirror is
  # fine and the index is what is wrong. Non-fatal: an offline build should still get as far as it can.
  apt-get update -y >/dev/null 2>&1 || echo "[install] WARN: apt-get update failed - package installs may use a stale index"

  # ESSENTIAL vs OPTIONAL, in SEPARATE transactions. apt installs a transaction atomically, so one unavailable
  # package takes the whole set down with it - which is exactly what happened on the first bake: pi-bluetooth
  # failed to fetch and dragged python3-dbus and python3-gi down with it, leaving an image whose BLE channel
  # could not start. An optional package must never be able to do that to a required one.
  BLE_ESSENTIAL=""
  for pkg in bluez python3-dbus python3-gi; do
    dpkg -s "$pkg" >/dev/null 2>&1 || BLE_ESSENTIAL="$BLE_ESSENTIAL $pkg"
  done
  if [ -n "$BLE_ESSENTIAL" ]; then
    echo "[install] installing Bluetooth setup deps:$BLE_ESSENTIAL"
    apt-get install -y $BLE_ESSENTIAL       || { echo "[install] retrying Bluetooth deps individually after a fresh index"
           apt-get update -y >/dev/null 2>&1 || true
           for pkg in $BLE_ESSENTIAL; do
             apt-get install -y --fix-missing "$pkg" || echo "[install] WARN: $pkg could not be installed"
           done; }
  fi

  # pi-bluetooth carries the hciuart attach that a UART-connected radio (Pi Zero W, Pi 3, Pi 4) needs before an
  # adapter exists at all. Its own transaction, so a fetch failure here cannot cost us the packages above. It
  # only exists in the Raspberry Pi archive; absent from the archive entirely is not an error.
  if apt-cache show pi-bluetooth >/dev/null 2>&1 && ! dpkg -s pi-bluetooth >/dev/null 2>&1; then
    echo "[install] installing pi-bluetooth (hciuart: attaches the UART-connected Bluetooth radio)"
    apt-get install -y pi-bluetooth       || { apt-get update -y >/dev/null 2>&1 || true; apt-get install -y --fix-missing pi-bluetooth; }       || echo "[install] WARN: pi-bluetooth failed - without hciuart the Bluetooth adapter may never appear"
  fi
  install -m 0644 "$(dirname "$0")/60-autopost-bluez.conf" /etc/dbus-1/system.d/60-autopost-bluez.conf 2>/dev/null     || echo "[install] WARN: could not install the BlueZ D-Bus policy"
  # The service runs unprivileged; group membership is the distro's own route to org.bluez and the D-Bus policy
  # above is the belt to its braces. Either alone is enough; both means an OS bump cannot quietly break it.
  getent group bluetooth >/dev/null 2>&1 && usermod -aG bluetooth autopost 2>/dev/null || true
  install -m 0644 "$(dirname "$0")/autopost-ble-setup.service" /etc/systemd/system/autopost-ble-setup.service 2>/dev/null     || echo "[install] WARN: could not install autopost-ble-setup.service"
  # A card with the Bluetooth radio disabled in config.txt would run this service against an adapter that never
  # appears. Warn loudly rather than shipping a rescue channel that cannot work.
  for CFG in /boot/firmware/config.txt /boot/config.txt; do
    [ -f "$CFG" ] || continue
    grep -qE '^[[:space:]]*dtoverlay=(disable-bt|pi3-disable-bt)' "$CFG" 2>/dev/null       && echo "[install] WARN: $CFG disables Bluetooth (dtoverlay=disable-bt) - the BLE rescue channel cannot work on this card"
  done
  systemctl daemon-reload 2>/dev/null || true
  systemctl enable bluetooth.service 2>/dev/null || true
  systemctl enable hciuart.service 2>/dev/null || true   # Pi Zero W / Pi 3: attaches the UART-connected radio
  systemctl enable autopost-ble-setup.service 2>/dev/null || true
  echo "[install] Bluetooth setup channel installed (device name: AutoPost-Setup-<last 4 of serial>)"
fi

# 5) Tailscale — super-admin remote terminal / reach, behind any NAT, no port-forwarding.
#    Auth non-interactively at imaging time:  TS_AUTHKEY=tskey-... sudo bash install.sh
if [ "${SKIP_TAILSCALE:-0}" != 1 ] && ! command -v tailscale >/dev/null 2>&1; then
  echo "[install] installing Tailscale"
  curl -fsSL https://tailscale.com/install.sh | sh || echo "[install] WARN: Tailscale install failed (non-fatal)"
fi
systemctl enable tailscaled 2>/dev/null || true   # enable now; it starts on the real boot (--now would need a live systemd)
systemctl start tailscaled 2>/dev/null || true
if [ -n "${TS_AUTHKEY:-}" ]; then
  # --ssh enables Tailscale SSH (super-admin terminal). The hostname is already autopost-<dealership> from
  # imaging, so pass it straight through (do NOT prefix another "autopost-" or it double-stacks).
  tailscale up --authkey "$TS_AUTHKEY" --ssh --hostname "$(hostname)" --accept-dns=false || true
else
  echo "[install] NOTE: set TS_AUTHKEY at imaging time to auto-join Tailscale (or run 'tailscale up --ssh' once)."
fi

# 5b) UNATTENDED per-device Tailscale join at first boot. The flasher drops /boot/firmware/autopost-tailscale.env
# (reusable key + per-device hostname) and this oneshot runs `tailscale up --ssh` on the real boot, so a shipped box
# is SSH-reachable off-LAN with ZERO commands at the dealership. Node state persists on AUTOPOST-DATA (golden symlink)
# so it stays the same node across reboots + the overlay. No-ops on a card with no key file.
cp "$(dirname "$0")/autopost-tailscale.service" /etc/systemd/system/autopost-tailscale.service 2>/dev/null || true
systemctl daemon-reload 2>/dev/null || true
systemctl enable autopost-tailscale.service 2>/dev/null || true

# 5b) UNATTENDED-OPERATION LAYER. Baked into the IMAGE, deliberately, rather than written by firstrun.sh at first
#     boot: everything here lives on the rootfs, and once the read-only overlay is switched on, anything written
#     to the rootfs at first boot evaporates on the next reboot. Baking it is what makes the overlay safe to
#     enable at all.
echo "[install] baking the unattended-operation layer (watchdog, journal cap, USB gadget)"

# --- hardware watchdog -------------------------------------------------------------------------------------
# Service-level Restart=always only helps while systemd is still running. If the KERNEL wedges, nothing recovers
# the box and a dealership needs a physical power cycle. /dev/watchdog exists on every Pi; this arms it so a
# hung unit reboots itself in ~15s instead of becoming a truck roll.
install -d -m 0755 /etc/systemd/system.conf.d
cat > /etc/systemd/system.conf.d/10-autopost-watchdog.conf <<'EOF'
[Manager]
RuntimeWatchdogSec=15
RebootWatchdogSec=2min
EOF

# --- journal size cap --------------------------------------------------------------------------------------
# journald defaults to ~10% of /var. On a device expected to run for years on an SD card, write volume is what
# eventually kills the card. 50M is plenty to diagnose a fault and bounded enough not to grind the flash.
install -d -m 0755 /etc/systemd/journald.conf.d
cat > /etc/systemd/journald.conf.d/10-autopost-cap.conf <<'EOF'
[Journal]
SystemMaxUse=50M
SystemMaxFileSize=10M
EOF

# --- USB ethernet gadget (support access over the USB cable) -----------------------------------------------
# NOT g_ether: that legacy module is gone from current Pi OS kernels, so it silently loads nothing and Pi OS's
# own CDC-ACM serial gadget keeps the USB device controller. libcomposite/configfs + RNDIS is the supported
# path, and the Microsoft OS descriptors make Windows bind its driver with no manual step.
if [ -f "$(dirname "$0")/autopost-usb-gadget.sh" ]; then
  install -m 0755 "$(dirname "$0")/autopost-usb-gadget.sh" /usr/local/sbin/autopost-usb-gadget.sh
  cat > /etc/systemd/system/autopost-usb-gadget.service <<'EOF'
[Unit]
Description=AutoPost USB ethernet gadget (support access over the USB cable)
# Runs LATE and takes the controller over: Pi OS creates its own serial gadget during boot and whichever binds
# LAST owns the UDC, so we must follow it rather than race it.
After=NetworkManager.service systemd-modules-load.service
Wants=NetworkManager.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/autopost-usb-gadget.sh

[Install]
WantedBy=multi-user.target
EOF
  install -d -m 0755 /etc/modules-load.d
  echo libcomposite > /etc/modules-load.d/autopost-usb-gadget.conf
  # enable by direct symlink: `systemctl enable` is unreliable inside a qemu chroot (same reason the golden
  # build creates every other wants-link by hand and hard-asserts on it).
  install -d -m 0755 /etc/systemd/system/multi-user.target.wants
  ln -sf /etc/systemd/system/autopost-usb-gadget.service \
         /etc/systemd/system/multi-user.target.wants/autopost-usb-gadget.service
  echo "[install]   USB gadget baked + enabled"
else
  echo "[install]   WARN: autopost-usb-gadget.sh not found — USB support access will NOT be available"
fi

# --- sshd --------------------------------------------------------------------------------------------------
# Tailscale SSH is a DIFFERENT server and does not listen on usb0, so the USB link needs the real one. Only
# enable a unit if the OS has neither form enabled: Debian 13 ships ssh.socket, and enabling both leaves them
# fighting over port 22.
if ! systemctl is-enabled ssh.socket >/dev/null 2>&1 && ! systemctl is-enabled ssh.service >/dev/null 2>&1; then
  systemctl enable ssh >/dev/null 2>&1 || {
    for U in /usr/lib/systemd/system/ssh.service /lib/systemd/system/ssh.service; do
      [ -f "$U" ] && ln -sf "$U" /etc/systemd/system/multi-user.target.wants/ssh.service && break
    done
  }
fi
rm -f /etc/ssh/sshd_config.d/rename_user.conf 2>/dev/null || true

# 6) Read-only rootfs overlay — DO NOT enable it on a card installed this way. This install.sh path keeps
#    /var/lib/autopost (the claim token) AND /etc/NetworkManager/system-connections on the ROOTFS, so turning on
#    the overlay here EVICTS both on the first power cut: the box loses its identity AND any corrected WiFi =
#    permanent, physical-recovery-only brick. The overlay is ONLY safe on the GOLDEN image, which bakes a separate
#    AUTOPOST-DATA partition and symlinks NM connections onto it (deploy/pi/golden + GOLDEN-IMAGE-SPEC.md), and
#    only after the on-Pi selftest 'overlay_active' + 2x power-cut persistence canary pass. See README.md.
# 7) BURN-IN SELF-TEST (defect gate) — a simple command the VA runs; the connector reports selftest.json up to the
#    hub so the "Ship a Pi" page shows PASS/FAIL and BLOCKS shipping a bad unit. Runs now unless SKIP_SELFTEST=1.
chmod +x "$APP_DIR/deploy/pi/selftest.sh" 2>/dev/null || true
ln -sf "$APP_DIR/deploy/pi/selftest.sh" /usr/local/bin/autopost-selftest 2>/dev/null || true
BURNIN_RC=0
if [ "${SKIP_SELFTEST:-0}" != 1 ]; then
  echo "[install] running burn-in self-test (defect gate)…"
  bash "$APP_DIR/deploy/pi/selftest.sh" || BURNIN_RC=$?
fi

echo "[install] done. Provision config + WiFi, then start the connector. DO NOT enable the read-only overlay on"
echo "[install]   this card — it is only safe on the golden image (AUTOPOST-DATA partition). See deploy/pi/README.md."
echo "[install]   start:  sudo systemctl start autopost-connector   |   re-test:  sudo autopost-selftest"

# A DEFECTIVE unit must not look like a successful install. Previously the burn-in failure was swallowed by
# `|| echo` and install.sh still exited 0 — so an automated/VA flow would happily box a bad Pi. Exit non-zero so
# the caller (and the flasher app) can HARD-STOP. (Bug found 2026-07-15.)
if [ "$BURNIN_RC" != 0 ]; then
  echo "[install] ⛔ BURN-IN FAILED — DO NOT SHIP this unit (fix/replace + re-run: sudo autopost-selftest)." >&2
  exit "$BURNIN_RC"
fi
