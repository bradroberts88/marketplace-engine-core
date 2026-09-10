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
| `build/icon.png` | The packaged Windows app icon (256x256), referenced by both packaging configs. |
| `build/installer.nsh` | Windows installer hooks: registers the keep-alive scheduled task on install, removes it on uninstall. |
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
| `flasher/_test/sha512crypt.test.js` | Verifies the `$6$` hasher against the published specification vectors. |
| `flasher/_test/ssh-hardening.test.js` | SSH hardening and secret-leak guards, including the lock-out interlock. Reads `connector/deploy/pi/install.sh`. |
| `flasher/_test/ui-batch.test.js` | Drives the real setup-screen script against a stub DOM: lanes, progress, one code per card. |
| `flasher/_test/write-probe.js` | Elevated bench probe: proves the raw disk opens with the Buffer device path. Opens only, writes nothing. |
| `flasher/_test/write-proof.js` | Elevated bench proof: writes and verifies a small test image on a real card. |
| `install/install-connector.ps1` | Admin PowerShell installer: registers the `DealershipConnector` scheduled task (boot-start, hidden, restart-on-failure). |
| `install/run-agent.cmd` | Supervisor loop the task launches; relaunches the agent 5s after any exit. |
| `install/uninstall-connector.ps1` | Removes the scheduled task and stops any running agent. |
| `scripts/sign-build.js` | Signs an agent build with the operator's Ed25519 private key and writes a detached `.sig` the agent verifies before updating. |
| `server/src/index.js` | Tunnel entry point: loads config, builds the store, starts the control WS, proxy, claim and admin servers. |
| `server/src/hub.js` | Shared state between the control channel and the proxy: agent registry, liveness, open streams, fail-closed enforcement, event log. |
| `server/src/control-server.js` | WS endpoint each dealership agent dials out to: token auth plus a 15s ping/pong so a silently-dead agent is dropped in ~30s. |
| `server/src/proxy-server.js` | Fail-closed HTTP CONNECT proxy for rep/GoLogin clients, with a 15s reconnect grace and destination/port allow-lists. |
| `server/src/dealership-store.js` | Hot JSON store for dealership identity: agent tokens, proxy credentials and one-time Crockford claim codes; atomic writes. |
| `server/src/claim-server.js` | The single public first-run endpoint (`POST /claim`, `GET /health`) with per-IP and global rate limits. |
| `server/src/admin-api.js` | Localhost-only, token-authenticated admin HTTP: status, events, pause/resume, restart, create/reissue/rotate/revoke dealerships. |
| `server/src/_test/health-alerts.test.js` | Hub alert de-duping across link refreshes plus the planned-vs-real disconnect distinction. |
| `server/README.md` | The VPS-side tunnel server: what it does, the fail-closed guarantee, config table and test-vs-production topology. |
| `server/package.json` / `server/package-lock.json` | Node manifest and lockfile for `dealership-tunnel-server` (only dependency: `ws`). |
| `server/config.example.json` | Template for the server `config.json`: control/proxy/admin/claim ports, allow-lists, claim-code onboarding (placeholders only). |
| `server/test-claim-flow.js` | End-to-end claim-code test on loopback: create, claim, connect, every rejection path, token rotate/revoke force-disconnect. |
| `server/.gitignore` | Keeps the server's `node_modules/`, `config.json` and logs out of the repository. |
| `deploy/pi/README.md` | The Raspberry Pi tunnel device: hardware to buy, imaging, provisioning and remote access. |
| `deploy/pi/install.sh` | One-shot Pi installer: Node 18+ (armhf via unofficial builds), the connector, the systemd service, Tailscale, CRLF guard. |
| `deploy/pi/set-wifi.sh` | Add, list, remove or prefer WiFi networks; several saved at once so the box fails over to a hotspot. |
| `deploy/pi/selftest.sh` | Pre-ship burn-in and defect gate run on the Pi: power, RAM, card, thermals, network, connector. Exit 0 = ship. |
| `deploy/pi/pi-verify.sh` | Bench acceptance test over the USB link; one machine-readable line per check plus a PASS/FAIL verdict. |
| `deploy/pi/GOLDEN-IMAGE-SPEC.md` | The separate `AUTOPOST-DATA` partition spec that stops overlay eviction from bricking a shipped device. |
| `deploy/pi/PI-SETUP-GUIDE.md` | Flash-to-Live setup walkthrough, repeatable per dealership. |
| `deploy/pi/PI-SHIP-TEST-PLAN.md` | The 10-stage ship-certification plan; a device is only certified after Stage 10. |
| `deploy/pi/PI-SHIP-RISK-REGISTER.md` | The deep-analysis findings, burn-in gate table and field telemetry list. |
| `deploy/pi/PROVISIONING-GUIDE.md` | The 10-minute VA guide for turning a blank Pi and a dealership into a ready-to-ship box. |
| `deploy/pi/USB-SSH.cmd` | Double-click entry point: elevates, brings up the USB link and drops into a shell on the Pi. |
| `deploy/pi/usb-ssh-connect.ps1` | The PC half of USB SSH: finds the gadget adapter by pinned MAC, sets `10.55.0.2/24` with no gateway, then hands over to ssh. |
| `deploy/pi/VERIFY-PI.cmd` | Bench acceptance launcher run on every unit before boxing; supports `--ap`, `--ssid` and CSV logging. |
| `deploy/pi/verify-pi.ps1` | Runs `pi-verify.sh` on the Pi over the USB link and prints one PASS/FAIL verdict; needs an SSH key. |
| `deploy/pi/USB-SSH-TESTING.md` | Why USB SSH exists (a reflash costs 45 minutes), the pinned addressing and what lands on the card. |
| `deploy/pi/WIFI-RESCUE.md` | The five field defects behind "the setup network never appears", the fixes, and the three ways into a unit that will not join. |
| `deploy/pi/autopost-ble-setup.py` | The Bluetooth rescue door: a GATT service a technician writes WiFi credentials to; never touches `nmcli` itself. |
| `deploy/pi/autopost-ble-setup.service` | Unit for the BLE rescue: unprivileged, no network or claim gating, so it runs on a box that never got online. |
| `deploy/pi/50-autopost-nm.rules` | Polkit rule granting the `autopost` user NetworkManager actions only, so "Set WiFi" works without root. |
| `deploy/pi/60-autopost-bluez.conf` | D-Bus policy naming the `autopost` user for BlueZ access, independent of the distro's `bluetooth` group stanza. |
| `deploy/pi/autopost-connector.service` | The 24/7 connector unit: restarts on any exit, waits for `config.json`, keeps all writes on the data partition. |
| `deploy/pi/autopost-claim.service` | First-boot self-provisioning from a claim code on the boot partition; starts the connector the moment it succeeds. |
| `deploy/pi/autopost-wifi-recovery.service` | The captive-portal rescue unit; deliberately ungated by network or claim so it runs on an offline box. |
| `deploy/pi/autopost-tailscale.service` | Unattended first-boot Tailscale join for remote recall, skipped when no key file is present. |
| `deploy/pi/autopost-captive-dnsmasq.conf` | Points every DNS lookup at the rescue portal so the "Sign in to network" sheet pops by itself. |
| `deploy/pi/autopost-usb-gadget.sh` | Brings up the USB ethernet gadget with pinned MACs; generated from the flasher, editable on the card. |
| `deploy/pi/ble-setup-page.html` | Self-contained Web Bluetooth setup page; works everywhere except iPhone and iPad, where nRF Connect is the fallback. |
| `deploy/pi/DAY-1-CHECKLIST.md` | The ~30-minute box-to-Live walkthrough for the pilot device. |
| `deploy/pi/golden/README.md` | The golden-image build kit: why the separate data partition exists, how to build and what must be certified first. |
| `deploy/pi/golden/build-golden.sh` | Orchestrates the build: package the connector, fetch pi-gen, build the rootfs, append the data partition. |
| `deploy/pi/golden/append-data-partition.sh` | Adds and seeds the third `AUTOPOST-DATA` partition so identity and updates survive the read-only overlay. |
| `deploy/pi/golden/customize-stock-image.sh` | Faster path: bakes the connector into the stock Pi OS Lite image in a chroot, with an ARMv6 variant for the Pi Zero W. |
| `deploy/pi/golden/pi-gen.config` | pi-gen settings for the image: arm64 Bookworm Lite, headless, FAT boot partition kept for flasher injection. |
| `deploy/pi/golden/stage-autopost/prerun.sh` | pi-gen stage guard: copies the previous stage's rootfs before the AutoPost layer is applied. |
| `deploy/pi/golden/stage-autopost/00-install-connector/` | The pi-gen install stage: packages, host-side staging and the chroot script — deliberately refuses to run (see below). |
| `deploy/pi/golden/stage-autopost/01-data-and-overlay/` | Second pi-gen stage: fstab entry for `AUTOPOST-DATA`, WiFi country, EEPROM pin, NetworkManager profiles moved onto the data partition, and the read-only rootfs overlay baked last. |
| `deploy/pi/USB-LINK.cmd` | Brings the PC side of the USB link up (10.55.0.2/24) and exits, for when a script — not a person — will SSH in. |
| `tools/RUN-TESTS.cmd` | Runs every test in the tree with plain Node; the two Electron-dependent flasher tests report as SKIPPED rather than silently passing. |
| `tools/PROMOTE-GOLDEN.cmd` | Promotes a rebuilt image from `images-rebuilt\` into `images\`: integrity check first, archives the outgoing image, keeps 32- and 64-bit apart. |

`server/test-claim-flow.js` runs from `connector/server/` after `npm install` (needs `ws`);
it currently passes 21/21 on loopback. `node src/_test/health-alerts.test.js` passes 13/13
with no dependencies.

The two scripts in `connector/tools/` are written for the operator's consolidated bench
layout — a folder holding `source\`, `images\`, `images-rebuilt\` and `app\` — and are run
from there, not from this repo's folder structure. `PROMOTE-GOLDEN.cmd` now derives its WSL
path from wherever it is run instead of a hardcoded personal desktop path.


The agent expects a real `config.json` at runtime; it is git-ignored and never committed.
Note: no `.sig` files are kept here — the one received was marked stale/do-not-use.

The golden-image kit is a recipe, not a built artifact: nothing in it has been run through
pi-gen or certified on hardware yet. `customize-stock-image.sh` is the real shipping path.
The pi-gen route is stale on purpose — its chroot script exits with an error unless
`ALLOW_STALE_PIGEN_STAGE=1` is set, because it would build an image with no WiFi or Bluetooth
rescue. The second stage folder `stage-autopost/01-data-and-overlay/` is now present; it must
run after every other image change, since the overlay has to be baked last.


Run the tests from `connector/` with `node src/_test/<name>.test.js`; they need no dependencies.
Current state: `planned-refresh` 13/13, `wifi-recovery` 87/87 and `config-resilience` 8/8 pass
(the last three checks now read the `autopost-connector.service` and `autopost-claim.service`
systemd units in `connector/deploy/pi/`).

The flasher tests run the same way (`node flasher/_test/<name>.test.js`). Current state:
`safety` 16/16, `inject` 49/49, `nowifi` 10/10, `confirm-batch` 10/10, `sha512crypt` 14/14,
`ui-batch` 35/35 and `ssh-hardening` 12/12 pass with no dependencies. `batch` and `pi-model`
need Electron installed (they load `main-flasher.js`, which requires `electron`).
`electron-load-test.js`,
`build-plan.js`, `do-inject.js`, `path-mangle-test.js`, `write-probe.js` and
`write-proof.js` are bench helpers that need real hardware or a flashed card.



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
