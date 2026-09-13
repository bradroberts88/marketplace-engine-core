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
drop view if exists public.qconnect_offline;
create view public.qconnect_offline as
  select device_id, dealer_id, tailscale_ip, last_seen_at
  from qconnect_devices
  where enabled and (last_seen_at is null or last_seen_at < now() - interval '15 minutes');
revoke all on public.qconnect_offline from anon;
grant select on public.qconnect_offline to authenticated;
