@echo off
title AutoPost - verify a flashed Pi

rem ============================================================================
rem  BENCH ACCEPTANCE TEST. Run this on every unit before you box it.
rem
rem    1) flash the card, put it in the Pi
rem    2) power the Pi on, wait ~90 seconds
rem    3) plug a USB DATA cable into the Pi's DATA port
rem         Pi Zero / Zero 2 W -> the micro-USB marked "USB"  (NOT "PWR IN")
rem         Pi 4               -> the USB-C port
rem    4) double-click this file
rem
rem  It prints PASS (ship it) or FAIL (do not ship, with the reason).
rem
rem  Optional arguments:
rem    VERIFY-PI.cmd --ap                  also prove the rescue AP raises (+45s, recommended)
rem    VERIFY-PI.cmd --log C:\qa\batch.csv append the result to a CSV for the batch
rem ============================================================================

net session >nul 2>&1
if %errorlevel% NEQ 0 (
  echo Click YES on the Windows prompt to continue...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList '%*' -Verb RunAs"
  exit /b
)

set "PSARGS="
:parse
if "%~1"=="" goto run
if /I "%~1"=="--ap"  set "PSARGS=%PSARGS% -Ap" & shift & goto parse
if /I "%~1"=="--log" set "PSARGS=%PSARGS% -Log '%~2'" & shift & shift & goto parse
if /I "%~1"=="--ssid" set "PSARGS=%PSARGS% -ExpectSsid '%~2'" & shift & shift & goto parse
shift
goto parse

:run
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0verify-pi.ps1" %PSARGS%
set RC=%ERRORLEVEL%

echo.
if %RC%==0 (echo Result: PASS) else (echo Result: FAIL - do not ship this unit)
echo.
pause
