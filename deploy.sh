#!/usr/bin/env bash
# Rebuilds and redeploys api + workers without keeping the API down while workers drain.
#
# A plain `docker compose up -d` recreates every service first and only starts the new
# containers once all old ones have stopped, so the API stays down for the whole worker
# stop_grace_period (up to 150s). Here the API is replaced on its own first, then the
# workers finish their running jobs while the new API is already serving.
#
# Usage: ./deploy.sh            build, migrate, replace api, then workers
#        SKIP_MIGRATION=1 ./deploy.sh
# Run it inside tmux/screen: an interrupted deploy leaves containers half-replaced.
set -euo pipefail

cd "$(dirname "$0")"

IMAGE=ag-go-api
WORKERS=(worker-media worker-io)
HEALTH_TIMEOUT_SECONDS=${HEALTH_TIMEOUT_SECONDS:-60}

log() {
  printf '\n[%s] %s\n' "$(date +%H:%M:%S)" "$*"
}

# This machine's IP on the route to $1 (an IP or a name), else its first IP. On a worker host
# that is its address on the private network it reaches the main host's Redis through.
host_ip() {
  local target ip=''
  target=$(getent ahostsv4 "$1" 2>/dev/null | awk 'NR == 1 { print $1 }' || true)
  if [[ -n "$target" && "$target" != 127.* ]]; then
    ip=$(ip route get "$target" 2>/dev/null | sed -nE 's/.* src ([0-9.]+).*/\1/p' | head -n 1 || true)
  fi
  [[ -n "$ip" ]] || ip=$(hostname -I 2>/dev/null | awk '{ print $1 }' || true)
  printf '%s' "$ip"
}

if [[ ! -f .env ]]; then
  echo "Missing .env (copy .env.example and fill it in first)." >&2
  exit 1
fi

# Shown on System > Workers: the commit the image is built from (workers on another commit
# than the api are flagged there), this machine's name and IP (WORKER_HOSTNAME and
# WORKER_HOST_IP in .env win).
if [[ -z "${GIT_COMMIT:-}" ]] && ! GIT_COMMIT=$(git -c safe.directory="$PWD" rev-parse HEAD 2>/dev/null); then
  GIT_COMMIT=''
  echo 'Warning: cannot read the checked-out commit; System > Workers will show it as unknown.' >&2
fi
export GIT_COMMIT
if ! grep -qE '^[[:space:]]*WORKER_HOSTNAME=' .env; then
  export WORKER_HOSTNAME=${WORKER_HOSTNAME:-$(hostname)}
fi
if ! grep -qE '^[[:space:]]*WORKER_HOST_IP=' .env; then
  export WORKER_HOST_IP=${WORKER_HOST_IP:-$(host_ip 1.1.1.1)}
fi

# An interrupted recreate leaves new containers named "<old id>_<name>" that were never
# started. Compose would count them as extra replicas, so drop them before deploying.
log 'Removing containers left over from an interrupted deploy'
leftovers=$(docker compose ps -a --format '{{.Name}}' | grep -E '^[0-9a-f]{12}_' || true)
if [[ -n "$leftovers" ]]; then
  echo "$leftovers"
  # shellcheck disable=SC2086
  docker rm -f $leftovers
else
  echo 'None'
fi

if [[ -z "${TAG:-}" ]]; then
  TAG=$(git -c safe.directory="$PWD" rev-parse --short HEAD 2>/dev/null || true)
  TAG=${TAG:-latest}
fi
export TAG

# The image running now: kept for rollback and by the image cleanup below.
previous_image=''
for service in api "${WORKERS[@]}"; do
  previous_container=$(docker compose ps -a -q "$service" 2>/dev/null | head -n 1 || true)
  if [[ -n "$previous_container" ]]; then
    previous_image=$(docker inspect -f '{{.Config.Image}}' "$previous_container" 2>/dev/null || true)
    [[ -n "$previous_image" ]] && break
  fi
done

log "Building image $IMAGE:$TAG"
docker compose build api

if [[ "${SKIP_MIGRATION:-0}" != 1 ]]; then
  log 'Running migrations'
  docker compose run --rm --no-deps api \
    node node_modules/typeorm/cli.js migration:run -d dist/database/data-source.js
fi

log 'Replacing api'
docker compose up -d --no-deps api

log "Waiting for api to become healthy (up to ${HEALTH_TIMEOUT_SECONDS}s)"
deadline=$((SECONDS + HEALTH_TIMEOUT_SECONDS))
until docker compose exec -T api node -e "
  fetch('http://127.0.0.1:' + process.env.PORT + '/' + process.env.API_PREFIX + '/health/ready')
    .then((res) => process.exit(res.ok ? 0 : 1))
    .catch(() => process.exit(1));
" >/dev/null 2>&1; do
  if ((SECONDS >= deadline)); then
    echo 'api did not become healthy, workers were left untouched. Recent logs:' >&2
    docker compose logs --tail 50 api >&2
    exit 1
  fi
  sleep 2
done
echo 'api is healthy'

log "Replacing ${WORKERS[*]} (old workers finish running jobs first, this can take a while)"
docker compose up -d --no-deps --remove-orphans "${WORKERS[@]}"

# Every deploy leaves an image per commit; keep this one and the previous one (rollback).
log 'Removing older images'
images=$(docker image ls "$IMAGE" --format '{{.Repository}}:{{.Tag}}' || true)
for image in $images; do
  if [[ "$image" != "$IMAGE:$TAG" && "$image" != "$previous_image" ]]; then
    docker image rm "$image" >/dev/null 2>&1 && echo "Removed $image" || true
  fi
done
docker image prune -f >/dev/null || true

log 'Deploy finished'
docker compose ps
