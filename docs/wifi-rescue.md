# Getting a Pi onto the customer's WiFi when it did not join by itself

There are now **three independent ways** into a unit that will not connect, plus a way to find out what it
actually tried. This document covers what went wrong in the field, what changed, and what to do on site.

---

## Part 1 — why the setup network "never populates" in the field

The rescue worked on the bench every time and failed at customers repeatedly. That is not bad luck: the bench
procedure and the customer site differ in specific ways, and each difference had a defect waiting behind it.
Five were found. Any one of them alone produces the reported symptom.

### 1. The bench test was breaking the card it was meant to validate — this is the big one

While the rescue AP is up, the daemon pauses autoconnect on the saved WiFi profiles so NetworkManager cannot
grab the single radio back mid-session. It did that with a plain `nmcli connection modify`, which **writes the
change to the keyfile on disk**.

The bench procedure was: flash the card → power it up → wait for `AutoPost-Setup-XXXX` to appear → confirm it →
**pull the power** → box it up.

Pulling the power with the AP up means the release never ran. The card shipped with the customer's own network
marked `autoconnect=false`. On arrival the Pi would not so much as *attempt* their WiFi — **however perfectly the
credentials were typed**. The "maybe the info was mistyped" theory was a red herring for these units; a card that
had been bench-tested was guaranteed to fail its first boot at the customer, and a card that had *not* been
bench-tested would have worked.

**Fixed:** the pause is now `nmcli connection modify --temporary`, which lives in NetworkManager's memory and
evaporates on the next boot. A yanked power cord now leaves the profile exactly as the flasher wrote it.
The startup repair also writes `autoconnect=yes` back to disk, so **cards already in the field heal themselves
on their next boot** with nobody touching them.

### 2. A working rescue AP was being torn down for reporting failure

`nmcli connection up` blocks until the activation settles. The command runner killed it after 20 seconds. On a
quiet bench the AP is up in under a second, so this never fired. On a dealership floor — thirty 2.4GHz networks,
a congested band — bring-up takes longer, nmcli got SIGTERMed, came back non-zero, and the rollback fired on the
exit code even when the AP was already serving on `10.42.0.1`.

**Fixed:** `nmcli --wait 45` with a matching runner timeout, and the rollback decision now rests on the observed
gateway address rather than the exit code. A non-zero exit is logged, not obeyed. The AP also **pins a channel**
now (the least congested of 1/6/11 from the cached scan) instead of leaving wpa_supplicant to auto-select —
brcmfmac firmware on the Zero W and Pi 3 does not implement ACS, which is what made bring-up slow or fail on
exactly the crowded sites where the rescue is needed.

### 3. The flap guard then silenced the rescue for the rest of the hour

Failed AP raises consumed the same six-per-hour budget as successful ones. Six rolled-back activations take
about ten minutes, after which the box logged `AP re-entry rate limit hit — holding` and raised **nothing** for
the remaining fifty minutes. That is precisely the shape of *"they waited 20 minutes watching the WiFi list and
it never appeared."*

**Fixed:** only successful raises count, and a box that has never once been online is exempt entirely — it has no
working state to protect and the rescue AP is its only remaining way of being fixed.

### 4. The startup repair silently did nothing when it mattered

The unit is `After=NetworkManager.service`, which means "after systemd started it", not "after it is ready". On a
Pi Zero W the daemon routinely wins that race. The repair is driven by `nmcli connection show`, and the command
runner never rejects — a call made too early came back as *empty stdout*. That does not look like an error, it
looks like "this box has no saved WiFi profiles", so the repair skipped everything and nothing downstream could
tell the difference.

**Fixed:** it now waits for NetworkManager to actually report running (bounded, so a wedged NM cannot block the
rescue), and logs what it repaired.

### 5. Nothing could ever say what happened

Every failure above is silent. A headless box with no internet reaches nobody through the journal, so every field
report was a guess. **This is the reason the other four survived so long**, and it is why the fix list includes a
rolling on-disk diagnostic log reachable over all three channels.

---

## Part 1b — wired mode: taking WiFi out of the loop entirely

A card can now be provisioned in one of two **network modes**, chosen in the flasher (or fleet-wide with
`AUTOPOST_NETWORK_MODE=wired`).

**WiFi mode** is everything above, unchanged.

