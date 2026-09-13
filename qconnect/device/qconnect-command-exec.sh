#!/bin/bash
# QConnect command executor: drains the server's to-do list for this box.
#
# Run right after every heartbeat. Each instruction is acknowledged with its
# outcome, so the dashboard shows "done" or "failed" rather than "sent and who
# knows". Only the fixed set of instructions below is ever obeyed; anything
# else is reported back as unsupported instead of executed.
set -u
QCONNECT=${QCONNECT:-/opt/qconnect}
STATE=$QCONNECT/state
PROV=$QCONNECT/etc/provision.json
LOG=/var/log/qconnect-commands.log
[ -f "$PROV" ] || exit 0

jget() { python3 -c "import json;print(json.load(open('$PROV')).get('$1',''))" 2>/dev/null; }
DEVICE_ID=$(jget device_id); DEVICE_TOKEN=$(jget device_token)
SB_URL=$(jget supabase_url); SB_URL=${SB_URL%/}
SB_KEY=$(jget supabase_anon_key)
[ -n "$DEVICE_ID" ] && [ -n "$DEVICE_TOKEN" ] && [ -n "$SB_URL" ] || exit 0

log() { echo "[$(date '+%F %T')] $*" >> "$LOG"; }

rpc() { # rpc <name> <json>
  curl -s --max-time 20 -X POST "$SB_URL/rest/v1/rpc/$1" \
    -H "apikey: $SB_KEY" -H "Authorization: Bearer $SB_KEY" \
    -H "Content-Type: application/json" -d "$2"
}

ack() { # ack <id> <ok|fail> <message>
  local body
  body=$(QA_DEV="$DEVICE_ID" QA_TOK="$DEVICE_TOKEN" QA_ID="$1" QA_OK="$2" QA_MSG="${3:-}" python3 -c '
import json, os
print(json.dumps({
    "p_device_id": os.environ["QA_DEV"], "p_device_token": os.environ["QA_TOK"],
    "p_command_id": os.environ["QA_ID"], "p_ok": os.environ["QA_OK"] == "ok",
    "p_result": {"message": os.environ.get("QA_MSG", "")[:400]},
    "p_error": None if os.environ["QA_OK"] == "ok" else os.environ.get("QA_MSG", "")[:400],
}))')
  rpc qconnect_ack_command "$body" > /dev/null
}

set_json_key() { # set_json_key <key> <value> — edits provision.json in place
  QK="$1" QV="$2" QP="$PROV" python3 - <<'PYEOF'
import json, os
path = os.environ["QP"]
with open(path) as f:
    data = json.load(f)
data[os.environ["QK"]] = os.environ["QV"]
tmp = path + ".tmp"
with open(tmp, "w") as f:
    json.dump(data, f, indent=2)
os.replace(tmp, path)
PYEOF
}

run_command() { # run_command <kind> <payload-json>; prints a message, returns 0/1
  local kind="$1" payload="$2" v
  case "$kind" in
    restart_agent)
      systemctl restart qconnect-netwatch.service 2>&1
      systemctl restart qconnect-heartbeat.timer 2>&1
      echo "services restarted" ;;
    rerun_setup)
      rm -f "$STATE/provisioned"
      systemctl restart qconnect-setup.service 2>&1
      echo "setup re-run" ;;
    reboot)
      echo "rebooting in 10 seconds"
      (sleep 10; systemctl reboot) > /dev/null 2>&1 & ;;
    reconnect)
      "$QCONNECT/qconnect-netmanager.sh" once 2>&1 | tail -n 3 ;;
    force_path)
      v=$(echo "$payload" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("path",""))')
      case "$v" in
        ethernet|wifi|cellular|hotspot)
          echo "$v" > "$STATE/forced_path"
          "$QCONNECT/qconnect-netmanager.sh" once 2>&1 | tail -n 3 ;;
        *) echo "unknown path '$v'"; return 1 ;;
      esac ;;
    set_wifi)
      QP="$payload" python3 - <<'PYEOF' > "$STATE/new-wifi.json.tmp"
import json, os
p = json.loads(os.environ["QP"])
print(json.dumps({"ssid": p.get("ssid", ""), "psk": p.get("psk", ""),
                  "hidden": bool(p.get("hidden", False))}))
PYEOF
      mv "$STATE/new-wifi.json.tmp" "$STATE/new-wifi.json"
      "$QCONNECT/qconnect-netmanager.sh" once 2>&1 | tail -n 3 ;;
    set_apn)
      v=$(echo "$payload" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("apn",""))')
      [ -n "$v" ] || { echo "no apn given"; return 1; }
      set_json_key cellular_apn "$v"
      echo "APN set to $v" ;;
    collect_logs)
      tail -n 120 /var/log/qconnect-*.log 2>/dev/null | tail -c 3000 ;;
    update_agent)
      v=$(echo "$payload" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("version",""))')
      QCONNECT_FORCE_VERSION="$v" "$QCONNECT/qconnect-agent-update.sh" 2>&1 | tail -n 3 ;;
    *)
      echo "unsupported instruction '$kind'"; return 1 ;;
  esac
}

POLL=$(rpc qconnect_poll_commands \
  "{\"p_device_id\":\"$DEVICE_ID\",\"p_device_token\":\"$DEVICE_TOKEN\"}")
echo "$POLL" > "$STATE/last-poll.json"

# A disabled box does nothing at all — the kill switch outranks every queue.
ENABLED=$(echo "$POLL" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("enabled", False))
except Exception: print(False)')
[ "$ENABLED" = "True" ] || { log "poll: disabled or unreadable"; exit 0; }

# The release the server wants us on is handled by the updater, not here.
echo "$POLL" | python3 -c '
import json, sys
rel = (json.load(sys.stdin) or {}).get("release") or {}
print(json.dumps(rel))' > "$STATE/target-release.json"

COUNT=$(echo "$POLL" | python3 -c 'import json,sys;print(len((json.load(sys.stdin) or {}).get("commands") or []))')
[ "$COUNT" -gt 0 ] 2>/dev/null || exit 0

for i in $(seq 0 $((COUNT - 1))); do
  CMD=$(echo "$POLL" | QI="$i" python3 -c '
import json, os, sys
print(json.dumps(json.load(sys.stdin)["commands"][int(os.environ["QI"])]))')
  ID=$(echo "$CMD"   | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')
  KIND=$(echo "$CMD" | python3 -c 'import json,sys;print(json.load(sys.stdin)["kind"])')
  PAYLOAD=$(echo "$CMD" | python3 -c 'import json,sys;print(json.dumps(json.load(sys.stdin).get("payload") or {}))')

  log "running $KIND ($ID)"
  if OUT=$(run_command "$KIND" "$PAYLOAD"); then
    ack "$ID" ok "$OUT"; log "  done: ${OUT:0:120}"
  else
    ack "$ID" fail "$OUT"; log "  failed: ${OUT:0:120}"
  fi
done

tail -n 500 "$LOG" > "$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"
exit 0
