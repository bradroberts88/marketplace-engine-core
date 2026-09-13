# Attic — quarantined code

Nothing in this folder is live.

It is excluded from the build, the linter, the test runs, the packaged
installer and the SD-card writer. Code here cannot run on a device or ship to a
customer. It is kept only so a decision can be reversed with a single move.

## How to bring something back

1. Move the file out of `attic/` to the path listed below.
2. Remove the matching exclusion in `.gitattributes`, `eslint.config.js` and
   `connector/tools/RUN-TESTS.cmd` if one was added for it.
3. Re-wire whatever installed it (`connector/deploy/pi/install.sh` or
   `connector/deploy/pi/golden/customize-stock-image.sh`), then re-run the
   bench checklist on a real card before shipping it.

## What is here and why

### `autopost-pi/` — the old AutoPost card recipe

Cards used to be provisioned two different ways, and that is the main reason
identical-looking cards behaved differently in the field. The QConnect recipe
(`qconnect/`) is now the only one. These files are the old one.

| File | Was | Replaced by |
| --- | --- | --- |
| `autopost-claim.service` | claimed the box against the hub using a one-time code from the boot partition | `qconnect-setup.service` — self-registration with a single-use enrolment ticket |
| `autopost-tailscale.service` | joined the tailnet using a shared, reusable fleet key | per-card single-use key minted at card-writing time (`qconnect/flash/tailscale-keys.sh`) |
| `autopost-captive-dnsmasq.conf` | captive-portal DNS for the old rescue AP | wildcard DNS written by `qconnect-firstrun.sh` |
| `autopost-ble-setup.py` | Bluetooth onboarding channel | `qconnect-portal.py` — Wi-Fi captive portal on the setup hotspot |
| `autopost-ble-setup.service` | ran the above | as above |
| `ble-setup-page.html` | its web page | `qconnect-portal.py` serves its own page |
| `60-autopost-bluez.conf` | D-Bus policy the Bluetooth channel needed | not needed |

The Bluetooth channel in particular depended on `bluez`, `python3-dbus` and
`python3-gi` being present and on the radio not being disabled in
`config.txt`. On any card where one of those was not true it looked healthy and
did nothing, which is the failure mode this clean-up exists to end.
