create schema auth;
create schema extensions;
create table auth.users(id uuid primary key default gen_random_uuid(), email text, raw_app_meta_data jsonb);
create role anon;
create role authenticated;
create role service_role;
-- stand-ins for the Supabase auth helpers; the smoke test swaps these bodies
create function auth.uid() returns uuid language sql stable as $f$ select null::uuid $f$;
create function auth.jwt() returns jsonb language sql stable as $f$ select '{}'::jsonb $f$;

-- Stand-ins for the Supabase realtime surface that Fleet Manager's own
-- migrations touch (broadcast topics). Local test harness only.
create schema if not exists realtime;
create table if not exists realtime.messages(
  id bigserial primary key, topic text, extension text, payload jsonb, event text
);
alter table realtime.messages enable row level security;
create or replace function realtime.topic() returns text language sql stable as $f$ select ''::text $f$;
create or replace function realtime.send(
  payload jsonb, event text, topic text, private boolean default true
) returns void language sql as $f$ select $f$;
do $$ begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    execute 'create publication supabase_realtime';
  end if;
end $$;
