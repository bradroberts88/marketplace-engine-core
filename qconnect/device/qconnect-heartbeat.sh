#!/bin/bash
# QConnect heartbeat: posts liveness + health + HOW the box is connected, every
# 5 minutes. Unlike v1 it reads the server's answer: a rejected box used to
# heartbeat forever into the void and show as "never seen".
set -u
QCONNECT=/opt/qconnect
STATE=$QCONNECT/state
PROV=$QCONNECT/etc/provision.json
LOG=/var/log/qconnect-heartbeat.log

# Send a heartbeat even before provisioning completes, so a box stuck on
# Tailscale or registration still reports itself as long as it has internet.
[ -f "$PROV" ] || exit 0

jget() { python3 -c "import json;print(json.load(open('$PROV')).get('$1',''))"; }
DEVICE_ID=$(jget device_id)
DEVICE_TOKEN=$(jget device_token)
SB_URL=$(jget supabase_url); SB_URL=${SB_URL%/}
SB_KEY=$(jget supabase_anon_key)

# Unreadable sensors report null, not 0 - a failing thermal probe must not look
# like a healthy 0 C.
read_or_null() { local v; v=$(eval "$1" 2>/dev/null); [ -n "$v" ] && echo "$v" || echo ""; }

TS_IP=$(read_or_null "tailscale ip -4 | head -1")
UPTIME_S=$(read_or_null "cut -d. -f1 /proc/uptime")
TEMP_C=$(read_or_null "awk '{printf \"%.1f\", \$1/1000}' /sys/class/thermal/thermal_zone0/temp")
DISK_FREE_MB=$(read_or_null "df -m / | awk 'NR==2 {print \$4}'")
MEM_FREE_MB=$(read_or_null "awk '/MemAvailable/ {printf \"%d\", \$2/1024}' /proc/meminfo")
AGENT_VERSION=$(cat "$QCONNECT/VERSION" 2>/dev/null)
STUCK_STEP=$(cat "$STATE/stuck_step" 2>/dev/null)
LAST_ERROR=$(cat "$STATE/last_error" 2>/dev/null)
[ -z "$LAST_ERROR" ] && LAST_ERROR=$(cat "$STATE/last_block_reason" 2>/dev/null)

PAYLOAD=$(QH_DEV="$DEVICE_ID" QH_TOK="$DEVICE_TOKEN" QH_IP="$TS_IP" QH_UP="$UPTIME_S" \
  QH_TEMP="$TEMP_C" QH_DISK="$DISK_FREE_MB" QH_MEM="$MEM_FREE_MB" QH_VER="$AGENT_VERSION" \
  QH_STUCK="$STUCK_STEP" QH_ERR="$LAST_ERROR" QH_NET="$STATE/net-state.json" \
  python3 <<'PYEOF'
import json, os

def num(name, cast):
    v = os.environ.get(name, "").strip()
    try:
        return cast(v)
    except (TypeError, ValueError):
        return None

def text(name):
    return os.environ.get(name, "").strip() or None

net = {}
try:
    with open(os.environ["QH_NET"]) as f:
        net = json.load(f)
except Exception:
    pass

status = {
    "tailscale_ip":    text("QH_IP"),
    "uptime_s":        num("QH_UP", int),
    "temp_c":          num("QH_TEMP", float),
    "disk_free_mb":    num("QH_DISK", int),
    "mem_free_mb":     num("QH_MEM", int),
    "agent_version":   text("QH_VER"),
    "stuck_step":      text("QH_STUCK"),
    "last_error":      text("QH_ERR") or net.get("last_error"),
    "connection_path": net.get("connection_path") or "unknown",
    "connection_detail": net.get("connection_detail"),
    "link_quality":    net.get("link_quality"),
    "pi_model":        net.get("pi_model"),
}
print(json.dumps({"p_device_id": os.environ["QH_DEV"],
                  "p_device_token": os.environ["QH_TOK"],
                  "p_status": status}))
PYEOF
)

CODE=$(curl -s -o /tmp/qconnect-hb.out -w '%{http_code}' --max-time 15 \
  -X POST "$SB_URL/rest/v1/rpc/qconnect_heartbeat" \
  -H "apikey: $SB_KEY" -H "Authorization: Bearer $SB_KEY" \
  -H "Content-Type: application/json" -d "$PAYLOAD")

STAMP=$(date '+%F %T')
if [ "$CODE" = "200" ] || [ "$CODE" = "204" ]; then
  echo "[$STAMP] ok ($CODE)" >> "$LOG"
  rm -f "$STATE/heartbeat_error"
else
  BODY=$(head -c 300 /tmp/qconnect-hb.out)
  echo "[$STAMP] heartbeat rejected: HTTP $CODE $BODY" >> "$LOG"
  echo "heartbeat: HTTP $CODE ${BODY:0:160}" > "$STATE/heartbeat_error"
fi
# Keep the log from growing without bound on a box that runs for years.
tail -n 500 "$LOG" > "$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"
exit 0
