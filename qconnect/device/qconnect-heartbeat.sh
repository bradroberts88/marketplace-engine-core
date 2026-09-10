#!/bin/bash
# QConnect heartbeat: posts liveness + basic health to Supabase every 5 minutes.
set -u
PROV=/opt/qconnect/etc/provision.json
[ -f /opt/qconnect/state/provisioned ] || exit 0

jget() { python3 -c "import json;print(json.load(open('$PROV')).get('$1',''))"; }
DEVICE_ID=$(jget device_id)
DEVICE_TOKEN=$(jget device_token)
SB_URL=$(jget supabase_url)
SB_KEY=$(jget supabase_anon_key)

TS_IP=$(tailscale ip -4 2>/dev/null | head -1)
UPTIME_S=$(cut -d. -f1 /proc/uptime)
TEMP_C=$(awk '{printf "%.1f", $1/1000}' /sys/class/thermal/thermal_zone0/temp 2>/dev/null)
DISK_FREE_MB=$(df -m / | awk 'NR==2 {print $4}')
MEM_FREE_MB=$(awk '/MemAvailable/ {printf "%d", $2/1024}' /proc/meminfo)

PAYLOAD=$(python3 - "$DEVICE_ID" "$DEVICE_TOKEN" "$TS_IP" "$UPTIME_S" "$TEMP_C" "$DISK_FREE_MB" "$MEM_FREE_MB" <<'PYEOF'
import json, sys
a = sys.argv
print(json.dumps({
  "p_device_id": a[1], "p_device_token": a[2],
  "p_status": {"tailscale_ip": a[3], "uptime_s": int(a[4] or 0),
               "temp_c": float(a[5] or 0), "disk_free_mb": int(a[6] or 0),
               "mem_free_mb": int(a[7] or 0)}
}))
PYEOF
)

curl -s -o /dev/null --max-time 15 \
  -X POST "$SB_URL/rest/v1/rpc/qconnect_heartbeat" \
  -H "apikey: $SB_KEY" -H "Authorization: Bearer $SB_KEY" \
  -H "Content-Type: application/json" -d "$PAYLOAD"
exit 0
