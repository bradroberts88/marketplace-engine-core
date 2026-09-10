@echo off
rem Launch the Dealership Connector as a real Windows app (its own window + tray, NOT a browser).
title AutoPost
cd /d "%~dp0"

rem Clear a var that some parent shells (e.g. an editor's integrated terminal) set, which would otherwise
rem force Electron to run as plain Node instead of a GUI app.
set "ELECTRON_RUN_AS_NODE="

where node >nul 2>nul || (echo Node.js is not installed. Get it from https://nodejs.org ^(LTS^), then run this again. & pause & exit /b 1)

if not exist "node_modules\electron\dist\electron.exe" (
  echo First run: installing the app ^(one time - this downloads Electron, ~200 MB^)...
  call npm install
)

start "" "node_modules\electron\dist\electron.exe" .
