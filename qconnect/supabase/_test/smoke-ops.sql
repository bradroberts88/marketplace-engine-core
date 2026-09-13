-- Smoke test for 06-08: command queue, checklist, workers and alerts.
-- Run after smoke.sql on the throwaway cluster.
\set ON_ERROR_STOP on

-- A pre-registered card opens a run with one row per step.
select public.qconnect_preregister('QCN-OPS-1', 'DLR-1', 'tok-ops-1');
do $$
declare n integer;
begin
  select count(*) into n from qconnect_run_steps s
    join qconnect_runs r on r.id = s.run_id
   where r.device_id = 'QCN-OPS-1' and r.state = 'in_progress';
  if n <> (select count(*) from qconnect_step_defs) then
    raise exception 'expected a full checklist, got % rows', n;
  end if;
end $$;

-- Reporting a later step passes the earlier ones too.
select public.qconnect_report_step('QCN-OPS-1', 'tok-ops-1', 'registered', true, 'ethernet');
do $$
declare n integer;
begin
  select count(*) into n from qconnect_run_steps s
    join qconnect_runs r on r.id = s.run_id
   where r.device_id = 'QCN-OPS-1' and s.ordinal <= 4 and s.status <> 'passed';
  if n <> 0 then raise exception 'earlier steps were not back-filled (% left)', n; end if;
end $$;

-- A wrong token is refused.
do $$
begin
  begin
    perform public.qconnect_report_step('QCN-OPS-1', 'wrong', 'power_on', true);
    raise exception 'a bad token was accepted';
  exception when others then
    if sqlerrm = 'a bad token was accepted' then raise; end if;
  end;
end $$;

-- The heartbeat completes the run (first_heartbeat is the last required step).
select public.qconnect_heartbeat('QCN-OPS-1', 'tok-ops-1',
  '{"connection_path":"ethernet","link_quality":100}'::jsonb);
do $$
declare v text;
begin
  select state into v from qconnect_runs where device_id = 'QCN-OPS-1'
   order by started_at desc limit 1;
  if v <> 'complete' then raise exception 'run should be complete, is %', v; end if;
end $$;

-- Command queue: issue as admin, poll as the device, acknowledge.
create or replace function auth.jwt() returns jsonb language sql stable as
  $f$ select '{"email":"admin@example.com","app_metadata":{"role":"admin"}}'::jsonb $f$;

do $$
declare v_cmd uuid; v_poll jsonb;
begin
  v_cmd := public.qconnect_issue_command('QCN-OPS-1', 'reconnect', '{}'::jsonb);
  v_poll := public.qconnect_poll_commands('QCN-OPS-1', 'tok-ops-1');
  if jsonb_array_length(v_poll->'commands') <> 1 then
    raise exception 'expected exactly one queued command, got %', v_poll->'commands';
  end if;
  perform public.qconnect_ack_command('QCN-OPS-1', 'tok-ops-1', v_cmd, true, '{}'::jsonb, null);
  if (select status from qconnect_commands where id = v_cmd) <> 'done' then
    raise exception 'acknowledged command did not close';
  end if;
end $$;

-- An unknown instruction is refused outright.
do $$
begin
  begin
    perform public.qconnect_issue_command('QCN-OPS-1', 'rm-rf', '{}'::jsonb);
    raise exception 'an unknown instruction was accepted';
  exception when others then
    if sqlerrm = 'an unknown instruction was accepted' then raise; end if;
  end;
end $$;

-- A disabled box gets no work at all.
select public.qconnect_set_enabled('QCN-OPS-1', false);
do $$
declare v jsonb;
begin
  v := public.qconnect_poll_commands('QCN-OPS-1', 'tok-ops-1');
  if (v->>'enabled') <> 'false' then raise exception 'a disabled box was handed work'; end if;
end $$;
select public.qconnect_set_enabled('QCN-OPS-1', true);

-- Silence worker: a registered box that has not been seen for an hour alerts,
-- and a fresh check-in resolves it.
select public.qconnect_preregister('QCN-OPS-2', 'DLR-1', 'tok-ops-2');
select public.qconnect_register('QCN-OPS-2', 'DLR-1', 'tok-ops-2', '100.64.0.9');
update qconnect_devices set last_seen_at = now() - interval '1 hour' where device_id = 'QCN-OPS-2';
select public.qconnect_worker_silence();
do $$
begin
  if not exists (select 1 from qconnect_alerts
                  where device_id = 'QCN-OPS-2' and kind = 'device_silent' and resolved_at is null)
  then raise exception 'silent box did not raise an alert'; end if;
end $$;
select public.qconnect_heartbeat('QCN-OPS-2', 'tok-ops-2', '{}'::jsonb);
do $$
begin
  if exists (select 1 from qconnect_alerts
              where device_id = 'QCN-OPS-2' and kind = 'device_silent' and resolved_at is null)
  then raise exception 'a box that checked in is still flagged as silent'; end if;
end $$;

