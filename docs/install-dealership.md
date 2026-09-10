# Installing AutoPost — dealership guide

AutoPost is a small always-on app that connects your dealership so your sales reps'
Facebook listings post from **your own internet connection** (your real local IP), which
Facebook trusts. Install it once on any office PC. It runs quietly in the system tray.

## Install

1. **Download** the `AutoPost Setup` file your account manager sends you, and double-click it.

2. **If Windows SmartScreen says "Windows protected your PC"** — this is normal for a newly
   published app, not a problem. Click **More info → Run anyway**.

   > The upcoming code-signed release shows **"Verified publisher: QuantumConnect AI"** and
   > skips this warning entirely. Until then, "Run anyway" is expected and safe.

3. **Follow the wizard** (Next → Install → Finish). It installs to Program Files, adds a
   desktop shortcut, and registers itself to **start automatically** when the PC boots or the
   user logs in.

4. **Sign in** with the username + password your account manager gives you. Done — the app
   moves to the system tray and keeps your connection live.

## Everyday use

- **It does NOT need to be "open."** AutoPost works entirely in the background from the **system tray**
  (bottom-right, by the clock — it may be hidden under the `^` arrow). The connection runs whether the window
  is open, closed, or never opened at all — there is **no taskbar button, and that is normal**. Nobody has to
  open it, click it, or keep a window on screen. Installed-but-never-run is the *only* state that doesn't work;
  it starts itself, so that won't happen.
- **Clicking the window's X** just minimizes it to the tray; it keeps running. To fully stop
  it, right-click the tray icon → **Quit**.
- It **starts on its own** every time the PC boots or the user signs in (starts hidden in the tray).
- The dashboard shows your connection, location, speed, and reps. A green **Connected** badge
  means everything is working.

## Good to know

- **One AutoPost per PC.** If a copy is already running, a second copy closes itself
  automatically (this is why it won't launch on a machine that's already running the app).
- **Keep the PC on** (or set to never sleep) during business hours so posting stays live —
  if the app is off, that dealership's posting pauses until it reconnects (fail-closed by design).

---

## How a rep's Facebook stays on the dealership's IP (for the operator)

Every rep's Facebook should always ride the **dealership's** internet — both when you log
them in and when the system posts. Then Facebook only ever sees one steady location.

- **NodeMaven reps (today):** the rep's GoLogin profile uses a public proxy address like
  `gate.nodemaven.com`. Open it from anywhere and GoLogin hops through that provider's
  computer in the rep's market first, so Facebook sees that market.
- **Dealership tunnel reps:** the AutoPost app turns the dealership's own internet into an
  address you point the rep's GoLogin profile at — think of it as the dealership's private
  NodeMaven. Same flow, but the hop is the dealership's real business connection.

**To connect a new rep:** create the rep's GoLogin profile → set its proxy to the
dealership's tunnel address (or NodeMaven) → open it in GoLogin Desktop and sign into
Facebook once. Because the connection hops through the dealership first, you're logging in as
if you're sitting at the dealership, and the system posts through the same address afterward.
