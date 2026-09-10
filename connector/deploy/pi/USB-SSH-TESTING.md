# Testing a Pi over USB — stop reflashing for every change

**The problem this removes:** a reflash costs 45+ minutes, so testing one changed command costs 45 minutes.

**What replaces it:** the flashed card comes up as a **USB Ethernet adapter**. Plug a USB cable from your PC
into the Pi and you have an SSH session at a fixed address. Flash once, then iterate live on the box — seconds
per change instead of a full write/verify/boot cycle.

---

## Using it

1. **Flash a card as normal.** In step 2 of the flasher, leave **USB SSH** checked (it is on by default) and
   either set a **Pi login password** or paste an **SSH public key**. One of the two is required — without a
   credential you get a Pi that answers on port 22 and cannot be logged into, which costs you the exact reflash
   this feature exists to avoid. The flasher warns you before you write the card.

2. **Boot the Pi and wait ~90 seconds.** A freshly flashed card boots, provisions, and **reboots itself once**.
   The USB gadget only exists after that second boot, because `dtoverlay=dwc2` is read by the firmware at boot
   time.

3. **Plug a USB DATA cable** from the PC into the Pi's **data** port:
   - **Pi Zero / Zero 2 W** — the micro-USB marked **`USB`**, *not* the one marked `PWR IN`.
   - **Pi 4** — the **USB-C** port.

4. **Run `USB-SSH.cmd`** (double-click; it elevates itself). It finds the adapter, sets the PC side to
   `10.55.0.2/24`, waits for the Pi, and drops you into a shell.

   Or do it by hand once the link is configured:
   ```
   ssh admin@10.55.0.1
   ```

---

## The addressing

| | |
|---|---|
| Pi (`usb0`) | `10.55.0.1/24` |
| PC side | `10.55.0.2/24` |
| Pi-side MAC (`dev_addr`) | `02:1a:11:00:00:01` |
| PC-side MAC (`host_addr`) | `02:1a:11:00:00:02` |
| NM profile on the Pi | `autopost-usb0` |

Both MACs are **pinned**, and that matters more than it looks. By default `g_ether` randomises both ends on
every boot, and Windows keys a network adapter — and therefore its saved static IP — off the MAC. Random MACs
mean Windows enumerates a brand-new "Ethernet N" adapter on every single boot and orphans the address you just
configured. Pinning them is what makes the link come back at the same IP after a reboot or a reflash. Both are
locally-administered unicast addresses, so they cannot collide with a real vendor NIC.

The USB link carries **no default route and no gateway** (`never-default=true` in the keyfile). Without that,
plugging in a laptop could hand the Pi's default route to the USB interface and cut it off from the internet —
and from Tailscale — the moment you connected to debug it.

---

## What is actually on the card

All placed by `firstrun.sh` on the first boot (see `flasher/inject.js`, `usbGadgetSteps`):

```
/boot/firmware/config.txt                  + [all]
                                             dtoverlay=dwc2,dr_mode=peripheral

/boot/firmware/cmdline.txt                 + modules-load=dwc2

/boot/firmware/autopost-usb-gadget.sh        builds the RNDIS gadget via libcomposite/configfs
/etc/systemd/system/autopost-usb-gadget.service   runs it on every boot (After=NetworkManager)

/etc/NetworkManager/system-connections/autopost-usb0.nmconnection   (static 10.55.0.1/24, never-default)
```

plus `sshd` enabled via the stock `/boot/firmware/ssh` flag file.

Four deliberate properties, three of them learned the hard way:

- **`libcomposite`, never `g_ether`.** The legacy `g_ether` gadget module has been **removed from current
  Raspberry Pi OS kernels**. `modules-load=dwc2,g_ether` therefore loads nothing at all, and Pi OS's own CDC-ACM
  serial gadget keeps the USB device controller — the Pi enumerates as a COM port Windows can't even open, with
  no ethernet interface anywhere. Only one gadget may own the controller, so the script explicitly **releases
  whatever holds it** before binding its own.
- **RNDIS with Microsoft OS descriptors.** RNDIS is the protocol Windows binds natively; the MS OS descriptors
  (`MSFT100`, compatible id `RNDIS`, sub-compatible id `5162001`) are what make it bind **automatically**. Without
  them you get an unknown device needing a manual Device Manager driver pick on every PC that touches a Pi.
- **`dr_mode=peripheral` is pinned**, not left at `otg`, so the port cannot come up in host mode and silently
  leave you with no `usb0`. The guard that decides whether to add it matches that **exact** line — stock Pi OS
  already ships `dtoverlay=dwc2,dr_mode=host` under `[cm5]`, and a looser `^dtoverlay=dwc2` check matches it,
  skips the append, and produces a card with no gadget.
- **The gadget script lives on the FAT boot partition.** That makes it editable from any Windows machine with the
  card in a reader — no booting, no shell — which is exactly the situation you're in when the gadget is what's
  broken. Only the small unit file sits on the rootfs.

`sshd` is the **real** OpenSSH server, which is not the same thing as the Tailscale SSH the golden image already
ships — Tailscale SSH does not listen on `usb0`. The script only enables a unit itself if the OS has neither
`ssh.socket` nor `ssh.service` enabled already: Debian 13 ships socket activation, and enabling both leaves them
fighting over port 22.

---

## When it does not work

| Symptom | Cause |
|---|---|
| No adapter appears at all | **Charge-only USB cable.** By far the most common cause — the Pi powers up, so everything looks right. A charge-only cable is physically identical to a data cable. Try another cable first. |
| No adapter appears | Cable in the wrong port (`PWR IN` instead of `USB` on a Zero). |
| No adapter appears | The card is still in its first-boot reboot. Wait 90s from power-on. |
| Pi shows up as a **COM port / "USB Serial Device"** instead of a network adapter | Pi OS's own serial gadget owns the USB controller — meaning `autopost-usb-gadget.service` did not run or failed. Check `journalctl -u autopost-usb-gadget`. Historically this was the `g_ether` bug (see above). |
| Unknown "RNDIS" device with a warning triangle in Device Manager | The MS OS descriptors should prevent this. If it happens: Update driver → Browse → Let me pick → Network adapters → Microsoft → **Remote NDIS Compatible Device**. One-time, per PC. |
| Adapter is there, `10.55.0.1` never answers | Pi side has not brought `usb0` up. Power-cycle and retry. |
| Adapter is there, SSH refuses the login | The card was flashed with no password and no key. That one does need a reflash. |
| `ssh` warns about a changed host key | Expected — a reflashed card is a new host at the same address. `USB-SSH.cmd` already bypasses `known_hosts` for this link. |

**Pi 4 power note:** with `dr_mode=peripheral` the USB-C port is a data port. A Pi 4 under load wants ~3A, which
a laptop USB port will not supply, so power it from its normal PSU (or via GPIO) and use the USB-C only for
data. A Pi Zero / Zero 2 W draws little enough to run off the laptop port directly.

---

## Turning it off

- **Per card:** uncheck **USB SSH** in the flasher before writing.
- **Fleet-wide:** set `AUTOPOST_USB_GADGET=0` in the environment (e.g. in `START-HERE.cmd`). This wins over the
  checkbox, so it is the switch to use if shipped dealership cards should never carry the gadget.
- **Give the PC adapter back to Windows:** `powershell -File usb-ssh-connect.ps1 -Reset`
