# QConnect Zero-Touch Provisioning

Plug-in-power-only deployment for QConnect (Raspberry Pi Zero 2 W). The dealer's
only job is plugging in the power cable. Everything else is automatic:

1. **Baked Wi-Fi first.** If dealer Wi-Fi credentials were provided at flash
   time, the box connects on its own and verifies real internet (captive
   portals are detected, not mistaken for connectivity).
2. **AP fallback.** If it cannot get online within 3 minutes, it broadcasts a
   hotspot named `QConnect-Setup-<DEVICE-ID>`. Anyone with a phone joins it, the
   setup page pops up automatically, they pick the dealer network and type
   the password. No app, no laptop, no IT ticket.
3. **Tailscale join.** Once online it joins your tailnet with a baked
   pre-auth key. Outbound-only; no inbound ports, ever.
4. **Supabase self-registration.** The box registers itself (device id,
   dealer id, per-device secret token, tailscale IP) and starts a 5-minute
   heartbeat with temp, disk, memory, and uptime.
5. **Remote kill.** Set `enabled = false` in Supabase or revoke the node in
   Tailscale to disable a box.

## One-time setup (you)

1. Run `supabase/schema.sql` in the Supabase SQL editor.
2. In the Tailscale admin console, create a **reusable, pre-authorized auth
   key** (tag it, e.g. `tag:qconnect`). Consider ACLs that block qconnect-to-qconnect
   traffic.

## Per-device workflow (your team, ~5 minutes)

1. Flash **Raspberry Pi OS Lite (64-bit)** to the microSD with Raspberry Pi
   Imager. In Imager's OS customization, set only the username/password
   (no Wi-Fi needed there).
2. With the card still mounted, run:

   ```bash
   ./flash/provision-sd.sh \
     --boot /Volumes/bootfs \
     --device-id QCN-0042 \
     --dealer-id kendall-ford-meridian \
     --wifi-ssid "DealerGuest" --wifi-pass "guestpass123" \
     --tailscale-key tskey-auth-XXXX \
     --supabase-url https://YOURPROJECT.supabase.co \
     --supabase-anon-key eyJhbGci...
   ```

   Omit `--wifi-ssid/--wifi-pass` if you don't have the dealer's Wi-Fi yet;
   the box will go straight to AP fallback at the site.
3. REQUIRED: pre-register the device by running the
   `qconnect_preregister(...)` line the script prints (SQL editor or your admin tooling). Unregistered devices are rejected at registration.
4. Eject, insert into the QConnect, ship it.

## What happens on first boot

- A one-shot firstrun script installs the agent to `/opt/qconnect`, sets the
  hostname to the device id, wires the captive-portal DNS config, creates
  the Wi-Fi profile, **deletes the secrets from the boot partition**, and
  reboots.
- `qconnect-setup.service` then runs the state machine until provisioned.
  It survives reboots and power cuts at any stage; it simply resumes.

## Field behavior cheat sheet (for dealer-facing docs)

| Situation | What staff sees | What to do |
|---|---|---|
| Baked Wi-Fi works | Nothing. Box just comes online. | Nothing |
| Wrong/missing Wi-Fi | `QConnect-Setup-<id>` network appears after ~3 min | Join it with a phone, enter dealer Wi-Fi password on the popup page |
| Bad password entered | Setup network reappears ~15 min later | Join again, re-enter |
| Guest network has a captive portal | Setup network keeps reappearing | Escalate: this site needs the portal exception or the cellular option |

## Files

```
flash/provision-sd.sh            Operator tool: writes payload to a flashed SD card
boot-payload/qconnect-firstrun.sh    One-shot installer (runs on first boot, self-removes)
device/qconnect-setup.sh             Provisioning state machine
device/qconnect-portal.py            Captive setup portal (stdlib only)
device/qconnect-heartbeat.sh         5-minute health ping
device/systemd/*                 Service + timer units
supabase/schema.sql              Fleet table + token-checked RPCs + offline view
```

## Security notes

- The anon key can only call `qconnect_register` / `qconnect_heartbeat`; row level
  security blocks all direct table access. Each box authenticates with its
  own random 40-char token, so one leaked box cannot read or spoof the fleet.
- Secrets (`provision.json`) are moved to `/opt/qconnect/etc` (root, 0600) and
  removed from the FAT32 boot partition on first boot.
- Tailscale runs with `--ssh` for remote admin over the tailnet only. Remove
  that flag if you want no interactive access at all.
- Captive-portal guest networks remain the known hard case. The box detects
  them and reports `captive_portal` as the block reason, but a human still
  has to click through or the site needs a MAC exception. That is the cue to
  ship the cellular variant instead.
