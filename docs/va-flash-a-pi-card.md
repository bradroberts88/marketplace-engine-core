# How to Flash a Setup Card for a Dealership Pi (VA Guide)

This is the full, click-by-click guide for preparing a **microSD card** that goes into a dealership's Raspberry
Pi. You do this on the setup laptop. When you finish, you eject the card, put it in the Pi, and ship the Pi.

You do **not** need to understand any of the technology. Follow the steps. If a popup appears, check the
**"Popups you might see"** table near the bottom — most of them you simply **Cancel**.

---

## What you need before you start

- [ ] The **AutoPost — Set up a Pi** app installed on the laptop (icon on the desktop).
- [ ] A **microSD card** (32 GB) in the **USB card reader**, plugged into the laptop.
- [ ] The **setup code** for this dealership (from the *Ship a Pi* page). It looks like `K7QP-3M2R`.
- [ ] The dealership's **WiFi name and password** (get these from the dealership). It **must have a 2.4GHz band** — the Pi does not connect to 5GHz-only networks (rare, but confirm up front).
- [ ] Which **Raspberry Pi model** and **US state** the Pi is going to (for the timezone).

> If you were given a card that already has something on it, that's fine — flashing **erases and replaces**
> everything on the card.

---

## Step by step

### 1. Open the app
Double-click **AutoPost — Set up a Pi**. You'll see a dark window with **4 numbered steps**.

### 2. Enter the dealership & setup code (Step 1 in the app)
- **Dealership**: type the dealership name (this is just a label, e.g. `Merchant Auto`).
- **Setup code**: paste the code from the Ship a Pi page (e.g. `K7QP-3M2R`).

### 3. Enter the WiFi (Step 2 in the app)
- **Must be a 2.4GHz WiFi.** The Pi only joins **2.4GHz** (not 5GHz). Most routers broadcast both under the same name, which is fine. If the dealership is **5GHz-only**, use a 2.4GHz network or a phone hotspot set to 2.4GHz instead. Rare, but the Pi cannot connect to a 5GHz-only network at all (and 2.4GHz is more reliable for 24/7 use).
- **Network name (SSID)** and **Password**: the dealership's WiFi.
- **Backup network (optional)**: if they gave you a second network (like a phone hotspot), add it. Otherwise
  leave it blank.
- **WiFi country**: pick **United States** (or **Canada** if the Pi will run in Canada).
- **Timezone**: pick the dealership's timezone (e.g. **Eastern US (New York)**, **Central US (Chicago)**, etc.).
- **Pi login**: leave the user as **`admin`** and set a **password** (write it down / keep it in the dealership
  record). This is only for support access — the Pi runs headless with no monitor. The card boots straight
  through on its own; it will **not** ask anyone to set up a login.

### 4. Pick the SD card (Step 3 in the app)
- Make sure the card + reader are plugged in.
- Click **Scan for cards**.
- The card appears as a line like **"Mass Storage Device · 32 GB · USB"**. Click it — it turns **green**.

> **Safety:** the app will only ever show removable cards. **The laptop's own drive can never appear here**, so
> you cannot pick the wrong drive. If nothing appears, re-seat the card and click **Scan for cards** again.

### 5. Preview first (recommended)
- Leave **Dry run** ON.
- Click **Preview (dry run)**. This writes **nothing** — it just shows you the WiFi and setup files that will
  be put on the card, so you can eyeball that the WiFi name and code look right.

### 6. Flash the card
- Turn **Dry run OFF** (uncheck it). The red **Erase + Flash** button lights up.
- Click **Erase + Flash**.
- A confirmation appears naming the card → click **ERASE + FLASH**.
- A **Windows security prompt** appears (see popups below) → click **Yes**.

### 7. Wait for it to finish (a few minutes)
The progress bar climbs through **writing → verifying → injecting**, then you see a green message:

> **Card written + verified. Boot files injected at F:\. Safe to eject and put in the Pi.**

**Do not pull the card until you see that green "done" message.**

### 8. Eject and ship
- Right-click the card's drive in **File Explorer** → **Eject** (or use the taskbar "Safely Remove Hardware").
- Take the card out, put it in the **Pi**, and prepare the Pi for shipping.

---

## Popups you might see (and what to do)

