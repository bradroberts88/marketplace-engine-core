@echo off
title AutoPost - Run tests
color 0B
cd /d "%~dp0..\source"

rem ============================================================================
rem  Runs every test in the repo. Pure Node, no npm install needed.
rem ============================================================================

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed. Get the LTS build from https://nodejs.org
  echo   then run this again.
  echo.
  pause
  exit /b 1
)

set "FAILED=0"

echo.
echo   === connector: pre-cap link refresh gate ===
node src\_test\planned-refresh.test.js || set "FAILED=1"

echo.
echo   === hub: health alerts + disconnect classification ===
node server\src\_test\health-alerts.test.js || set "FAILED=1"

echo.
echo   === connector: wifi recovery ===
node src\_test\wifi-recovery.test.js || set "FAILED=1"
echo.
echo   === connector: config resilience (the 2026-08-30 zero-byte config.json) ===
rem Deliberately OUTSIDE the electron gate: this covers the failure that bricked a customer unit,
rem and a suite that silently skips reads exactly like a suite that passed.
node src\_test\config-resilience.test.js || set "FAILED=1"

echo.
echo   === flasher: safety ===
node flasher\_test\safety.test.js || set "FAILED=1"

echo.
echo   === flasher: first-run injection ===
node flasher\_test\inject.test.js || set "FAILED=1"

echo.
echo   === flasher: capture WiFi on first boot ===
node flasher\_test\nowifi.test.js || set "FAILED=1"

echo.
echo   === flasher: ssh hardening + secret leakage ===
node flasher\_test\ssh-hardening.test.js || set "FAILED=1"

echo.
echo   === flasher: batch confirm dialog ===
node flasher\_test\confirm-batch.test.js || set "FAILED=1"

rem confirm-batch.test.js drives the REAL confirmBatch() and still needs NO electron install - it stubs
rem 'electron' and 'drivelist' through Module._load. That matters: the two tests below are skipped on this
rem tree, so before it existed nothing executed confirmBatch at all, and a ReferenceError in it shipped.
rem These two load flasher\main-flasher.js, which requires 'electron'. The consolidated tree ships
rem without source\node_modules on purpose - the app in app\ is already packaged and carries its own.
rem Reported as SKIPPED rather than silently dropped or falsely failed. To enable them:
rem     cd source  &&  npm install       (downloads Electron, about 200 MB, one time)
if exist "node_modules\electron" (
  echo.
  echo   === flasher: pi model selection ===
  node flasher\_test\pi-model.test.js || set "FAILED=1"

  echo.
  echo   === flasher: batch ===
  node flasher\_test\batch.test.js || set "FAILED=1"
) else (
  echo.
  echo   === flasher: pi model selection ===
  echo   SKIPPED - needs 'electron'. Run "npm install" in source\ to enable.
  echo.
  echo   === flasher: batch ===
  echo   SKIPPED - needs 'electron'. Run "npm install" in source\ to enable.
)

echo.
echo   === flasher: batch UI ===
node flasher\_test\ui-batch.test.js || set "FAILED=1"

echo.
if "%FAILED%"=="1" (
  echo   ================================================================
  echo    SOME TESTS FAILED - see the output above.
  echo   ================================================================
) else (
  echo   ================================================================
  echo    ALL TESTS PASSED.
  echo   ================================================================
)
echo.
pause
exit /b %FAILED%
