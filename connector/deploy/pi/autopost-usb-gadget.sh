#!/bin/bash
# GENERATED from flasher/inject.js usbGadgetScriptLines() - edit THERE, not here, then re-run:
#   node -e "require('./flasher/inject')" ... (see deploy/pi/README or regen-usb-gadget.js)
# AutoPost USB ethernet gadget - RNDIS via libcomposite/configfs. Runs on every boot.
# Editable directly on the card from Windows: this file is on the FAT boot partition.
set +e
G=/sys/kernel/config/usb_gadget/autopost
DEV_MAC=02:1a:11:00:00:01
HOST_MAC=02:1a:11:00:00:02
PI_IP=10.55.0.1
PREFIX=24

modprobe libcomposite 2>/dev/null
mountpoint -q /sys/kernel/config || mount -t configfs none /sys/kernel/config 2>/dev/null

# Wait for a UDC. Its absence means dwc2 is not in peripheral mode (config.txt), not that we are early.
UDC=""
for i in $(seq 1 30); do
  UDC="$(ls /sys/class/udc 2>/dev/null | head -n1)"
  [ -n "$UDC" ] && break
  sleep 1
done
[ -n "$UDC" ] || { echo "autopost-usb-gadget: no UDC - is dtoverlay=dwc2,dr_mode=peripheral set?"; exit 0; }

# Release whatever owns the UDC (Pi OS's serial console gadget). Only ONE gadget may be bound at a time -
# this is the step whose absence left the Pi presenting a serial port instead of a network adapter.
for g in /sys/kernel/config/usb_gadget/*; do
  [ -d "$g" ] || continue
  [ "$g" = "$G" ] && continue
  echo "" > "$g/UDC" 2>/dev/null
done

[ -d "$G" ] && echo "" > "$G/UDC" 2>/dev/null   # idempotent: unbind ours so we can re-bind cleanly
mkdir -p "$G" || exit 0
cd "$G" || exit 0

echo 0x1d6b > idVendor          # Linux Foundation
echo 0x0104 > idProduct         # Multifunction Composite Gadget
echo 0x0100 > bcdDevice
echo 0x0200 > bcdUSB
# Misc/IAD device class - required for Windows to accept a composite RNDIS gadget.
echo 0xEF > bDeviceClass
echo 0x02 > bDeviceSubClass
echo 0x01 > bDeviceProtocol

mkdir -p strings/0x409
echo "autopost0001" > strings/0x409/serialnumber
echo "AutoPost"     > strings/0x409/manufacturer
echo "AutoPost Pi"  > strings/0x409/product

# Microsoft OS descriptors: this is what makes Windows load its RNDIS driver automatically instead of
# showing an unknown device that needs a manual driver pick on every PC.
mkdir -p os_desc
echo 1       > os_desc/use
echo 0xcd    > os_desc/b_vendor_code
echo MSFT100 > os_desc/qw_sign

mkdir -p configs/c.1/strings/0x409
echo "RNDIS" > configs/c.1/strings/0x409/configuration
echo 250     > configs/c.1/MaxPower

# Pinned MACs: g_ether-style randomisation makes Windows enumerate a NEW adapter every boot and orphan the
# static IP. Both are locally-administered unicast, so they cannot collide with a real vendor NIC.
mkdir -p functions/rndis.usb0
echo "$DEV_MAC"  > functions/rndis.usb0/dev_addr
echo "$HOST_MAC" > functions/rndis.usb0/host_addr
echo RNDIS   > functions/rndis.usb0/os_desc/interface.rndis/compatible_id
echo 5162001 > functions/rndis.usb0/os_desc/interface.rndis/sub_compatible_id

ln -sf functions/rndis.usb0 configs/c.1/ 2>/dev/null
ln -sf configs/c.1 os_desc/ 2>/dev/null

echo "$UDC" > UDC || { echo "autopost-usb-gadget: bind to $UDC FAILED"; exit 0; }
echo "autopost-usb-gadget: bound to $UDC"

# Belt-and-braces addressing. NetworkManager has an autopost-usb0 profile, but it marks the interface
# unmanaged in some boot orderings - setting the address directly means the link works either way.
for i in $(seq 1 15); do [ -d /sys/class/net/usb0 ] && break; sleep 1; done
if [ -d /sys/class/net/usb0 ]; then
  ip link set usb0 up 2>/dev/null
  ip addr show dev usb0 2>/dev/null | grep -q "$PI_IP" || ip addr add "$PI_IP/$PREFIX" dev usb0 2>/dev/null
  echo "autopost-usb-gadget: usb0 up at $PI_IP/$PREFIX"
fi
exit 0
