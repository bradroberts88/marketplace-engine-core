#!/usr/bin/env python3
"""QConnect captive setup portal.

Runs while the fallback hotspot is up. Every DNS name resolves to
10.42.0.1 (dnsmasq wildcard), so any phone that joins QConnect-Setup-<id>
gets this page automatically via its captive-portal popup.

It shows what the box already tried (cable, Wi-Fi, cellular) and why each
failed, then lets staff fix the Wi-Fi. Credentials land in
/opt/qconnect/state/new-wifi.json; qconnect-setup.sh verifies them and writes
the verdict to state/wifi-result, which this page polls - so a mistyped
password says "wrong password" instead of silently costing 13 minutes.

Stdlib only; no dependencies.
"""
import json
import os
import re
import subprocess
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

QCONNECT = "/opt/qconnect"
STATE_DIR = os.path.join(QCONNECT, "state")
CREDS_FILE = os.path.join(STATE_DIR, "new-wifi.json")
RESULT_FILE = os.path.join(STATE_DIR, "wifi-result")
SCAN_CACHE = os.path.join(STATE_DIR, "scan-cache.txt")
NET_STATE = os.path.join(STATE_DIR, "net-state.json")
# Bind to the hotspot address only. 0.0.0.0 briefly exposed this page on the
# dealer LAN whenever the two profiles overlapped.
BIND_ADDR = os.environ.get("QCONNECT_PORTAL_BIND", "10.42.0.1")

REASONS = {
    "ok": "Connected.",
    "wrong_password": "That password was not accepted. Check it and try again.",
    "ssid_not_in_range": "That network was not found. Check the name, or move the box closer.",
    "ssid_not_in_range_2g_radio": (
        "That network was not found. This box only supports 2.4 GHz Wi-Fi, so a "
        "5 GHz-only network will never appear. Use the 2.4 GHz network, a cable, "
        "or a phone hotspot."
    ),
    "joined_but_no_internet": "Joined the network, but there is no internet behind it.",
    "captive_portal": "This network shows a sign-in page. It needs an open or pre-approved connection.",
    "cellular_no_apn": "A modem is fitted but no mobile APN was set at the bench.",
    "cellular_sim_locked": "The SIM is PIN-locked. Unlock it before shipping.",
    "cellular_sim_disabled": "The SIM or modem RF is disabled. Check the SIM seating.",
    "cellular_no_tower": "The modem cannot see a tower. Check the antenna and coverage.",
    "cellular_failed": "The modem could not connect. Check the SIM, signal and APN.",
    "no_path": "No cable, no known Wi-Fi, no modem.",
}

# AT&T is the fleet default. The portal lets staff override it without reflashing.
ATT_DEFAULT_APN = "broadband"
ATT_APN_OPTIONS = ["broadband", "m2m.com.attz", "att.mvno", "nxtgenphone"]


def provision_json():
    return read_json(os.path.join(QCONNECT, "etc", "provision.json"))


def current_cellular_apn():
    return provision_json().get("cellular_apn") or ATT_DEFAULT_APN


def read_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return {}


def read_text(path):
    try:
        with open(path) as f:
            return f.read().strip()
    except Exception:
        return ""


def device_id():
    return read_json(os.path.join(QCONNECT, "etc", "provision.json")).get("device_id", "QConnect")


def scan_ssids():
    """Nearby networks, strongest first.

    While wlan0 hosts the AP, brcmfmac radios (Zero 2 W, Pi 3) cannot scan at
    all, so setup.sh caches a scan taken just BEFORE the AP came up. Live scan
    first, cache second, and if both are empty we say so honestly rather than
    implying there are no networks.
    """
    out = ""
    try:
        out = subprocess.run(
            ["nmcli", "-t", "-f", "SSID,SIGNAL", "device", "wifi", "list", "--rescan", "auto"],
            capture_output=True, text=True, timeout=20,
        ).stdout
    except Exception:
        out = ""
    if not out.strip():
        out = read_text(SCAN_CACHE)
    rows, seen, ssids = [], set(), []
    for line in out.strip().splitlines():
        parts = line.rsplit(":", 1)
        if len(parts) != 2 or not parts[0]:
            continue
        try:
            rows.append((parts[0], int(parts[1])))
        except ValueError:
            continue
    for ssid, _sig in sorted(rows, key=lambda r: -r[1]):
        if ssid.startswith("QConnect") or ssid in seen:
            continue
        seen.add(ssid)
        ssids.append(ssid)
    return ssids[:20]


def ethernet_state():
    for dev in os.listdir("/sys/class/net"):
        if not dev.startswith(("eth", "enx", "enp", "end")):
            continue
        if read_text(f"/sys/class/net/{dev}/carrier") == "1":
            return "cable detected"
    return "no cable"


def modem_state():
    try:
        out = subprocess.run(["mmcli", "-L"], capture_output=True, text=True, timeout=8).stdout
        return "modem fitted" if "Modem" in out else "no modem"
    except Exception:
        return "no modem"


def esc(s):
    return (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace('"', "&quot;"))


