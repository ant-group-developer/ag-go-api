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

WORKERS=(worker-media worker-io)
HEALTH_TIMEOUT_SECONDS=${HEALTH_TIMEOUT_SECONDS:-60}

log() {
  printf '\n[%s] %s\n' "$(date +%H:%M:%S)" "$*"
}

if [[ ! -f .env ]]; then
  echo "Missing .env (copy .env.example and fill it in first)." >&2
  exit 1
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

log 'Building image'
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
  fetch('http://127.0.0.1:' + process.env.PORT + '/' + process.env.API_PREFIX + '/health')
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

log 'Deploy finished'
docker compose ps
