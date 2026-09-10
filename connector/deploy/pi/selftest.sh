#!/usr/bin/env bash
# AutoPost Pi — PRE-SHIP BURN-IN SELF-TEST + DEFECT GATE
# ---------------------------------------------------------------------------------------------------------------
# Runs ON the Pi (as root) at the end of provisioning. A non-technical VA runs ONE command; this exercises the
# hardware, OS, storage, thermals, power, network, and the connector, and prints a clear SHIP / DO-NOT-SHIP
# verdict. It writes /var/lib/autopost/selftest.json which the connector reports up to the hub, so the Super
# Admin provisioning page shows PASS/FAIL and BLOCKS shipping an un-passed device. Because a shipped Pi CANNOT
# be recalled, a marginal unit (bad PSU, weak cooling, flaky SD/RAM, corrupt image) MUST surface here, not at a
# dealership. Every CRITICAL check that fails => overall FAIL => mark the unit DEFECTIVE and do not ship.
#
#   sudo bash selftest.sh                 # full burn-in (~4-6 min incl. stress). Exit 0 = SHIP, 1 = DEFECTIVE.
#   sudo bash selftest.sh --quick         # skip the long stress/badblocks (dev only; NOT a ship gate)
#
# Thresholds are conservative for a Pi 4B (4GB) + official 27W PSU + a fan case. Tune via env if needed.
set -u
QUICK=0; [ "${1:-}" = "--quick" ] && QUICK=1
DATA_DIR="${CONNECTOR_RUNTIME_DIR:-/var/lib/autopost}"
OUT_JSON="$DATA_DIR/selftest.json"
STRESS_SECS="${SELFTEST_STRESS_SECS:-120}"
TEMP_MAX_C="${SELFTEST_TEMP_MAX_C:-70}"        # tightened 80->70C (deep-analysis): ~15C headroom for a hot dealership closet
FREE_MIN_MB="${SELFTEST_FREE_MIN_MB:-1024}"
CONTROL_HOST="${SELFTEST_CONTROL_HOST:-}"      # filled from config.json below
mkdir -p "$DATA_DIR" 2>/dev/null || true

# ---- result accumulator ----------------------------------------------------------------------------------------
declare -a R_NAME R_SEV R_OK R_DETAIL
add() { R_NAME+=("$1"); R_SEV+=("$2"); R_OK+=("$3"); R_DETAIL+=("$4"); }   # name, severity(critical|high|info), ok(1/0), detail
have() { command -v "$1" >/dev/null 2>&1; }
num()  { echo "${1:-0}" | tr -cd '0-9.'; }

echo "==================== AutoPost Pi burn-in self-test ===================="
SERIAL=$(cat /proc/cpuinfo 2>/dev/null | awk -F': ' '/Serial/{print $2}' | tail -1)
MODEL=$(tr -d '\0' < /proc/device-tree/model 2>/dev/null)
echo "model: ${MODEL:-unknown}  serial: ${SERIAL:-unknown}  quick=$QUICK"

# ---- 0) install missing test tools (best-effort; absence != fail, just SKIP that stressor) ---------------------
if [ "$QUICK" = "0" ]; then
  for pkg in stress-ng memtester; do have "${pkg%%-*}" || have "$pkg" || apt-get install -y "$pkg" >/dev/null 2>&1 || true; done
fi

# ---- 1) POWER / UNDERVOLTAGE (the #1 Pi failure) — CRITICAL --------------------------------------------------
if have vcgencmd; then
  TH=$(vcgencmd get_throttled 2>/dev/null | sed 's/.*=//')
  THN=$(( TH ))
  # bit0 undervolt now, bit16 undervolt occurred; bit1/bit17 freq-cap; bit2/bit18 throttled; bit3/bit19 soft-temp-limit
  if [ "$THN" -eq 0 ]; then add "power_undervoltage" critical 1 "get_throttled=0x0 (clean PSU + cable)"
  else add "power_undervoltage" critical 0 "get_throttled=$TH — UNDERVOLTAGE/THROTTLE bits set. Bad/underspec PSU or cable. Swap the 27W official PSU + cable, re-run."; fi
