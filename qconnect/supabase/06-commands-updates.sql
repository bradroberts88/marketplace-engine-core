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
