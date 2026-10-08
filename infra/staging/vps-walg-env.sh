#!/usr/bin/env bash
# WAL-G settings for staging (ADR 0019, follow-up 1), run by setu on the VPS: /opt/setu/walg.env (mode 600) from the
# R2 credentials Kamrul stored (/opt/setu/r2.env: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET) and
# a libsodium key made here once (/opt/setu/walg.key). Nothing is printed. The key must ALSO be kept off the VPS
# (Kamrul's password manager): without it the backups in R2 cannot be read. Then SETU_WAL_ARCHIVE=on in staging.env.
set -euo pipefail
R=/opt/setu/r2.env; K=/opt/setu/walg.key; F=/opt/setu/walg.env
[[ -r "$R" ]] || { echo "no $R (the R2 credentials)"; exit 1; }
umask 077
[[ -s "$K" ]] || { openssl rand -hex 32 > "$K"; echo "made a new backup encryption key: $K — copy it off the VPS now"; }
# shellcheck disable=SC1090
. "$R"
cat > "$F" <<ENV
# WAL-G → Cloudflare R2 (setu staging). Made by infra/staging/vps-walg-env.sh; secrets — never print or commit.
WALG_S3_PREFIX=s3://${R2_BUCKET}/staging
AWS_ENDPOINT=https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com
AWS_ACCESS_KEY_ID=${R2_ACCESS_KEY_ID}
AWS_SECRET_ACCESS_KEY=${R2_SECRET_ACCESS_KEY}
AWS_REGION=auto
AWS_S3_FORCE_PATH_STYLE=true
WALG_LIBSODIUM_KEY=$(cat "$K")
WALG_LIBSODIUM_KEY_TRANSFORM=hex
WALG_COMPRESSION_METHOD=brotli
WALG_UPLOAD_CONCURRENCY=4
PGHOST=/var/run/postgresql
PGUSER=setu
PGDATABASE=setu
ENV
grep -q '^SETU_WAL_ARCHIVE=' /opt/setu/staging.env || printf '\n# WAL archiving to R2 (WAL-G, /opt/setu/walg.env)\nSETU_WAL_ARCHIVE=on\n' >> /opt/setu/staging.env
echo "$F written (mode $(stat -c %a "$F")); SETU_WAL_ARCHIVE=on in staging.env — deploy to restart postgres with archiving"
