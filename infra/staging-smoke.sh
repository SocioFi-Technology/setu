#!/usr/bin/env bash
# Local rehearsal of the staging stack (week 2): the production images, Caddy in front, two API replicas, Postgres /
# Redis / MinIO stand-ins. Builds the images (unless --no-build), migrates, seeds, then checks through Caddy:
# /api/ready, a sign-in, a prescription printed into object storage and served back, the bucket private, JSON logs.
#   infra/staging-smoke.sh [--no-build] [--down]
set -euo pipefail
cd "$(dirname "$0")/.."
export SETU_TAG="${SETU_TAG:-local-$(git rev-parse --short HEAD)}" SETU_REGISTRY="${SETU_REGISTRY:-setu-local}" SETU_ENV_FILE=staging.local.env
DC=(docker compose -f infra/docker-compose.staging.yml --env-file infra/staging.local.env --profile local --profile migrate)
BASE="http://localhost:8088"
if [[ " $* " != *" --no-build "* ]]; then
  for t in api staff tools; do docker build -q -f infra/Dockerfile --target "$t" -t "$SETU_REGISTRY/setu-$t:$SETU_TAG" . >/dev/null; echo "built $SETU_REGISTRY/setu-$t:$SETU_TAG"; done
fi
"${DC[@]}" up -d --wait postgres redis minio
"${DC[@]}" run --rm migrate node infra/s3-bucket.mjs
"${DC[@]}" run --rm migrate                       # migrate:deploy + the setu_app password (SCRAM)
"${DC[@]}" run --rm migrate pnpm db:seed >/dev/null && echo "seeded"
"${DC[@]}" up -d --wait api staff caddy
echo "ready: $(curl -fsS "$BASE/api/ready")"
jar=$(mktemp)
curl -fsS -c "$jar" -X POST "$BASE/api/v1/auth/login" -H 'content-type: application/json' -d '{"identifier":"01799000002","password":"setu1234"}' >/dev/null && echo "signed in (the E2E clinic's doctor)"
rx=$("${DC[@]}" exec -T postgres psql -U setu -d setu -tAc "select id from \"Composition\" where \"tenantId\"='t_e2e' and status='final' and \"signedById\"='u_e2e_doctor' and kind='consultation-note' limit 1")
[[ -n "$rx" ]] || { echo "no signed note in the seed"; exit 1; }
# the original print, or — the volume kept from an earlier run — a copy
pr=$(curl -fs -b "$jar" -X POST "$BASE/api/v1/documents/rx/$rx/print" -H 'content-type: application/json' -H "idempotency-key: smoke-$(date +%s%N)" -d '{"format":"a5","lang":"both"}' \
  || curl -fsS -b "$jar" -X POST "$BASE/api/v1/documents/rx/$rx/print" -H 'content-type: application/json' -H "idempotency-key: smoke-$(date +%s%N)" -d '{"format":"a5","lang":"both","reason":"copy"}')
pid=$(node -e 'const p=JSON.parse(process.argv[1]); console.log(p.print.id)' "$pr")
code=$(curl -s -b "$jar" -o /tmp/setu-smoke.pdf -w '%{http_code}' "$BASE/api/v1/documents/prints/$pid/pdf")
[[ "$code" == 200 && "$(head -c 4 /tmp/setu-smoke.pdf)" == "%PDF" ]] && echo "printed into object storage and served back by the API ($(wc -c < /tmp/setu-smoke.pdf) bytes)" || { echo "pdf: HTTP $code"; exit 1; }
key=$("${DC[@]}" exec -T postgres psql -U setu -d setu -tAc "select \"storageKey\" from \"DocumentPrint\" where id='$pid'")
anon=$(docker exec "$("${DC[@]}" ps -q api | sed -n 1p)" curl -s -o /dev/null -w '%{http_code}' "http://minio:9000/setu-staging/$key")
[[ "$anon" == 403 ]] && echo "anonymous read of the stored file: HTTP 403 (private bucket)" || { echo "anonymous read: HTTP $anon"; exit 1; }
logs=$("${DC[@]}" logs api --no-log-prefix 2>/dev/null || true)
first=$(grep -m1 '^{' <<<"$logs")
node -e 'JSON.parse(process.argv[1]); console.log("api logs are JSON lines")' "$first"
! grep -qiE 'setu_session=|deviceKeys"\s*:\s*\{' <<<"$logs" && echo "no cookies or device keys in the logs"
jobs=$(curl -fsS "$BASE/api/health/jobs"); echo "jobs: ${jobs:0:160}"
rm -f "$jar"
if [[ " $* " == *" --down "* ]]; then "${DC[@]}" down -v; fi
echo "staging smoke: OK"