else add "power_undervoltage" critical 0 "vcgencmd missing — not Pi OS / wrong image"; fi

# ---- 2) HARDWARE: RAM + CPU cores — CRITICAL ------------------------------------------------------------------
CORES=$(nproc 2>/dev/null); [ "${CORES:-0}" -ge 4 ] && add "cpu_cores" critical 1 "$CORES cores online" || add "cpu_cores" critical 0 "only ${CORES:-0}/4 cores online — CPU/boot fault"
TOTAL_MB=$(( $(awk '/MemTotal/{print $2}' /proc/meminfo 2>/dev/null || echo 0) / 1024 ))
[ "$TOTAL_MB" -ge 1800 ] && add "ram_size" high 1 "${TOTAL_MB}MB RAM" || add "ram_size" high 0 "${TOTAL_MB}MB RAM (low/mis-detected)"
if [ "$QUICK" = "0" ] && have memtester; then
  if memtester 200M 1 >/tmp/memtest.log 2>&1; then add "ram_integrity" critical 1 "memtester 200M passed"
  else add "ram_integrity" critical 0 "memtester FAILED — bad RAM, DEFECTIVE ($(tail -1 /tmp/memtest.log))"; fi
else add "ram_integrity" critical "$([ "$QUICK" = 1 ] && echo 1 || echo 0)" "$([ "$QUICK" = 1 ] && echo 'skipped (--quick)' || echo 'memtester unavailable — install it')"; fi

# ---- 3) STORAGE: SD write/read integrity, free space, I/O errors — CRITICAL ----------------------------------
TF="$DATA_DIR/.selftest_io"
if dd if=/dev/urandom of="$TF" bs=1M count=32 conv=fsync >/dev/null 2>&1; then
  SUM1=$(sha256sum "$TF" | awk '{print $1}'); sync; echo 3 > /proc/sys/vm/drop_caches 2>/dev/null || true
  SUM2=$(sha256sum "$TF" | awk '{print $1}'); rm -f "$TF"
  [ "$SUM1" = "$SUM2" ] && add "sd_write_read" critical 1 "32MB write/verify OK" || add "sd_write_read" critical 0 "SD read-back MISMATCH — failing card, DEFECTIVE"
else add "sd_write_read" critical 0 "SD write FAILED (read-only/full/dead card)"; fi
FREE_MB=$(( $(df -Pm "$DATA_DIR" 2>/dev/null | awk 'NR==2{print $4}') ))
[ "${FREE_MB:-0}" -ge "$FREE_MIN_MB" ] && add "disk_free" high 1 "${FREE_MB}MB free" || add "disk_free" high 0 "only ${FREE_MB:-0}MB free (need >=${FREE_MIN_MB})"
IOERR=$(dmesg 2>/dev/null | grep -icE 'mmc[0-9].*(error|timeout|failed)|I/O error|EXT4-fs error|blk_update_request')
[ "${IOERR:-0}" -eq 0 ] && add "sd_io_errors" critical 1 "no SD/IO errors in dmesg" || add "sd_io_errors" critical 0 "$IOERR SD/IO errors in dmesg — failing card"

# ---- 4) OS / FIRMWARE / KERNEL — CRITICAL/high ---------------------------------------------------------------
ARCH=$(uname -m); [ "$ARCH" = "aarch64" ] && add "os_arch" critical 1 "aarch64" || add "os_arch" critical 0 "arch=$ARCH (need aarch64/64-bit Pi OS)"
PANIC=$(dmesg 2>/dev/null | grep -icE 'kernel panic|Oops|BUG: |segfault'); [ "${PANIC:-0}" -eq 0 ] && add "kernel_clean" critical 1 "no panics/oops" || add "kernel_clean" critical 0 "$PANIC kernel panics/oops in dmesg"
if have vcgencmd; then BLV=$(vcgencmd bootloader_version 2>/dev/null | head -1); add "bootloader" info 1 "${BLV:-unknown}"; fi
if have node; then NV=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null); [ "${NV:-0}" -ge 18 ] && add "node_version" critical 1 "node $(node -v)" || add "node_version" critical 0 "node too old/absent (need >=18)"; else add "node_version" critical 0 "node not installed"; fi
# CRITICAL (elevated from high): the Pi has NO real-time clock — if it can't NTP-sync, its wrong clock makes every
# TLS handshake to the hub fail = a permanent brick that looks like a network fault.
if have timedatectl; then timedatectl show -p NTPSynchronized --value 2>/dev/null | grep -q yes && add "clock_ntp" critical 1 "NTP synced" || add "clock_ntp" critical 0 "clock NOT NTP-synced — TLS to the hub will fail (permanent brick). Open UDP/123 or verify the HTTPS-date fallback."; fi

