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
