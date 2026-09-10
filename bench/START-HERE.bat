@echo off
setlocal EnableDelayedExpansion
title AutoPost - Set up a Pi
color 0B

rem ############################################################################
rem  THIS IS THE ONLY FILE YOU NEED TO DOUBLE-CLICK.
rem
rem  It unblocks the downloaded files, checks that everything the flasher needs
rem  is present, installs the one prerequisite (Raspberry Pi Imager) if it is
rem  missing, loads the bench settings, then starts the app.
rem
rem  BEFORE YOU RUN THIS: extract the ZIP first. Right-click the downloaded
rem  AutoPost-Setup.zip, choose "Extract All...", then open the extracted folder
rem  and double-click this file. Running it from inside the ZIP preview window
rem  does not work - Windows only unpacks this one file, not the 1.4 GB of Pi
rem  images next to it. Step 0 below catches that and tells you.
rem
rem  Bench settings (WiFi, SSH key, Pi password, Tailscale key) live in
rem  bench-settings.cmd next to this file - NOT in here. Edit that file to change
rem  them. It holds real secrets: keep this folder off shared drives and out of
rem  git.
rem
rem  HOW TO FLASH CARDS (multi-card):
rem    1. Put as many SD cards in readers as you have, and press "Scan for cards".
rem    2. Each card gets its own row. Fill in that row: dealership, setup code,
rem       WiFi name + password, timezone. Every row is INDEPENDENT - different
rem       dealerships in one batch is fine and normal.
rem    3. Turn "Dry run" OFF, press "Erase + Flash". ONE confirmation covers the
rem       whole batch and every card writes AT THE SAME TIME.
rem    4. When a card finishes, its row offers "Another card for this dealership"
rem       or "Different dealership". Swap the card, press Scan, carry on. You
rem       never need to close and reopen this program.
rem
rem  EVERY CARD NEEDS ITS OWN SETUP CODE. Codes are one-time - the hub burns one
rem  the first time a Pi claims - so two cards sharing a code means the second Pi
rem  never comes online. Mint one code per card on the Ship-a-Pi page first. The
rem  app refuses to flash if it sees the same code twice.
rem ############################################################################

cd /d "%~dp0"

rem ============================================================================
rem  0) STILL INSIDE THE ZIP? When you double-click a .bat from Explorer's ZIP
rem     preview, Windows copies ONLY that one file to a temp folder and runs it
rem     there. Nothing else comes with it, so every check below would fail with a
rem     confusing "file missing" list. Detect the temp path and say plainly what
rem     to do instead. The app-exists test keeps a genuine extract-to-Temp
rem     working, which is unusual but legitimate.
rem
rem     Done with cmd's own substring-replace, which is case-insensitive and
rem     needs no external program. Deliberately NOT "find /i": Git for Windows
rem     puts a Unix find.exe on PATH for some install options, and it shadows
rem     C:\Windows\System32\find.exe, so this whole check would silently never
rem     fire on those machines. Verified: it did exactly that on the build box.
rem ============================================================================
if exist "app\AutoPost Pi Setup.exe" goto :not_inside_zip
set "HERE=%~dp0"
set "PROBE=!HERE:%TEMP%=!"
if not "!PROBE!"=="!HERE!" goto :inside_zip
set "PROBE=!HERE:\AppData\Local\Temp\=!"
if not "!PROBE!"=="!HERE!" goto :inside_zip
goto :not_inside_zip

:inside_zip
echo.
echo   ================================================================
echo    YOU ARE RUNNING THIS FROM INSIDE THE ZIP FILE.
echo   ================================================================
echo.
echo    Windows only unpacked this one file, so the app and the 1.4 GB of
echo    Pi images are not here. Nothing was changed.
echo.
echo    Do this instead:
echo      1. Close this window.
echo      2. Right-click AutoPost-Setup.zip, choose "Extract All...".
echo      3. Open the folder it creates.
echo      4. Double-click START-HERE.bat in there.
echo.
pause
exit /b 1

:not_inside_zip

rem ============================================================================
rem  1) Administrator rights. REQUIRED for multi-card flashing, not just for disk
rem     access: running elevated is what lets the app write several cards at once
rem     without a separate Windows permission prompt per card. Click YES once.
rem ============================================================================
net session >nul 2>&1
if %errorlevel% NEQ 0 (
  echo   Click YES on the Windows prompt to continue...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

rem ============================================================================
rem  2) UNBLOCK. Every file extracted from a ZIP that came off the internet
rem     carries a "mark of the web" alternate data stream. Windows then warns on,
rem     or outright blocks, the app and its DLLs. Strip the mark once across the
rem     whole folder so the rest of this runs clean. A no-op if never tagged.
rem ============================================================================
echo.
echo   Unblocking downloaded files...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem -LiteralPath '%~dp0' -Recurse -Force -File -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue" >nul 2>&1