# ---- 5) SERVICES: connector + tailscale enabled & active — CRITICAL ------------------------------------------
systemctl is-enabled autopost-connector.service >/dev/null 2>&1 && EN=1 || EN=0
systemctl is-active  autopost-connector.service >/dev/null 2>&1 && AC=1 || AC=0
[ "$EN" = 1 ] && [ "$AC" = 1 ] && add "connector_service" critical 1 "enabled + active" || add "connector_service" critical 0 "enabled=$EN active=$AC — service not running (won't auto-start 24/7)"
if have tailscale; then tailscale status >/dev/null 2>&1 && add "tailscale" critical 1 "up (remote reach OK)" || add "tailscale" critical 0 "tailscale NOT up — we could NOT reach this device after ship. Run 'tailscale up --ssh'"; else add "tailscale" critical 0 "tailscale not installed — NO remote reach (cannot recall!)"; fi

# ---- 6) CONNECTOR CONFIG present & valid ---------------------------------------------------------------------
CFG="${CONNECTOR_CONFIG:-$DATA_DIR/config.json}"; [ -f "$CFG" ] || CFG="/opt/autopost/config.json"
if [ -f "$CFG" ] && node -e "const c=require('$CFG'); if(!c.dealershipToken||!c.controlUrl) process.exit(1)" >/dev/null 2>&1; then
  add "connector_config" critical 1 "config.json valid (claimed)"
  CONTROL_HOST=$(node -e "try{console.log(new URL(require('$CFG').controlUrl).host)}catch(e){}" 2>/dev/null)
else add "connector_config" critical 0 "config.json missing/invalid — device NOT claimed to a dealership yet"; fi

# ---- 6b) PERSISTENCE (the #1 non-recall brick risk) + SERVICE-USER TELEMETRY + FIRMWARE — CRITICAL ----------
# DATA PARTITION: $DATA_DIR MUST be a SEPARATE writable partition, NOT a dir on the (soon read-only overlay) rootfs.
# If it's on the rootfs, the first dealership power-cut after overlay-enable EVICTS config.json + the one-time claim
# token -> the device boots inactive and CANNOT re-claim -> a permanently bricked, non-recallable unit. Top ship gate.
if have findmnt; then
  DSRC=$(findmnt -no SOURCE -T "$DATA_DIR" 2>/dev/null); RSRC=$(findmnt -no SOURCE -T / 2>/dev/null); DFS=$(findmnt -no FSTYPE -T "$DATA_DIR" 2>/dev/null)
  if [ -n "$DSRC" ] && [ "$DSRC" != "$RSRC" ] && printf '%s' "$DFS" | grep -qE 'ext4|f2fs'; then
    if sudo -u autopost sh -c "echo ok > '$DATA_DIR/.persist_canary' && sync && rm -f '$DATA_DIR/.persist_canary'" 2>/dev/null; then
      add "data_partition_persistent" critical 1 "$DATA_DIR on $DSRC ($DFS) — separate + writable (survives overlay + power cut)"
    else add "data_partition_persistent" critical 0 "$DATA_DIR not writable as the service user"; fi
  else add "data_partition_persistent" critical 0 "$DATA_DIR is on the ROOTFS ($DSRC) — overlay would EVICT the claim token on the first power cut = permanent brick. Flash the golden image with a baked AUTOPOST-DATA partition."; fi
else
  # FAIL-CLOSED: without findmnt we cannot PROVE the data dir is a separate partition — and this is the gate that
  # stands between us and a permanently bricked, non-recallable unit. Never let a missing tool silently skip it.
  add "data_partition_persistent" critical 0 "findmnt unavailable — cannot verify $DATA_DIR is a separate partition (install util-linux). Refusing to certify: this is the anti-brick gate."
