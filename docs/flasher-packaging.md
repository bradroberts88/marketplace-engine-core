# AutoPost Pi Setup (flasher) — packaging & deployment

The VA SD-card flasher is a **separate electron-builder product** from the dealership connector (its own appId
`com.quantumconnect.autopost.flasher`, so both can be installed on one machine without colliding). It launches
straight into flasher mode via `flasherBuild: true` (injected by `electron-builder-flasher.json`).

## Build

```bash
npm run dist:flasher        # -> dist-flasher/
```

Outputs:
- **`dist-flasher/win-unpacked/AutoPost Pi Setup.exe`** — the **portable app** (self-contained, ~186 MB). Proven
  working: launches the flasher UI, loads the **bundled** `drivelist` binary (win32-x64-128), so the VA machine
  needs **no compiler / no Node**. This folder is the shippable artifact — zip it and copy it to the VA laptop.
- **NSIS installer** (`AutoPost Pi Setup Setup.exe`) — the polished installer with Start-menu + desktop shortcut.

### If the NSIS installer step fails with "Cannot create symbolic link"
electron-builder extracts a code-signing helper (`winCodeSign`) that contains macOS symlinks; creating symlinks
on Windows needs privilege. Fix either way, then re-run `npm run dist:flasher`:
- **Enable Windows Developer Mode** (Settings → System → For developers → Developer Mode ON), **or**
- Run the build from an **Administrator** terminal.

The **portable `win-unpacked` app does NOT need this** — only the installer wrapper does. If you just need to
hand a VA the tool today, zip `dist-flasher/win-unpacked/` and go.

## Prerequisite on the VA machine: Raspberry Pi Imager

The flasher hands the actual disk write to **Raspberry Pi Imager** (reliable native write+verify). Install it
once on each VA laptop:

```
winget install RaspberryPiFoundation.RaspberryPiImager
```

The flasher auto-detects it at `C:\Program Files\Raspberry Pi Ltd\Imager\rpi-imager.exe` (or set `RPI_IMAGER`).
If it is missing, the flasher shows a clear error instead of failing silently. (A future enhancement is to have
the installer chain-install rpi-imager so the VA installs nothing manually.)

## What the VA does
See **[VA-FLASH-A-PI-CARD.md](VA-FLASH-A-PI-CARD.md)** — click-by-click steps + the popup table.