**Wired mode** points the Pi's USB DATA port the other way round. It ships with **no WiFi credentials at all**,
so there is nothing to mistype and the entire class of failure in Part 1 stops applying to it.

| | WiFi mode | Wired mode |
|---|---|---|
| Uplink | the dealership's wireless | USB-ethernet adapter on the Pi's **USB** port |
| That port's role | USB **device** (`dr_mode=peripheral`) | USB **host** (no dwc2 overlay) |
| Service access | USB cable to a laptop, `10.55.0.1` | patch cable from the adapter to a laptop, **same `10.55.0.1`** |
| WiFi credentials on the card | yes | none |
| WiFi rescue AP | yes | yes — still there if the cable is dead |
| Bluetooth rescue | yes | yes |

### How the port switches

`dr_mode` is a device-tree parameter read by the firmware at boot, so this is decided when the card is written,
not at runtime. Wired mode works by **absence**: no `dtoverlay=dwc2` and no `modules-load=dwc2`, which leaves the
Zero W / Zero 2 W micro-USB data port on the stock `dwc_otg` driver in host mode — the way a bare Pi Zero hosts a
keyboard or a hub. Writing `dr_mode=host` instead would swap in a driver that Raspberry Pi does not ship or test
for host duty on this platform, and the wired path has to be the boring one.

Re-flashing a card the other way is safe in both directions: firstrun strips the gadget overlay on a wired card,
and `configTxtPatched` strips it on the card as it is written. A leftover `dr_mode=peripheral` would leave the
adapter unpowered with nothing on the box to explain why, so it is removed in two places on purpose.

### The wired profile

One NetworkManager keyfile, `autopost-eth0`, doing two jobs:

- `method=auto` — DHCP from the dealership network. This is the real uplink, and unlike the old usb0 profile it
  carries **no `never-default`**: the wire is allowed to own the default route, because it *is* the way out.
- `address1=10.55.0.1/24` — a fixed service address carried alongside the lease, so the box is still reachable
  at a known address on a bench with **no DHCP server at all**. Run a patch cable from the adapter straight into
  a laptop (modern NICs auto-MDIX, so an ordinary cable is fine) and SSH to it. **This is what replaces "SSH over
  the USB cable"**, and the address is deliberately unchanged so `USB-SSH.cmd`, `verify-pi.ps1`, the rescue
  portal's bind and every document keep working.
- `autoconnect-priority=30`, above the WiFi profiles (primary 10, backups 9–1), so a box carrying both prefers
  the wire.

It is **not** pinned to `interface-name=eth0`. A USB adapter enumerates under whatever name predictable naming
gives it — `enx<mac>` on many builds — which `eth0` would never match, and a profile that silently matches
nothing is exactly the failure mode this project keeps getting bitten by.

### Two fixes that came with it

**sshd is no longer nested inside the USB-gadget block.** It used to be, so unticking USB SSH shipped a card with
no SSH server and no key installed — silently, and fatally for a mode whose entire service story is SSH over the
wire. It is now emitted in both modes.

**The first re-probe after the rescue AP goes up is now ~90 seconds, not 15 minutes.** The 15-minute figure is
right for an unattended box riding out a site outage, but the commonest reason the AP goes up at all is that the
real network had not finished coming up — a wired adapter still getting DHCP, a slow WPA association. It backs
off to the full interval after the first look.

Alongside that, the daemon now checks for a **live wired device** before treating "no saved WiFi" as an
emergency. Without it, a wired card raised its rescue AP within seconds of every boot, before the adapter had
finished DHCP, on a box that was about to be perfectly online. The USB gadget is excluded from that check by
name and by profile — it is type=ethernet and permanently connected, so counting it would suppress the instant
AP on every "No WiFi yet" card, which is the one case that genuinely wants it.

### Choosing hardware

Pi OS ships drivers for the common chipsets: `r8152` (Realtek RTL8152B/8153), `smsc95xx` (LAN9500/9512/9514),
`ax88179_178a` (ASIX). The Pi Zero "Ethernet + USB HUB HAT" uses LAN9514 and is a safe bet. Unbranded adapters
with undocumented chipsets are the risk. Budget roughly +200 mA on the Pi's 5 V rail, fed through the data port —
fine on a decent 2 A supply, marginal on a phone charger, and brownouts on these boards are silent.

**Pi 4 needs none of this**: its USB-C port is pinned peripheral but the four USB-A ports are always host, and it
has built-in ethernet anyway.

