\set ON_ERROR_STOP on

-- 1. preregister stores only a fingerprint
select public.qconnect_preregister('QCN-TEST-001', 'bench-test', 'plain-token-abc');
select case when device_token is null and device_token_hash =
            encode(extensions.digest('plain-token-abc','sha256'),'hex')
       then 'PASS token hashed, plaintext empty' else 'FAIL token storage' end
from public.qconnect_devices where device_id = 'QCN-TEST-001';

-- 2. wrong token is rejected
do $$
begin
  perform public.qconnect_register('QCN-TEST-001','bench-test','wrong','100.64.0.1');
  raise exception 'FAIL bad token accepted';
exception when others then
  if sqlerrm = 'registration rejected' then raise notice 'PASS bad token rejected';
  else raise; end if;
end $$;

-- 3. unknown device cannot self-register
do $$
begin
  perform public.qconnect_register('QCN-GHOST','x','plain-token-abc','100.64.0.9');
  raise exception 'FAIL unknown device accepted';
exception when others then
  if sqlerrm = 'registration rejected' then raise notice 'PASS unknown device rejected';
  else raise; end if;
end $$;

-- 4. correct token registers and heartbeats
select public.qconnect_register('QCN-TEST-001','bench-test','plain-token-abc','100.64.0.1');
select case when public.qconnect_heartbeat('QCN-TEST-001','plain-token-abc',
              '{"temp_c":48.2,"mem_free_mb":220}'::jsonb)
       then 'PASS heartbeat accepted, box enabled' else 'FAIL heartbeat' end;

-- 5. kill switch refuses a non-admin token
do $$
begin
  perform public.qconnect_set_enabled('QCN-TEST-001', false);
  raise exception 'FAIL non-admin flipped the kill switch';
exception when others then
  if sqlerrm = 'not authorized' then raise notice 'PASS non-admin blocked from kill switch';
  else raise; end if;
end $$;

-- 6. views hide everything from a non-admin, non-dealer token
select case when count(*) = 0 then 'PASS fleet view hidden from unscoped user'
            else 'FAIL fleet view leaked' end from public.qconnect_fleet;

-- become an admin
insert into auth.users (id, email, raw_app_meta_data)
values ('11111111-1111-1111-1111-111111111111','admin@example.com','{"role":"admin"}');
create or replace function auth.uid() returns uuid language sql stable
  as $f$ select '11111111-1111-1111-1111-111111111111'::uuid $f$;
create or replace function auth.jwt() returns jsonb language sql stable
  as $f$ select '{"app_metadata":{"role":"admin"}}'::jsonb $f$;

-- 7. admin sees the fleet and can flip the switch, and it is audited
select case when count(*) = 1 then 'PASS admin sees the fleet' else 'FAIL admin view' end
from public.qconnect_fleet;
select public.qconnect_set_enabled('QCN-TEST-001', false);
select case when count(*) = 1 then 'PASS kill switch audited with actor email' else 'FAIL audit' end
from public.qconnect_audit where device_id='QCN-TEST-001' and action='disable'
  and actor_email='admin@example.com';

-- 8. a disabled box is told to stand down instead of being accepted silently
select case when public.qconnect_heartbeat('QCN-TEST-001','plain-token-abc','{}'::jsonb) = false
       then 'PASS disabled box gets enabled=false' else 'FAIL kill switch not enforced' end;

-- 9. bench run seeds the full checklist and the go/no-go rule holds
select public.qconnect_bench_start('QCN-TEST-001','Bench VA','Pi Zero 2 W') as run \gset
select case when count(*) = 39 then 'PASS 39 checklist steps seeded'
            else 'FAIL seeded ' || count(*) end
from public.qconnect_bench_checks where run_id = :'run';
select case when count(*) = 10 then 'PASS connectivity phase seeded'
            else 'FAIL connectivity phase ' || count(*) end
from public.qconnect_bench_checks where run_id = :'run' and phase = 8;
select case when public.qconnect_bench_finish(:'run') = 'no_go'
       then 'PASS open steps produce no_go' else 'FAIL verdict' end;
update public.qconnect_bench_checks set passed = true where run_id = :'run';
select case when public.qconnect_bench_finish(:'run') = 'go'
       then 'PASS all steps passed produce go' else 'FAIL verdict' end;
