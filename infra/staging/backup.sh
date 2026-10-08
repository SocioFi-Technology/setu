#!/usr/bin/env bash
# Nightly backup of staging on the SocioFi VPS (cron, 02:30 Dhaka): the database (pg_dump, custom format) and the
# bucket's files (MinIO's data volume), into /opt/setu/backups, the last 7 kept. On the same disk for now (Kamrul,
# 08/10/2026: off-server copies come with production). The restore drill reads the newest pair.
set -euo pipefail
started=$(date -u +%FT%TZ)
pgc() { docker ps -q -f label=com.docker.compose.project=setu-staging -f label=com.docker.compose.service=postgres; }
# the run is recorded in JobRun ("backup"): the job-age check (/health/jobs/ok) alarms on a failed or missed backup
record() { local ok="$1" err="$2" c; c=$(pgc); [[ -n "$c" ]] || return 0
  docker exec -i "$c" psql -q -U setu -d setu -v ok="$ok" -v err="$err" -v st="$started" >/dev/null <<'SQL' || true
INSERT INTO "JobRun" ("name", "lastStartedAt", "lastFinishedAt", "lastOk", "lastError", "runs") VALUES ('backup', :'st', now(), :'ok', NULLIF(:'err', ''), 1)
ON CONFLICT ("name") DO UPDATE SET "lastStartedAt" = EXCLUDED."lastStartedAt", "lastFinishedAt" = now(), "lastOk" = EXCLUDED."lastOk", "lastError" = EXCLUDED."lastError", "runs" = "JobRun"."runs" + 1;
SQL
}
trap 'record false "backup.sh failed at line $LINENO"' ERR
B=/opt/setu/backups; mkdir -p "$B"; chmod 700 "$B"
ts=$(date -u +%Y%m%dT%H%M%SZ)
pg=$(pgc)
mn=$(docker ps -q -f label=com.docker.compose.project=setu-staging -f label=com.docker.compose.service=minio)
[[ -n "$pg" && -n "$mn" ]] || { echo "$(date -u +%FT%TZ) setu backup: postgres or minio is not running"; exit 1; }
# row counts beside the dump (staging is idle at night), for the restore drill to compare
docker exec "$pg" psql -U setu -d setu -tAF' ' -c "select 'Patient', count(*) from \"Patient\" union all select 'Encounter', count(*) from \"Encounter\" union all select 'Invoice', count(*) from \"Invoice\" union all select 'Composition', count(*) from \"Composition\" union all select 'DocumentPrint', count(*) from \"DocumentPrint\" union all select 'AuditEvent', count(*) from \"AuditEvent\" union all select 'User', count(*) from \"User\"" > "$B/db-$ts.counts"
docker exec "$pg" pg_dump -U setu -d setu -Fc > "$B/db-$ts.dump.part" && mv "$B/db-$ts.dump.part" "$B/db-$ts.dump"
vol=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "$mn")
docker run --rm -v "$vol":/data:ro -v "$B":/out alpine:3.20 tar -C /data -czf "/out/files-$ts.tar.gz.part" . && mv "$B/files-$ts.tar.gz.part" "$B/files-$ts.tar.gz"
ls -1t "$B"/db-*.dump | tail -n +8 | sed 's/\.dump$//' | while read -r f; do rm -f "$f.dump" "$f.counts"; done; ls -1t "$B"/files-*.tar.gz | tail -n +8 | xargs -r rm -f
echo "$(date -u +%FT%TZ) setu backup ok: db-$ts.dump ($(du -h "$B/db-$ts.dump" | cut -f1)), files-$ts.tar.gz ($(du -h "$B/files-$ts.tar.gz" | cut -f1))"
record true ""
