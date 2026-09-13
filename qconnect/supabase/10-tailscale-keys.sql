-- QConnect 10 — one tunnel key per card, and a screen that can see them
-- ---------------------------------------------------------------------------
-- A single shared key used for every card is why one box joined the private
-- network and the next, written from the same laptop an hour later, silently
-- did not: the moment that key was revoked, expired or hit its use limit,
-- every card written afterwards was dead on arrival and looked identical to a
-- good one.
--
-- From here each card is written with its own single-use key, and the key's id
-- and expiry are recorded against the card. That gives three things the fleet
-- never had: a box can be cut off on its own without touching any other box, a
-- key that is about to expire is visible before a card is shipped, and a card
-- that was written with a key nobody recorded shows up as exactly that.
--
-- Safe to run more than once.

alter table qconnect_devices
  add column if not exists tailscale_key_id         text,
  add column if not exists tailscale_key_expires_at timestamptz,
  add column if not exists tailscale_key_issued_at  timestamptz,
  add column if not exists tailscale_key_revoked_at timestamptz;

alter table qconnect_enrolments
  add column if not exists tailscale_key_id         text,
  add column if not exists tailscale_key_expires_at timestamptz;

create index if not exists qconnect_devices_key_expiry_idx
  on qconnect_devices (tailscale_key_expires_at)
  where tailscale_key_revoked_at is null;

-- Card-writing side: record which key went onto which card, at the moment the
-- card is written. Called by qconnect/flash/provision-sd.sh with the service
-- key; never reachable from a browser or from a device.
create or replace function public.qconnect_record_card_key(
  p_device_id text, p_key_id text, p_expires_at timestamptz
) returns void
language plpgsql security definer set search_path = public as $$
begin
  update qconnect_enrolments
     set tailscale_key_id         = nullif(p_key_id, ''),
         tailscale_key_expires_at = p_expires_at
   where device_id = p_device_id and used_at is null;

  update qconnect_devices
     set tailscale_key_id         = nullif(p_key_id, ''),
         tailscale_key_expires_at = p_expires_at,
         tailscale_key_issued_at  = now(),
         tailscale_key_revoked_at = null
   where device_id = p_device_id;
end;
$$;
revoke execute on function public.qconnect_record_card_key(text, text, timestamptz)
  from anon, authenticated, public;

-- Carry the key details across when the card enrols itself, so a box that
-- created its own row still shows the key it joined with.
create or replace function public.qconnect_adopt_enrolment_key(p_device_id text)
returns void
language sql security definer set search_path = public as $$
  update qconnect_devices d
     set tailscale_key_id         = coalesce(d.tailscale_key_id, e.tailscale_key_id),
         tailscale_key_expires_at = coalesce(d.tailscale_key_expires_at, e.tailscale_key_expires_at),
         tailscale_key_issued_at  = coalesce(d.tailscale_key_issued_at, e.created_at)
    from qconnect_enrolments e
   where d.device_id = p_device_id and e.device_id = p_device_id;
$$;
revoke execute on function public.qconnect_adopt_enrolment_key(text) from anon, authenticated, public;

