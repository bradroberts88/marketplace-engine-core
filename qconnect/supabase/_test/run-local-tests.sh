#!/usr/bin/env bash
set -e
export PATH="$PATH"
D=${PGT_DIR:-/tmp/pgt}
rm -rf $D/data
initdb -D $D/data -U pg > $D/initdb.log 2>&1
pg_ctl -D $D/data -o "-k $D -h ''" -l $D/log start > /dev/null
sleep 1
createdb -h $D -U pg qc
psql -h $D -U pg -q -d qc -f $D/prelude.sql
for f in 01-schema-hardened 02-admin-killswitch-audit 03-token-hashing 04-bench-tests; do
  echo "== $f"
  psql -h $D -U pg -d qc -v ON_ERROR_STOP=1 -q -f ${SQL_DIR:-'..'}/$f.sql && echo "   OK"
  echo "== $f (re-run, idempotency)"
  psql -h $D -U pg -d qc -v ON_ERROR_STOP=1 -q -f ${SQL_DIR:-'..'}/$f.sql && echo "   OK"
done
echo "== smoke test"
psql -h $D -U pg -d qc -v ON_ERROR_STOP=1 -q -f $D/smoke.sql
pg_ctl -D $D/data stop > /dev/null
