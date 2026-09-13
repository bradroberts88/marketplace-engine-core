-- QConnect 05 — connectivity visibility
-- Makes "why is this box offline?" answerable from the dashboard instead of
-- from an SSH session. The device already sends these fields in p_status
-- (see device/qconnect-heartbeat.sh); this promotes the important ones to real
-- columns so they can be filtered, sorted and alerted on.
--
-- Run AFTER 04. Idempotent, safe on a live fleet.

alter table public.qconnect_devices
  add column if not exists connection_path   text,     -- ethernet | wifi | cellular | hotspot | none
  add column if not exists connection_detail text,     -- SSID, modem operator, interface name
  add column if not exists link_quality      integer,  -- 0-100 where the path can report it
  add column if not exists pi_model          text,
  add column if not exists agent_version     text,
  add column if not exists stuck_step        text,     -- network | tailscale | register | null
  add column if not exists last_error        text,
  add column if not exists first_seen_at     timestamptz;

create index if not exists qconnect_devices_path_idx on public.qconnect_devices (connection_path);
create index if not exists qconnect_devices_stuck_idx on public.qconnect_devices (stuck_step)
  where stuck_step is not null;

-- Heartbeat now unpacks the connectivity fields. Unknown/absent keys leave the
-- previous value untouched rather than blanking it, so one odd beat from a box
-- with a broken sensor does not erase good history.
create or replace function public.qconnect_heartbeat(
  p_device_id text, p_device_token text, p_status jsonb
) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_enabled boolean;
begin
  update qconnect_devices
     set last_seen_at      = now(),
         first_seen_at     = coalesce(first_seen_at, now()),
         last_status       = p_status,
         tailscale_ip      = coalesce(nullif(p_status->>'tailscale_ip', ''), tailscale_ip),
         connection_path   = coalesce(nullif(p_status->>'connection_path', ''), connection_path),
         connection_detail = coalesce(nullif(p_status->>'connection_detail', ''), connection_detail),
         link_quality      = coalesce((p_status->>'link_quality')::int, link_quality),
         pi_model          = coalesce(nullif(p_status->>'pi_model', ''), pi_model),
         agent_version     = coalesce(nullif(p_status->>'agent_version', ''), agent_version),
         -- These two are cleared on purpose when the device reports itself
         -- healthy: they describe the CURRENT problem, not the history.
         stuck_step        = nullif(p_status->>'stuck_step', ''),
         last_error        = nullif(p_status->>'last_error', '')
   where device_id = p_device_id
     and device_token_hash = public.qconnect_token_hash(p_device_token)
   returning enabled into v_enabled;
  if v_enabled is null then
    raise exception 'rejected';
  end if;
  return v_enabled;
end;
$$;
grant execute on function public.qconnect_heartbeat(text, text, jsonb) to anon;

