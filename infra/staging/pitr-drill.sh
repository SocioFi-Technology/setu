#!/usr/bin/env bash
# Point-in-time restore drill (ADR 0019, follow-up 1), run by setu on the VPS. Restores the database as it was at a
# chosen moment from the off-server archive (R2: the newest base backup taken before it + the WAL up to it) into a
# scratch container on its own network — never the live one, which keeps running — then checks it and removes it.
#   infra/staging/pitr-drill.sh [--target '2026-10-08 14:20:00+00']     (default: 2 minutes ago)
# It prints the RTO (fetch + WAL replay until the copy is open) and checks the copy stops at the target: the newest
# job run in the copy (the sweeps write JobRun every minute) is at or before it, and within two minutes of it.
# Overrides for a local rehearsal: SETU_PG_IMAGE, SETU_WALG_ENV_FILE, SETU_DRILL_NET (an existing network, kept),
# CHECK_SQL (one value printed and compared by eye).
set -euo pipefail
IMG="${SETU_PG_IMAGE:-setu/setu-postgres:16-walg-v3.0.9}"; ENVF="${SETU_WALG_ENV_FILE:-/opt/setu/walg.env}"
NET=${SETU_DRILL_NET:-setu-pitr-drill}; C=setu-pitr-drill
T="$(date -u -d '2 minutes ago' '+%Y-%m-%d %H:%M:%S+00')"
[[ "${1:-}" == --target ]] && T="$2"
log() { echo "[pitr $(date -u +%H:%M:%S)] $*"; }
cleanup() { docker rm -f "$C" >/dev/null 2>&1 || true; [[ -z "${SETU_DRILL_NET:-}" ]] && docker network rm "$NET" >/dev/null 2>&1 || true; rm -f "${INNER:-}"; }
trap cleanup EXIT; cleanup
docker network create "$NET" >/dev/null 2>&1 || true
# the newest base backup that finished before the target
list=$(timeout 120 docker run --rm --network "$NET" --env-file "$ENVF" "$IMG" wal-g backup-list --detail --json 2>/dev/null)
B=$(python3 -c '
import json,sys,datetime as d
t=d.datetime.fromisoformat(sys.argv[1].replace(" ","T"))
bs=[b for b in json.loads(sys.argv[2]) if d.datetime.fromisoformat(b["finish_time"].replace("Z","+00:00"))<t]
print(max(bs,key=lambda b:b["finish_time"])["backup_name"] if bs else "")' "$T" "$list")
[[ -n "$B" ]] || { log "no base backup finished before $T"; exit 1; }
log "target $T — base backup $B, then the archived WAL up to the target"
INNER=$(mktemp); chmod 644 "$INNER"
cat > "$INNER" <<SH
set -e
D=/var/lib/postgresql/data; mkdir -p \$D; chown postgres:postgres \$D; chmod 700 \$D
# one sync at the end instead of an fsync per extracted file (~0.2 s each; a base backup is ~1,000 files)
WALG_TAR_DISABLE_FSYNC=true gosu postgres wal-g backup-fetch \$D $B
sync
echo fetched > /tmp/fetched
gosu postgres touch \$D/recovery.signal
# the copy never archives: it must not write a new timeline into the real archive
cat >> \$D/postgresql.auto.conf <<CONF
restore_command = 'wal-g wal-fetch %f %p'
recovery_target_time = '$T'
recovery_target_action = 'promote'
archive_mode = 'off'
CONF
exec gosu postgres postgres
SH
t0=$(date +%s)
docker run -d --name "$C" --network "$NET" --memory 1g --env-file "$ENVF" -v "$INNER":/drill.sh:ro --entrypoint bash "$IMG" /drill.sh >/dev/null
until docker exec "$C" test -f /tmp/fetched 2>/dev/null; do docker inspect -f '{{.State.Running}}' "$C" | grep -q true || { docker logs --tail 20 "$C"; exit 1; }; sleep 1; done
t1=$(date +%s); log "base backup fetched in $((t1 - t0)) s"
until [[ "$(docker exec "$C" psql -U setu -d setu -tAc 'select pg_is_in_recovery()' 2>/dev/null)" == f ]]; do docker inspect -f '{{.State.Running}}' "$C" | grep -q true || { docker logs --tail 30 "$C"; exit 1; }; sleep 1; done
t2=$(date +%s); log "WAL replayed to the target and the copy promoted in $((t2 - t1)) s — RTO for the database: $((t2 - t0)) s"
docker logs "$C" 2>&1 | grep -E "recovery stopping|last completed transaction|archive recovery complete" | sed 's/^/    /' | cut -c1-200
if [[ -n "${CHECK_SQL:-}" ]]; then
  log "check: $(docker exec "$C" psql -U setu -d setu -tAc "$CHECK_SQL")"
else
  newest=$(docker exec "$C" psql -U setu -d setu -tAc "select max(\"lastFinishedAt\") from \"JobRun\" where name <> 'backup'")
  ok=$(python3 -c '
import sys,datetime as d
f=lambda s:d.datetime.fromisoformat(s.strip().replace(" ","T")[:26]+"+00:00" if "+" not in s else s.strip().replace(" ","T"))
t=f(sys.argv[1]); n=f(sys.argv[2]); g=(t-n).total_seconds()
print(f"{g:.0f}" if 0<=g<=120 else f"BAD {g:.0f}")' "$T" "$newest")
  [[ "$ok" != BAD* ]] || { log "the copy does not stop at the target: newest job run $newest vs $T ($ok s)"; exit 1; }
  log "the copy stops at the target: newest job run $newest, $ok s before $T"
  log "rows: $(docker exec "$C" psql -U setu -d setu -tAF' ' -c "select 'Patient', count(*) from \"Patient\" union all select 'Encounter', count(*) from \"Encounter\" union all select 'AuditEvent', count(*) from \"AuditEvent\"" | tr '\n' ' ')"
fi
log "PITR DRILL OK — scratch removed"