### What the bench checks

`pi-verify.sh` reads the mode the card was provisioned in from `/boot/firmware/autopost-network-mode` and
compares it against what the card actually has — because a card asked for wired but built as a gadget looks
completely normal on a bench (it has a usb0, it answers SSH) and then arrives with a dead adapter and no uplink:

```
INFO network-mode=wired
PASS wired-port-host-mode
PASS wired-profile-present
PASS wired-service-address
PASS wired-sshd-enabled
```

---

## Part 2 — the three ways in

| | Reaches the device via | Works when | Needs |
|---|---|---|---|
| **A. Setup WiFi** | the Pi's own WiFi radio | the radio is free and the AP activates | any phone |
| **B. Bluetooth** | the Bluetooth controller | **always** — independent of the WiFi radio | any phone + a free app |
| **C. The wire** | the USB gadget, or the wired NIC | always, if you can touch the device | a laptop + a cable |

**B is the new one, and it is the redundancy that was missing.** The setup WiFi inherits a structural weakness it
cannot engineer away: the Pi has one radio, and it cannot be an access point and a station at once. So the rescue
must take the AP down to re-test the real network, must give the radio back to apply a correction, and leaves a
gap whenever an activation fails. Every one of those windows is a moment where someone looks at their phone, sees
nothing, and concludes the device is dead. Bluetooth is a separate controller with its own link layer — it is
reachable while the WiFi radio is scanning, associating, failing, hosting the AP, or torn down mid-probe.

All three doors lead to the **same engine**. The Bluetooth service never drives `nmcli`; it writes a request file
and `wifi-recovery.js` applies it through the same code path as the captive portal. One radio, one owner. That is
what keeps the never-strand teardown order, the captive-portal outcome and the duplicate-profile cleanup
identical no matter which door was used.

### A. Setup WiFi (unchanged for the technician)

1. Join `AutoPost-Setup-XXXX` (password: the fleet setup password).
2. The setup page opens by itself. If it does not, browse to `http://10.42.0.1`.
3. Pick the network, type the password, tap Connect.

### B. Bluetooth — the new redundant path

The device advertises as **`AutoPost-Setup-XXXX`** — deliberately the same name as the rescue WiFi network, so
there is never a question of whether they are the same box. It advertises whenever the unit is not online, plus
for 15 minutes after every boot.

**On Android or a laptop** — open `ble-setup-page.html` (see *Hosting the page* below), tap **Find nearby
AutoPost devices**, and fill in the form. One tap, same look as the WiFi portal.

**On iPhone or iPad** — iOS has no Web Bluetooth in any browser, so the page will not work there. Use the free
**nRF Connect** or **LightBlue** app instead. This is why the protocol is designed to be typeable by hand:

1. Scan, connect to `AutoPost-Setup-XXXX`.
2. Open the service beginning `a5f10000`.
3. Write this **text** (UTF-8) to the characteristic ending `0003`:

   ```
   setupcode|TheWiFiName|ThePassword
   ```

4. Read the characteristic ending `0001` for status, `0004` for how the attempt went.

The **setup code** is either the fleet setup password (the same one that opens the rescue WiFi) or the
per-device code — the last 6 hex characters of the board serial. Three wrong codes buys a 30-second lockout.

If the WiFi name or password contains a `|`, the typed form cannot represent it — use the web page (which sends
JSON) or the setup WiFi portal instead.

#### Characteristic map

| UUID ends | Name | Access | Content |
|---|---|---|---|
| `0001` | STATUS | read, notify | JSON: online, connectivity, phase, ssid, mac, lastError |
| `0002` | NETWORKS | read | JSON: the cached scan |
| `0003` | CREDENTIALS | write | `code\|ssid\|password`, or JSON `{code,ssid,password,identity,hidden}` |
| `0004` | RESULT | read, notify | JSON: outcome of the last request |
| `0005` | LOG | read | text: the rolling diagnostic ring |
| `0006` | COMMAND | write | `code\|scan` or `code\|recheck` |

Service UUID: `a5f10000-4e7a-4c2b-9d1f-6b0e2c7a9d31`; each characteristic shares that suffix.
**These are fixed for the life of the product** — a client that knows them must keep working against every
future firmware, so they are never to be regenerated.

