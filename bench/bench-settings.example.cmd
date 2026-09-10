@echo off
rem ############################################################################
rem  BENCH SETTINGS - loaded by START-HERE.bat. Edit here, not in the launcher.
rem
rem  THIS FILE CONTAINS REAL SECRETS (the fleet Pi password and the Tailscale
rem  auth key). They are the same on every unit you ship, and sshd listens on
rem  the dealership LAN, so anyone who obtains this file can log into any Pi you
rem  have shipped. Keep this folder off shared drives and out of git. Rotate by
rem  changing the values here and re-flashing; cards already out keep the old ones.
rem ############################################################################

rem  4) PRODUCTION BENCH SETTINGS (fill these in once; they apply to every card).
rem ============================================================================
rem Your workshop WiFi. Added to EVERY card as the lowest-priority network, so a unit can join your bench
rem network and actually CLAIM before you ship it - that is what VERIFY-PI.cmd checks. The dealership's own
rem network always wins on priority, so this never displaces it. Leave blank to turn this off.
set "AUTOPOST_BENCH_SSID="
set "AUTOPOST_BENCH_PASS="

rem Fleet SSH key. Injected into EVERY card automatically, so nobody has to paste it per unit and VERIFY-PI.cmd
rem can always log in unattended. The form field in the app stays blank; leave it blank and this is used.
rem This is a PUBLIC key - safe to keep in this file. Regenerate with: ssh-keygen -t ed25519
set "AUTOPOST_DEV_SSH_PUBKEY=ssh-ed25519 REPLACE-WITH-YOUR-FLEET-PUBLIC-KEY comment"

rem Fleet console/SSH password for the 'admin' user on EVERY card. Leave the password field in the app blank
rem and this is used. 16 random chars (~93 bits), dash-grouped so it can be typed off a screen onto a physical
rem console, and with no ambiguous glyphs (no 0/O, no 1/l/I).
rem THIS IS A REAL SECRET and it is the same on every unit: sshd listens on the dealership LAN, so anyone who
rem obtains it can log into any Pi you have shipped. Keep this folder off shared drives and out of git. Rotate
rem by changing it here and re-flashing; existing cards keep the old one.
set "AUTOPOST_PI_PASS=REDACTED-SET-LOCALLY"

rem Which Pi model the hardware dropdown STARTS on. The fleet is original Zero W, so that is the default and the
rem VA never has to touch the dropdown. Change to pi4 only if you standardise on Pi 4 / Zero 2 W hardware.
rem NOTE: the zerow image is 32-bit and boots on EVERY Pi including the 4; the pi4 image is 64-bit and does NOT
rem boot on an original Zero W at all. That is why zerow is the safe default.
set "AUTOPOST_PI_MODEL=zerow"

rem Set to 0 if you ever want to ship cards with NO USB gadget / no sshd (overrides the app's checkbox).
rem set "AUTOPOST_USB_GADGET=0"

rem --- Tailscale fleet key (reusable, tagged) so every shipped Pi self-joins the
rem     tailnet for remote SSH recall.
set "AUTOPOST_TS_AUTHKEY=tskey-auth-kmM6h6Y27V11CNTRL-PoYeNFHgngPUFyMTGynmhPvwdCei8S88X"

exit /b 0