rem ============================================================================
rem  3) PREFLIGHT. Check everything up front and report ALL of it at once, so a
rem     missing file is found here rather than halfway through a card write.
rem ============================================================================
echo.
echo   ================================================================
echo    AutoPost - checking files
echo   ================================================================
echo.

set "MISSING=0"

call :need "app\AutoPost Pi Setup.exe"            "the flasher application"
call :need "images\autopost-golden-zerow.img.xz"  "the Pi Zero W golden image - the fleet default"
call :need "images\autopost-golden.img.xz"        "the Pi 4 / 64-bit golden image"
call :need "source\flasher\writer.js"             "the flasher source"
call :need "bench-settings.cmd"                   "the bench settings - WiFi, SSH key, Pi password, Tailscale key"

rem The Imager installer is only needed if Imager is not already installed.
set "IMAGER_EXE=C:\Program Files\Raspberry Pi Ltd\Imager\rpi-imager.exe"
if not exist "imager_latest.exe" (
  if not exist "%IMAGER_EXE%" (
    echo   [MISSING] imager_latest.exe - the Raspberry Pi Imager installer
    echo             Raspberry Pi Imager is also not already installed, so there
    echo             is no way to write a card. Install it by hand from:
    echo             https://www.raspberrypi.com/software/
    set "MISSING=1"
  )
)

if "!MISSING!"=="1" (
  echo.
  echo   ================================================================
  echo    CANNOT START - the files listed above are missing.
  echo    Nothing was changed. Restore them and run this again.
  echo.
  echo    Most likely cause: the ZIP was only part-extracted. Extract
  echo    AutoPost-Setup.zip again, all of it, and run this from there.
  echo   ================================================================
  echo.
  pause
  exit /b 1
)

echo.
echo   All required files are present.
echo.

rem ============================================================================
rem  4) Prerequisite: Raspberry Pi Imager. This is the actual write engine - the
rem     app shells out to it. Installed silently from the bundled copy if absent.
rem ============================================================================
if not exist "%IMAGER_EXE%" (
  echo   Installing Raspberry Pi Imager, please wait about a minute...
  "%~dp0imager_latest.exe" /S
  ping -n 8 127.0.0.1 >nul
  if not exist "%IMAGER_EXE%" (
    echo.
    echo   ERROR: Raspberry Pi Imager still is not at:
    echo          %IMAGER_EXE%
    echo   Install it by hand from https://www.raspberrypi.com/software/ and run
    echo   this again. Nothing was changed.
    echo.
    pause
    exit /b 1
  )
  echo   Raspberry Pi Imager installed.
) else (
  echo   Raspberry Pi Imager is already installed.
)
set "RPI_IMAGER=%IMAGER_EXE%"

rem ============================================================================
rem  5) Golden images. The app's "Pi hardware" dropdown picks between these two at
rem     flash time. Do NOT set AUTOPOST_PI_IMAGE: that generic override forces
rem     EVERY flash onto ONE file regardless of the dropdown, defeating the picker.
rem ============================================================================
set "AUTOPOST_PI_IMAGE_PI4=%~dp0images\autopost-golden.img.xz"
set "AUTOPOST_PI_IMAGE_ZEROW=%~dp0images\autopost-golden-zerow.img.xz"

rem ============================================================================
rem  6) Bench settings: WiFi, fleet SSH key, Pi password, Tailscale key, default
rem     hardware model. Kept in their own file so this launcher carries no secrets.
rem ============================================================================
call "%~dp0bench-settings.cmd"
if errorlevel 1 (
  echo.
  echo   ERROR: bench-settings.cmd failed to load. Nothing was changed.
  echo.
  pause
  exit /b 1
)

rem ============================================================================
rem  7) Start the app.
rem ============================================================================
echo   Starting AutoPost...
echo.
start "" "%~dp0app\AutoPost Pi Setup.exe"

rem Give the window a moment to appear so this console closing is not mistaken
rem for the app failing to launch.
ping -n 3 127.0.0.1 >nul
exit /b 0

rem ============================================================================
rem  Helper: report a required file, and remember that something was missing.
rem ============================================================================
rem  Written without parenthesised if/else blocks on purpose: cmd expands %~2 BEFORE
rem  parsing the block, so a description containing "(" or ")" would end the block
rem  early and abort the script with "was unexpected at this time".
:need
if not exist "%~1" goto :need_missing
echo   [ok]      %~1
goto :eof
:need_missing
echo   [MISSING] %~1
echo             %~2
set "MISSING=1"
goto :eof
