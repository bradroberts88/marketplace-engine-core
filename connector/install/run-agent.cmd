@echo off
rem Supervisor loop: keeps the connector agent ALWAYS running. If it ever exits — crash, a self-heal restart,
rem or a remote restart from the super-admin — this relaunches it after a short pause. The Windows scheduled
rem task (install-connector.ps1) starts THIS at boot; this keeps the agent alive from then on.
setlocal
cd /d "%~dp0.."
:loop
node "src\agent.js"
echo [%date% %time%] connector exited (code %errorlevel%) - restarting in 5s
ping -n 6 127.0.0.1 >nul
goto loop
