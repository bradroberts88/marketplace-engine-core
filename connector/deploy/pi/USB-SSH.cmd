@echo off
title AutoPost - SSH to the Pi over USB

rem ============================================================================
rem  Connect to a flashed Pi over the USB cable, so a change can be tested in
rem  seconds instead of costing a 45-minute reflash.
rem
rem  Plug a DATA USB cable from this PC into the Pi's DATA port:
rem    Pi Zero / Zero 2 W -> the micro-USB marked "USB"  (NOT "PWR IN")
rem    Pi 4               -> the USB-C port
rem  then double-click this file.
rem
rem  Optional first argument = the Pi login user (defaults to admin):
rem      USB-SSH.cmd admin
rem ============================================================================

set "PIUSER=%~1"
if "%PIUSER%"=="" set "PIUSER=admin"

rem Setting an IP address needs Administrator - re-launch elevated if we are not.
net session >nul 2>&1
if %errorlevel% NEQ 0 (
  echo Click YES on the Windows prompt to continue...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList '%PIUSER%' -Verb RunAs"
  exit /b
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0usb-ssh-connect.ps1" -PiUser "%PIUSER%"

echo.
pause
