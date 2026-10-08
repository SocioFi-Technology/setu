#!/usr/bin/env bash
# The backup / restore drill (staging on the SocioFi VPS). Restores the newest nightly backup into scratch containers on
# their own network — never the live stack — then: the row counts against the ones recorded at backup time, migrations
# up to date, every stored print's file present in the files backup, the API test suite against the restored database
# (dev credentials put back on the copy so the tests can sign in), then everything scratch is removed.
#   infra/staging/restore-drill.sh [/opt/setu/backups/db-<ts>.dump]
set -euo pipefail
B=/opt/setu/backups
D="${1:-$(ls -1t "$B"/db-*.dump | head -n 1)}"; base="${D%.dump}"; F="${base/db-/files-}.tar.gz"
[[ -f "$D" && -f "$F" ]] || { echo "no backup pair for $D"; exit 1; }
SHA=$(cat /opt/setu/state/.current-tag); TOOLS="setu/setu-tools:$SHA"
NET="setu-drill"; PW=$(openssl rand -hex 16); APW=$(openssl rand -hex 16)
cleanup() { docker rm -f setu-drill-pg setu-drill-redis >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; }
trap cleanup EXIT; cleanup
log() { echo "[drill $(date -u +%H:%M:%S)] $*"; }
log "backup: $(basename "$D") + $(basename "$F"); tools image $TOOLS"
t0=$(date +%s)
docker network create "$NET" >/dev/null
docker run -d --name setu-drill-pg --network "$NET" --network-alias postgres --memory 1g -e POSTGRES_USER=setu -e POSTGRES_PASSWORD="$PW" -e POSTGRES_DB=setu postgres:16 >/dev/null
docker run -d --name setu-drill-redis --network "$NET" --network-alias redis --memory 256m redis:7 >/dev/null
for i in $(seq 1 60); do docker exec setu-drill-pg pg_isready -U setu -d setu -q 2>/dev/null && break; sleep 1; done; sleep 2
docker exec setu-drill-pg psql -q -U setu -d setu -c "CREATE ROLE setu_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT" >/dev/null
docker exec -i setu-drill-pg pg_restore -U setu -d setu --no-owner --exit-on-error < "$D"
t1=$(date +%s); log "restored in $((t1 - t0)) s"

# 1. the row counts recorded at backup time
q="select 'Patient', count(*) from \"Patient\" union all select 'Encounter', count(*) from \"Encounter\" union all select 'Invoice', count(*) from \"Invoice\" union all select 'Composition', count(*) from \"Composition\" union all select 'DocumentPrint', count(*) from \"DocumentPrint\" union all select 'AuditEvent', count(*) from \"AuditEvent\" union all select 'User', count(*) from \"User\""
if diff <(docker exec setu-drill-pg psql -U setu -d setu -tAF' ' -c "$q") "$base.counts" >/dev/null; then log "row counts match the backup: $(tr '\n' ' ' < "$base.counts")"; else log "ROW COUNTS DIFFER"; diff <(docker exec setu-drill-pg psql -U setu -d setu -tAF' ' -c "$q") "$base.counts" || true; exit 1; fi

# 2. every stored print has its file in the files backup (MinIO keeps an object as a folder named after its key)
listing=$(tar -tzf "$F")
missing=0; n=0
while read -r key; do [[ -z "$key" ]] && continue; n=$((n+1)); grep -qF "./setu-staging/$key/" <<<"$listing" || { missing=$((missing+1)); echo "  missing: $key"; }; done < <(docker exec setu-drill-pg psql -U setu -d setu -tAc 'select "storageKey" from "DocumentPrint" where "storageKey" is not null')
[[ $missing == 0 ]] && log "files: all $n stored prints are in the files backup" || { log "FILES MISSING: $missing of $n"; exit 1; }

# 3. migrations up to date, the API's role, dev credentials on the copy, then the API tests
E=(-e DATABASE_URL="postgresql://setu:$PW@postgres:5432/setu" -e DATABASE_URL_APP="postgresql://setu_app:$APW@postgres:5432/setu" -e REDIS_URL=redis://redis:6379 -e STORAGE_DIR=/tmp/setu-storage)
docker run --rm --network "$NET" --user root "${E[@]}" "$TOOLS" sh -c 'pnpm --filter @setu/db exec prisma migrate status >/tmp/s.txt 2>&1; grep -q "Database schema is up to date" /tmp/s.txt && echo "migrations: up to date" || { cat /tmp/s.txt; exit 1; }
  pnpm db:set-app-password >/dev/null && SEED_RESET_CREDENTIALS=1 pnpm db:seed >/dev/null && echo "seeded dev credentials onto the copy"'
t2=$(date +%s)
log "API tests against the restored copy"
docker run --rm --network "$NET" --user root "${E[@]}" "$TOOLS" sh -c 'pnpm --filter @setu/api test > /tmp/t.txt 2>&1; rc=$?; grep -E "Test Files|Tests  |FAIL" /tmp/t.txt | head -40; exit $rc' && ok=1 || ok=0
log "tests took $(( $(date +%s) - t2 )) s; restore $((t1 - t0)) s; drill total $(( $(date +%s) - t0 )) s"
[[ $ok == 1 ]] && log "DRILL OK — scratch containers removed" || { log "DRILL: API TESTS FAILED"; exit 1; }
