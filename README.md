# Marketplace Engine

Working repository for the AutoPost / Marketplace Engine system: the Pi card flashing
bench, the on-device connector, and the operational guides that go with them.

This is the first batch of material; more is on the way.

## Layout

| Folder | What is in it |
|---|---|
| `docs/` | Operational and reference documentation (see below). |
| `bench/` | Bench tooling for programming Pi cards. |

### docs/

| File | Purpose |
|---|---|
| `autopost-overview.md` | Overview of the AutoPost bundle: what each piece is and where it runs. |
| `read-me-first.txt` | Short instructions shipped alongside the setup bundle, plus build notes. |
| `va-flash-a-pi-card.md` | Click-by-click guide for flashing a dealership setup card. |
| `wifi-rescue.md` | Field WiFi rescue: causes, fixes, and on-site procedure. |

### bench/

| File | Purpose |
|---|---|
| `START-HERE.bat` | Launcher: preflight checks, prerequisites, bench settings, starts the app. |
| `bench-settings.example.cmd` | Template for bench settings. Copy to `bench-settings.cmd` and fill in. |

### Required third-party tool

The flashing guide uses **Raspberry Pi Imager**. It is not stored in this repository
(`*.exe` is git-ignored); each bench machine downloads it from the official page:
<https://www.raspberrypi.com/software/>.

## Secrets

No real credentials live in this repository. `bench-settings.example.cmd` is a template:
the fleet Pi password, the Tailscale auth key and the fleet SSH public key are replaced
with placeholders.

To use it on a bench machine:

1. Copy `bench/bench-settings.example.cmd` to `bench/bench-settings.cmd`.
2. Fill in the real values locally.

`bench/bench-settings.cmd` is listed in `.gitignore` and must never be committed. The
real values still apply to every unit shipped, so keep that local file off shared drives.
Rotating means changing the values and re-flashing; cards already in the field keep the
old ones.
