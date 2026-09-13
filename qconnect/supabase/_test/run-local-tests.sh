#!/usr/bin/env bash
# Runs 01-04 against a throwaway local Postgres (twice each, to prove they are
# idempotent), then a smoke test covering token hashing, registration refusal,
# the admin-only kill switch, view scoping and the bench go/no-go rule.
#
# Needs a local postgres 14+ on PATH and a non-root user. Nothing touches the
# real project. From this directory:  ./run-local-tests.sh
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
SQL_DIR="${SQL_DIR:-$HERE/..}"
D="${PGT_DIR:-/tmp/qconnect-pgtest}"
mkdir -p "$D"
rm -rf $D/data $D/.s.PGSQL.*
initdb -D $D/data -U pg > $D/initdb.log 2>&1
pg_ctl -D $D/data -o "-k $D -h ''" -l $D/log start > /dev/null
sleep 1
createdb -h $D -U pg qc
psql -h $D -U pg -q -d qc -f $HERE/prelude.sql
for f in 01-schema-hardened 02-admin-killswitch-audit 03-token-hashing 04-bench-tests 05-connectivity; do
  echo "== $f"
  psql -h $D -U pg -d qc -v ON_ERROR_STOP=1 -q -f $SQL_DIR/$f.sql && echo "   OK"
  echo "== $f (re-run, idempotency)"
  psql -h $D -U pg -d qc -v ON_ERROR_STOP=1 -q -f $SQL_DIR/$f.sql && echo "   OK"
done
echo "== smoke test"
psql -h $D -U pg -d qc -v ON_ERROR_STOP=1 -q -f $HERE/smoke.sql
pg_ctl -D $D/data stop > /dev/null
