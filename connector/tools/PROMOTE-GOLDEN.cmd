@echo off
setlocal EnableDelayedExpansion
title AutoPost - Promote a rebuilt golden image
color 0B
cd /d "%~dp0.."

rem ============================================================================
rem  Promote a freshly built image from images-rebuilt\ into images\, where the
rem  flasher picks it up.
rem
rem  This is the LAST step of a golden rebuild, and it is deliberately separate
rem  from the build: an image that has not been flashed to a card and booted is
rem  not a shippable image, whatever the build log said. Build -> test one card
rem  -> promote.
rem
rem  What it does:
rem    * refuses to promote an image that fails its own xz integrity check
rem    * archives whatever is in images\ as ...ARCHIVED-<date>.img.xz first, so
rem      a bad promotion is always one rename away from being undone
rem    * keeps the 32-bit and 64-bit images strictly apart - they are different
rem      products and a card flashed with the wrong one does not boot at all
rem ============================================================================

set "SRC=images-rebuilt"
set "DST=images"

if not exist "%SRC%\" (
  echo.
  echo   No images-rebuilt\ folder. Build an image first:
  echo     wsl -u root -e bash -lc "ARCH=armhf REPO=... bash source/deploy/pi/golden/customize-stock-image.sh"
  echo.
  pause
  exit /b 1
)

rem --- date stamp for the archive name (YYYYMMDD, locale-independent) ---------
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd"') do set "STAMP=%%i"

rem --- WSL path of THIS folder, derived, never hardcoded to one machine ------
for /f "usebackq delims=" %%i in (`wsl.exe -e wslpath -a "%CD%"`) do set "WSLROOT=%%i"

set "FOUND=0"
for %%N in (autopost-golden autopost-golden-zerow) do (
  if exist "%SRC%\%%N.img.xz" (
    set "FOUND=1"
    echo.
    echo   ============================================================
    echo    %%N.img.xz
    echo   ============================================================

    rem Integrity FIRST. A truncated or corrupt image that reaches images\ gets
    rem written to cards and only fails on the bench, hours later.
    echo    checking archive integrity...
    wsl.exe -e xz -t "/mnt/c/Users/wills/Desktop/AutoPost/%SRC%/%%N.img.xz"
    if errorlevel 1 (
      echo    FAILED its integrity check - NOT promoted. Rebuild it.
    ) else (
      echo    integrity OK

      if exist "%DST%\%%N.img.xz" (
        if exist "%DST%\%%N.ARCHIVED-%STAMP%.img.xz" (
          echo    an archive for today already exists - overwriting it
          del /q "%DST%\%%N.ARCHIVED-%STAMP%.img.xz"
        )
        echo    archiving the current image as %%N.ARCHIVED-%STAMP%.img.xz
        move /y "%DST%\%%N.img.xz" "%DST%\%%N.ARCHIVED-%STAMP%.img.xz" >nul
      )

      echo    promoting...
      move /y "%SRC%\%%N.img.xz" "%DST%\%%N.img.xz" >nul
      if errorlevel 1 (
        echo    PROMOTION FAILED - restoring the previous image
        if exist "%DST%\%%N.ARCHIVED-%STAMP%.img.xz" move /y "%DST%\%%N.ARCHIVED-%STAMP%.img.xz" "%DST%\%%N.img.xz" >nul
      ) else (
        echo    promoted. The flasher will use it on the next card.
      )
    )
  )
)

if "%FOUND%"=="0" (
  echo.
  echo   Nothing to promote - images-rebuilt\ has no autopost-golden*.img.xz
)

echo.
echo   Current images\:
dir /b "%DST%\*.img.xz"
echo.
echo   Reminder: flash ONE card from the promoted image and run VERIFY-PI
echo   before boxing a batch.
echo.
pause
