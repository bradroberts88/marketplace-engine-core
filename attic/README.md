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

Card onboarding used to have two front doors: a Bluetooth channel and a Wi-Fi
setup page. Two doors meant two things to keep working, and the Bluetooth one
quietly did nothing on any card missing its packages or with the radio switched
off in `config.txt` - a card that looked healthy and never connected. The
QConnect captive portal (`qconnect/device/qconnect-portal.py`) is now the only
onboarding door. These are the retired Bluetooth files.

| File | Was | Replaced by |
| --- | --- | --- |
| `autopost-ble-setup.py` | Bluetooth onboarding channel | `qconnect-portal.py` — Wi-Fi captive portal on the setup hotspot |
| `autopost-ble-setup.service` | ran the above | as above |
| `ble-setup-page.html` | its web page | `qconnect-portal.py` serves its own page |
| `60-autopost-bluez.conf` | D-Bus policy the Bluetooth channel needed | not needed |

The Bluetooth channel in particular depended on `bluez`, `python3-dbus` and
`python3-gi` being present and on the radio not being disabled in
`config.txt`. On any card where one of those was not true it looked healthy and
did nothing, which is the failure mode this clean-up exists to end.
