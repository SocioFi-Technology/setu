#!/usr/bin/env bash
# Deploy (week 2, ADR 0019). Runs on the staging host, in a checkout of this repo's infra/ with the env file beside it.
#   infra/deploy.sh <commit-sha>      deploy that commit's images
#   infra/deploy.sh --rollback        redeploy the previous commit's images; the database is left as it is (a second
#                                     --rollback goes forward again: .previous-tag is always the one before the current)
# The images exist only for commits CI passed (.github/workflows/images.yml builds them after CI on main); when gh is
# installed the commit's CI status is checked as well. Steps: pull → migrate:deploy + the setu_app password (once) →
# rolling restart of the API replicas, then the staff app (each new container must be healthy before an old one goes).
# Never `migrate dev`, never a reset; migrations are additive, so a rollback needs no database step.
# Local rehearsal: SETU_REGISTRY=setu-local SETU_ENV_FILE=staging.local.env infra/deploy.sh --local <tag>
set -euo pipefail
cd "$(dirname "$0")"
export SETU_REGISTRY="${SETU_REGISTRY:-ghcr.io/sociofi-technology}" SETU_ENV_FILE="${SETU_ENV_FILE:-staging.env}"
STATE="${SETU_STATE_DIR:-.}"; LOCAL=0; ROLLBACK=0; TAG=""
for a in "$@"; do case "$a" in --local) LOCAL=1 ;; --rollback) ROLLBACK=1 ;; -*) echo "unknown option $a"; exit 2 ;; *) TAG="$a" ;; esac; done
if [[ $ROLLBACK == 1 ]]; then TAG="$(cat "$STATE/.previous-tag" 2>/dev/null || true)"; [[ -n "$TAG" ]] || { echo "no previous deploy to roll back to"; exit 1; }; fi
[[ -n "$TAG" ]] || { echo "usage: deploy.sh <commit-sha> | --rollback"; exit 2; }
[[ "$TAG" != latest ]] || { echo "refusing the tag 'latest' — deploy a commit SHA"; exit 2; }
[[ $LOCAL == 1 || "$TAG" =~ ^[0-9a-f]{40}$ ]] || { echo "deploy the full 40-character commit SHA (the images are tagged with it)"; exit 2; }
export SETU_TAG="$TAG"
PROFILES=(--profile migrate); [[ $LOCAL == 1 ]] && PROFILES+=(--profile local)
DC=(docker compose -f docker-compose.staging.yml --env-file "$SETU_ENV_FILE" "${PROFILES[@]}")
log() { echo "[deploy $(date -u +%H:%M:%S)] $*"; }

if [[ $LOCAL == 0 ]]; then
  if command -v gh >/dev/null; then
    concl=$(gh run list --repo SocioFi-Technology/setu --commit "$TAG" --workflow ci --json conclusion --jq '.[0].conclusion // "no run"' 2>/dev/null) || concl="unknown commit"
    [[ "$concl" == success ]] || { echo "CI is not green for $TAG ($concl) — not deploying"; exit 1; }
  fi
  for t in api staff tools; do docker manifest inspect "$SETU_REGISTRY/setu-$t:$TAG" >/dev/null || { echo "no image $SETU_REGISTRY/setu-$t:$TAG (CI not green, or not built yet)"; exit 1; }; done
  log "pulling $TAG"; "${DC[@]}" pull -q api staff migrate
fi

current="$(cat "$STATE/.current-tag" 2>/dev/null || true)"
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
# a changed Caddyfile (infra/caddy/, mounted as a directory so a git checkout is seen) — reloaded in place, no restart
"${DC[@]}" exec -T caddy caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1 || { log "caddy: the Caddyfile does not load — fix it; the running config is unchanged"; exit 1; }
roll api 2
roll staff 1
[[ -n "$current" && "$current" != "$TAG" ]] && echo "$current" > "$STATE/.previous-tag"
echo "$TAG" > "$STATE/.current-tag"
log "deployed $TAG (previous: ${current:-none})"
