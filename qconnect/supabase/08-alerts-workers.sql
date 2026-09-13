-- QConnect 08 — alerts and the background workers that raise them
--
-- Nothing here waits for someone to open the dashboard. Five workers run once
-- a minute: they fail overdue steps, notice boxes that went quiet, expire
-- commands a box never picked up, catch updates that never reported back
-- healthy, and hand new alerts to the email dispatcher.
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
-- waiting up to a minute for the worker.
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
