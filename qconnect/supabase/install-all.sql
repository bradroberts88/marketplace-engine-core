-- QConnect Fleet Manager — combined install.
-- Generated from 01..09. Idempotent; safe to re-run. Apply as ONE migration.

-- ============================================================
-- 01-schema-hardened.sql
-- ============================================================
-- QConnect fleet schema (hardened)
-- Run once in the Supabase SQL editor.

-- ============================================================
-- QConnect device layer, hardened. Idempotent.
-- ============================================================
create table if not exists public.qconnect_devices (
  device_id     text primary key,
  dealer_id     text not null,
  device_token  text not null,
  tailscale_ip  text,
  enabled       boolean not null default true,
  registered_at timestamptz,
  last_seen_at  timestamptz,
  last_status   jsonb,
  created_at    timestamptz not null default now()
);
alter table public.qconnect_devices enable row level security;
revoke all on public.qconnect_devices from anon, authenticated;

-- Flash-time preregistration (service role only). MANDATORY per device.
create or replace function public.qconnect_preregister(
  p_device_id text, p_dealer_id text, p_device_token text
) returns void
language sql security definer set search_path = public as $$
  insert into qconnect_devices (device_id, dealer_id, device_token)
  values (p_device_id, p_dealer_id, p_device_token)
  on conflict (device_id) do update
    set dealer_id = excluded.dealer_id, device_token = excluded.device_token;
$$;
revoke execute on function public.qconnect_preregister from anon, authenticated;

-- FINDING 2 FIX: registration requires an existing row + matching token.
-- Unknown devices are rejected. No more open self-registration.
create or replace function public.qconnect_register(
  p_device_id text, p_dealer_id text, p_device_token text, p_tailscale_ip text
) returns void
language plpgsql security definer set search_path = public as $$
begin
  update qconnect_devices
     set tailscale_ip  = p_tailscale_ip,
         registered_at = coalesce(registered_at, now()),
         last_seen_at  = now()
   where device_id = p_device_id and device_token = p_device_token;
  if not found then
    raise exception 'registration rejected';
  end if;
end;
$$;
grant execute on function public.qconnect_register(text, text, text, text) to anon;

create or replace function public.qconnect_heartbeat(
  p_device_id text, p_device_token text, p_status jsonb
) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_enabled boolean;
begin
  update qconnect_devices
     set last_seen_at = now(),
         last_status  = p_status,
         tailscale_ip = coalesce(p_status->>'tailscale_ip', tailscale_ip)
   where device_id = p_device_id and device_token = p_device_token
   returning enabled into v_enabled;
  if v_enabled is null then
    raise exception 'rejected';
  end if;
  return v_enabled;
end;
$$;
grant execute on function public.qconnect_heartbeat to anon;

-- FINDING 1 FIX: offline view locked to logged-in dashboard users only.
create or replace view public.qconnect_offline as
  select device_id, dealer_id, tailscale_ip, last_seen_at
  from qconnect_devices
  where enabled and (last_seen_at is null or last_seen_at < now() - interval '15 minutes');
revoke all on public.qconnect_offline from anon;
grant select on public.qconnect_offline to authenticated;

-- ============================================================
-- 02-admin-killswitch-audit.sql
-- ============================================================
-- QConnect 02 — admin-only kill switch + audit trail
-- Closes Finding 4 of the security review: in v1 any logged-in dashboard user
-- could disable a box. Admin status comes from the signed JWT's app_metadata,
-- which end users cannot edit (unlike user_metadata).
--
-- Run AFTER 01-schema-hardened.sql. Idempotent.

-- Mark an admin once per user, from the SQL editor / service role:
--   update auth.users
--      set raw_app_meta_data = coalesce(raw_app_meta_data,'{}'::jsonb) || '{"role":"admin"}'::jsonb
--    where email = 'you@example.com';
-- The user must sign out and back in for the new JWT to carry the claim.

create or replace function public.qconnect_is_admin()
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'admin';
$$;
revoke execute on function public.qconnect_is_admin() from anon;
grant execute on function public.qconnect_is_admin() to authenticated;

-- Dealer scope for non-admin staff, also from app_metadata.
create or replace function public.qconnect_dealer_id()
returns text
language sql stable security definer set search_path = public as $$
  select auth.jwt() -> 'app_metadata' ->> 'dealer_id';
$$;
revoke execute on function public.qconnect_dealer_id() from anon;
grant execute on function public.qconnect_dealer_id() to authenticated;

-- ---------------------------------------------------------------- audit log
-- Fleet Manager compatibility: older installs have a VIEW named qconnect_audit
-- over a qconnect_audit_log table. Drop the view (only if it really is a view)
-- so the real table can take the name; its rows are carried forward below.
do $$
begin
  if exists (
    select 1 from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'qconnect_audit' and c.relkind = 'v'
  ) then
    execute 'drop view public.qconnect_audit';
  end if;
end $$;

create table if not exists public.qconnect_audit (
  id          bigint generated always as identity primary key,
  actor_id    uuid,
  actor_email text,
  device_id   text,
  action      text not null,
  detail      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

-- Columns matching the legacy Fleet Manager audit view, so its dashboard
-- keeps working unchanged against this table.
alter table public.qconnect_audit add column if not exists actor_role text;
alter table public.qconnect_audit add column if not exists dealer_id  text;
alter table public.qconnect_audit add column if not exists at timestamptz
  generated always as (created_at) stored;

-- Carry legacy rows forward (once; guarded so re-runs do not duplicate).
do $$
begin
  if to_regclass('public.qconnect_audit_log') is not null then
    insert into public.qconnect_audit (actor_email, actor_role, device_id, action, dealer_id, created_at)
    select l.actor_email, l.actor_role, l.device_id, l.action, l.dealer_id, l.at
      from public.qconnect_audit_log l
     where not exists (
       select 1 from public.qconnect_audit a
        where a.created_at = l.at
          and a.device_id is not distinct from l.device_id
          and a.action = l.action
     );
  end if;
end $$;

create index if not exists qconnect_audit_device_idx on public.qconnect_audit (device_id, created_at desc);

alter table public.qconnect_audit enable row level security;
revoke all on public.qconnect_audit from anon, authenticated;
grant select on public.qconnect_audit to authenticated;
grant all on public.qconnect_audit to service_role;

-- Append-only from the app's point of view: no insert/update/delete policies.
drop policy if exists "qconnect_audit_read" on public.qconnect_audit;
-- Fleet Manager adds group scoping: when qconnect_dealer_groups exists, group
-- admins read their group's rows; otherwise the plain admin/dealer rule applies.
do $$
begin
  if to_regclass('public.qconnect_dealer_groups') is not null then
    execute $p$
      create policy "qconnect_audit_read" on public.qconnect_audit
        for select to authenticated
        using (
          public.qconnect_is_admin()
          or (
            coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'group_admin'
            and dealer_id in (
              select g.dealer_id from public.qconnect_dealer_groups g
               where g.group_id = auth.jwt() -> 'app_metadata' ->> 'group_id'
            )
          )
          or exists (
            select 1 from public.qconnect_devices d
             where d.device_id = qconnect_audit.device_id
               and d.dealer_id = public.qconnect_dealer_id()
          )
        )
    $p$;
  else
    execute $p$
      create policy "qconnect_audit_read" on public.qconnect_audit
        for select to authenticated
        using (
          public.qconnect_is_admin()
          or exists (
            select 1 from public.qconnect_devices d
             where d.device_id = qconnect_audit.device_id
               and d.dealer_id = public.qconnect_dealer_id()
          )
        )
    $p$;
  end if;
end $$;

-- --------------------------------------------------------------- kill switch
-- Admin: any box. group_admin (when qconnect_dealer_groups exists): own group.
-- Every toggle is written to the audit trail with actor, role and dealer.
-- Older installs return void from this function; drop it so the return type
-- can change to boolean.
drop function if exists public.qconnect_set_enabled(text, boolean);
create or replace function public.qconnect_set_enabled(
  p_device_id text, p_enabled boolean
) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_email  text;
  v_role   text := coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '');
  v_group  text := auth.jwt() -> 'app_metadata' ->> 'group_id';
  v_dealer text;
begin
  if v_role = 'admin' then
    update qconnect_devices set enabled = p_enabled
     where device_id = p_device_id
     returning dealer_id into v_dealer;
  elsif v_role = 'group_admin' and to_regclass('public.qconnect_dealer_groups') is not null then
    update qconnect_devices d set enabled = p_enabled
     where d.device_id = p_device_id
       and d.dealer_id in (select g.dealer_id from public.qconnect_dealer_groups g
                            where g.group_id = v_group)
     returning d.dealer_id into v_dealer;
  else
    raise exception 'not authorized';
  end if;

  if v_dealer is null then
    raise exception 'not authorized';
  end if;

  select email into v_email from auth.users where id = auth.uid();

  insert into qconnect_audit (actor_id, actor_email, actor_role, device_id, action, dealer_id, detail)
  values (auth.uid(), v_email, v_role, p_device_id,
          case when p_enabled then 'enable' else 'disable' end,
          v_dealer,
          jsonb_build_object('enabled', p_enabled));

  return p_enabled;
