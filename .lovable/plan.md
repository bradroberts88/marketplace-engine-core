# Make any QConnect box connect itself — Wi-Fi, Ethernet, or cellular

Goal: a box gets power, and it finds its own way online. Whichever cable, network, or SIM is
present, it should just work, and when it can't, it should say exactly why — on the box, on a
phone, and in the fleet view.

Target hardware: Raspberry Pi Zero 2 W (2.4 GHz Wi-Fi only, no Ethernet port) and Raspberry Pi 4
(dual-band Wi-Fi plus a real Ethernet port). Boxes are pre-configured at your bench, with the
phone setup page as rescue.

## 1. One connection manager instead of Wi-Fi-only logic

Replace the Wi-Fi-only wait loop with a single loop that tries every path it can see, in order, and
keeps retrying forever:

1. **Ethernet** — plug in a cable and it is online in seconds, no setup at all. Works through a USB
   Ethernet adapter too, so a Zero 2 W with an adapter behaves the same as a Pi 4.
2. **Wi-Fi** — the network baked in at the bench, then any other saved networks.
3. **Cellular** — any USB modem that is plugged in, handled generically so you can pick the exact
   hardware later. If no modem is present this step is skipped silently.
4. **Phone hotspot** — a bench-saved hotspot name/password as a last resort.

If all four fail, the box raises its own setup network and shows the phone page. The moment any
path succeeds, the box moves on. If the working path later drops, it falls back down the list on
its own without a reboot.

Being online means real internet, not a dealer guest portal — the existing captive-portal check is
kept and extended to every path.

## 2. Make the connection to your server actually happen

Five things currently make two identical-looking cards behave differently. All get fixed:

- **Cards that were never registered can never come online.** The card writer only prints a line
  of setup text the operator has to run by hand. It will do the registration itself and refuse to
  finish the card if it fails.
- **One reused access key per batch.** Only the first card joins; the rest loop forever. The writer
  will require a fresh key per card and check it before writing.
- **A boot-timing race silently skips startup.** On some boots the box's services are skipped
  entirely and never retried. Fixed on all three services.
- **The startup file path is wrong on current Pi OS,** so on some images nothing we install ever
  runs. Fixed to probe both locations.
- **Everything assumes a newer Pi OS.** On an older image every network command fails silently. The
  box will check on first boot and shout loudly (log, screen, fleet view) instead of pretending.

## 3. Radio and network edge cases

- Record the Pi model and radio capability, and warn at bench time when a Zero 2 W is paired with a
  5 GHz-only dealer network — the single most common "this one won't connect".
- Support hidden networks, correct Wi-Fi country/regulatory setup without depending on tools that
  may be missing, and Ethernet-only sites with the radio off.
- Cap the setup network name so it is always valid.

## 4. A setup page staff can't get wrong

- Shows the box's current state plainly: which paths it tried, what it found, what failed.
- Lists Ethernet and cellular as options, not just Wi-Fi.
- Handles the case where the radio can't scan while hosting the setup network (true on Zero 2 W) —
  says "type your network name" instead of showing an empty list.
- Verifies the password before closing the setup window, and says "wrong password, try again"
  instead of disappearing for 13 minutes.
- Only reachable on the setup network, never on the dealer's own network.

## 5. Nothing fails silently again

- The heartbeat currently throws away the server's reply, so a rejected box looks like a dead box.
  It will capture the response and surface the reason.
- A "stuck at step N" beacon so a box that has internet but is failing later steps reports itself.
- Real sensor readings distinguished from failed readings.
- First heartbeat sent as soon as the box is online, not on a fixed delay after boot.

## 6. Bench and fleet visibility

- Bench checklist gains connection-path coverage: Ethernet-only, Wi-Fi-only, cellular-only, and
  each fallback.
- The fleet view shows how each box is connected (cable / Wi-Fi / cellular), its signal or link
  state, and its last failure reason.

## Technical notes

- New `qconnect-netmanager.sh` state machine replaces the Wi-Fi wait/AP loop in
  `qconnect-setup.sh`; connection attempts go through NetworkManager profiles with explicit
  priorities (`connection.autoconnect-priority`) so failover is NM-native and survives reboots.
- Cellular is implemented as an NM `gsm` connection created on modem detection via ModemManager,
  with APN taken from `provision.json`; absent modem is a no-op. Hardware-agnostic, so any
  USB/hat modem exposing a ModemManager device works.
- `provision-sd.sh`: call `qconnect_preregister` over the REST RPC with a service key, hard-fail on
  non-200; fix the `/boot` vs `/boot/firmware` cmdline path; replace the SIGPIPE-prone token
  generator with a fixed-length hex token; normalise the trailing slash on the server URL;
  reject a reused Tailscale key.
- Add `RequiresMountsFor=` to `qconnect-setup.service`, `autopost-claim.service`,
  `autopost-tailscale.service`, and `autopost-connector.service`.
- `qconnect-firstrun.sh`: assert `nmcli` + active NetworkManager, set regdomain via modprobe conf +
  cmdline + `rfkill unblock` rather than `raspi-config` only, and fail loudly with a console
  message when `provision.json` is missing.
- Redact the Tailscale key only after `provisioned` is written, not before join completes.
- `qconnect-heartbeat.sh`: capture HTTP status and body, persist `last_error`, include
  `connection_path`, `pi_model`, `link_quality`, `stuck_step`; null out unreadable sensors.
- `qconnect-portal.py`: bind to the AP address only, add Ethernet/cellular sections, pre-scan
  before AP activation and cache results, add password-verification round trip with error display.
- Schema: extend `qconnect_heartbeat` / device row with `connection_path`, `pi_model`,
  `last_error`, `stuck_step`; update the fleet view and dashboard columns.
- Bench SQL gains a connectivity phase with per-path checks and go/no-go verdicts.

## Order of work

1. Registration made automatic and boot path fixed — unblocks the "some cards are simply dead" class.
2. Mount-race guards and the OS assertion.
3. Error reporting: heartbeat status, stuck beacon, fleet columns.
4. The unified connection manager with Ethernet and cellular.
5. Portal rework, radio edge cases, hidden networks.
6. Bench checklist and fleet view updates.

## Not included

- Choosing and certifying a specific cellular modem or carrier plan; the code will be
  hardware-agnostic until you pick one, and the SIM/APN goes in at bench time.
- Any physical bench run — the checklist will be ready, but a real card still has to be tested.
