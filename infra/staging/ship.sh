#!/usr/bin/env bash
# From a developer machine: ship a committed revision to the SocioFi VPS, build its images there, deploy it — as the
# `setu` user, in its own rootless Docker daemon (the docker context `rootless`).
#   infra/staging/ship.sh [<commit>]        (default HEAD; the tree is sent with git archive — only what is committed)
# On the VPS: /opt/setu/app (the source of the revision, synced in place — never replaced: Caddy's bind mount of
# infra/caddy would keep pointing at a deleted folder), /opt/setu/staging.env (secrets,
# infra/staging/vps-env.sh), /opt/setu/state (the deployed tags), /opt/setu/backups. Images: setu/setu-{api,staff,tools}:<sha>.
set -euo pipefail
cd "$(dirname "$0")/../.."
HOST="${SETU_SSH_HOST:-sociofi}"; SSH=(ssh -l "${SETU_SSH_USER:-setu}" "$HOST")   # the setu user: its own rootless docker
SHA=$(git rev-parse "${1:-HEAD}^{commit}")
echo "shipping $SHA to $HOST"
git archive --format=tar "$SHA" | "${SSH[@]}" "set -e; rm -rf /opt/setu/app.new; mkdir -p /opt/setu/app.new; tar -x -C /opt/setu/app.new; mkdir -p /opt/setu/app; rsync -a --delete /opt/setu/app.new/ /opt/setu/app/; rm -rf /opt/setu/app.new; echo $SHA > /opt/setu/app/REVISION"
"${SSH[@]}" "set -e; cd /opt/setu/app; infra/staging/vps-env.sh; \
  docker build -q -f infra/postgres/Dockerfile -t setu/setu-postgres:16-walg-v3.0.9 infra/postgres >/dev/null; echo built setu/setu-postgres:16-walg-v3.0.9; \
  for t in api staff tools drill; do docker build -q -f infra/Dockerfile --target \$t -t setu/setu-\$t:$SHA . >/dev/null; echo built setu/setu-\$t:$SHA; done; \
  SETU_REGISTRY=setu SETU_IMAGES=local SETU_COMPOSE_EXTRA=compose.cohost.yml SETU_PROFILES=bundled \
  SETU_ENV_FILE=/opt/setu/staging.env SETU_STATE_DIR=/opt/setu/state infra/deploy.sh $SHA"
