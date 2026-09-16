# Setting up two Pi 4s from scratch on a Windows laptop

This is written for someone who has never done this before. Follow it top to
bottom. Do one Pi completely, then do the second one. Allow about an hour for
the first and twenty minutes for the second.

If anything does not match what this page says, stop and read section 10 before
carrying on.

---

## 1. What you are actually doing

Inside each Pi is a little memory card, about the size of a fingernail. That card
holds everything the Pi knows — the system it runs and our software. There is no
other storage. So:

- **Erasing the card erases the Pi completely.** That is the "remove everything"
  step you asked for. Nothing survives it.
- **Putting a fresh card back in gives you a brand-new Pi.** Then we add our
  files, and the Pi sets itself up the first time you switch it on.

You do all of this on your laptop with the card out of the Pi. You never type
anything into the Pi itself.

One thing to get out of the way: the USB-C lead you have is the **power** lead.
It is not how you set the Pi up. Everything below happens through the memory card.

---

## 2. What you need on the table

- The two Pi 4s.
- The memory card out of each one (section 3 shows you how).
- Your laptop's card slot, or the small USB card adapter.
- The power supply for each Pi.
- A network cable, if the place they will live has a spare socket on the router.
  This is optional, but it is the easiest way to get a Pi online.
- The Wi-Fi name and password for where they will live, if you know it.
- The QConnect folder on your laptop (the one with a `flash` folder inside it).

The SIM cards are already inside the Pis. Leave them there.

**Before you start, one thing has to be switched on at our end:** the fleet
system that hands each card its one-time registration ticket. If that has not
been done yet the preparation step in section 6 will stop and tell you so — it
will not write a card that cannot register. Ask us to switch it on and then carry
on from section 6.

---

## 3. Getting the memory card out

1. Unplug the Pi from power. Never remove the card while it has power.
2. Turn the Pi over. On the underside, on the edge next to the USB-C power
   socket, there is a thin slot with the card sticking very slightly out.
3. Pull the card straight out with your fingernails. On a Pi 4 it just slides —
   there is no click, and nothing needs pressing.
4. Put it in your laptop's card slot, or in the USB adapter and then into a USB
   port.

Windows will probably show one or two "drives" appear, and may offer to format
them. **Say no / close that box.** We are about to erase the card properly in a
moment, but not that way.

---

## 4. Erasing everything off the card

1. If you do not already have it, download **Raspberry Pi Imager** from
   raspberrypi.com and install it. It is free and made by the people who make the
   Pi.
2. Open it. You will see three buttons: device, operating system, storage.
3. Click **Choose OS**, scroll to the bottom, and pick **Erase**.
4. Click **Choose storage**.

   **Stop and read this line.** The list shows every drive it can write to. Pick
   the one that is the size of your memory card (usually 16, 32 or 64 GB) and
   that is not your laptop's own disk. If you are unsure, take the card out,
   look at the list, put it back in, and pick the one that appeared. Choosing
   wrong erases the wrong thing and it cannot be undone.

5. Click **Write**, confirm, and wait. It takes a minute or two.
6. When it says it is finished, leave the card where it is.

The Pi is now completely blank. Everything that was on it is gone.

---

## 5. Writing a fresh system onto the card

Still in Raspberry Pi Imager:

1. Click **Choose device** and pick **Raspberry Pi 4**.
2. Click **Choose OS**, then **Raspberry Pi OS (other)**, then
   **Raspberry Pi OS Lite (64-bit)**. "Lite" is correct — it has no desktop, and
   that is what we want.
3. Click **Choose storage** and pick the same card as before.
4. Click **Next**. If it offers to apply customisation settings, choose
   **No, clear settings**. Our own step does all of that, and two sets of
   settings fighting each other is a common cause of a Pi that never connects.
5. Click **Yes** to write, and wait. Ten minutes is normal. It will verify the
   card afterwards; let it finish.
6. When it says "Write Successful", **do not eject yet**. Take the card out of
   the reader and put it straight back in, so Windows sees the new contents. A
   drive called **bootfs** should appear, about 0.2 GB in size.

---

## 6. Adding our software to the card

1. Open the QConnect folder on your laptop, then the `flash` folder inside it.
2. Right-click **Prepare-Card.ps1** and choose **Run with PowerShell**.
3. It lists the removable drives it can see. Type the letter of the **bootfs**
   drive (usually `E` or `F`) and press Enter.
