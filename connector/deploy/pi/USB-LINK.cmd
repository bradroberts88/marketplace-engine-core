@echo off
title AutoPost - configure the USB link to the Pi

rem ============================================================================
rem  Configures THIS PC's side of the USB link to the Pi (10.55.0.2/24) and then
rem  exits - it does NOT open an SSH session. Use this when you want the link up
rem  so something else (a script, or Claude) can SSH in.
rem
rem  For a normal interactive login, use USB-SSH.cmd instead.
rem ============================================================================

net session >nul 2>&1
if %errorlevel% NEQ 0 (
  echo Click YES on the Windows prompt to continue...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0usb-ssh-connect.ps1" -NoSsh

echo.
echo Link configured. You can close this window.
pause
