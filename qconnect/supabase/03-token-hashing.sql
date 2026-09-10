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
