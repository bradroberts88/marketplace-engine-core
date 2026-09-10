create schema auth;
create schema extensions;
create table auth.users(id uuid primary key default gen_random_uuid(), email text, raw_app_meta_data jsonb);
create role anon;
create role authenticated;
create role service_role;
-- stand-ins for the Supabase auth helpers; the smoke test swaps these bodies
create function auth.uid() returns uuid language sql stable as $f$ select null::uuid $f$;
create function auth.jwt() returns jsonb language sql stable as $f$ select '{}'::jsonb $f$;