4. It asks four things:
   - **A short name for this Pi.** Use something you can write on the case, for
     example `QCN-0001` for the first and `QCN-0002` for the second.
   - **Which dealership it is going to.** Whatever short name we agreed for that
     store.
   - **Wi-Fi name**, then **Wi-Fi password.** Press Enter to skip both if you
     don't have them. Fill them in if you can, even if you plan to use a cable —
     it costs nothing and gives the Pi another way to rescue itself later.
   - The SIM is already set up for AT&T; you are not asked about it.
5. It prints a short summary ending with **"This card is ready."**

If it stops with a message in red, nothing was written to the card. Read the
message — it says exactly what is missing — fix that, and run it again.

6. In Windows, right-click the bootfs drive and choose **Eject**, then take the
   card out.

---

## 7. Now the second Pi

Do sections 3 to 6 again for the second Pi, from the start, with its own name
(`QCN-0002`).

**Do not shortcut this by copying the first card.** Each card is issued its own
one-time registration ticket and its own remote-access key. Two cards carrying
the same one means the second Pi will never come online, and it will look
perfectly healthy while failing. The preparation tool refuses to reuse a key, but
it cannot stop you copying a card by hand, so please don't.

---

## 8. First power-on

1. Put the card back in the Pi, contacts facing the board, and push it home.
2. If you are using a network cable, plug that in **now**, before power.
3. Plug in the power.
4. There is a red light and a green light. Red comes on and stays on — that is
   power. Green flickers while it is thinking. On the very first start-up the Pi
   sets itself up and restarts itself once, so the lights go out and come back.
   **This is normal. Give it four minutes and do not unplug it.**

How it gets online, in the order it tries:

- **Network cable** — nothing to do at all. If the cable is live, it uses it.
- **Wi-Fi** — if you typed the details in at section 6, it joins by itself. If
  you didn't, or the password has changed, the Pi puts up its own network called
  **QConnect-Setup-QCN-0001**. On your phone, join it (password `qconnect123`), a
  setup page opens, pick your Wi-Fi, type the password, press Save.
- **The SIM** — if there is no cable and no Wi-Fi, it falls back to the mobile
  network on its own. Give it five minutes; the first connection to a mast is the
  slow one. If the signal is poor, move the Pi near a window and away from metal.

The cable and Wi-Fi are preferred over the SIM on purpose — the SIM costs money
per megabyte, so it is the safety net, not the everyday route.

---

## 9. Checking it worked

Open the fleet dashboard. Within a few minutes of the Pi's first start-up, the
name you gave it should appear in the list and turn **online**, showing which way
it connected — cable, Wi-Fi or cellular.

That is the whole test. If the Pi is in that list and online, it is done, and you
can close the laptop. It updates itself from then on.

Write the name on the case with a marker so the box and the dashboard always
agree.

---

## 10. When something isn't right

| What you see | What to do |
|---|---|
| No lights at all | Push the power plug fully in at both ends and try another socket. A weak phone charger is the single most common cause; use the supply that came with the Pi. |
| Red light on, green never flickers | Power off, take the card out, push it fully back in, power on. If still nothing, the card did not get written — redo sections 4 to 6. |
| It restarted itself once and now sits there | That is normal for the first two minutes. After five minutes, go to the next row. |
| Never appears in the dashboard | Almost always the network. Join the QConnect-Setup network with your phone and open the setup page; it lists the last few attempts in plain words and says which one failed and why. |
| The setup network doesn't appear either | Power off, wait ten seconds, power on, wait four minutes. If it still doesn't, the card is not set up — redo sections 4 to 6 for that Pi. |
| Was online, now offline | Did the Wi-Fi password change? Redo the setup page. On a Pi relying on the SIM, move it near a window. |
| SIM never connects | It may not be activated yet, or it may have a PIN on it. The setup page says which. |

The one rule: **never pull the memory card out while the Pi has power**, and
never let anything reformat it. That is what turns a working Pi into a dead one.

---

## 11. Who to call

**QCAI Support · 1-855-782-6824 · support@quantumconnectai.com**

Have the name you wrote on the case ready — it is the first thing we will ask
for.
