# Marketplace Engine

Working repository for the AutoPost / Marketplace Engine system: the Pi card flashing
bench, the on-device connector, and the operational guides that go with them.

This is the first batch of material; more is on the way.

## Layout

| Folder | What is in it |
|---|---|
| `docs/` | Operational and reference documentation (see below). |
| `bench/` | Bench tooling for programming Pi cards. |
| `connector/` | The dealership desktop app (Electron tray app + tunnel agent). |

### docs/

| File | Purpose |
|---|---|
| `autopost-overview.md` | Overview of the AutoPost bundle: what each piece is and where it runs. |
| `read-me-first.txt` | Short instructions shipped alongside the setup bundle, plus build notes. |
| `va-flash-a-pi-card.md` | Click-by-click guide for flashing a dealership setup card. |
| `wifi-rescue.md` | Field WiFi rescue: causes, fixes, and on-site procedure. |
| `claim-onboarding.md` | Claim-code self-serve onboarding: identity store, claim endpoint, security model. |
| `desktop-app-roadmap.md` | Desktop app roadmap to 1,000 clients: shipped work and prioritized phases. |
| `flasher-packaging.md` | Packaging and deployment of the VA Pi Setup flasher (electron-builder outputs, prereqs). |
| `install-dealership.md` | Dealership-facing install guide for the AutoPost desktop app. |

### bench/

| File | Purpose |
|---|---|
| `START-HERE.bat` | Launcher: preflight checks, prerequisites, bench settings, starts the app. |
| `bench-settings.example.cmd` | Template for bench settings. Copy to `bench-settings.cmd` and fill in. |

### connector/

| File | Purpose |
|---|---|
| `README.md` | Connector overview: what it is, why, architecture, and baked-in safeguards. |
| `package.json` / `package-lock.json` | Node manifest and lockfile (`dealership-connector`, product name "AutoPost"). |
| `src/agent.js` | The connector agent: dials out to the control server over WSS, relays rep streams, heartbeat, remote config, auto-update with rollback. |
| `electron-main.js` | Desktop shell: tray app, child-process connector, native dashboard window; also the VA card-flasher mode. |
| `electron-builder-flasher.json` | electron-builder target for the separate VA Pi Setup card-writer app. |
| `firstrun-ui.js` | First-run setup screen: redeems a one-time setup code against the claim endpoint and writes `config.json`. |
| `preview-ui.js` | Dashboard preview with a mock tunnel (`node preview-ui.js`, sign in manager / preview). |
| `firstrun-test.js` | End-to-end loopback test of the first-run setup flow against the real claim server. |
| `never-drop-test.js` | Loopback test of the agent's liveness plumbing (hello, ping, heartbeat.json). |
| `test-local.js` | Local smoke test: full tunnel end to end with no VPS — proves egress IP and fail-closed behavior. |
| `Start_App.cmd` | Windows launcher: runs the Electron app, installing dependencies on first run. |
| `Start_Dashboard.cmd` | Windows launcher: starts the preview dashboard and opens it in the browser. |
| `config.example.json` | Template for the per-dealership `config.json` (placeholders only). |
| `dashboard-preview.html` | Static preview of the status dashboard styling. |

The agent expects a real `config.json` at runtime; it is git-ignored and never committed.
Note: no `.sig` files are kept here — the one received was marked stale/do-not-use.

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