-- Repeats fold into one open row.
select public.qconnect_worker_silence();
update qconnect_devices set last_seen_at = now() - interval '2 hours' where device_id = 'QCN-OPS-2';
select public.qconnect_worker_silence();
select public.qconnect_worker_silence();
do $$
declare n integer;
begin
  select count(*) into n from qconnect_alerts
   where device_id = 'QCN-OPS-2' and kind = 'device_silent' and resolved_at is null;
  if n <> 1 then raise exception 'expected one open silence alert, got %', n; end if;
end $$;

-- A card that never came up: its required steps go past the deadline and alert.
select public.qconnect_preregister('QCN-OPS-3', 'DLR-1', 'tok-ops-3');
update qconnect_run_steps s set due_at = now() - interval '1 hour'
  from qconnect_runs r where r.id = s.run_id and r.device_id = 'QCN-OPS-3' and s.status = 'pending';
select public.qconnect_worker_steps();
do $$
begin
  if not exists (select 1 from qconnect_alerts where device_id = 'QCN-OPS-3' and kind = 'step_overdue')
  then raise exception 'an overdue step did not alert'; end if;
  -- The optional "first listing" step must NOT raise anything.
  if exists (select 1 from qconnect_run_steps s join qconnect_runs r on r.id = s.run_id
              where r.device_id = 'QCN-OPS-3' and s.step = 'first_listing' and s.status = 'overdue')
  then raise exception 'an optional step was marked overdue'; end if;
end $$;

-- Releases: a rollout aimed at one dealership reaches its boxes only.
select public.qconnect_publish_release('1.0.0', 'https://example.test/a.tar.gz',
  repeat('a', 64), 'c2ln', 'first', 'stable');
select public.qconnect_start_rollout('1.0.0', 'dealer', 'DLR-1', 100);
do $$
begin
  if not exists (select 1 from public.qconnect_target_release('QCN-OPS-1') where version = '1.0.0')
  then raise exception 'a targeted box was not offered the release'; end if;
end $$;
select public.qconnect_stop_rollout('1.0.0');
do $$
begin
  if exists (select 1 from public.qconnect_target_release('QCN-OPS-1'))
  then raise exception 'a stopped rollout is still being offered'; end if;
end $$;

-- An update that never reports healthy is failed and alerted.
select public.qconnect_report_update('QCN-OPS-1', 'tok-ops-1', '1.0.0', 'installed', '0.9.0', null);
update qconnect_update_attempts set started_at = now() - interval '2 hours' where version = '1.0.0';
select public.qconnect_worker_updates();
do $$
begin
  if not exists (select 1 from qconnect_alerts where device_id = 'QCN-OPS-1' and kind = 'update_failed')
  then raise exception 'a stalled update did not alert'; end if;
end $$;

-- The dispatcher hand-off lists unsent alerts and marks them once.
do $$
declare ids uuid[];
begin
  select array_agg(id) into ids from public.qconnect_pending_alert_emails(50);
  if ids is null or array_length(ids, 1) = 0 then
    raise exception 'no alerts were waiting for an email';
  end if;
  perform public.qconnect_mark_alert_emailed(ids);
  if exists (select 1 from public.qconnect_pending_alert_emails(50)) then
    raise exception 'alerts were queued for a second email';
  end if;
end $$;

-- The combined entry point either runs the workers (07:00-20:00 Mountain) or
-- reports that it skipped. The individual workers stay ungated so the checks
-- above work at any hour.
do $$
declare v jsonb;
begin
  v := public.qconnect_run_workers();
  if not (v ? 'steps' or v ? 'skipped') then
    raise exception 'run_workers returned an unexpected shape: %', v;
  end if;
  if v ? 'skipped' and (v->>'skipped') not like 'outside 07:00-20:00%' then
    raise exception 'run_workers skipped for an unexpected reason: %', v;
  end if;
end $$;

-- One key per card. A key inside the 14-day warning window must raise an alert
-- while there is still time to rewrite the card, and the rotation screen must
-- show the card's state in words an operator can act on.
do $$
declare v_state text; v_n integer;
begin
  perform public.qconnect_record_card_key('QCN-OPS-1', 'key-abc', now() + interval '5 days');
  v_n := public.qconnect_worker_keys();
  if v_n < 1 then
    raise exception 'an expiring key raised no alert';
  end if;
  if not exists (select 1 from qconnect_alerts
                  where device_id = 'QCN-OPS-1' and kind = 'key_expiring' and resolved_at is null) then
    raise exception 'the expiring-key alert was not recorded';
  end if;

  select key_state into v_state from qconnect_keys where device_id = 'QCN-OPS-1';
  if v_state is distinct from 'expiring soon' then
    raise exception 'rotation screen shows %, expected expiring soon', coalesce(v_state, 'nothing');
  end if;

  perform public.qconnect_record_card_key('QCN-OPS-1', 'key-fresh', now() + interval '90 days');
  select key_state into v_state from qconnect_keys where device_id = 'QCN-OPS-1';
  if v_state is distinct from 'ok' then
    raise exception 'after rewriting the card the key still reads %', v_state;
  end if;
end $$;

select 'smoke-ops: all checks passed' as result;
