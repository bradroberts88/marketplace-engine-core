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
