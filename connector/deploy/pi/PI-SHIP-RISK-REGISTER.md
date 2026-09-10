# Pi shipping risk register (from the 2026-07-14 deep analysis: 12 domains, 175 risks, 24 gates verified)

## Executive finding
The connector SOFTWARE is genuinely strong (half-open detection, planned pre-cap reconnect, self-heal,
crash-loop rollback). The danger is almost entirely **hardware / OS / storage at ship time**, on a device we can
never recall. Two silent killers dominate:
1. **Overlay eviction → permanent brick.** `/var/lib/autopost` is on the rootfs; enabling overlay makes the first
   power cut evict the one-time claim token → the device can't re-claim. **Fix = golden image with a baked
   AUTOPOST-DATA partition** (see GOLDEN-IMAGE-SPEC.md). `selftest.sh` now hard-blocks shipping without it.
2. **Field telemetry was dead** — the agent runs as `autopost` (not in `video`), so `vcgencmd` failed silently.
   **Fixed:** `usermod -aG video autopost` in install.sh + telemetry in every heartbeat + a `telemetry_as_service_user`
   ship gate.

## Pre-ship BURN-IN gates (any CRITICAL fail = DEFECTIVE, do not ship) — implemented in selftest.sh
| Gate | Pass condition |
|---|---|
| power_undervoltage | `get_throttled` == 0x0 after a reboot + 120s CPU+SD+WiFi soak (bit16-only → reboot & re-soak) |
| card_counterfeit *(bench, pre-flash)* | `f3probe` "Good news" + usable ≥ 93% of labeled capacity |
| card_surface_soak *(bench)* | `f3write/f3read` 0 mismatches; on-Pi 30-min write/verify; 0 mmc/EXT4 dmesg errors |
| ram_integrity | `memtester 200M` + `stress-ng --vm --verify` 0 failures (soldered RAM → whole board defective) |
| thermal_under_load | peak **< 70°C** under 2-min stress + no soft-temp throttle + fan physically spins |
| **data_partition_persistent** | `/var/lib/autopost` is a SEPARATE ext4/f2fs partition, writable as autopost (not rootfs) |
| **telemetry_as_service_user** | `sudo -u autopost vcgencmd get_throttled` returns a number |
| clock_ntp | **CRITICAL** — NTPSynchronized + a reachable source (no-RTC Pi + bad clock = TLS brick) |
| connector_service / agent_loads | service enabled+active + `agent.js --selftest` == selftest-ok + ws resolves |
| tailscale_offlan_reach | an OFF-LAN admin node can `tailscale ssh` in (else we can't recall it) |
| hub_connected_and_egress | Live on the hub + one geo-checked test post egressing the **dealership IP** |
| eeprom_current / os_arch / kernel_clean | EEPROM up-to-date, aarch64, no panics |
| crlf_clean | no CR in shipped scripts/units (Windows-checkout guard: .gitattributes + install.sh self-strip) |
| overlay_active + power_cut_persistence_canary *(bench, Phase 2)* | overlay on; config + claim + update marker + WiFi survive **2 hard power cuts**, back Live < 180s, no re-claim |

## Field telemetry each shipped agent sends (implemented / to-extend)
throttled (full 20-bit, OR-accumulated hub-side), tempC (+ 7-day baseline trend), **rootfsOverlay**,
**dataWritable**, diskFreeMb, memFreeMb, uptime, rssMb — *to add:* agentVersionSha (on-disk, not cfg),
clockSynced, publicEgressIp (CGNAT/rotating-IP flag), activeInterface + wifiSignalDbm, eMMC life-time, lastBootReason.
The hub raises a de-duped **health-alert** on undervolt / overheat / throttle / low-disk / lost-overlay / read-only-storage.

## Build order (priority)
- **P0** Golden master image (baked AUTOPOST-DATA partition + overlay ON + EEPROM pinned) — GOLDEN-IMAGE-SPEC.md. *(needs a pi-gen/CustomPiOS CI image + a real Pi to certify — the gating item for PAID ships.)*
- **P0 DONE** video-group telemetry fix; telemetry in every heartbeat; selftest data-partition + service-user gates.
- **P0** Hub certification gate: refuse "Mark shipped" unless burnin && overlay && canary all passed (extend the store + provisioning page).
- **P1 DONE (partial)** selftest hardening (clock critical, thermal 70C, agent-loads, eeprom, data-partition). *To add:* f3 card screen, storage soak, off-LAN Tailscale + real-egress gates (need bench + a real Pi).
- **P1** pre-ship-overlay-check.sh (the 2× power-cut canary harness).
- **P2** claim self-recovery (re-issue a consumed code); set-wifi hidden/enterprise; agent durable-write hardening; adaptive plannedReconnectMs + captive-portal probe.

## Open questions for the operator
1. **CM4/eMMC vs microSD for the first paid ships?** eMMC deletes the counterfeit-card / wear / partition / canary
   class entirely. Hold paid ships for CM4, or ship microSD interim with all card gates mandatory?
2. Does the burn-in bench get a **smart plug** to automate the 2× power-cut canary (vs a VA pulling power)?
3. Golden image via **pi-gen/CustomPiOS in CI** — who builds + maintains it?
4. **Off-LAN Tailscale** admin node with a tagged, non-expiring key — provisioned?
5. Should the hub **re-issue a consumed claim** (self-healing fleet) or is on-site re-provision acceptable (truck-roll on any identity loss)?