-- Marked when an operator retires a card's key from the rotation screen. The
-- revocation at the tunnel provider itself is done by the app; this records it.
-- Callable from the rotation screen, but it re-checks admin rights here: the
-- screen being hidden is never the thing that keeps a dealer out.
create or replace function public.qconnect_mark_key_revoked(p_device_id text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.qconnect_is_admin() then
    raise exception 'only an administrator can retire a card key';
  end if;
  update qconnect_devices
     set tailscale_key_revoked_at = now()
   where device_id = p_device_id;
  perform public.qconnect_audit_write('key_revoked', p_device_id,
    'Retired the remote-access key for ' || p_device_id);
  update qconnect_alerts
     set resolved_at = now()
   where device_id = p_device_id and kind = 'key_expiring' and resolved_at is null;
end;
$$;
revoke execute on function public.qconnect_mark_key_revoked(text) from anon, public;
grant execute on function public.qconnect_mark_key_revoked(text) to authenticated;

-- What the key-rotation screen reads. One row per card, role-scoped the same
-- way every other fleet view is: an admin sees the fleet, a dealer sees theirs.
drop view if exists public.qconnect_keys;
create view public.qconnect_keys as
  select d.device_id,
         d.dealer_id,
         d.tailscale_ip,
         -- A card that enrolled itself may carry the key details on its
         -- enrolment ticket rather than on the device row; show either.
         coalesce(d.tailscale_key_id, e.tailscale_key_id) as tailscale_key_id,
         coalesce(d.tailscale_key_issued_at, e.created_at) as tailscale_key_issued_at,
         coalesce(d.tailscale_key_expires_at, e.tailscale_key_expires_at) as tailscale_key_expires_at,
         d.tailscale_key_revoked_at,
         d.registered_at,
         d.last_seen_at,
         case
           when d.tailscale_key_revoked_at is not null then 'revoked'
           when coalesce(d.tailscale_key_id, e.tailscale_key_id) is null then 'unrecorded'
           when coalesce(d.tailscale_key_expires_at, e.tailscale_key_expires_at) is null then 'no expiry recorded'
           when coalesce(d.tailscale_key_expires_at, e.tailscale_key_expires_at) < now() then 'expired'
           when coalesce(d.tailscale_key_expires_at, e.tailscale_key_expires_at) < now() + interval '14 days' then 'expiring soon'
           else 'ok'
         end as key_state,
         case when coalesce(d.tailscale_key_expires_at, e.tailscale_key_expires_at) is null then null
              else greatest(0, date_part('day',
                     coalesce(d.tailscale_key_expires_at, e.tailscale_key_expires_at) - now()))::int
         end as days_left
    from qconnect_devices d
    left join lateral (
      select * from qconnect_enrolments x
       where x.device_id = d.device_id
       order by x.created_at desc limit 1
    ) e on true
   where public.qconnect_is_admin() or d.dealer_id = public.qconnect_dealer_id();
grant select on public.qconnect_keys to authenticated;

-- Worker: a key that is within a fortnight of expiring is a card that will
-- stop being reachable, so it is raised while there is still time to rewrite
-- it - not on the morning it goes dark.
create or replace function public.qconnect_worker_keys()
returns integer
language plpgsql security definer set search_path = public as $$
declare v_row record; v_n integer := 0;
begin
  for v_row in
    select device_id, tailscale_key_expires_at
      from qconnect_devices
     where tailscale_key_revoked_at is null
       and tailscale_key_expires_at is not null
       and tailscale_key_expires_at < now() + interval '14 days'
  loop
    perform public.qconnect_raise_alert(
      v_row.device_id,
      'key_expiring',
      case when v_row.tailscale_key_expires_at < now() then 'critical' else 'warning' end,
      case when v_row.tailscale_key_expires_at < now()
           then 'Remote access key has expired'
           else 'Remote access key expires soon' end,
      'Box ' || v_row.device_id || ': its key ' ||
        case when v_row.tailscale_key_expires_at < now() then 'expired on ' else 'expires on ' end ||
        to_char(v_row.tailscale_key_expires_at, 'DD/MM/YYYY') ||
        '. Rewrite the card with a fresh key before it needs remote help.',
      v_row.device_id || ':key'
    );
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;
revoke execute on function public.qconnect_worker_keys() from anon, authenticated, public;

-- Fold the key check into the same 30-minute, 07:00-20:00 Mountain window as
-- every other worker.
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
    'keys',     public.qconnect_worker_keys(),
    'bench',    public.qconnect_bench_autocheck(null),
    'at',       now()
  );
end;
$$;
revoke execute on function public.qconnect_run_workers() from anon, authenticated, public;
