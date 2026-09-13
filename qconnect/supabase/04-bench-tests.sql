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
    (v_run, 8, '8.1', 'Cellular: AT&T SIM detected by ModemManager'),
    (v_run, 8, '8.2', 'Cellular: modem registers to tower with no PIN lock'),
    (v_run, 8, '8.3', 'Cellular: box comes online using APN broadband with no Wi-Fi or cable'),
    (v_run, 8, '8.4', 'Cellular: heartbeat reports connection_path=cellular and link_quality > 0'),
    (v_run, 8, '8.5', 'Cellular: wrong APN (e.g. invalid.example) fails with cellular_failed'),
    (v_run, 8, '8.6', 'Cellular: failover from cellular to cable works when cable is plugged in'),
    (v_run, 8, '8.7', 'Cellular: portal APN override persists to provision.json and reconnects');

  return v_run;
end;
$$;
revoke execute on function public.qconnect_bench_start(text, text, text) from anon, public;
grant execute on function public.qconnect_bench_start(text, text, text) to authenticated;

-- Go/no-go rule from the checklist: phases 1, 2 and 4 clean, phase 3 clean,
-- phase 7 clean. Any recorded failure anywhere is a no-go.
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