fi
# TELEMETRY AS THE SERVICE USER: the agent runs as autopost; without the video group vcgencmd fails and ALL field
# power/thermal telemetry is silently dead (install.sh runs 'usermod -aG video autopost').
if have vcgencmd; then
  sudo -u autopost vcgencmd get_throttled 2>/dev/null | grep -q '0x' \
    && add "telemetry_as_service_user" critical 1 "autopost can read vcgencmd — field telemetry live" \
    || add "telemetry_as_service_user" critical 0 "autopost CANNOT read vcgencmd — field power/thermal telemetry DEAD (usermod -aG video autopost)"
fi
# Agent code actually loads (module-load selftest against the INSTALLED copy) + ws resolves.
AGENT_JS="${APP_DIR:-/opt/autopost/connector}/src/agent.js"; [ -f "$AGENT_JS" ] || AGENT_JS=/opt/autopost/connector/src/agent.js
if [ -f "$AGENT_JS" ] && node "$AGENT_JS" --selftest 2>/dev/null | grep -q 'selftest-ok'; then add "agent_loads" critical 1 "agent.js loads (selftest-ok)"; else add "agent_loads" critical 0 "agent.js failed to load (bad build/dep)"; fi
# EEPROM/bootloader current (pin a known-good version in the master image).
if have rpi-eeprom-update; then rpi-eeprom-update 2>/dev/null | grep -qi 'up.to.date\|up to date' && add "eeprom_current" high 1 "EEPROM up to date" || add "eeprom_current" high 0 "EEPROM update available — pin a good version in the image"; fi
# Read-only rootfs state — informational here; the golden image bakes overlay ON with a separate data partition.
grep -qw boot=overlay /proc/cmdline 2>/dev/null && add "rootfs_overlay" info 1 "overlay active (power-cut safe)" || add "rootfs_overlay" high 0 "rootfs WRITABLE (no overlay) — a power cut can corrupt it; enable overlay LAST, and only after the data partition exists"

# ---- 7) NETWORK: link, DNS, outbound to the hub, Wi-Fi signal ------------------------------------------------
ip route get 1.1.1.1 >/dev/null 2>&1 && add "net_link" critical 1 "has a default route/IP" || add "net_link" critical 0 "NO network route — not online"
getent hosts google.com >/dev/null 2>&1 && add "net_dns" high 1 "DNS resolves" || add "net_dns" high 0 "DNS resolution FAILED"
if [ -n "${CONTROL_HOST:-}" ]; then
  HH="${CONTROL_HOST%%:*}"; PP="${CONTROL_HOST##*:}"; [ "$PP" = "$HH" ] && PP=443
  if timeout 8 bash -c "exec 3<>/dev/tcp/$HH/$PP" 2>/dev/null; then add "hub_reachable" critical 1 "reached hub $CONTROL_HOST"; exec 3>&- 2>/dev/null
  else add "hub_reachable" critical 0 "CANNOT reach the hub ($CONTROL_HOST) — dealership firewall blocks outbound WSS/443?"; fi
fi
WIFI_IF=$(iw dev 2>/dev/null | awk '/Interface/{print $2; exit}')
if [ -n "${WIFI_IF:-}" ] && iw dev "$WIFI_IF" link 2>/dev/null | grep -q signal; then
  SIG=$(iw dev "$WIFI_IF" link 2>/dev/null | awk '/signal/{print $2}')
  awk "BEGIN{exit !($SIG > -70)}" && add "wifi_signal" high 1 "${SIG} dBm (good)" || add "wifi_signal" high 0 "${SIG} dBm (weak <-70; move the Pi or use Ethernet)"
else add "wifi_signal" info 1 "on Ethernet (or Wi-Fi not the active link)"; fi

