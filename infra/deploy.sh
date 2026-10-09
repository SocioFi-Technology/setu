#!/usr/bin/env bash
# Deploy (week 2, ADR 0019). Runs on the staging host, in a checkout of this repo's infra/ with the env file beside it.
#   infra/deploy.sh <commit-sha>      deploy that commit's images
#   infra/deploy.sh --rollback        redeploy the previous commit's images; the database is left as it is (a second
#                                     --rollback goes forward again: .previous-tag is always the one before the current)
# The images exist only for commits CI passed (.github/workflows/images.yml builds them after CI on main); when gh is
# installed the commit's CI status is checked as well. Steps: pull → migrate:deploy + the setu_app password (once) →
# rolling restart of the API replicas, then the staff app and the patient app (each new container must be healthy before an old one goes).
# Never `migrate dev`, never a reset; migrations are additive, so a rollback needs no database step.
# Local rehearsal: SETU_REGISTRY=setu-local SETU_ENV_FILE=staging.local.env infra/deploy.sh --local <tag>
# Co-hosted (the SocioFi VPS, infra/compose.cohost.yml): SETU_COMPOSE_EXTRA=compose.cohost.yml adds the overlay,
# SETU_PROFILES=bundled starts the stack's own postgres / redis / minio first (and the bucket), SETU_IMAGES=local deploys
# images built on the host (infra/staging/vps-build.sh) instead of pulling them — the commit's CI is checked where gh is.
set -euo pipefail
cd "$(dirname "$0")"
export SETU_REGISTRY="${SETU_REGISTRY:-ghcr.io/sociofi-technology}" SETU_ENV_FILE="${SETU_ENV_FILE:-staging.env}"
STATE="${SETU_STATE_DIR:-.}"; mkdir -p "$STATE"; LOCAL=0; ROLLBACK=0; TAG=""
for a in "$@"; do case "$a" in --local) LOCAL=1 ;; --rollback) ROLLBACK=1 ;; -*) echo "unknown option $a"; exit 2 ;; *) TAG="$a" ;; esac; done
if [[ $ROLLBACK == 1 ]]; then TAG="$(cat "$STATE/.previous-tag" 2>/dev/null || true)"; [[ -n "$TAG" ]] || { echo "no previous deploy to roll back to"; exit 1; }; fi
[[ -n "$TAG" ]] || { echo "usage: deploy.sh <commit-sha> | --rollback"; exit 2; }
[[ "$TAG" != latest ]] || { echo "refusing the tag 'latest' — deploy a commit SHA"; exit 2; }
[[ $LOCAL == 1 || "$TAG" =~ ^[0-9a-f]{40}$ ]] || { echo "deploy the full 40-character commit SHA (the images are tagged with it)"; exit 2; }
export SETU_TAG="$TAG"
PROFILES=(--profile migrate); [[ $LOCAL == 1 ]] && PROFILES+=(--profile local)
for p in ${SETU_PROFILES//,/ }; do PROFILES+=(--profile "$p"); done
FILES=(-f docker-compose.staging.yml); [[ -n "${SETU_COMPOSE_EXTRA:-}" ]] && FILES+=(-f "$SETU_COMPOSE_EXTRA")
DC=(docker compose "${FILES[@]}" --env-file "$SETU_ENV_FILE" "${PROFILES[@]}")
log() { echo "[deploy $(date -u +%H:%M:%S)] $*"; }

if [[ $LOCAL == 0 && "${SETU_IMAGES:-registry}" == local ]]; then
  for t in api staff patient tools; do docker image inspect "$SETU_REGISTRY/setu-$t:$TAG" >/dev/null 2>&1 || { echo "no local image $SETU_REGISTRY/setu-$t:$TAG — build it first"; exit 1; }; done
elif [[ $LOCAL == 0 ]]; then
  if command -v gh >/dev/null; then
    concl=$(gh run list --repo SocioFi-Technology/setu --commit "$TAG" --workflow ci --json conclusion --jq '.[0].conclusion // "no run"' 2>/dev/null) || concl="unknown commit"
    [[ "$concl" == success ]] || { echo "CI is not green for $TAG ($concl) — not deploying"; exit 1; }
  fi
  for t in api staff patient tools; do docker manifest inspect "$SETU_REGISTRY/setu-$t:$TAG" >/dev/null || { echo "no image $SETU_REGISTRY/setu-$t:$TAG (CI not green, or not built yet)"; exit 1; }; done
  log "pulling $TAG"; "${DC[@]}" pull -q api staff patient migrate
fi

current="$(cat "$STATE/.current-tag" 2>/dev/null || true)"
if [[ " ${PROFILES[*]} " == *" bundled "* ]]; then
  log "the stack's own postgres / redis / minio"; "${DC[@]}" up -d --wait postgres redis >/dev/null; "${DC[@]}" up -d minio >/dev/null
  ok=0; for i in $(seq 1 30); do if "${DC[@]}" run --rm -T migrate node infra/s3-bucket.mjs; then ok=1; break; fi; sleep 2; done
  [[ $ok == 1 ]] || { log "the bucket could not be created — is minio up?"; exit 1; }
fi
if [[ $ROLLBACK == 0 ]]; then
  log "migrating (migrate:deploy + the setu_app password)"; "${DC[@]}" run --rm migrate
else
  log "rolling back to $TAG — the database stays as it is"
fi

# rolling restart: start as many new containers beside the old, wait until they are healthy, then remove the old ones
roll() {
  local svc="$1" want="$2" old new
  old=$("${DC[@]}" ps -q "$svc" | tr '\n' ' ')
  log "$svc: starting $want new beside: ${old:-none}"
  "${DC[@]}" up -d --no-deps --no-recreate --scale "$svc=$(( $(wc -w <<<"$old") + want ))" "$svc" >/dev/null
  for i in $(seq 1 90); do
    new=$("${DC[@]}" ps -q "$svc" | grep -vxF -f <(tr ' ' '\n' <<<"$old" | sed '/^$/d') || true)
    healthy=0; for c in $new; do [[ "$(docker inspect -f '{{.State.Health.Status}}' "$c")" == healthy ]] && healthy=$((healthy+1)); done
    [[ $healthy -ge $want ]] && break; sleep 2
  done
  [[ $healthy -ge $want ]] || { log "$svc: new containers not healthy — stopping them, the old ones keep serving"; for c in $new; do docker rm -f "$c" >/dev/null; done; exit 1; }
  for c in $old; do docker stop -t 20 "$c" >/dev/null && docker rm "$c" >/dev/null; done
  log "$svc: $want healthy on $TAG; old ones removed"
}
"${DC[@]}" up -d --no-deps --no-recreate caddy >/dev/null
# a Caddy whose mounted folder was replaced underneath it sees nothing: recreate it once (a second's gap at the edge)
"${DC[@]}" exec -T caddy test -f /etc/caddy/Caddyfile || { log "caddy: its config folder is gone (replaced on disk) — recreating"; "${DC[@]}" up -d --no-deps --force-recreate caddy >/dev/null; sleep 2; }
# a changed Caddyfile (infra/caddy/, mounted as a directory so a git checkout is seen) — reloaded in place, no restart
"${DC[@]}" exec -T caddy caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1 || { log "caddy: the Caddyfile does not load — fix it; the running config is unchanged"; exit 1; }
roll api 2
roll staff 1
roll patient 1
[[ -n "$current" && "$current" != "$TAG" ]] && echo "$current" > "$STATE/.previous-tag"
echo "$TAG" > "$STATE/.current-tag"
log "deployed $TAG (previous: ${current:-none})"