| Popup | When | What to do |
|---|---|---|
| **"Do you want to allow this app to make changes to your device?"** (Windows security / UAC) | When you click **Erase + Flash** | Click **Yes**. This is required — writing a card needs permission. |
| **"You need to format the disk in drive X:"** or **"Format USB Drive (X:)"** | During or right after the write | Click **Cancel** (and the **X** to close). **NEVER click Format / Start** — the card is being written correctly, Windows is just confused for a moment. |
| **"Please insert a disk into USB Drive (X:)"** | During or right after the write | Click **Cancel**. Same thing — Windows momentarily loses track of the card while it's being rewritten. Harmless. |
| A **Raspberry Pi Imager** window flashes up | Rarely, during the write | Leave it alone; it closes by itself. Do not click inside it. |
| **"Windows protected your PC" (SmartScreen)** | First time you open the app | Click **More info → Run anyway**. |

> **Rule of thumb:** the only button you ever click **Yes / Allow** on is the **Windows security prompt** in
> Step 6. Every other popup during the flash, you **Cancel**.

---

## If something goes wrong

- **The card doesn't show up when you Scan** → unplug and re-plug the reader, wait 5 seconds, click **Scan for
  cards** again.
- **The flash shows a red error message** → read it, click the card again, and **retry** (a card can always be
  re-flashed, nothing is broken). If it fails twice with the same error, copy the message and send it to your
  manager.
- **You picked the wrong dealership code or WiFi** → no problem, just fix Step 1/Step 2 and flash again.
- **You're not sure it finished** → only trust the green **"Card written + verified"** message. If you don't see
  it, don't ship the card — flash again.

---

## What this card does (for your understanding)

When the Pi is powered on with this card:
1. It boots up and joins the dealership's WiFi automatically.
2. It reads the setup code and connects itself to AutoPost.
3. From then on it runs on its own — no keyboard, no screen needed.

That's why getting the **WiFi** and the **setup code** right in Steps 2–3 is the important part.

---

## If the WiFi was entered wrong — the device fixes itself with a phone (no re-flash needed)

If the WiFi name or password was wrong, the device can't get online — and because it's headless (no screen), you
can't just log in and fix it. So the device has a **built-in rescue** the dealership can do on their own:

1. Power the device on and wait about **7 minutes**. (It waits ~2 minutes after power-on, then ~5 minutes of no
   internet — so it never pops up if the real WiFi is just slow to connect.) When it stays offline, it creates its
   **own** WiFi network called **`AutoPost-Setup`** (with a few characters after it, e.g. `AutoPost-Setup-6373`).
2. On a **phone**, open WiFi settings and join **`AutoPost-Setup`**. When it asks for a password, enter:
   **`autopost212`** (iOS may label the network "Weak Security" — that's normal, ignore it.)
3. A setup page opens by itself. (If it doesn't pop up, open a browser and go to **`http://10.42.0.1`**.)
4. Pick the correct WiFi from the list, type its password, tap **Connect**.
5. The phone drops the `AutoPost-Setup` network — that's normal. The device joins the real WiFi and comes online.
   If the password was still wrong, `AutoPost-Setup` reappears in about a minute to try again.

> **Ship the password with the unit.** `autopost212` is the same on every device — put it on the device/box (or
> the dealership's setup card) so whoever is on-site can join `AutoPost-Setup`. It only ever matters if the WiFi
> was wrong; a correctly-set device never shows this network.

### Checking it worked (support / with a monitor + keyboard)
Log in at the `raspberrypi login:` prompt with user **`admin`** and the Pi password set at flash time, then run:

- `nmcli device status` — `wlan0` should say **connected** to the dealership's network
- `nmcli connection show --active` — lists the active WiFi connection
- `ping -c 4 8.8.8.8` — **0% packet loss** means the device is on the internet
- `hostname -I` — shows the device's IP (a real address, not `127.0.1.1`)

**To disconnect / forget a WiFi from the terminal** (there's no cable to unplug — WiFi is managed by software; use this to
re-test recovery, since forgetting the network makes the device go offline again):

- `nmcli connection show` — lists ALL saved WiFi networks by name
- `sudo nmcli connection delete "<name>"` — **forgets** a WiFi: the device disconnects and will NOT rejoin (names look
  like `autopost-wifi-Rogersxy`). After this it goes offline, and `AutoPost-Setup` returns after the grace window.
- `sudo nmcli connection down "<name>"` — just disconnect for now (keeps it saved; autoconnect may bring it back)

To watch the recovery service live: `journalctl -u autopost-wifi-recovery -f`  ·  its status: `sudo systemctl status autopost-wifi-recovery`

The `raspberrypi login:` prompt on the console is **normal** for a headless device — nobody needs to log in for it
to work; everything runs in the background. The timing above is tunable via the service env
(`WIFI_RECOVERY_BOOT_GRACE_MS` / `WIFI_RECOVERY_OFFLINE_GRACE_MS`).