end;
$$;
revoke execute on function public.qconnect_set_enabled(text, boolean) from anon, public;
grant execute on function public.qconnect_set_enabled(text, boolean) to authenticated;

-- --------------------------------------------- token-free dashboard fleet view
-- Views run with owner rights and bypass RLS, so the row filter lives INSIDE
-- the view and anon is revoked (same reasoning as Finding 1).
create or replace view public.qconnect_fleet as
  select device_id,
         dealer_id,
         tailscale_ip,
         enabled,
         registered_at,
         last_seen_at,
         last_status,
         created_at,
         (last_seen_at is not null and last_seen_at > now() - interval '15 minutes') as online
  from public.qconnect_devices
  where public.qconnect_is_admin()
     or dealer_id = public.qconnect_dealer_id();
revoke all on public.qconnect_fleet from anon;
grant select on public.qconnect_fleet to authenticated;

-- Keep the offline view consistent with the same scoping.
create or replace view public.qconnect_offline as
  select device_id, dealer_id, tailscale_ip, last_seen_at
  from public.qconnect_devices
  where enabled
    and (last_seen_at is null or last_seen_at < now() - interval '15 minutes')
    and (public.qconnect_is_admin() or dealer_id = public.qconnect_dealer_id());
revoke all on public.qconnect_offline from anon;
grant select on public.qconnect_offline to authenticated;

-- ============================================================
-- 03-token-hashing.sql
-- ============================================================
-- QConnect 03 — hash the device tokens (Finding 5)
-- The device keeps sending its plain token; only the SHA-256 fingerprint is
-- stored, so a database dump no longer contains usable device credentials.
-- No change is needed on the device side.
--
-- Run AFTER 02. Idempotent, and safe to run on a fleet that is already live:
-- existing plaintext tokens are hashed in place in one pass.

create extension if not exists pgcrypto with schema extensions;

alter table public.qconnect_devices
  add column if not exists device_token_hash text;

create or replace function public.qconnect_token_hash(p_token text)
returns text
language sql immutable set search_path = public, extensions as $$
  select encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex');
$$;
revoke execute on function public.qconnect_token_hash(text) from anon, authenticated, public;

-- One-time backfill: fingerprint every token that is still stored in the clear.
update public.qconnect_devices
   set device_token_hash = public.qconnect_token_hash(device_token)
 where device_token_hash is null
   and device_token is not null;

-- Blank the plaintext column once every row has a fingerprint. The column is
-- kept (nullable) so nothing that still references it breaks; it holds no
-- secret from here on.
alter table public.qconnect_devices alter column device_token drop not null;
update public.qconnect_devices set device_token = null where device_token_hash is not null;

-- ------------------------------------------------- RPCs now compare the hash
create or replace function public.qconnect_preregister(
  p_device_id text, p_dealer_id text, p_device_token text
) returns void
language sql security definer set search_path = public as $$
  insert into qconnect_devices (device_id, dealer_id, device_token, device_token_hash)
  values (p_device_id, p_dealer_id, null, public.qconnect_token_hash(p_device_token))
  on conflict (device_id) do update
    set dealer_id         = excluded.dealer_id,
        device_token      = null,
        device_token_hash = excluded.device_token_hash;
$$;
revoke execute on function public.qconnect_preregister(text, text, text) from anon, authenticated, public;

create or replace function public.qconnect_register(
  p_device_id text, p_dealer_id text, p_device_token text, p_tailscale_ip text
) returns void
language plpgsql security definer set search_path = public as $$
begin
  update qconnect_devices
     set tailscale_ip  = p_tailscale_ip,
         registered_at = coalesce(registered_at, now()),
         last_seen_at  = now()
   where device_id = p_device_id
     and device_token_hash = public.qconnect_token_hash(p_device_token);
  if not found then
    raise exception 'registration rejected';
  end if;
end;
$$;
grant execute on function public.qconnect_register(text, text, text, text) to anon;

create or replace function public.qconnect_heartbeat(
  p_device_id text, p_device_token text, p_status jsonb
) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_enabled boolean;
begin
  update qconnect_devices
     set last_seen_at = now(),
         last_status  = p_status,
         tailscale_ip = coalesce(p_status->>'tailscale_ip', tailscale_ip)
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

-- ============================================================
-- 04-bench-tests.sql
-- ============================================================
-- QConnect 04 — bench test runs, so the 7-phase checklist is recorded instead
-- of living on paper. One run per physical card you certify.
-- Run AFTER 03. Idempotent.