Notifications are truncated to 20 bytes on purpose: a notification is capped at the connection MTU and the
device cannot know it, so a notification means *"something changed, read me"*. Always re-read the
characteristic for the real value.

### C. The wire — the one that cannot be broken by a radio

The rescue portal is bound to `10.55.0.1` permanently, from the moment the daemon starts — it is not part of the
AP lifecycle at all. **Both modes reach it at the same address**; only the cable differs.

**WiFi-mode card** (USB gadget): plug a laptop into the Pi's **USB DATA** port (marked `USB`, not `PWR IN`).

**Wired-mode card**: run a patch cable from the Pi's USB-ethernet adapter straight into the laptop.

Then, either way:

1. Set the laptop's new network adapter to `10.55.0.2 / 255.255.255.0`.
2. Browse to **`http://10.55.0.1`** — same setup page.
3. **`http://10.55.0.1/log`** is the diagnostic log. This is how a returned unit gets diagnosed on the bench
   instead of being reflashed, which destroys the evidence.

---

## Part 3 — finding out what a unit actually did

Every decision the rescue makes now lands in a bounded on-disk ring at
`/var/lib/autopost/runtime/recovery-log.txt`, reachable four ways:

- `http://10.55.0.1/log` over the USB cable — **works with no radio at all**
- `http://10.42.0.1/log` on the rescue WiFi
- the `0005` characteristic over Bluetooth
- `sudo cat /var/lib/autopost/runtime/recovery-log.txt` over SSH/Tailscale

Machine-readable state sits alongside it:

| File | Written by | Contains |
|---|---|---|
| `wifi-recovery.json` | wifi-recovery.js | the original shape, unchanged — VERIFY-PI and the dashboard parse this |
| `wifi-status.json` | wifi-recovery.js | the richer status the off-band channels read |
| `wifi-scan.json` | wifi-recovery.js | the last cached scan |
| `wifi-request.json` | the Bluetooth service | a pending credential request |
| `wifi-result.json` | wifi-recovery.js | how the last request went |

Requests are idempotent by `id` and the last consumed id is persisted, so a service restart cannot replay a
correction and knock a now-working box back off its network.

---

## Part 4 — what to change on the bench

**Do not power-cycle a card out of AP mode as the last thing you do.** With the `--temporary` fix this is no
longer destructive, but the habit is worth dropping anyway: a card unplugged mid-rescue leaves a stale
`autopost-setup-ap` profile, which `pi-verify.sh` now reports as a warning so you can tell it happened.

**Run `pi-verify.sh` before boxing.** It now hard-fails on the exact condition that caused this:

```
FAIL wifi-autoconnect-on-disk :: profile(s) autopost-dealer-0.nmconnection have autoconnect=false -
     this unit will NOT join the customer WiFi on arrival.
```

and it checks the Bluetooth channel is genuinely registered with BlueZ, not merely that the unit is running:

```
PASS svc-active:autopost-ble-setup
PASS bt-adapter-up
PASS bt-gatt-registered
```

A unit that passes has **two** independent ways home. A unit with `bt-gatt-registered` warning has one.

---

## Hosting the Web Bluetooth page

`ble-setup-page.html` is entirely self-contained — no fonts, scripts or images from anywhere — so it can go on
any static host. Web Bluetooth requires a **secure context**, so it must be served over `https://`
(or opened as a local `file://` on a desktop, which also counts). Serving it over plain `http://` produces a
page that looks fine and can never connect; the page detects that case and says so explicitly rather than
letting someone in a service bay retry forever.

---

## Rebuilding and shipping this

1. `tools\RUN-TESTS.cmd` — 76 assertions cover the rescue, including a regression test for each of the five
   field failures above. (`pi-model.test.js` and `batch.test.js` need `npm install`; they require `electron`.)
2. Rebuild the golden image: `deploy/pi/golden/customize-stock-image.sh`. It now hard-asserts the Bluetooth
   channel is present, its packages are installed, the D-Bus policy is in place, the Python compiles under the
   image's own interpreter, and `config.txt` does not disable the Bluetooth radio.
3. Flash one card, run `pi-verify.sh --ap`, then `tools\PROMOTE-GOLDEN.cmd`.

The stale pi-gen stage at `golden/stage-autopost/` now refuses to run: it never installed the WiFi rescue and
does not install the Bluetooth one either, so an image built from it would look completely normal right up
until the day it mattered.