-- Registration records the path the box used to get there. The old 4-argument
-- version must go: keeping both makes every call ambiguous ("function is not
-- unique") and every card fails to register.
drop function if exists public.qconnect_register(text, text, text, text);

create or replace function public.qconnect_register(
  p_device_id text, p_dealer_id text, p_device_token text, p_tailscale_ip text,
  p_connection_path text default null, p_connection_detail text default null,
  p_pi_model text default null
) returns void
language plpgsql security definer set search_path = public as $$
begin
  update qconnect_devices
     set tailscale_ip      = p_tailscale_ip,
         registered_at     = coalesce(registered_at, now()),
         last_seen_at      = now(),
         first_seen_at     = coalesce(first_seen_at, now()),
         connection_path   = coalesce(nullif(p_connection_path, ''), connection_path),
         connection_detail = coalesce(nullif(p_connection_detail, ''), connection_detail),
         pi_model          = coalesce(nullif(p_pi_model, ''), pi_model),
         stuck_step        = null,
         last_error        = null
   where device_id = p_device_id
     and device_token_hash = public.qconnect_token_hash(p_device_token);
  if not found then
    raise exception 'registration rejected';
  end if;
end;
$$;
grant execute on function public.qconnect_register(text, text, text, text, text, text, text) to anon;

-- Fleet view gains the connectivity columns plus a single plain-English
-- health verdict the dashboard can show without any client-side logic.
-- The column list changes, and Postgres refuses to re-shape a view in place.
drop view if exists public.qconnect_fleet;
create view public.qconnect_fleet as
  select device_id,
         dealer_id,
         tailscale_ip,
         enabled,
         registered_at,
         last_seen_at,
         first_seen_at,
         last_status,
         created_at,
         connection_path,
         connection_detail,
         link_quality,
         pi_model,
         agent_version,
         stuck_step,
         last_error,
         (last_seen_at is not null and last_seen_at > now() - interval '15 minutes') as online,
         case
           when not enabled then 'disabled'
           when registered_at is null and last_seen_at is null then 'never_checked_in'
           when last_seen_at is null or last_seen_at < now() - interval '15 minutes' then 'offline'
           when stuck_step is not null then 'stuck_' || stuck_step
           when link_quality is not null and link_quality < 30 then 'weak_signal'
           else 'healthy'
         end as health
  from public.qconnect_devices
  where public.qconnect_is_admin()
     or dealer_id = public.qconnect_dealer_id();
revoke all on public.qconnect_fleet from anon;
grant select on public.qconnect_fleet to authenticated;

-- ---------------------------------------------------------------- bench 8
-- Connectivity phase: every path a dealership might have, proved on the bench
-- before the card ships. Replaces 04's seeder with the same list plus phase 8.
create or replace function public.qconnect_bench_start(
  p_device_id text, p_operator text default null, p_hardware text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_run uuid;
begin
  if not public.qconnect_is_admin() then
    raise exception 'not authorized';
  end if;

  insert into qconnect_bench_runs (device_id, operator, hardware)
  values (p_device_id, p_operator, p_hardware)
  returning id into v_run;

  insert into qconnect_bench_checks (run_id, phase, step, label)
  values
    (v_run, 1, '1.1', 'Flash Pi OS Lite 64-bit Bookworm, username/password only, no Wi-Fi, no SSH'),
    (v_run, 1, '1.2', 'provision-sd.sh pre-registers the device and prints the summary'),
    (v_run, 1, '1.3', 'Preregister row exists with registered_at still empty'),
    (v_run, 1, '1.4', 'Card holds the qconnect/ payload and cmdline.txt runs qconnect-firstrun.sh at the right mountpoint'),
    (v_run, 1, '1.5', 'Re-running the writer with the same Tailscale key is refused'),
    (v_run, 2, '2.1', 'First boot untouched: boots, runs firstrun, self-reboots'),
    (v_run, 2, '2.2', 'Node appears in Tailscale with tag:qconnect'),
    (v_run, 2, '2.3', 'registered_at set and tailscale_ip matches the admin console'),
    (v_run, 2, '2.4', 'After 6 min last_seen_at advanced and health values present'),
    (v_run, 2, '2.5', 'Tailscale SSH opens; all three logs end successfully'),
    (v_run, 2, '2.6', 'Secrets hygiene: no provision.json on boot, authkey redacted, mode 600'),
    (v_run, 2, '2.7', 'Device shows Online in the dashboard'),
    (v_run, 3, '3.1', 'Clean reboot: back within 3 min, setup did not rerun'),
    (v_run, 3, '3.2', 'Three hard power cuts: always returns, no filesystem errors'),
    (v_run, 3, '3.3', 'Ten-minute Wi-Fi outage: reappears unaided, offline view tracked it'),
    (v_run, 4, '4.1', 'Setup hotspot appears within about 4 min'),
    (v_run, 4, '4.2', 'Setup page pops automatically within about 15 s of joining'),
    (v_run, 4, '4.3', 'Dropdown lists nearby networks including the bench SSID'),
    (v_run, 4, '4.4', 'Wrong password: page says wrong password, hotspot returns'),
    (v_run, 4, '4.5', 'Right password: completes phase 2 unaided'),
    (v_run, 4, '4.6', 'Captive popup verified on iPhone and Android'),
    (v_run, 5, '5.1', 'Admin disable: heartbeat returns enabled=false, audit row written'),
    (v_run, 5, '5.2', 'Re-enable: audit shows both actions with the operator email'),
    (v_run, 5, '5.3', 'Tailscale node deleted: SSH drops'),
    (v_run, 6, '6.1', 'Card pulled and mounted on a laptop'),
    (v_run, 6, '6.2', 'Boot partition contains no provision.json'),
    (v_run, 6, '6.3', 'authkey redacted on ext4; test device disabled afterwards'),
    (v_run, 7, '7.1', 'Box left running 24 h in a case'),
    (v_run, 7, '7.2', 'No heartbeat gap over 15 min, temp under 70 C, mem free over 100 MB'),
    (v_run, 7, '7.3', 'Steady-state temperature and free memory recorded'),
    -- Phase 8: connectivity. Each path proved on its own, then handover between them.
    (v_run, 8, '8.1', 'Cable only, no Wi-Fi configured: online within 3 min, fleet shows path ethernet'),
    (v_run, 8, '8.2', 'Wi-Fi only, 2.4 GHz SSID: online, fleet shows path wifi with SSID and signal'),
    (v_run, 8, '8.3', 'Pi 4 on a 5 GHz-only SSID joins; Zero 2 W reports ssid_not_in_range_2g_radio instead of failing silently'),
    (v_run, 8, '8.4', 'Hidden SSID joins when flashed with the hidden flag'),
    (v_run, 8, '8.5', 'Cellular: AT&T SIM detected by ModemManager'),
    (v_run, 8, '8.6', 'Cellular: modem registers to tower with no PIN lock'),
    (v_run, 8, '8.7', 'Cellular: box comes online using APN broadband with no Wi-Fi or cable, fleet shows path cellular'),
    (v_run, 8, '8.8', 'Cellular: wrong APN (e.g. invalid.example) fails with cellular_failed'),
    (v_run, 8, '8.9', 'Cellular: failover from cellular to cable works when cable is plugged in'),
    (v_run, 8, '8.10', 'Cellular: portal APN override persists to provision.json and reconnects'),
    (v_run, 8, '8.11', 'Saved phone hotspot is used when the dealer Wi-Fi is switched off'),
    (v_run, 8, '8.12', 'Cable unplugged while running: fails over to Wi-Fi within 2 min, path updates'),
    (v_run, 8, '8.13', 'Cable plugged back in: returns to ethernet, no reboot, no gap in heartbeats'),
    (v_run, 8, '8.14', 'Wrong flashed Wi-Fi password: setup hotspot appears and the dashboard shows stuck_network with wrong_password'),
    (v_run, 8, '8.15', 'Captive-portal network: box reports captive_portal rather than claiming to be online'),
    (v_run, 8, '8.16', 'Pi Zero 2 W only sees 2.4 GHz networks and reports it clearly'),
    (v_run, 8, '8.17', 'Pi 4 sees both 2.4 GHz and 5 GHz networks');

  return v_run;
end;
$$;
revoke execute on function public.qconnect_bench_start(text, text, text) from anon, public;
grant execute on function public.qconnect_bench_start(text, text, text) to authenticated;

-- Go/no-go unchanged: any open or failed check anywhere is a no-go.
