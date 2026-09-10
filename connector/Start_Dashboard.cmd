@echo off
title AutoPost - Dashboard
cd /d "%~dp0"

node -v >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js is not installed on this PC.
  echo Install the LTS version from https://nodejs.org  then double-click this file again.
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo First run: installing components ^(one time^)...
  call npm install
)

echo.
echo Starting the connector dashboard...
start "Connector Dashboard Server" cmd /c "node preview-ui.js"
timeout /t 3 >nul
start "" http://127.0.0.1:4599

echo.
echo ================================================================
echo   The dashboard just opened in your browser.
echo   Sign in with:   manager  /  preview
echo.
echo   A separate black window is running the connector.
echo   Close THAT window to stop the dashboard.
echo ================================================================
echo.
pause