# ---- 8) THERMAL + SUSTAINED STRESS (surfaces a marginal PSU/cooler/SoC) — CRITICAL --------------------------
T0=$(( $(cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null || echo 0) / 1000 ))
add "temp_idle" info 1 "${T0}C idle"
if [ "$QUICK" = "0" ]; then
  echo "  running ${STRESS_SECS}s CPU+mem stress (thermal/power burn-in)…"
  if have stress-ng; then stress-ng --cpu "$(nproc)" --vm 1 --vm-bytes 256M --timeout "${STRESS_SECS}s" >/dev/null 2>&1 &
  else for i in $(seq 1 "$(nproc)"); do ( timeout "${STRESS_SECS}" bash -c 'while :; do :; done' ) & done; fi
  SPID=$!; TMAX=0
  END=$(( $(date +%s) + STRESS_SECS ))
  while [ "$(date +%s)" -lt "$END" ]; do TC=$(( $(cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null || echo 0) / 1000 )); [ "$TC" -gt "$TMAX" ] && TMAX=$TC; sleep 3; done
  wait 2>/dev/null
  add "temp_under_load" critical "$([ "$TMAX" -lt "$TEMP_MAX_C" ] && echo 1 || echo 0)" "peak ${TMAX}C under load (max ${TEMP_MAX_C}C)$([ "$TMAX" -ge "$TEMP_MAX_C" ] && echo ' — add/fix the fan+heatsink' )"
  if have vcgencmd; then TH2=$(( $(vcgencmd get_throttled 2>/dev/null | sed 's/.*=//') )); [ "$TH2" -eq 0 ] && add "no_throttle_under_load" critical 1 "no throttle/undervolt during stress" || add "no_throttle_under_load" critical 0 "throttled/undervolted UNDER LOAD (get_throttled=0x$(printf %x $TH2)) — PSU or cooling marginal, DEFECTIVE"; fi
else add "temp_under_load" critical 1 "skipped (--quick)"; fi

# ---- verdict + JSON ------------------------------------------------------------------------------------------
PASS=1; CRIT_FAIL=0; TOTAL=${#R_NAME[@]}; OKS=0
JSON="{\"ts\":$(date +%s000),\"model\":\"${MODEL:-}\",\"serial\":\"${SERIAL:-}\",\"quick\":$QUICK,\"checks\":["
for i in "${!R_NAME[@]}"; do
  [ "${R_OK[$i]}" = 1 ] && OKS=$((OKS+1))
  if [ "${R_OK[$i]}" != 1 ] && [ "${R_SEV[$i]}" = critical ]; then PASS=0; CRIT_FAIL=$((CRIT_FAIL+1)); fi
  [ "$i" -gt 0 ] && JSON+=","
  JSON+="{\"name\":\"${R_NAME[$i]}\",\"severity\":\"${R_SEV[$i]}\",\"ok\":$([ "${R_OK[$i]}" = 1 ] && echo true || echo false),\"detail\":\"$(echo "${R_DETAIL[$i]}" | sed 's/"/\\"/g')\"}"
done
JSON+="],\"pass\":$([ "$PASS" = 1 ] && echo true || echo false),\"criticalFails\":$CRIT_FAIL,\"ok\":$OKS,\"total\":$TOTAL}"
echo "$JSON" > "$OUT_JSON" 2>/dev/null || true
chmod 644 "$OUT_JSON" 2>/dev/null || true

echo "-----------------------------------------------------------------------"
for i in "${!R_NAME[@]}"; do
  MARK=$([ "${R_OK[$i]}" = 1 ] && echo "PASS" || echo "FAIL"); [ "${R_SEV[$i]}" = info ] && [ "${R_OK[$i]}" = 1 ] && MARK="info"
  printf "  [%-4s] %-24s %s\n" "$MARK" "${R_NAME[$i]}" "${R_DETAIL[$i]}"
done
echo "-----------------------------------------------------------------------"
if [ "$PASS" = 1 ]; then
  echo "  VERDICT: ✅ SHIP  ($OKS/$TOTAL checks ok, 0 critical failures). Result -> $OUT_JSON"
  echo "======================================================================="
  exit 0
else
  echo "  VERDICT: ⛔ DO NOT SHIP — DEFECTIVE  ($CRIT_FAIL critical failure(s)). Fix or replace the unit + re-run."
  echo "======================================================================="
  exit 1
fi
