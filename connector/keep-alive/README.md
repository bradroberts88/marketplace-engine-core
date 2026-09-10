# AutoPost always-on supervisor

Keeps the AutoPost desktop app running like a service, **without** a Windows service or admin rights — part of
the "never drop" system (a competitor's app "closes and stops posting through the day"; ours must not).

The per-user scheduled task `AutoPost Keep-Alive` runs every ~1 minute in the user's session (plus **at logon**
for fast reboot recovery, and it **runs on battery**). It does two things:

1. **Restart if missing** — a crash, an accidental Quit, closing the window, or a reboot all bring AutoPost back.
2. **Restart if WEDGED** — a running process is *not* proof it works (RULE 0). The agent writes
   `%LOCALAPPDATA%\AutoPost\heartbeat.json` every ~15s; if the app is running but the heartbeat is **stale
   (>90s)** the watchdog kills the whole tree and restarts it clean. (A *missing* heartbeat is left alone — the
   app may be starting or in the no-config preview; `connected:false` with a *fresh* timestamp is also left alone
   — it is reconnecting.)

The one permitted user-stop is `%LOCALAPPDATA%\AutoPost\disabled.flag`: while it exists the supervisor never
starts the app. The app's tray **"Turn Off AutoPost"** writes it (and **"Turn On"** deletes it). **Quit / close /
crash never write it**, so they always auto-restart.

## Use

```powershell
powershell -ExecutionPolicy Bypass -File .\Install-KeepAlive.ps1     # install (dealership installer runs this)
powershell -ExecutionPolicy Bypass -File .\Uninstall-KeepAlive.ps1   # remove
```

No admin required (per-user task, `RL LIMITED`, interactive session, so the tray app shows normally). Runs hidden
via `wscript run-hidden.vbs` so no console window ever flashes.

## The other never-drop layers (in the app itself)

- **Half-open detection** (`src/agent.js`): active ws `ping`/`pong`; if the link is silent for ~60s (the classic
  post-sleep "socket looks OPEN but is dead") it `terminate()`s to force a reconnect — the single biggest fix.
  An independent wall-clock watchdog exits after a prolonged outage so this supervisor relaunches a fresh one.
- **Sleep** (`electron-main.js`): `powerSaveBlocker('prevent-app-suspension')` stops *idle* sleep (it cannot stop
  lid-close/manual sleep — no user-mode API can); `powerMonitor 'resume'` forces an immediate reconnect on wake.
- **Never re-sign-in**: 10-year dashboard session + silent auto-login, now with retry so a transient failure
  never dumps the user on a password screen.

## Not covered without admin

"Rebooted but nobody has logged in yet" needs a Windows **Service** or a SYSTEM task (admin, one-time). A service
also can't show a tray (Session 0), which is why the always-on agent and the tray GUI would be split. See
`DESKTOP-APP-ROADMAP.md`.
