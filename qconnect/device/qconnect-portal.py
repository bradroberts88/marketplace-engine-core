#!/usr/bin/env python3
"""QConnect captive setup portal.

Runs while the fallback hotspot is up. Every DNS name resolves to
10.42.0.1 (dnsmasq wildcard), so any phone that joins QConnect-Setup-<id>
gets this page automatically via its captive-portal popup.

Staff picks the dealer Wi-Fi network, types the password, taps Connect.
Credentials land in /opt/qconnect/state/new-wifi.json and qconnect-setup.sh
takes it from there. Stdlib only; no dependencies.
"""
import json
import os
import re
import subprocess
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

STATE_DIR = "/opt/qconnect/state"
CREDS_FILE = os.path.join(STATE_DIR, "new-wifi.json")


def device_id():
    try:
        with open("/opt/qconnect/etc/provision.json") as f:
            return json.load(f).get("device_id", "QConnect")
    except Exception:
        return "QConnect"


def scan_ssids():
    """List nearby 2.4GHz networks, strongest first, own hotspot excluded."""
    try:
        out = subprocess.run(
            ["nmcli", "-t", "-f", "SSID,SIGNAL", "device", "wifi", "list", "--rescan", "yes"],
            capture_output=True, text=True, timeout=25,
        ).stdout
    except Exception:
        return []
    seen, ssids = set(), []
    rows = []
    for line in out.strip().splitlines():
        parts = line.rsplit(":", 1)
        if len(parts) != 2 or not parts[0]:
            continue
        try:
            rows.append((parts[0], int(parts[1])))
        except ValueError:
            continue
    for ssid, _sig in sorted(rows, key=lambda r: -r[1]):
        if ssid.startswith("QConnect-Setup") or ssid in seen:
            continue
        seen.add(ssid)
        ssids.append(ssid)
    return ssids[:20]


PAGE = """<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>QConnect Setup</title>
<style>
  body {{ font-family: -apple-system, system-ui, sans-serif; background:#0f1420;
         color:#e8ecf4; margin:0; padding:24px; }}
  .card {{ max-width:420px; margin:40px auto; background:#1a2233; border-radius:14px;
          padding:28px; box-shadow:0 8px 30px rgba(0,0,0,.4); }}
  h1 {{ font-size:22px; margin:0 0 4px; }}
  .sub {{ color:#8fa0bd; font-size:14px; margin-bottom:22px; }}
  label {{ display:block; font-size:13px; color:#8fa0bd; margin:14px 0 6px; }}
  select, input {{ width:100%; box-sizing:border-box; padding:12px; font-size:16px;
          border-radius:8px; border:1px solid #2c3a55; background:#0f1420;
          color:#e8ecf4; }}
  button {{ width:100%; margin-top:22px; padding:14px; font-size:16px; font-weight:600;
          border:0; border-radius:8px; background:#3b82f6; color:#fff; }}
  .ok {{ text-align:center; }}
  .ok h1 {{ color:#4ade80; }}
</style></head>
<body><div class="card">{body}</div></body></html>
"""

FORM = """
<h1>QConnect Setup</h1>
<div class="sub">Device {dev} &middot; Connect this box to the dealership Wi-Fi</div>
<form method="POST" action="/setup">
  <label>Wi-Fi network</label>
  <select name="ssid">{options}</select>
  <label>Or type the network name</label>
  <input name="ssid_manual" placeholder="Network name (optional)">
  <label>Wi-Fi password</label>
  <input name="pass" type="password" placeholder="Password (leave blank if open)">
  <button type="submit">Connect</button>
</form>
"""

DONE = """
<div class="ok">
<h1>Connecting&hellip;</h1>
<div class="sub">The QConnect is joining <b>{ssid}</b>.<br><br>
This setup network will disappear in a few seconds. If it comes back
in about 15 minutes, the password did not work; join it and try again.</div>
</div>
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

    def do_GET(self):
        # OS captive-portal probes: answer with a redirect so the phone
        # pops the setup page instead of thinking it is online.
        probe = re.search(r"(generate_204|hotspot-detect|connecttest|ncsi|success\.txt)", self.path)
        if probe:
            self.send_response(302)
            self.send_header("Location", "http://10.42.0.1/")
            self.end_headers()
            return
        opts = "".join(f"<option>{s}</option>" for s in scan_ssids()) or "<option value=''>(scan found nothing)</option>"
        self._send(PAGE.format(body=FORM.format(dev=device_id(), options=opts)))

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        data = urllib.parse.parse_qs(self.rfile.read(length).decode())
        ssid = (data.get("ssid_manual", [""])[0] or data.get("ssid", [""])[0]).strip()
        password = data.get("pass", [""])[0]
        if not ssid:
            self._send(PAGE.format(body=FORM.format(dev=device_id(), options="")), 400)
            return
        os.makedirs(STATE_DIR, exist_ok=True)
        tmp = CREDS_FILE + ".tmp"
        with open(tmp, "w") as f:
            json.dump({"ssid": ssid, "pass": password}, f)
        os.replace(tmp, CREDS_FILE)  # atomic so setup.sh never reads a partial file
        self._send(PAGE.format(body=DONE.format(ssid=ssid)))

    def log_message(self, *args):
        pass  # keep journal quiet


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 80), Portal).serve_forever()
