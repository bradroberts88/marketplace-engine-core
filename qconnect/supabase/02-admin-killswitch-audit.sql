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
drop view if exists public.qconnect_fleet;
create view public.qconnect_fleet as
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
drop view if exists public.qconnect_offline;
create view public.qconnect_offline as
  select device_id, dealer_id, tailscale_ip, last_seen_at
  from public.qconnect_devices
  where enabled
    and (last_seen_at is null or last_seen_at < now() - interval '15 minutes')
    and (public.qconnect_is_admin() or dealer_id = public.qconnect_dealer_id());
revoke all on public.qconnect_offline from anon;
grant select on public.qconnect_offline to authenticated;
