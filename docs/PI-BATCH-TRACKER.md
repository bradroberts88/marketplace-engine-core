# Pi batch tracker — wireless, cable and AT&T cellular

Print this page and keep it on the bench. One row per card. Work through the
three ways of getting online in the order below, because each one rules out a
different fault. The same results appear by themselves on the Bench page of the
fleet dashboard as each card checks in, so you never have to type them twice —
this sheet is for the bench, the dashboard is the record.

## How to run one card

1. Write the card, put it in the Pi, note the card name from the sticker.
2. **Cable first.** Plug in an Ethernet cable, then power. Within two minutes the
   card should appear online on the dashboard. This proves the card itself is
   good.
3. **Then Wi-Fi.** Unplug the cable, power-cycle, join the `QConnect-Setup`
   network, enter the office Wi-Fi details. Expect online again within two
   minutes.
4. **Then cellular.** Unplug the cable, fit the AT&T SIM, power-cycle, leave it
   ten minutes. Expect online with a mobile connection.
5. Tick or cross each of the three boxes, and write the reason shown on the
   dashboard next to any cross.

A card is ready to ship when cable and at least one of Wi-Fi or cellular pass.
A card that fails **cable** does not go out at all — that is the card, not the
site.

## Tracker

| # | Card name | Date | Run by | Cable | Wi-Fi | AT&T SIM | Reason if failed | Ship? |
|---|---|---|---|---|---|---|---|---|
| 1 |  |  |  | ☐ | ☐ | ☐ |  | ☐ |
| 2 |  |  |  | ☐ | ☐ | ☐ |  | ☐ |
| 3 |  |  |  | ☐ | ☐ | ☐ |  | ☐ |
| 4 |  |  |  | ☐ | ☐ | ☐ |  | ☐ |
| 5 |  |  |  | ☐ | ☐ | ☐ |  | ☐ |
| 6 |  |  |  | ☐ | ☐ | ☐ |  | ☐ |
| 7 |  |  |  | ☐ | ☐ | ☐ |  | ☐ |
| 8 |  |  |  | ☐ | ☐ | ☐ |  | ☐ |
| 9 |  |  |  | ☐ | ☐ | ☐ |  | ☐ |
| 10 |  |  |  | ☐ | ☐ | ☐ |  | ☐ |
| 11 |  |  |  | ☐ | ☐ | ☐ |  | ☐ |
| 12 |  |  |  | ☐ | ☐ | ☐ |  | ☐ |
| 13 |  |  |  | ☐ | ☐ | ☐ |  | ☐ |
| 14 |  |  |  | ☐ | ☐ | ☐ |  | ☐ |
| 15 |  |  |  | ☐ | ☐ | ☐ |  | ☐ |
| 16 |  |  |  | ☐ | ☐ | ☐ |  | ☐ |
| 17 |  |  |  | ☐ | ☐ | ☐ |  | ☐ |
| 18 |  |  |  | ☐ | ☐ | ☐ |  | ☐ |
| 19 |  |  |  | ☐ | ☐ | ☐ |  | ☐ |
| 20 |  |  |  | ☐ | ☐ | ☐ |  | ☐ |

Copy the block for a bigger batch.

## What a failure means, in plain words

These are the exact words the dashboard uses, so you can match them without
guessing.

| The dashboard says | What it means | Do this |
|---|---|---|
| Connected | Nothing wrong | Tick and move on. |
| Wi-Fi password was not accepted | The password typed on the setup page is wrong | Rejoin `QConnect-Setup` and type it again, watching for capitals. |
| Wi-Fi network not found | The card cannot see that network name | Check the name for typos; move the card nearer the access point. |
| Wi-Fi network not found (this box is 2.4 GHz only) | The office network is 5 GHz and this card's radio cannot reach it | Put the card on the 2.4 GHz network, or use cable or the SIM. |
| Joined the network but there is no internet behind it | It is on the network; the network has no way out | Site firewall or guest network. Try another socket or ask the site. |
| Network shows a sign-in page | A guest network wants someone to click "accept" | Use a normal network, cable or the SIM. |
| SIM is PIN-locked | The SIM asks for a PIN | Remove the PIN in a phone first, then refit it. |
| SIM or modem radio is switched off | The modem is disabled | Power-cycle; if it repeats, the modem needs looking at. |
| Modem cannot see a mobile tower | No AT&T signal where the card is | Move near a window and retry. |
| Modem fitted but no mobile APN set | Card written before the AT&T settings were built in | Rewrite the card with the current writer. |
| Mobile data did not connect | SIM is seen but data will not come up | Check the SIM is activated on the AT&T account. |
| The box network service is not running | Something on the card is broken | Rewrite the card. Do not ship it. |
| No cable, no known Wi-Fi, no modem | Nothing was connected | Expected between steps; not a fault. |
| No Wi-Fi radio found on this box | Hardware without Wi-Fi | Skip the Wi-Fi step; use cable or SIM. |
| (never checked in) | The card never reported at all | Almost always the card was written wrong. Rewrite it and start again. |

## When you are finished

Give the completed sheet, or the Bench page export, to whoever is shipping the
batch. Anything with a cross against **cable** or **never checked in** stays on
the bench.
