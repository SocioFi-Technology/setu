#!/usr/bin/env bash
# Staging on the SocioFi VPS (ADR 0019 addendum): writes /opt/setu/staging.env once, with fresh secrets — mode 600, never
# printed, never in git. Run on the VPS. An existing file is kept (rotating a secret = edit it, then deploy).
#   infra/staging/vps-env.sh [/opt/setu/staging.env]
set -euo pipefail
F="${1:-/opt/setu/staging.env}"
[[ -e "$F" ]] && { echo "$F exists — kept"; exit 0; }
r() { openssl rand -hex "$1"; }
PG=$(r 24); APP=$(r 24); MINIO=$(r 24)
umask 077
cat > "$F" <<ENV
# Setu staging on the SocioFi VPS — generated $(date -u +%FT%TZ) by infra/staging/vps-env.sh. Secrets: never print, never commit.
NODE_ENV=production
# Kamrul 08/10/2026: the fake gateway and SMS on staging (no real money, no texts to the seeded numbers)
SETU_STAGE=staging
PAYMENTS_PROVIDER=fake
FAKE_PAYMENTS_SECRET=$(r 32)
SMS_PROVIDER=fake
AI_PROVIDER=off
# the stack's own postgres (compose interpolates SETU_PG_PASSWORD; the owner role runs migrations, setu_app the API)
SETU_PG_PASSWORD=$PG
DATABASE_URL=postgresql://setu:$PG@postgres:5432/setu
DATABASE_URL_APP=postgresql://setu_app:$APP@postgres:5432/setu
REDIS_URL=redis://redis:6379
SESSION_SECRET=$(r 32)
DEVICE_KEY_SECRET=$(r 32)
GATEWAY_TOKEN_KEY=$(r 32)
WRISTBAND_SECRET=$(r 32)
PUBLIC_APP_URL=https://setu.sociofitechnology.com
VERIFY_BASE_URL=https://setu.sociofitechnology.com/verify/rc
STORAGE=s3
SETU_MINIO_PASSWORD=$MINIO
S3_ENDPOINT=http://minio:9000
S3_REGION=us-east-1
S3_BUCKET=setu-staging
S3_ACCESS_KEY=setu
S3_SECRET_KEY=$MINIO
S3_PATH_STYLE=1
# the seed (demo data) on staging: its own password and PIN for every seeded account, never the published dev ones
SEED_ALLOW=staging
SEED_PASSWORD=$(r 9)
SEED_PIN=$(printf '%04d' $(( $(od -An -N2 -tu2 /dev/urandom) % 10000 )))
ENV
# a dev PIN by chance: draw again
while grep -qE '^SEED_PIN=(1234|2580)$' "$F"; do sed -i "s/^SEED_PIN=.*/SEED_PIN=$(printf '%04d' $(( $(od -An -N2 -tu2 /dev/urandom) % 10000 )))/" "$F"; done
echo "$F written (mode $(stat -c %a "$F"))"
