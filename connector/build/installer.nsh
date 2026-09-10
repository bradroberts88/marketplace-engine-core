; AutoPost NSIS customizations.
; On install: register the always-on supervisor (a per-user scheduled task) so the app restarts on
; crash / quit / close / reboot / wedge. Runs the bundled Install-KeepAlive.ps1 as the installing user
; (no admin needed). asar is false, so the app files live under $INSTDIR\resources\app.
; On uninstall: remove the scheduled task.

!macro customInstall
  nsExec::Exec 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$INSTDIR\resources\app\supervisor\Install-KeepAlive.ps1"'
!macroend

!macro customUnInstall
  nsExec::Exec 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$INSTDIR\resources\app\supervisor\Uninstall-KeepAlive.ps1"'
!macroend
