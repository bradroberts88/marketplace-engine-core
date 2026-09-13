# QConnect bench runbook — one card, start to finish

> Received a box rather than building one? Start with the plain-English
> [owner's guide](../../docs/PI-OWNERS-GUIDE.md) instead — this runbook is for
> the bench.

Print this. Do one card at a time. Every step has an expected result; if you
don't see it, stop and follow the "if it doesn't match" line before moving on.
Tick each step on the Bench page in the fleet app as you go.

Time per card once you're in a rhythm: about 12 minutes, plus flashing.

---

## Before you start (once per batch)

- [ ] A laptop with the SD card reader and the `qconnect/flash` folder.
- [ ] The golden image file for the model you're doing
      (`autopost-golden-zerow.img.xz` for Pi Zero 2 W, `autopost-golden.img.xz` for Pi 4).
- [ ] Wi-Fi name and password for the bench network. Note whether it is 2.4 GHz.
      A Pi Zero 2 W cannot see a 5 GHz-only network.
- [ ] An Ethernet cable on a live port (Pi 4 only — the Zero has no socket).
- [ ] An activated AT&T SIM per card that needs cellular, plus the USB modem.
- [ ] Your fleet app open on the Bench page.

---

## Phase 1 — Prepare the card

1. Insert the SD card.
2. Run the prep script:

   ```
   ./qconnect/flash/provision-sd.sh --label "BENCH-001" --model zerow \
     --wifi-ssid "<bench wifi>" --wifi-pass "<password>" \
     --cell-apn broadband
   ```

3. **Expected:** the script ends with `pre-registered OK` and the card now
   appears in the fleet app with status *Awaiting first boot*.

   **If it doesn't match:** the card is not registered and will never connect,
   no matter how good the network is. Do not flash it. Re-run the script and
   read the error — usually the backend credentials aren't set in your shell.

4. Eject the card.

- [ ] Phase 1 pass

---

## Phase 2 — First boot on wireless

1. Put the card in the Pi. No Ethernet, no modem. Power on.
2. Wait up to 4 minutes.
3. **Expected:** in the fleet app the card turns **online**, connection shows
   **Wi-Fi**, and the bench timeline ticks *power on*, *network up*,
   *tunnel up*, *registered*, *first heartbeat*.

   **If it stays offline:**
   - Check the bench network is 2.4 GHz if this is a Zero 2 W.
   - Bring a phone near the Pi, join the `QConnect-Setup` network it puts up,
     and open the setup page. It lists the last few connection attempts in
     plain words — read the reason there.
   - `wifi_bad_password`, `wifi_not_found`, `no_dhcp` each mean exactly what
     they say. Fix and press Retry on that page.

4. Record the signal strength shown in the app (anything below 25% at the
   bench will be worse at the dealer).

- [ ] Phase 2 pass

---

## Phase 3 — Ethernet (Pi 4 only; skip for Zero 2 W)

1. Plug in the Ethernet cable while the Pi is running.
2. Wait 60 seconds.
3. **Expected:** the connection in the app flips to **Ethernet** and the card
   stays online without a gap in check-ins.

   **If it doesn't match:** unplug and replug; if still nothing, the port or
   cable is dead — try a known-good port before blaming the card.

4. Unplug the cable.
5. **Expected:** within 90 seconds the connection falls back to **Wi-Fi** and
   the card is still online.

- [ ] Phase 3 pass (or marked N/A for Zero 2 W)

---

## Phase 4 — Cellular on the AT&T SIM

1. Power the Pi down. Insert the SIM into the modem, plug the modem in,
   power back up.
2. Wait up to 5 minutes — first registration on the tower is the slow one.
3. **Expected:** the app shows the modem present, SIM **ready**, registered on
   the network, APN `broadband`.

   **If it doesn't match:**
   - `cellular_sim_locked` — the SIM has a PIN. Clear the PIN, or enter it on
     the setup page.
   - `cellular_sim_disabled` — the line isn't activated with AT&T yet.
   - `cellular_no_tower` — move the Pi and antenna away from metal and
     retry; a bench inside a steel shop is often the whole problem.
   - Registered but no data — change the APN on the setup page to
     `m2m.com.attz`, then `att.mvno`, then `nxtgenphone`, retrying each.

4. Now turn off the bench Wi-Fi (or unplug the access point).
5. **Expected:** within 3 minutes the connection shows **Cellular** and the
   card is still online and checking in.
6. Turn the Wi-Fi back on.
7. **Expected:** within 3 minutes it returns to **Wi-Fi** — cellular is the
   fallback, not the default, because it costs money per megabyte.

- [ ] Phase 4 pass

---

## Phase 5 — Prove it can be fixed remotely

1. In the fleet app, on this card, press **Reconnect**.
2. **Expected:** within two check-ins the card reports the command done and
   comes back online.
3. Press **Send diagnostics**.
4. **Expected:** a fresh diagnostics entry appears on the card's page.

- [ ] Phase 5 pass

---

## Phase 6 — Label and box

1. Write the card's label on the case with a marker. It must match the label
   in the app exactly.
2. On the Bench page, press **Mark card ready**.
3. **Expected:** the card's bench run shows all steps green and the status
   becomes *Ready to ship*.

- [ ] Phase 6 pass

---

## Go / no-go

Ship the card only when phases 1, 2, 4, 5 and 6 are all green
(phase 3 too, on a Pi 4). Any red step means the card goes back on the bench —
a card that half-works at the bench never works at a dealer.

---

## The five things that cause almost every failure

1. **The card was never pre-registered.** Phase 1 catches this. It used to be
   a line of SQL you had to paste by hand, which is why some cards worked and
   some never could.
2. **A shared join key.** Each card now gets its own one-time secret; don't
   copy one card's prepared files onto another card.
3. **5 GHz-only Wi-Fi at the dealer.** A Zero 2 W simply cannot see it. Ask
   before you ship.
4. **Powering the Pi from a phone charger that sags.** Use a proper 5 V 2.5 A
   supply; brownouts look exactly like network faults.
5. **A SIM that was never activated.** Check phase 4 shows SIM *ready*, not
   just *present*.
