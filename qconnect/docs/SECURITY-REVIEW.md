# QConnect security review — findings and what closes them

Transcribed from `QConnect_Supabase_Security_Review_and_Hardening_Patch.pdf`, with the current
status of each finding against the SQL in `../supabase/`.

## Finding 1 — the offline view could leak to the public key (critical)

Supabase grants read access on new objects in `public` to the anon and authenticated roles by
default, and a Postgres view runs with its owner's rights, bypassing row level security on the table
underneath. `qconnect_offline` was therefore readable by anyone holding the anon key, exposing
device ids, dealer ids, Tailscale addresses and last-seen times.

**Status: closed.** `01` revokes anon and grants only authenticated. `02` re-applies the same rule to
the new `qconnect_fleet` view and adds the dealer filter *inside* both views.

## Finding 2 — open self-registration (high)

Registration used to let any unregistered device claim any unused device id, first write wins. The
anon key ships on every card, so anyone extracting it could flood the table or squat ids.

**Status: closed.** Registration only succeeds against a row that already exists with a matching
token. Preregistration is service-role only and is a mandatory flashing step, not an optional one.

## Finding 3 — a stolen SD card (high, not SQL)

After first boot, `provision.json` lives on the ext4 partition. The device token is a one-device
blast radius and the anon key is public by definition, but the Tailscale pre-auth key would let a
thief join your tailnet from their own machine.

**Status: partly closed — the rest is operational.**

- Closed in code: `device/qconnect-setup.sh` overwrites the key with `REDACTED-AFTER-JOIN` right
  after a successful join. Tailnet membership persists in tailscaled's own state.
- **You must do:** create QConnect keys as `tag:qconnect` with a 90-day expiry, and write ACLs so
  those nodes can reach only your control endpoints — never each other, never your admin machines.
- **You must do:** rotate the batch key and delete the node when a device is reported stolen.

## Finding 4 — kill switch open to every logged-in user (medium)

**Status: closed in `02`.** `qconnect_set_enabled` raises `not authorized` unless the caller's signed
token carries `app_metadata.role = 'admin'`, which users cannot edit. Every call writes the actor,
the device and the action to `qconnect_audit`. Hiding the button in the interface is cosmetic on top
of this.

## Finding 5 — token storage and error hygiene (low)

**Status: closed in `03`.** Only `sha256(token)` is stored. The plaintext column is emptied during
the migration and kept nullable so nothing breaks. Devices are unchanged — they still send the plain
token and the database fingerprints it on arrival.

Registration errors reveal nothing useful now that unknown devices are rejected identically, and
Supabase's own API rate limits cover the register RPC at this fleet size.

## Already right, left alone

- Row level security enabled with zero policies on the devices table: direct table reads with the
  anon or authenticated key return nothing, in any client.
- All writes flow through SECURITY DEFINER RPCs with a pinned `search_path` and a per-device token
  check.
- The dashboard reads a token-free view, so no device credential ever reaches a browser.
