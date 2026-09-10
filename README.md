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
| `src/claim.js` | First-run self-provisioning client: redeems a one-time setup code and writes `config.json` durably. |
| `src/dashboard.js` | Local 127.0.0.1 status dashboard: tunnel health, public IP/geo/latency probe, rep list. |
| `src/tunnel.js` | Data-plane egress with the LAN-isolation guard (blocks private/loopback/link-local/CGNAT, IPv4 + IPv6, fail closed). |
| `src/wifi-recovery.js` | On-device WiFi rescue daemon (`autopost-wifi-recovery.service`): raises an "AutoPost-Setup" access point with a captive setup page when a unit is stranded on wrong WiFi credentials. |
| `src/_test/planned-refresh.test.js` | Guards the pre-cap link-refresh gate (the 2026-08-17 mid-session cuts). |
| `src/_test/config-resilience.test.js` | Guards the zero-length `config.json` deadlock fixes (the 2026-08-30 field failure). |
| `src/_test/wifi-recovery.test.js` | Unit tests for the WiFi-recovery helpers and its single-radio, never-strand state machine. |
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
| `keep-alive/README.md` | The always-on supervisor: what it restarts, the heartbeat health check, and the one permitted user-stop. |
| `keep-alive/Install-KeepAlive.ps1` | Installs the per-user "AutoPost Keep-Alive" scheduled task (no admin; at logon + every minute; runs on battery). |
| `keep-alive/Uninstall-KeepAlive.ps1` | Removes the scheduled task. |
| `keep-alive/keep-alive.ps1` | The watchdog itself: restarts AutoPost when missing, or when running but wedged (heartbeat older than 90s). |
| `keep-alive/run-hidden.vbs` | Invisible launcher so the watchdog never flashes a console window. |
| `flasher/index.html` | The VA-facing "Set up a Pi" screen: card picker, WiFi, claim code, dry run and flash progress. |
| `flasher/main-flasher.js` | Electron main-process side: drive scan, safety filter, dry run, batch confirmation, spawns the elevated writer. |
| `flasher/preload.js` | The only bridge between the flasher screen and the main process (scan, dry run, flash, verify, progress). |
| `flasher/safety.js` | The "never flash the wrong drive" predicates: pure, fail-closed eligibility gates for removable SD cards. |
| `flasher/writer.js` | The elevated worker: re-verifies the target, writes and verifies the image with Raspberry Pi Imager, injects the boot files. |
| `flasher/inject.js` | Pure renderer for the files dropped on the card's boot partition (`autopost-claim.env`, `firstrun.sh`, USB-gadget SSH). |
| `flasher/hub.js` | Claim-code source: validates a pasted code, or mints one against the admin API when `AUTOPOST_ADMIN_URL`/`AUTOPOST_ADMIN_TOKEN` are set. |
| `flasher/sha512crypt.js` | Pure-Node SHA-512 crypt (`$6$`) for the Pi console password, so no OpenSSL binary is needed on Windows. |
| `flasher/_test/safety.test.js` | The "never the wrong drive" predicates against synthetic drive rows. |
| `flasher/_test/inject.test.js` | Golden-file test of every rendered boot-partition file, including shell-injection safety. |
| `flasher/_test/nowifi.test.js` | Capture-WiFi-on-first-boot cards: no profiles written, claim code and password still present. |
| `flasher/_test/confirm-batch.test.js` | Drives the real one-dialog-per-batch confirmation (Electron and drivelist stubbed). |
| `flasher/_test/batch.test.js` | Batch consent tokens, per-device write lock, per-lane job id. Needs Electron installed. |
| `flasher/_test/pi-model.test.js` | Pi-model image resolution and the environment overrides. Needs Electron installed. |
| `flasher/_test/electron-load-test.js` | Live check under the real Electron runtime: native modules load, this machine's system disk is refused. |
| `flasher/_test/build-plan.js` | Builds a real plan file targeting an eligible card, for an end-to-end run of the writer. |
| `flasher/_test/do-inject.js` | Injects the boot files into an already-flashed, mounted boot partition. |
| `flasher/_test/path-mangle-test.js` | Checks whether Node mangles the `\\.\PhysicalDriveN` device path. |

The agent expects a real `config.json` at runtime; it is git-ignored and never committed.
Note: no `.sig` files are kept here — the one received was marked stale/do-not-use.

Run the tests from `connector/` with `node src/_test/<name>.test.js`; they need no dependencies.
Current state: `planned-refresh` 13/13 and `wifi-recovery` 87/87 pass. `config-resilience`
passes 5/8 — the three remaining checks read `connector/deploy/pi/autopost-connector.service`
and `autopost-claim.service`, which have not been added to the repository yet.

The flasher tests run the same way (`node flasher/_test/<name>.test.js`). Current state:
`safety` 16/16, `inject` 49/49, `nowifi` 10/10 and `confirm-batch` 10/10 pass with no
dependencies. `batch` and `pi-model` need Electron installed (they load `main-flasher.js`,
which requires `electron`), and `electron-load-test.js`, `build-plan.js`, `do-inject.js`
and `path-mangle-test.js` are bench helpers that need real hardware or a flashed card.



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
