#!/usr/bin/env bash
# Nightly backup of staging on the SocioFi VPS (cron, 02:30 Dhaka): the database (pg_dump, custom format) and the
# bucket's files (MinIO's data volume), into /opt/setu/backups, the last 7 kept; and, with WAL-G configured
# (/opt/setu/walg.env), a base backup and the same files encrypted to Cloudflare R2 (Kamrul, 08/10/2026, follow-up 1).
# The restore drill reads the newest local pair; infra/staging/pitr-drill.sh restores from R2 to a point in time.
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
# off-server (ADR 0019, follow-up 1): with WAL-G configured, a base backup (point-in-time restores start from one),
# then tonight's dump, counts and files — compressed and encrypted (libsodium) before they leave — to R2; 7 base
# backups (and the WAL they need) and 7 nights of dumps are kept there
W=/opt/setu/walg.env; offsite=""
if [[ -s "$W" ]]; then
  img=$(docker inspect -f '{{.Config.Image}}' "$pg"); L="$B/offsite-$ts.log"
  docker exec -u postgres "$pg" wal-g backup-push /var/lib/postgresql/data >"$L" 2>&1
  docker run --rm --env-file "$W" -v "$B":/b:ro "$img" sh -c "wal-g st put /b/db-$ts.dump dumps/db-$ts.dump && wal-g st put /b/db-$ts.counts dumps/db-$ts.counts && wal-g st put /b/files-$ts.tar.gz dumps/files-$ts.tar.gz" >>"$L" 2>&1
  docker exec -u postgres "$pg" wal-g delete retain FULL 7 --confirm >>"$L" 2>&1
  docker run --rm --env-file "$W" "$img" sh -c 'wal-g st ls dumps/ | awk "NR>1{print \$NF}" | grep -oE "^db-[0-9]{8}T[0-9]{6}Z" | sort -u | head -n -7 | while read -r n; do for f in "$n.dump.br" "$n.counts.br" "files-${n#db-}.tar.gz.br"; do wal-g st rm "dumps/$f" || true; done; done' >>"$L" 2>&1
  ls -1t "$B"/offsite-*.log | tail -n +8 | xargs -r rm -f
  offsite="; off-server (R2, encrypted): base backup, dump, files"
fi
ls -1t "$B"/db-*.dump | tail -n +8 | sed 's/\.dump$//' | while read -r f; do rm -f "$f.dump" "$f.counts"; done; ls -1t "$B"/files-*.tar.gz | tail -n +8 | xargs -r rm -f
echo "$(date -u +%FT%TZ) setu backup ok: db-$ts.dump ($(du -h "$B/db-$ts.dump" | cut -f1)), files-$ts.tar.gz ($(du -h "$B/files-$ts.tar.gz" | cut -f1))$offsite"
record true ""