create table if not exists public.qconnect_bench_runs (
  id          uuid primary key default gen_random_uuid(),
  device_id   text not null,
  operator    text,
  hardware    text,
  notes       text,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  verdict     text not null default 'in_progress'
              check (verdict in ('in_progress', 'go', 'no_go')),
  metrics     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create table if not exists public.qconnect_bench_checks (
  id         uuid primary key default gen_random_uuid(),
  run_id     uuid not null references public.qconnect_bench_runs(id) on delete cascade,
  phase      smallint not null,
  step       text not null,
  label      text not null,
  passed     boolean,
  note       text,
  checked_by text,
  checked_at timestamptz,
  unique (run_id, step)
);
create index if not exists qconnect_bench_checks_run_idx on public.qconnect_bench_checks (run_id, phase, step);

grant select, insert, update, delete on public.qconnect_bench_runs   to authenticated;
grant select, insert, update, delete on public.qconnect_bench_checks to authenticated;
grant all on public.qconnect_bench_runs   to service_role;
grant all on public.qconnect_bench_checks to service_role;
revoke all on public.qconnect_bench_runs   from anon;
revoke all on public.qconnect_bench_checks from anon;

alter table public.qconnect_bench_runs   enable row level security;
alter table public.qconnect_bench_checks enable row level security;

-- Bench testing is an internal admin activity.
drop policy if exists "bench_runs_admin" on public.qconnect_bench_runs;
create policy "bench_runs_admin" on public.qconnect_bench_runs
  for all to authenticated
  using (public.qconnect_is_admin()) with check (public.qconnect_is_admin());

drop policy if exists "bench_checks_admin" on public.qconnect_bench_checks;
create policy "bench_checks_admin" on public.qconnect_bench_checks
  for all to authenticated
  using (public.qconnect_is_admin()) with check (public.qconnect_is_admin());

-- Seed a run with the full checklist from QConnect_Bench_Test_Checklist.pdf.
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
    (v_run, 1, '1.1', 'Flash Pi OS Lite 64-bit, username/password only, no Wi-Fi, no SSH'),
    (v_run, 1, '1.2', 'provision-sd.sh prints device summary and preregister line'),
    (v_run, 1, '1.3', 'Preregister row exists with registered_at still empty'),
    (v_run, 1, '1.4', 'Card holds 8 files in qconnect/ and cmdline.txt runs qconnect-firstrun.sh'),
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
    (v_run, 4, '4.4', 'Wrong password: hotspot returns within about 15 min'),
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

-- Go/no-go rule from the checklist: all phases must be clean. Any open or failed
-- check anywhere is a no-go.
create or replace function public.qconnect_bench_finish(p_run_id uuid)
returns text
language plpgsql security definer set search_path = public as $$
declare v_open int; v_failed int; v_verdict text;
begin
  if not public.qconnect_is_admin() then
    raise exception 'not authorized';
  end if;

  select count(*) filter (where passed is null),
         count(*) filter (where passed is false)
    into v_open, v_failed
    from qconnect_bench_checks where run_id = p_run_id;

  v_verdict := case when v_failed > 0 or v_open > 0 then 'no_go' else 'go' end;

  update qconnect_bench_runs
     set verdict = v_verdict, finished_at = now()
   where id = p_run_id;

  return v_verdict;
end;
$$;
revoke execute on function public.qconnect_bench_finish(uuid) from anon, public;
grant execute on function public.qconnect_bench_finish(uuid) to authenticated;

-- ============================================================
-- 05-connectivity.sql
-- ============================================================
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

-- ============================================================
-- 06-commands-updates.sql
-- ============================================================
-- QConnect 06 — two-way command channel + signed self-update
--
-- Until now the fleet was write-only: a box told the server how it was doing
-- and nothing could ever be sent back. This adds a queue the box drains on
-- every heartbeat, plus a release/rollout table so a box can replace its own
-- software with a signed bundle and roll back if the new one does not come
-- back healthy.
--
-- Run AFTER 05. Idempotent, safe on a live fleet.

-- ============================================================ command queue
create table if not exists public.qconnect_commands (
  id           uuid primary key default gen_random_uuid(),
  device_id    text not null references public.qconnect_devices(device_id) on delete cascade,
  kind         text not null,      -- see qconnect_command_kinds below
  payload      jsonb not null default '{}'::jsonb,
  status       text not null default 'queued',  -- queued|sent|done|failed|expired
  attempts     integer not null default 0,
  max_attempts integer not null default 3,
  issued_by    uuid,
  issued_email text,
  result       jsonb,
  error        text,
  created_at   timestamptz not null default now(),
  sent_at      timestamptz,
  finished_at  timestamptz,
  expires_at   timestamptz not null default now() + interval '24 hours'
);
create index if not exists qconnect_commands_pending_idx
  on public.qconnect_commands (device_id, created_at)
  where status in ('queued', 'sent');
create index if not exists qconnect_commands_device_idx
  on public.qconnect_commands (device_id, created_at desc);

alter table public.qconnect_commands enable row level security;
revoke all on public.qconnect_commands from anon, authenticated;
grant select on public.qconnect_commands to authenticated;
grant all on public.qconnect_commands to service_role;

drop policy if exists "qconnect_commands_read" on public.qconnect_commands;
create policy "qconnect_commands_read" on public.qconnect_commands
  for select to authenticated
  using (
    public.qconnect_is_admin()
    or exists (
      select 1 from public.qconnect_devices d
      where d.device_id = qconnect_commands.device_id
        and d.dealer_id = public.qconnect_dealer_id()
    )
  );

-- The device only ever runs commands from this list. An unknown kind is
-- refused at insert time, so a typo in the dashboard cannot park a command
-- that every box will fetch and then reject forever.
create or replace function public.qconnect_command_kinds()
returns text[] language sql immutable as $$
  select array[
    'restart_agent',      -- restart the qconnect services
    'rerun_setup',        -- clear provisioned flag and run setup again
    'reboot',
    'reconnect',          -- re-run the network picker
    'force_path',         -- payload: {"path":"ethernet|wifi|cellular|hotspot"}
    'set_wifi',           -- payload: {"ssid":"...","psk":"...","hidden":bool}
    'set_apn',            -- payload: {"apn":"broadband","user":"","pass":""}
    'collect_logs',
    'update_agent'        -- payload: {"version":"..."} (usually implicit)
  ];
$$;

-- ============================================================== releases
create table if not exists public.qconnect_releases (
  version     text primary key,          -- e.g. 2026.09.13-1
  channel     text not null default 'stable',
  bundle_url  text not null,
  sha256      text not null,
  signature   text not null,             -- base64 detached signature of the bundle
  notes       text,
  published   boolean not null default false,
  created_at  timestamptz not null default now()
);
alter table public.qconnect_releases enable row level security;
revoke all on public.qconnect_releases from anon, authenticated;
grant select on public.qconnect_releases to authenticated;
grant all on public.qconnect_releases to service_role;

drop policy if exists "qconnect_releases_read" on public.qconnect_releases;
create policy "qconnect_releases_read" on public.qconnect_releases
  for select to authenticated using (true);

-- A rollout aims one release at part of the fleet. percent lets a release go
-- to a handful of boxes first; the split is a stable hash of the device id so
-- a box does not flip in and out of the wave between heartbeats.
create table if not exists public.qconnect_rollouts (
  id          uuid primary key default gen_random_uuid(),
  version     text not null references public.qconnect_releases(version) on delete cascade,
  scope_kind  text not null default 'all',   -- all|dealer|device
  scope_value text,
  percent     integer not null default 100,
  active      boolean not null default true,
  created_by  uuid,
  created_at  timestamptz not null default now()
);
create index if not exists qconnect_rollouts_active_idx
  on public.qconnect_rollouts (active, created_at desc);
alter table public.qconnect_rollouts enable row level security;
revoke all on public.qconnect_rollouts from anon, authenticated;
grant select on public.qconnect_rollouts to authenticated;
grant all on public.qconnect_rollouts to service_role;

drop policy if exists "qconnect_rollouts_read" on public.qconnect_rollouts;
create policy "qconnect_rollouts_read" on public.qconnect_rollouts
  for select to authenticated using (true);

create table if not exists public.qconnect_update_attempts (
  id          uuid primary key default gen_random_uuid(),
  device_id   text not null references public.qconnect_devices(device_id) on delete cascade,
  version     text not null,
  from_version text,
  status      text not null default 'started', -- started|installed|healthy|rolled_back|failed
  error       text,
  started_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists qconnect_update_attempts_device_idx
  on public.qconnect_update_attempts (device_id, started_at desc);
create index if not exists qconnect_update_attempts_open_idx
  on public.qconnect_update_attempts (status, started_at)
  where status in ('started', 'installed');

alter table public.qconnect_update_attempts enable row level security;
revoke all on public.qconnect_update_attempts from anon, authenticated;
grant select on public.qconnect_update_attempts to authenticated;
grant all on public.qconnect_update_attempts to service_role;

drop policy if exists "qconnect_update_attempts_read" on public.qconnect_update_attempts;
create policy "qconnect_update_attempts_read" on public.qconnect_update_attempts
  for select to authenticated
  using (
    public.qconnect_is_admin()
    or exists (
      select 1 from public.qconnect_devices d
      where d.device_id = qconnect_update_attempts.device_id
        and d.dealer_id = public.qconnect_dealer_id()
    )
  );

-- ------------------------------------------------- which release a box wants
create or replace function public.qconnect_target_release(p_device_id text)
returns table (version text, bundle_url text, sha256 text, signature text)
language sql stable security definer set search_path = public as $$
  select r.version, r.bundle_url, r.sha256, r.signature
    from qconnect_rollouts ro
    join qconnect_releases r on r.version = ro.version and r.published
    join qconnect_devices  d on d.device_id = p_device_id
   where ro.active
     and (
       ro.scope_kind = 'all'
       or (ro.scope_kind = 'dealer' and ro.scope_value = d.dealer_id)
       or (ro.scope_kind = 'device' and ro.scope_value = d.device_id)
     )
     -- stable per-device slot: same box, same answer, every time
     and (('x' || substr(md5(p_device_id), 1, 8))::bit(32)::bigint % 100) < ro.percent
   order by ro.created_at desc
   limit 1;
$$;

-- ------------------------------------------------------- device-facing RPCs
-- Drains the queue for one box. Returns the pending commands AND the release
-- the box should be running, so a stuck box needs exactly one round trip.
create or replace function public.qconnect_poll_commands(
  p_device_id text, p_device_token text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_enabled boolean;
  v_cmds    jsonb;
  v_rel     jsonb;
begin
  select enabled into v_enabled
    from qconnect_devices
   where device_id = p_device_id
     and device_token_hash = public.qconnect_token_hash(p_device_token);
  if v_enabled is null then
    raise exception 'rejected';
  end if;
  if not v_enabled then
    -- A disabled box gets no work, not even an update.
    return jsonb_build_object('enabled', false, 'commands', '[]'::jsonb);
  end if;

  with claimed as (
    update qconnect_commands c
       set status   = 'sent',
           attempts = c.attempts + 1,
           sent_at  = now()
     where c.device_id = p_device_id
       and c.status in ('queued', 'sent')
       and c.expires_at > now()
       and c.attempts < c.max_attempts
     returning c.id, c.kind, c.payload, c.created_at
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'kind', kind, 'payload', payload)
                            order by created_at), '[]'::jsonb)
    into v_cmds from claimed;

  select to_jsonb(t) into v_rel from public.qconnect_target_release(p_device_id) t;

  return jsonb_build_object('enabled', true, 'commands', v_cmds, 'release', v_rel);
end;
$$;
grant execute on function public.qconnect_poll_commands(text, text) to anon;

create or replace function public.qconnect_ack_command(
  p_device_id text, p_device_token text, p_command_id uuid,
  p_ok boolean, p_result jsonb default '{}'::jsonb, p_error text default null
) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not exists (
    select 1 from qconnect_devices
     where device_id = p_device_id
       and device_token_hash = public.qconnect_token_hash(p_device_token)
  ) then
    raise exception 'rejected';
  end if;

  update qconnect_commands
     set status      = case when p_ok then 'done' else 'failed' end,
         result      = coalesce(p_result, '{}'::jsonb),
         error       = nullif(p_error, ''),
         finished_at = now()
   where id = p_command_id and device_id = p_device_id;
end;
$$;
grant execute on function public.qconnect_ack_command(text, text, uuid, boolean, jsonb, text) to anon;

-- The box reports each stage of its own update. 'healthy' is only sent after
-- the new version has proved it can still reach the server.
create or replace function public.qconnect_report_update(
  p_device_id text, p_device_token text, p_version text,
  p_status text, p_from_version text default null, p_error text default null
) returns void
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not exists (
    select 1 from qconnect_devices
     where device_id = p_device_id
       and device_token_hash = public.qconnect_token_hash(p_device_token)
  ) then
    raise exception 'rejected';
  end if;
  if p_status not in ('started', 'installed', 'healthy', 'rolled_back', 'failed') then
    raise exception 'unknown update status %', p_status;
  end if;

  select id into v_id
    from qconnect_update_attempts
   where device_id = p_device_id and version = p_version
     and status in ('started', 'installed')
   order by started_at desc limit 1;

  if v_id is null then
    insert into qconnect_update_attempts (device_id, version, from_version, status, error)
    values (p_device_id, p_version, nullif(p_from_version, ''), p_status, nullif(p_error, ''));
  else
    update qconnect_update_attempts
       set status = p_status, error = nullif(p_error, ''), updated_at = now()
     where id = v_id;
  end if;
end;
$$;
grant execute on function public.qconnect_report_update(text, text, text, text, text, text) to anon;

-- -------------------------------------------------------- admin-facing RPCs
create or replace function public.qconnect_issue_command(
  p_device_id text, p_kind text, p_payload jsonb default '{}'::jsonb
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_email text;
begin
  if not public.qconnect_is_admin() then
    raise exception 'not authorized';
  end if;
  if not (p_kind = any (public.qconnect_command_kinds())) then
    raise exception 'unknown command %', p_kind;
  end if;

  select auth.jwt() ->> 'email' into v_email;

  insert into qconnect_commands (device_id, kind, payload, issued_by, issued_email)
  values (p_device_id, p_kind, coalesce(p_payload, '{}'::jsonb), auth.uid(), v_email)
  returning id into v_id;

  insert into qconnect_audit (actor_id, actor_email, device_id, action, detail)
  values (auth.uid(), v_email, p_device_id, 'command:' || p_kind,
          jsonb_build_object('command_id', v_id, 'payload', coalesce(p_payload, '{}'::jsonb)));

  return v_id;
end;
$$;
revoke execute on function public.qconnect_issue_command(text, text, jsonb) from anon;
grant execute on function public.qconnect_issue_command(text, text, jsonb) to authenticated;

create or replace function public.qconnect_publish_release(
  p_version text, p_bundle_url text, p_sha256 text, p_signature text,
  p_notes text default null, p_channel text default 'stable'
) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.qconnect_is_admin() then
    raise exception 'not authorized';
  end if;
  insert into qconnect_releases (version, channel, bundle_url, sha256, signature, notes, published)
  values (p_version, p_channel, p_bundle_url, p_sha256, p_signature, p_notes, true)
  on conflict (version) do update
    set bundle_url = excluded.bundle_url, sha256 = excluded.sha256,
        signature  = excluded.signature,  notes  = excluded.notes,
        channel    = excluded.channel,    published = true;

  insert into qconnect_audit (actor_id, actor_email, action, detail)
  values (auth.uid(), auth.jwt() ->> 'email', 'release:publish',
          jsonb_build_object('version', p_version, 'sha256', p_sha256));
end;
$$;
revoke execute on function public.qconnect_publish_release(text, text, text, text, text, text) from anon;
grant execute on function public.qconnect_publish_release(text, text, text, text, text, text) to authenticated;

create or replace function public.qconnect_start_rollout(
  p_version text, p_scope_kind text default 'all', p_scope_value text default null,
  p_percent integer default 100
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not public.qconnect_is_admin() then
    raise exception 'not authorized';
  end if;
  if p_scope_kind not in ('all', 'dealer', 'device') then
    raise exception 'unknown scope %', p_scope_kind;
  end if;
  if p_percent < 1 or p_percent > 100 then
    raise exception 'percent must be 1-100';
  end if;

  -- One active rollout per release keeps "which version should this box run?"
  -- a question with exactly one answer.
  update qconnect_rollouts set active = false where version = p_version and active;

  insert into qconnect_rollouts (version, scope_kind, scope_value, percent, created_by)
  values (p_version, p_scope_kind, nullif(p_scope_value, ''), p_percent, auth.uid())
  returning id into v_id;

  insert into qconnect_audit (actor_id, actor_email, action, detail)
  values (auth.uid(), auth.jwt() ->> 'email', 'release:rollout',
          jsonb_build_object('version', p_version, 'scope_kind', p_scope_kind,
                             'scope_value', p_scope_value, 'percent', p_percent));
  return v_id;
end;
$$;
revoke execute on function public.qconnect_start_rollout(text, text, text, integer) from anon;
grant execute on function public.qconnect_start_rollout(text, text, text, integer) to authenticated;

create or replace function public.qconnect_stop_rollout(p_version text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.qconnect_is_admin() then
    raise exception 'not authorized';
  end if;
  update qconnect_rollouts set active = false where version = p_version and active;
  insert into qconnect_audit (actor_id, actor_email, action, detail)
  values (auth.uid(), auth.jwt() ->> 'email', 'release:rollout_stop',
          jsonb_build_object('version', p_version));
end;
$$;
revoke execute on function public.qconnect_stop_rollout(text) from anon;
grant execute on function public.qconnect_stop_rollout(text) to authenticated;

-- ============================================================
-- 07-onboarding-steps.sql
-- ============================================================
-- QConnect 07 — strict onboarding step tracking
--
-- Every card gets a run when it is pre-registered at the bench. The run holds
-- one row per step it must pass, each with a deadline. A step that is not
-- reported in time becomes 'overdue' (see 08) instead of quietly never
-- happening, which is exactly how the "some cards just never came up" problem
-- stayed invisible.
--
-- Run AFTER 06. Idempotent, safe on a live fleet.

create table if not exists public.qconnect_step_defs (
  step       text primary key,
  ordinal    smallint not null,
  label      text not null,
  deadline_s integer not null,   -- seconds after the run starts
  required   boolean not null default true
);
grant select on public.qconnect_step_defs to authenticated, service_role;

insert into public.qconnect_step_defs (step, ordinal, label, deadline_s, required) values
  ('power_on',        1, 'Box powered on and first-run script completed', 600,   true),
  ('network_up',      2, 'Internet reachable over cable, Wi-Fi or cellular', 900,  true),
  ('tunnel_up',       3, 'Secure tunnel connected',                       1200,  true),
  ('registered',      4, 'Registered with the server',                    1500,  true),
  ('first_heartbeat', 5, 'First check-in received',                       1800,  true),
  ('first_listing',   6, 'First listing posted',                          86400, false)
on conflict (step) do update
  set ordinal = excluded.ordinal, label = excluded.label,
      deadline_s = excluded.deadline_s, required = excluded.required;

create table if not exists public.qconnect_runs (
  id          uuid primary key default gen_random_uuid(),
  device_id   text not null references public.qconnect_devices(device_id) on delete cascade,
  state       text not null default 'in_progress',  -- in_progress|complete|failed
  started_at  timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists qconnect_runs_device_idx on public.qconnect_runs (device_id, started_at desc);
create index if not exists qconnect_runs_open_idx on public.qconnect_runs (state) where state = 'in_progress';

create table if not exists public.qconnect_run_steps (
  id          uuid primary key default gen_random_uuid(),
  run_id      uuid not null references public.qconnect_runs(id) on delete cascade,
  device_id   text not null,
  step        text not null,
  ordinal     smallint not null,
  label       text not null,
  status      text not null default 'pending',  -- pending|passed|failed|overdue|skipped
  due_at      timestamptz not null,
  reported_at timestamptz,
  detail      text,
  unique (run_id, step)
);
create index if not exists qconnect_run_steps_open_idx
  on public.qconnect_run_steps (status, due_at) where status = 'pending';
create index if not exists qconnect_run_steps_device_idx
  on public.qconnect_run_steps (device_id, ordinal);

alter table public.qconnect_runs      enable row level security;
alter table public.qconnect_run_steps enable row level security;
revoke all on public.qconnect_runs      from anon, authenticated;
revoke all on public.qconnect_run_steps from anon, authenticated;
grant select on public.qconnect_runs      to authenticated;
grant select on public.qconnect_run_steps to authenticated;
grant all on public.qconnect_runs      to service_role;
grant all on public.qconnect_run_steps to service_role;

drop policy if exists "qconnect_runs_read" on public.qconnect_runs;
create policy "qconnect_runs_read" on public.qconnect_runs
  for select to authenticated
  using (
    public.qconnect_is_admin()
    or exists (select 1 from public.qconnect_devices d
                where d.device_id = qconnect_runs.device_id
                  and d.dealer_id = public.qconnect_dealer_id())
  );

drop policy if exists "qconnect_run_steps_read" on public.qconnect_run_steps;
create policy "qconnect_run_steps_read" on public.qconnect_run_steps
  for select to authenticated
  using (
    public.qconnect_is_admin()
    or exists (select 1 from public.qconnect_devices d
                where d.device_id = qconnect_run_steps.device_id
                  and d.dealer_id = public.qconnect_dealer_id())
  );

-- Opens a fresh run and closes any run still open for the same box, so a
-- re-flashed card starts from a clean checklist instead of inheriting the
-- failures of its previous life.
create or replace function public.qconnect_start_run(p_device_id text)
returns uuid
language plpgsql security definer set search_path = public as $$
declare v_run uuid;
begin
  update qconnect_runs
     set state = 'failed', finished_at = now()
   where device_id = p_device_id and state = 'in_progress';

  insert into qconnect_runs (device_id) values (p_device_id) returning id into v_run;

  insert into qconnect_run_steps (run_id, device_id, step, ordinal, label, due_at)
  select v_run, p_device_id, d.step, d.ordinal, d.label, now() + make_interval(secs => d.deadline_s)
    from qconnect_step_defs d;

  return v_run;
end;
$$;
revoke execute on function public.qconnect_start_run(text) from anon, authenticated, public;

-- Pre-registration now also opens the checklist. Same signature and same
-- behaviour as 03 otherwise, so provision-sd.sh needs no change.
create or replace function public.qconnect_preregister(
  p_device_id text, p_dealer_id text, p_device_token text
) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into qconnect_devices (device_id, dealer_id, device_token, device_token_hash)
  values (p_device_id, p_dealer_id, null, public.qconnect_token_hash(p_device_token))
  on conflict (device_id) do update
    set dealer_id         = excluded.dealer_id,
        device_token      = null,
        device_token_hash = excluded.device_token_hash;

  perform public.qconnect_start_run(p_device_id);
end;
$$;
revoke execute on function public.qconnect_preregister(text, text, text) from anon, authenticated, public;

-- ------------------------------------------------------------ step reporting
-- Called by the box itself. Passing a later step implicitly passes the earlier
-- ones: a box that registers clearly had network and a tunnel, and we would
-- rather not raise three false alarms because one report was lost.
create or replace function public.qconnect_report_step(
  p_device_id text, p_device_token text, p_step text,
  p_ok boolean default true, p_detail text default null
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_run     uuid;
  v_ordinal smallint;
begin
  if not exists (
    select 1 from qconnect_devices
     where device_id = p_device_id
       and device_token_hash = public.qconnect_token_hash(p_device_token)
  ) then
    raise exception 'rejected';
  end if;

  select ordinal into v_ordinal from qconnect_step_defs where step = p_step;
  if v_ordinal is null then
    raise exception 'unknown step %', p_step;
  end if;

  select id into v_run from qconnect_runs
   where device_id = p_device_id and state = 'in_progress'
   order by started_at desc limit 1;
  if v_run is null then
    v_run := public.qconnect_start_run(p_device_id);
  end if;

  if p_ok then
    update qconnect_run_steps
       set status = 'passed', reported_at = now(), detail = nullif(p_detail, '')
     where run_id = v_run and ordinal <= v_ordinal and status <> 'passed';
  else
    update qconnect_run_steps
       set status = 'failed', reported_at = now(), detail = nullif(p_detail, '')
     where run_id = v_run and step = p_step;
  end if;

  -- A run is complete once every required step has passed.
  update qconnect_runs
     set state = 'complete', finished_at = now()
   where id = v_run
     and state = 'in_progress'
     and not exists (
       select 1 from qconnect_run_steps s
        join qconnect_step_defs d on d.step = s.step
       where s.run_id = v_run and d.required and s.status <> 'passed'
     );
end;
$$;
grant execute on function public.qconnect_report_step(text, text, text, boolean, text) to anon;

-- A first heartbeat counts as a report in its own right, so a box running an
-- older agent that does not call qconnect_report_step still ticks the boxes it
-- has visibly cleared.
create or replace function public.qconnect_note_progress(p_device_id text, p_step text)
returns void
language plpgsql security definer set search_path = public as $$
declare v_run uuid; v_ordinal smallint;
begin
  select ordinal into v_ordinal from qconnect_step_defs where step = p_step;
  if v_ordinal is null then return; end if;

  select id into v_run from qconnect_runs
   where device_id = p_device_id and state = 'in_progress'
   order by started_at desc limit 1;
  if v_run is null then return; end if;

  update qconnect_run_steps
     set status = 'passed', reported_at = now()
   where run_id = v_run and ordinal <= v_ordinal and status in ('pending', 'overdue');

  update qconnect_runs
     set state = 'complete', finished_at = now()
   where id = v_run and state = 'in_progress'
     and not exists (
       select 1 from qconnect_run_steps s
        join qconnect_step_defs d on d.step = s.step
       where s.run_id = v_run and d.required and s.status <> 'passed'
     );
end;
$$;
revoke execute on function public.qconnect_note_progress(text, text) from anon, authenticated, public;

-- Dashboard timeline: one row per step of the newest run of each box.
drop view if exists public.qconnect_onboarding;
create view public.qconnect_onboarding
with (security_invoker = true) as
  select r.id as run_id, r.device_id, d.dealer_id, r.state, r.started_at, r.finished_at,
         s.step, s.ordinal, s.label, s.status, s.due_at, s.reported_at, s.detail
    from qconnect_runs r
    join qconnect_devices d on d.device_id = r.device_id
    join qconnect_run_steps s on s.run_id = r.id
   where r.started_at = (select max(r2.started_at) from qconnect_runs r2 where r2.device_id = r.device_id);
grant select on public.qconnect_onboarding to authenticated;

-- ============================================================
-- 08-alerts-workers.sql
-- ============================================================
-- QConnect 08 — alerts and the background workers that raise them
--
-- Nothing here waits for someone to open the dashboard. Five workers run every
-- 30 minutes between 07:00 and 20:00 Mountain time: they fail overdue steps,
-- notice boxes that went quiet, expire commands a box never picked up, catch
-- updates that never reported back healthy, and hand new alerts to the email
-- dispatcher. Outside that window the workers wake and go straight back to
-- sleep, so overnight problems surface in the morning batch.
--
-- Run AFTER 07. Idempotent, safe on a live fleet.

create table if not exists public.qconnect_alerts (
  id              uuid primary key default gen_random_uuid(),
  device_id       text references public.qconnect_devices(device_id) on delete cascade,
  dealer_id       text,
  kind            text not null,     -- step_overdue|step_failed|device_silent|command_expired|update_failed
  severity        text not null default 'warning' check (severity in ('info', 'warning', 'critical')),
  title           text not null,
  detail          text,
  dedupe_key      text not null,
  opened_at       timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  occurrences     integer not null default 1,
  acknowledged_at timestamptz,
  acknowledged_by uuid,
  resolved_at     timestamptz,
  email_sent_at   timestamptz
);
-- One open alert per problem. A flapping box updates the same row instead of
-- filling the page (and the inbox) with copies.
create unique index if not exists qconnect_alerts_open_key
  on public.qconnect_alerts (dedupe_key) where resolved_at is null;
create index if not exists qconnect_alerts_feed_idx
  on public.qconnect_alerts (resolved_at, opened_at desc);
create index if not exists qconnect_alerts_email_idx
  on public.qconnect_alerts (email_sent_at, opened_at) where resolved_at is null;

alter table public.qconnect_alerts enable row level security;
revoke all on public.qconnect_alerts from anon, authenticated;
grant select on public.qconnect_alerts to authenticated;
grant all on public.qconnect_alerts to service_role;

drop policy if exists "qconnect_alerts_read" on public.qconnect_alerts;
create policy "qconnect_alerts_read" on public.qconnect_alerts
  for select to authenticated
  using (
    public.qconnect_is_admin()
    or dealer_id = public.qconnect_dealer_id()
  );

-- ------------------------------------------------------------- raise/resolve
create or replace function public.qconnect_raise_alert(
  p_device_id text, p_kind text, p_severity text, p_title text,
  p_detail text default null, p_dedupe_key text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_key text; v_dealer text;
begin
  v_key := coalesce(nullif(p_dedupe_key, ''), coalesce(p_device_id, '-') || ':' || p_kind);
  select dealer_id into v_dealer from qconnect_devices where device_id = p_device_id;

  insert into qconnect_alerts (device_id, dealer_id, kind, severity, title, detail, dedupe_key)
  values (p_device_id, v_dealer, p_kind, p_severity, p_title, nullif(p_detail, ''), v_key)
  on conflict (dedupe_key) where resolved_at is null do update
    set last_seen_at = now(),
        occurrences  = qconnect_alerts.occurrences + 1,
        detail       = coalesce(nullif(excluded.detail, ''), qconnect_alerts.detail)
  returning id into v_id;

  return v_id;
end;
$$;
revoke execute on function public.qconnect_raise_alert(text, text, text, text, text, text) from anon, authenticated, public;

create or replace function public.qconnect_auto_resolve(p_device_id text, p_kind text)
returns void
language sql security definer set search_path = public as $$
  update qconnect_alerts
     set resolved_at = now()
   where device_id = p_device_id and kind = p_kind and resolved_at is null;
$$;
revoke execute on function public.qconnect_auto_resolve(text, text) from anon, authenticated, public;

create or replace function public.qconnect_ack_alert(p_alert_id uuid, p_resolve boolean default false)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.qconnect_is_admin() then
    raise exception 'not authorized';
  end if;
  update qconnect_alerts
     set acknowledged_at = coalesce(acknowledged_at, now()),
         acknowledged_by = coalesce(acknowledged_by, auth.uid()),
         resolved_at     = case when p_resolve then now() else resolved_at end
   where id = p_alert_id;

  insert into qconnect_audit (actor_id, actor_email, action, detail)
  values (auth.uid(), auth.jwt() ->> 'email',
          case when p_resolve then 'alert:resolve' else 'alert:acknowledge' end,
          jsonb_build_object('alert_id', p_alert_id));
end;
$$;
revoke execute on function public.qconnect_ack_alert(uuid, boolean) from anon;
grant execute on function public.qconnect_ack_alert(uuid, boolean) to authenticated;

-- ==================================================================== workers
-- 1. Steps past their deadline.
create or replace function public.qconnect_worker_steps()
returns integer
language plpgsql security definer set search_path = public as $$
declare v_row record; v_n integer := 0;
begin
  update qconnect_run_steps s
     set status = 'overdue'
    from qconnect_step_defs d
   where d.step = s.step and d.required
     and s.status = 'pending' and s.due_at < now();

  for v_row in
    select s.device_id, s.step, s.label, s.status, s.run_id
      from qconnect_run_steps s
      join qconnect_runs r on r.id = s.run_id and r.state = 'in_progress'
     where s.status in ('overdue', 'failed')
  loop
    perform public.qconnect_raise_alert(
      v_row.device_id,
      case when v_row.status = 'failed' then 'step_failed' else 'step_overdue' end,
      'critical',
      case when v_row.status = 'failed'
           then 'Setup step failed: ' || v_row.label
           else 'Setup step did not finish in time: ' || v_row.label end,
      'Box ' || v_row.device_id || ' has not cleared "' || v_row.label || '".',
      v_row.run_id::text || ':' || v_row.step
    );
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

-- 2. Boxes that have gone quiet. A box is expected every 5 minutes; 20 minutes
--    of silence from a box that was registered means something broke.
create or replace function public.qconnect_worker_silence()
returns integer
language plpgsql security definer set search_path = public as $$
declare v_row record; v_n integer := 0;
begin
  for v_row in
    select device_id, last_seen_at, connection_path
      from qconnect_devices
     where enabled and registered_at is not null
       and last_seen_at < now() - interval '20 minutes'
  loop
    perform public.qconnect_raise_alert(
      v_row.device_id, 'device_silent', 'critical',
      'Box has stopped checking in',
      'Last check-in ' || to_char(v_row.last_seen_at, 'DD/MM/YYYY HH24:MI') ||
      ' over ' || coalesce(v_row.connection_path, 'unknown') || '.',
      v_row.device_id || ':silent'
    );
    v_n := v_n + 1;
  end loop;

  -- Anything that has checked in since is healthy again.
  update qconnect_alerts a
     set resolved_at = now()
    from qconnect_devices d
   where d.device_id = a.device_id and a.kind = 'device_silent'
     and a.resolved_at is null
     and d.last_seen_at >= now() - interval '20 minutes';

  return v_n;
end;
$$;

-- 3. Commands a box never picked up or never finished.
create or replace function public.qconnect_worker_commands()
returns integer
language plpgsql security definer set search_path = public as $$
declare v_row record; v_n integer := 0;
begin
  update qconnect_commands
     set status = 'expired', finished_at = now()
   where status in ('queued', 'sent')
     and (expires_at < now() or attempts >= max_attempts);

  for v_row in
    select device_id, kind, id from qconnect_commands
     where status in ('expired', 'failed') and finished_at > now() - interval '5 minutes'
  loop
    perform public.qconnect_raise_alert(
      v_row.device_id, 'command_expired', 'warning',
      'Instruction was not carried out',
      'The "' || v_row.kind || '" instruction never completed on ' || v_row.device_id || '.',
      v_row.id::text || ':command'
    );
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

-- 4. Updates that installed but never reported back healthy.
create or replace function public.qconnect_worker_updates()
returns integer
language plpgsql security definer set search_path = public as $$
declare v_row record; v_n integer := 0;
begin
  update qconnect_update_attempts
     set status = 'failed', error = coalesce(error, 'no healthy report within 30 minutes'),
         updated_at = now()
   where status in ('started', 'installed')
     and started_at < now() - interval '30 minutes';

  for v_row in
    select device_id, version, id, error from qconnect_update_attempts
     where status in ('failed', 'rolled_back') and updated_at > now() - interval '5 minutes'
  loop
    perform public.qconnect_raise_alert(
      v_row.device_id, 'update_failed', 'critical',
      'Software update did not take',
      'Version ' || v_row.version || ' on ' || v_row.device_id || ': ' ||
      coalesce(v_row.error, 'rolled back to the previous version') || '.',
      v_row.id::text || ':update'
    );
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

-- 5. Dispatcher hand-off. The email itself is sent by the app (see
--    app/routes/api/public/qconnect-alert-emails.ts); the database only says
--    which alerts are still waiting for one.
create or replace function public.qconnect_pending_alert_emails(p_limit integer default 20)
returns table (id uuid, device_id text, dealer_id text, kind text, severity text,
               title text, detail text, occurrences integer, opened_at timestamptz)
language sql security definer set search_path = public as $$
  select a.id, a.device_id, a.dealer_id, a.kind, a.severity, a.title, a.detail,
         a.occurrences, a.opened_at
    from qconnect_alerts a
   where a.resolved_at is null and a.email_sent_at is null
   order by a.opened_at
   limit greatest(1, least(p_limit, 100));
$$;
revoke execute on function public.qconnect_pending_alert_emails(integer) from anon, authenticated, public;

create or replace function public.qconnect_mark_alert_emailed(p_ids uuid[])
returns void
language sql security definer set search_path = public as $$
  update qconnect_alerts set email_sent_at = now() where id = any (p_ids);
$$;
revoke execute on function public.qconnect_mark_alert_emailed(uuid[]) from anon, authenticated, public;

-- The scheduler wakes this every 30 minutes, but the fleet only gets
-- attention during business hours: 07:00-20:00 Mountain time, every day.
-- Checking the hour here (not in the cron pattern) keeps the window correct
-- through daylight-saving changes, since America/Denver handles DST itself.
create or replace function public.qconnect_run_workers()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_hour integer;
begin
  v_hour := extract(hour from now() at time zone 'America/Denver');
  if v_hour < 7 or v_hour >= 20 then
    return jsonb_build_object('skipped', 'outside 07:00-20:00 America/Denver', 'at', now());
  end if;
  return jsonb_build_object(
    'steps',    public.qconnect_worker_steps(),
    'silence',  public.qconnect_worker_silence(),
    'commands', public.qconnect_worker_commands(),
    'updates',  public.qconnect_worker_updates(),
    'at',       now()
  );
end;
$$;
revoke execute on function public.qconnect_run_workers() from anon, authenticated, public;

-- ------------------------------------------------- heartbeat closes the loop
-- Same signature as 05 plus two things: a check-in ticks the onboarding
-- checklist, and it clears the "gone quiet" alert immediately rather than
-- waiting for the next worker run.
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
         stuck_step        = nullif(p_status->>'stuck_step', ''),
         last_error        = nullif(p_status->>'last_error', '')
   where device_id = p_device_id
     and device_token_hash = public.qconnect_token_hash(p_device_token)
   returning enabled into v_enabled;
  if v_enabled is null then
    raise exception 'rejected';
  end if;

  perform public.qconnect_note_progress(p_device_id, 'first_heartbeat');
  perform public.qconnect_auto_resolve(p_device_id, 'device_silent');
  return v_enabled;
end;
$$;
grant execute on function public.qconnect_heartbeat(text, text, jsonb) to anon;

-- Registration ticks the checklist too, for agents that predate step reporting.
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
  perform public.qconnect_note_progress(p_device_id, 'registered');
end;
$$;
grant execute on function public.qconnect_register(text, text, text, text, text, text, text) to anon;

-- ------------------------------------------------------------------ schedule
-- pg_cron is present on Supabase; on a plain Postgres (the local test rig) the
-- workers are simply called by hand.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'qconnect-workers';
    perform cron.schedule('qconnect-workers', '*/30 * * * *', 'select public.qconnect_run_workers()');
  end if;
end;
$$;

-- ============================================================
-- 09-enrolment-batches-net.sql
-- ============================================================
-- QConnect 09 — self-enrolment, batches, and visible network failures
--
-- Three things this adds:
--   1. Enrolment tickets. The bench writes a short-lived, single-use ticket to
--      the card instead of anyone running SQL by hand. On first boot the card
--      presents the ticket and creates its own row. A card that was never
--      ticketed says so, loudly, instead of looping forever.
--   2. Batches. A provisioning run of any size is one row, and every card it
--      wrote is attached to it, so "how far along is the run and which cards
--      failed?" is a single query.
--   3. Network events. Every failed join is recorded with a machine-readable
--      reason, surfaced on the card's setup screen and in the fleet view, and
--      raised as an alert. NetworkManager being broken or absent is itself a
--      reportable reason instead of a silent no-op.
--
-- Run AFTER 08. Idempotent, safe on a live fleet.

-- ======================================================================= batches
create table if not exists public.qconnect_batches (
  id          text primary key,
  label       text,
  dealer_id   text,
  card_count  integer not null default 0,
  notes       text,
  created_at  timestamptz not null default now(),
  created_by  uuid
);
grant select on public.qconnect_batches to authenticated;
grant all    on public.qconnect_batches to service_role;
alter table public.qconnect_batches enable row level security;

drop policy if exists "qconnect_batches_read" on public.qconnect_batches;
create policy "qconnect_batches_read" on public.qconnect_batches
  for select to authenticated
  using (public.qconnect_is_admin() or dealer_id = public.qconnect_dealer_id());

-- =================================================================== enrolments
-- Only the hash of the ticket is stored. A dump of this table cannot be used to
-- enrol anything.
create table if not exists public.qconnect_enrolments (
  ticket_hash text primary key,
  device_id   text not null,
  dealer_id   text not null,
  batch_id    text references public.qconnect_batches(id) on delete set null,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  used_path   text,
  created_at  timestamptz not null default now(),
  created_by  uuid
);
create index if not exists qconnect_enrolments_device_idx on public.qconnect_enrolments (device_id);
create index if not exists qconnect_enrolments_batch_idx  on public.qconnect_enrolments (batch_id);
create index if not exists qconnect_enrolments_open_idx   on public.qconnect_enrolments (expires_at)
  where used_at is null;

grant select on public.qconnect_enrolments to authenticated;
grant all    on public.qconnect_enrolments to service_role;
alter table public.qconnect_enrolments enable row level security;

-- The ticket hash is never exposed to the dashboard, only the status columns.
drop policy if exists "qconnect_enrolments_read" on public.qconnect_enrolments;
create policy "qconnect_enrolments_read" on public.qconnect_enrolments
  for select to authenticated
  using (public.qconnect_is_admin() or dealer_id = public.qconnect_dealer_id());

-- Bench side: issue a ticket for a card about to be written.
create or replace function public.qconnect_issue_enrolment(
  p_device_id text, p_dealer_id text, p_ticket text,
  p_batch_id text default null, p_batch_label text default null,
  p_ttl_days integer default 30
) returns timestamptz
language plpgsql security definer set search_path = public as $$
declare v_expires timestamptz;
begin
  if length(coalesce(p_ticket, '')) < 32 then
    raise exception 'enrolment ticket too short';
  end if;

  if p_batch_id is not null then
    insert into qconnect_batches (id, label, dealer_id)
    values (p_batch_id, coalesce(p_batch_label, p_batch_id), p_dealer_id)
    on conflict (id) do update set label = coalesce(excluded.label, qconnect_batches.label);
  end if;

  v_expires := now() + make_interval(days => greatest(1, least(p_ttl_days, 365)));

  insert into qconnect_enrolments (ticket_hash, device_id, dealer_id, batch_id, expires_at)
  values (public.qconnect_token_hash(p_ticket), p_device_id, p_dealer_id, p_batch_id, v_expires)
  on conflict (ticket_hash) do update
    set device_id = excluded.device_id,
        dealer_id = excluded.dealer_id,
        batch_id  = excluded.batch_id,
        expires_at = excluded.expires_at,
        used_at   = null;

  if p_batch_id is not null then
    update qconnect_batches b
       set card_count = (select count(*) from qconnect_enrolments e where e.batch_id = b.id)
     where b.id = p_batch_id;
  end if;

  return v_expires;
end;
$$;
revoke execute on function public.qconnect_issue_enrolment(text, text, text, text, text, integer)
  from anon, authenticated, public;

-- Card side: first boot. Creates the device row, burns the ticket, opens the
-- onboarding checklist and records how the card got online.
create or replace function public.qconnect_self_register(
  p_device_id text, p_ticket text, p_device_token text,
  p_tailscale_ip text default null, p_connection_path text default null,
  p_connection_detail text default null, p_pi_model text default null
) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_row      qconnect_enrolments%rowtype;
  v_hash     text := public.qconnect_token_hash(p_device_token);
  v_existing text;
begin
  select * into v_row from qconnect_enrolments
   where ticket_hash = public.qconnect_token_hash(p_ticket);

  if v_row.ticket_hash is null then
    raise exception 'enrolment ticket not recognised';
  end if;
  if v_row.device_id <> p_device_id then
    raise exception 'enrolment ticket belongs to another box';
  end if;
  if v_row.expires_at < now() then
    raise exception 'enrolment ticket expired';
  end if;

  -- A card that already enrolled and simply rebooted before it could persist
  -- the fact must not be locked out: same box, same token is allowed through.
  if v_row.used_at is not null then
    select device_token_hash into v_existing from qconnect_devices where device_id = p_device_id;
    if v_existing is distinct from v_hash then
      raise exception 'enrolment ticket already used';
    end if;
  end if;

  insert into qconnect_devices (device_id, dealer_id, device_token, device_token_hash,
                                tailscale_ip, registered_at, last_seen_at, first_seen_at,
                                connection_path, connection_detail, pi_model)
  values (p_device_id, v_row.dealer_id, null, v_hash,
          nullif(p_tailscale_ip, ''), now(), now(), now(),
          nullif(p_connection_path, ''), nullif(p_connection_detail, ''), nullif(p_pi_model, ''))
  on conflict (device_id) do update
    set dealer_id         = v_row.dealer_id,
        device_token      = null,
        device_token_hash = v_hash,
        tailscale_ip      = coalesce(nullif(p_tailscale_ip, ''), qconnect_devices.tailscale_ip),
        registered_at     = coalesce(qconnect_devices.registered_at, now()),
        last_seen_at      = now(),
        first_seen_at     = coalesce(qconnect_devices.first_seen_at, now()),
        connection_path   = coalesce(nullif(p_connection_path, ''), qconnect_devices.connection_path),
        connection_detail = coalesce(nullif(p_connection_detail, ''), qconnect_devices.connection_detail),
        pi_model          = coalesce(nullif(p_pi_model, ''), qconnect_devices.pi_model),
        stuck_step        = null,
        last_error        = null;

  update qconnect_enrolments
     set used_at = coalesce(used_at, now()),
         used_path = coalesce(nullif(p_connection_path, ''), used_path)
   where ticket_hash = v_row.ticket_hash;

  if not exists (select 1 from qconnect_runs where device_id = p_device_id) then
    perform public.qconnect_start_run(p_device_id);
  end if;
  perform public.qconnect_note_progress(p_device_id, 'registered');
  perform public.qconnect_auto_resolve(p_device_id, 'enrolment_failed');

  return 'enrolled';
end;
$$;
grant execute on function public.qconnect_self_register(text, text, text, text, text, text, text) to anon;

-- A card that presents a bad ticket cannot write to any table, so it reports the
-- refusal through this one narrow door instead. Rate-limited by the unique
-- alert key: one open alert per box, however many times it retries.
create or replace function public.qconnect_report_enrolment_failure(
  p_device_id text, p_reason text
) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.qconnect_raise_alert(
    null, 'enrolment_failed', 'critical',
    'A box could not enrol itself',
    'Box ' || coalesce(nullif(p_device_id, ''), 'unknown') || ': ' ||
    coalesce(nullif(p_reason, ''), 'no reason given') || '.',
    coalesce(nullif(p_device_id, ''), 'unknown') || ':enrolment'
  );
end;
$$;
grant execute on function public.qconnect_report_enrolment_failure(text, text) to anon;

-- ================================================================= net events
alter table public.qconnect_devices
  add column if not exists last_net_reason   text,
  add column if not exists last_net_event_at timestamptz,
  add column if not exists netmanager_ok     boolean;

create table if not exists public.qconnect_net_events (
  id            uuid primary key default gen_random_uuid(),
  device_id     text not null references public.qconnect_devices(device_id) on delete cascade,
  dealer_id     text,
  path          text,            -- ethernet | wifi | cellular | hotspot | none
  reason        text not null,   -- ok | wrong_password | ssid_not_in_range | ... | netmanager_unavailable
  detail        text,
  netmanager_ok boolean,
  created_at    timestamptz not null default now()
);
create index if not exists qconnect_net_events_device_idx
  on public.qconnect_net_events (device_id, created_at desc);

grant select on public.qconnect_net_events to authenticated;
grant all    on public.qconnect_net_events to service_role;
alter table public.qconnect_net_events enable row level security;

drop policy if exists "qconnect_net_events_read" on public.qconnect_net_events;
create policy "qconnect_net_events_read" on public.qconnect_net_events
  for select to authenticated
  using (public.qconnect_is_admin() or dealer_id = public.qconnect_dealer_id());

-- Plain-English wording used by both the fleet view and the alert email, so the
-- dashboard and the inbox never disagree about what went wrong.
create or replace function public.qconnect_net_reason_label(p_reason text)
returns text
language sql immutable set search_path = public as $$
  select case p_reason
    when 'ok'                         then 'Connected'
    when 'wrong_password'             then 'Wi-Fi password was not accepted'
    when 'ssid_not_in_range'          then 'Wi-Fi network not found'
    when 'ssid_not_in_range_2g_radio' then 'Wi-Fi network not found (this box is 2.4 GHz only)'
    when 'joined_but_no_internet'     then 'Joined the network but there is no internet behind it'
    when 'captive_portal'             then 'Network shows a sign-in page'
    when 'cellular_sim_locked'        then 'SIM is PIN-locked'
    when 'cellular_sim_disabled'      then 'SIM or modem radio is switched off'
    when 'cellular_no_tower'          then 'Modem cannot see a mobile tower'
    when 'cellular_no_apn'            then 'Modem fitted but no mobile APN set'
    when 'cellular_failed'            then 'Mobile data did not connect'
    when 'netmanager_unavailable'     then 'The box network service is not running'
    when 'no_path'                    then 'No cable, no known Wi-Fi, no modem'
    when 'no_wifi_radio'              then 'No Wi-Fi radio found on this box'
    else coalesce(p_reason, 'Unknown')
  end;
$$;
grant execute on function public.qconnect_net_reason_label(text) to authenticated, anon;

create or replace function public.qconnect_report_net_event(
  p_device_id text, p_device_token text, p_reason text,
  p_path text default null, p_detail text default null,
  p_netmanager_ok boolean default true
) returns void
language plpgsql security definer set search_path = public as $$
declare v_dealer text;
begin
  select dealer_id into v_dealer from qconnect_devices
   where device_id = p_device_id
     and device_token_hash = public.qconnect_token_hash(p_device_token);
  if v_dealer is null then
    raise exception 'rejected';
  end if;

  insert into qconnect_net_events (device_id, dealer_id, path, reason, detail, netmanager_ok)
  values (p_device_id, v_dealer, nullif(p_path, ''), p_reason, nullif(p_detail, ''), p_netmanager_ok);

  update qconnect_devices
     set last_net_reason   = p_reason,
         last_net_event_at = now(),
         netmanager_ok     = p_netmanager_ok
   where device_id = p_device_id;

  -- Keep the history useful, not infinite: the newest 50 events per box.
  delete from qconnect_net_events e
   where e.device_id = p_device_id
     and e.id not in (
       select id from qconnect_net_events
        where device_id = p_device_id
        order by created_at desc
        limit 50
     );

  if p_reason = 'ok' then
    perform public.qconnect_auto_resolve(p_device_id, 'network_problem');
  else
    perform public.qconnect_raise_alert(
      p_device_id, 'network_problem',
      case when p_netmanager_ok then 'warning' else 'critical' end,
      public.qconnect_net_reason_label(p_reason),
      'Box ' || p_device_id || ': ' || public.qconnect_net_reason_label(p_reason) ||
        coalesce(' (' || nullif(p_detail, '') || ')', '') || '.',
      p_device_id || ':network'
    );
  end if;
end;
$$;
grant execute on function public.qconnect_report_net_event(text, text, text, text, text, boolean) to anon;

-- ================================================================= fleet view
-- Adds the last network failure in plain English, the network-service health
-- flag, and the batch the card came from.
drop view if exists public.qconnect_fleet;
create view public.qconnect_fleet as
  select d.device_id,
         d.dealer_id,
         d.tailscale_ip,
         d.enabled,
         d.registered_at,
         d.last_seen_at,
         d.first_seen_at,
         d.last_status,
         d.created_at,
         d.connection_path,
         d.connection_detail,
         d.link_quality,
         d.pi_model,
         d.agent_version,
         d.stuck_step,
         d.last_error,
         d.last_net_reason,
         d.last_net_event_at,
         public.qconnect_net_reason_label(d.last_net_reason) as last_net_label,
         coalesce(d.netmanager_ok, true) as netmanager_ok,
         e.batch_id,
         (d.last_seen_at is not null and d.last_seen_at > now() - interval '15 minutes') as online,
         case
           when not d.enabled then 'disabled'
           when d.registered_at is null and d.last_seen_at is null then 'never_checked_in'
           when d.last_seen_at is null or d.last_seen_at < now() - interval '15 minutes' then 'offline'
           when d.netmanager_ok is false then 'network_service_down'
           when d.stuck_step is not null then 'stuck_' || d.stuck_step
           when d.link_quality is not null and d.link_quality < 30 then 'weak_signal'
           else 'healthy'
         end as health
  from public.qconnect_devices d
  left join lateral (
    select batch_id from public.qconnect_enrolments
     where device_id = d.device_id
     order by created_at desc limit 1
  ) e on true
  where public.qconnect_is_admin()
     or d.dealer_id = public.qconnect_dealer_id();
revoke all on public.qconnect_fleet from anon;
grant select on public.qconnect_fleet to authenticated;

-- Batch progress, one row per provisioning run.
drop view if exists public.qconnect_batch_progress;
create view public.qconnect_batch_progress
with (security_invoker = true) as
  select b.id as batch_id,
         b.label,
         b.dealer_id,
         b.created_at,
         count(e.ticket_hash)                                        as cards_written,
         count(*) filter (where e.used_at is not null)               as cards_enrolled,
         count(*) filter (where d.last_seen_at > now() - interval '15 minutes') as cards_online,
         count(*) filter (where e.used_at is null and e.expires_at < now())     as tickets_expired
    from public.qconnect_batches b
    left join public.qconnect_enrolments e on e.batch_id = b.id
    left join public.qconnect_devices    d on d.device_id = e.device_id
   group by b.id, b.label, b.dealer_id, b.created_at;
grant select on public.qconnect_batch_progress to authenticated;

-- ============================================================ bench autochecks
-- Anything the box can prove by itself is ticked without a human. Steps that
-- need eyes or hands (LEDs, unplugging a cable) stay manual.
create or replace function public.qconnect_bench_autocheck(p_run_id uuid default null)
returns integer
language plpgsql security definer set search_path = public as $$
declare v_run record; v_dev record; v_n integer := 0; v_hit integer;
begin
  for v_run in
    select r.id, r.device_id from qconnect_bench_runs r
     where r.verdict = 'in_progress'
       and (p_run_id is null or r.id = p_run_id)
  loop
    select * into v_dev from qconnect_devices where device_id = v_run.device_id;
    continue when v_dev.device_id is null;

    -- 1.3 preregistered, 2.3 registered with a tunnel address,
    -- 2.4/2.7 checking in, 8.x the path it actually used.
    update qconnect_bench_checks c
       set passed = true, checked_at = now(), checked_by = 'auto',
           note = coalesce(c.note, 'Confirmed automatically from the box reports')
     where c.run_id = v_run.id and c.passed is distinct from true
       and (
         (c.step = '1.3' and v_dev.registered_at is null)
         or (c.step = '2.3' and v_dev.registered_at is not null and v_dev.tailscale_ip is not null)
         or (c.step = '2.4' and v_dev.last_seen_at > now() - interval '15 minutes')
         or (c.step = '2.7' and v_dev.last_seen_at > now() - interval '15 minutes')
         or (c.step = '8.1' and v_dev.connection_path = 'ethernet')
         or (c.step = '8.2' and v_dev.connection_path = 'wifi')
         or (c.step = '8.7' and v_dev.connection_path = 'cellular')
         or (c.step = '8.5' and v_dev.connection_path = 'cellular')
         or (c.step = '8.6' and v_dev.connection_path = 'cellular')
         or (c.step = '8.11' and v_dev.connection_path = 'hotspot')
         or (c.step = '8.16' and v_dev.pi_model ilike '%Zero 2%'
             and exists (select 1 from qconnect_net_events n
                          where n.device_id = v_dev.device_id
                            and n.reason = 'ssid_not_in_range_2g_radio'))
       );
    get diagnostics v_hit = row_count;
    v_n := v_n + v_hit;
  end loop;
  return v_n;
end;
$$;
revoke execute on function public.qconnect_bench_autocheck(uuid) from anon, public;
grant execute on function public.qconnect_bench_autocheck(uuid) to authenticated;

-- The worker set gains the bench autochecker, so a card being benched ticks its
-- own boxes as it comes up rather than after someone refreshes the page.
create or replace function public.qconnect_run_workers()
returns jsonb
language sql security definer set search_path = public as $$
  select jsonb_build_object(
    'steps',    public.qconnect_worker_steps(),
    'silence',  public.qconnect_worker_silence(),
    'commands', public.qconnect_worker_commands(),
    'updates',  public.qconnect_worker_updates(),
    'bench',    public.qconnect_bench_autocheck(null),
    'at',       now()
  );
$$;
revoke execute on function public.qconnect_run_workers() from anon, authenticated, public;
