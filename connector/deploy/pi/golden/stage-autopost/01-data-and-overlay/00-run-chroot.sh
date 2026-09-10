#!/bin/bash -e
# CHROOT side: fstab entry for the AUTOPOST-DATA partition, WiFi country, EEPROM pin, and PRE-BAKE the read-only
# rootfs overlay. Order matters: everything else in the image must be done before overlay goes on.

# 1) Mount the persistent data partition at /var/lib/autopost. nofail so a missing/renamed card never blocks boot;
#    x-systemd.growfs auto-expands it to fill the space on first boot.
if ! grep -q 'AUTOPOST-DATA' /etc/fstab; then
  echo 'LABEL=AUTOPOST-DATA  /var/lib/autopost  ext4  defaults,noatime,nofail,x-systemd.growfs  0  2' >> /etc/fstab
fi

# 2) WiFi regulatory domain default (per-dealership country is also set by firstrun.sh at flash time).
raspi-config nonint do_wifi_country US 2>/dev/null || true

# 3) Pin the bootloader EEPROM to the 'default'/stable channel so a surprise EEPROM update can't change behavior.
if [ -f /etc/default/rpi-eeprom-update ]; then
  sed -i 's/^FIRMWARE_RELEASE_STATUS=.*/FIRMWARE_RELEASE_STATUS="default"/' /etc/default/rpi-eeprom-update || true
fi

# 3b) CRITICAL for the overlay to be SAFE: move NetworkManager's saved connections onto the DATA partition so a
#     WiFi correction (from the self-rescue hotspot OR a super-admin Set-WiFi push) SURVIVES the read-only overlay
#     and power cuts. Without this, /etc/NetworkManager/system-connections lives on the overlaid rootfs and every
#     fix is EVICTED on the next reboot = a headless, offline, physical-recovery-only brick for a dealership whose
#     WiFi we just corrected. This is GOLDEN-IMAGE-SPEC requirement #6.
install -d -m 0700 /var/lib/autopost/nm-system-connections
rm -rf /etc/NetworkManager/system-connections
ln -s /var/lib/autopost/nm-system-connections /etc/NetworkManager/system-connections
#     NM's connection store now lives on the data partition — make NetworkManager wait for that mount so it never
#     starts with an EMPTY store before the partition is up (which would leave the box unable to join WiFi).
install -d /etc/systemd/system/NetworkManager.service.d
cat > /etc/systemd/system/NetworkManager.service.d/10-autopost-data.conf <<'DROPIN'
[Unit]
RequiresMountsFor=/var/lib/autopost
After=var-lib-autopost.mount
DROPIN

# 4) PRE-BAKE the rootfs overlay (corruption-proof: rootfs writes evaporate on reboot; only AUTOPOST-DATA persists).
#    raspi-config ships the toggle; enable it non-interactively. /var/lib/autopost is a separate partition, so it
#    stays writable under the overlay. This must be the LAST image-time change. NOTE: enable_overlayfs inside a
#    chroot cannot always build the initramfs / set the boot partition read-only — the built image MUST be
#    certified on a real Pi (selftest 'overlay_active' + the 2x power-cut persistence canary) before shipping.
raspi-config nonint enable_overlayfs 2>/dev/null || {
  echo "WARN: enable_overlayfs not available in chroot; append-data-partition.sh will set boot=overlay in cmdline as a fallback"
}
# Reliable fallback regardless of raspi-config: ensure the kernel actually mounts the overlay by putting
# boot=overlay on the kernel command line (append-data-partition.sh also does this; belt + suspenders).
for CMDLINE in /boot/firmware/cmdline.txt /boot/cmdline.txt; do
  if [ -f "$CMDLINE" ] && ! grep -q 'boot=overlay' "$CMDLINE"; then
    sed -i 's/[[:space:]]*$//' "$CMDLINE"; sed -i '1 s/$/ boot=overlay/' "$CMDLINE"
  fi
done