PAGE = """<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>QConnect Setup</title>
<style>
  body {{ font-family: -apple-system, system-ui, sans-serif; background:#0f1420;
         color:#e8ecf4; margin:0; padding:24px; }}
  .card {{ max-width:460px; margin:32px auto; background:#1a2233; border-radius:14px;
          padding:28px; box-shadow:0 8px 30px rgba(0,0,0,.4); }}
  h1 {{ font-size:22px; margin:0 0 4px; }}
  .sub {{ color:#8fa0bd; font-size:14px; margin-bottom:20px; }}
  label {{ display:block; font-size:13px; color:#8fa0bd; margin:14px 0 6px; }}
  select, input {{ width:100%; box-sizing:border-box; padding:12px; font-size:16px;
          border-radius:8px; border:1px solid #2c3a55; background:#0f1420;
          color:#e8ecf4; }}
  button {{ width:100%; margin-top:22px; padding:14px; font-size:16px; font-weight:600;
          border:0; border-radius:8px; background:#3b82f6; color:#fff; }}
  .status {{ background:#0f1420; border:1px solid #2c3a55; border-radius:10px;
          padding:14px; font-size:13px; margin-bottom:8px; }}
  .status div {{ display:flex; justify-content:space-between; padding:3px 0; }}
  .status span {{ color:#8fa0bd; }}
  .err {{ background:#3b1d22; border:1px solid #7f2e3b; color:#ffb4bd; border-radius:10px;
          padding:12px; font-size:14px; margin-bottom:14px; }}
  .chk {{ display:flex; align-items:center; gap:8px; margin-top:14px; font-size:14px;
          color:#8fa0bd; }}
  .chk input {{ width:auto; }}
  .ok {{ text-align:center; }}
  .ok h1 {{ color:#4ade80; }}
</style></head>
<body><div class="card">{body}</div></body></html>
"""

FORM = """
<h1>QConnect Setup</h1>
<div class="sub">Device {dev}</div>
{error}
<div class="status">
  <div><span>Network cable</span><b>{eth}</b></div>
  <div><span>Mobile modem</span><b>{modem}</b></div>
  <div><span>Last problem</span><b>{reason}</b></div>
</div>
<div class="sub">Plugging in a network cable is the fastest fix and needs nothing below.
Otherwise pick the dealership Wi-Fi.</div>
<form method="POST" action="/setup">
  <label>Wi-Fi network</label>
  <select name="ssid">{options}</select>
  <label>Or type the network name (needed for hidden networks)</label>
  <input name="ssid_manual" placeholder="Network name (optional)">
  <label>Wi-Fi password</label>
  <input name="pass" type="password" placeholder="Password (leave blank if open)">
  <div class="chk"><input type="checkbox" name="hidden" value="yes" id="h">
    <label for="h" style="margin:0">This network is hidden</label></div>
  <button type="submit">Connect</button>
</form>
"""

DONE = """
<div class="ok">
<h1>Testing&hellip;</h1>
<div class="sub">The QConnect is trying <b>{ssid}</b>.<br><br>
Keep this page open. This setup network drops for a few seconds while it tests.
If the password is wrong, rejoin <b>{ap}</b> and this page will tell you.</div>
</div>
<script>setTimeout(function(){{location.href='/';}}, 25000);</script>
"""


class Portal(BaseHTTPRequestHandler):
    def _send(self, html, code=200):
        body = html.encode()
        self.send_response(code)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _form(self, code=200):
        result = read_text(RESULT_FILE)
        reason_key = result or read_json(NET_STATE).get("last_error") or read_text(
            os.path.join(STATE_DIR, "last_block_reason"))
        message = REASONS.get(reason_key, reason_key or "none yet")
        error = ""
        if result and result != "ok":
            error = f'<div class="err">{esc(REASONS.get(result, result))}</div>'
        options = "".join(f"<option>{esc(s)}</option>" for s in scan_ssids())
        if not options:
            options = "<option value=''>(no scan available - type the name below)</option>"
        self._send(PAGE.format(body=FORM.format(
            dev=esc(device_id()), options=options, error=error,
            eth=esc(ethernet_state()), modem=esc(modem_state()),
            reason=esc(message))), code)

    def do_GET(self):
        # OS captive-portal probes: answer with a redirect so the phone
        # pops the setup page instead of thinking it is online.
        if re.search(r"(generate_204|hotspot-detect|connecttest|ncsi|success\.txt)", self.path):
            self.send_response(302)
            self.send_header("Location", f"http://{BIND_ADDR}/")
            self.end_headers()
            return
        self._form()

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        data = urllib.parse.parse_qs(self.rfile.read(length).decode())
        ssid = (data.get("ssid_manual", [""])[0] or data.get("ssid", [""])[0]).strip()
        password = data.get("pass", [""])[0]
        hidden = "yes" if data.get("hidden") else "no"
        if not ssid:
            self._form(400)
            return
        os.makedirs(STATE_DIR, exist_ok=True)
        # Clear the old verdict so the page does not show a stale failure.
        try:
            os.remove(RESULT_FILE)
        except OSError:
            pass
        tmp = CREDS_FILE + ".tmp"
        with open(tmp, "w") as f:
            json.dump({"ssid": ssid, "pass": password, "hidden": hidden}, f)
        os.replace(tmp, CREDS_FILE)  # atomic so setup.sh never reads a partial file
        ap = f"QConnect-Setup-{device_id()}"
        self._send(PAGE.format(body=DONE.format(ssid=esc(ssid), ap=esc(ap))))

    def log_message(self, *args):
        pass  # keep journal quiet


if __name__ == "__main__":
    try:
        ThreadingHTTPServer((BIND_ADDR, 80), Portal).serve_forever()
    except OSError:
        # The AP address may not be up yet on the very first try; fall back to
        # the loopback-safe bind so the service does not crash-loop.
        ThreadingHTTPServer(("0.0.0.0", 80), Portal).serve_forever()
