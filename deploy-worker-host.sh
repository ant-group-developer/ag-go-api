#!/usr/bin/env bash
# Builds and (re)starts every worker on an extra VPS (a "worker host"): worker-media (FFmpeg
# renders) and worker-io (Drive imports, ZIP downloads, outbox).
#
# The workers take jobs from the main host's Redis queues, use the main host's Postgres and
# R2. The api and the migrations stay on the main host (deploy.sh). Deploy the main host
# first, then every worker host on the same commit: before the running workers are replaced,
# the new image must reach Postgres and Redis, its migrations must match the database's
# exactly (a worker host behind or ahead of the main host is refused), and QUEUE_PREFIX, R2
# and the Google token key must be the main host's (see src/workers/worker-host-preflight.ts).
#
# First time on a new VPS (Docker with the Compose and buildx plugins, util-linux):
#   git clone <repo> && cd ag-go-api
#   cp .env.example .env   # copy the main host's values (R2, Google, QUEUE_PREFIX...), but
#                          # point DATABASE_URL and REDIS_URL at its private IP, not localhost
# Every deploy, on the commit the main host runs:
#   git pull --ff-only origin main && sudo bash ./deploy-worker-host.sh
# Run it inside tmux/screen: the old workers finish their running jobs first (up to
# WORKER_STOP_GRACE_PERIOD), and the host has no workers if the script is cut off meanwhile.
set -euo pipefail

cd "$(dirname "$0")"

WORKERS=(worker-media worker-io)
IMAGE=ag-go-api
STARTUP_CHECK_SECONDS=${STARTUP_CHECK_SECONDS:-15}
LOCK_FILE=/tmp/ag-go-deploy-worker-host.lock

log() {
  printf '\n[%s] %s\n' "$(date +%H:%M:%S)" "$*"
}

fail() {
  echo "Error: $*" >&2
  exit 1
}

# Value of $1 in .env (last assignment wins; quotes, inline comments and trailing blanks
# dropped), or $2 when unset.
env_value() {
  local value
  value=$(grep -E "^[[:space:]]*$1=" .env | tail -n 1 | cut -d= -f2- | tr -d '\r' || true)
  if [[ $value != [\"\']* ]]; then
    value=${value%%[[:space:]]#*}
  fi
  value=${value%"${value##*[![:space:]]}"}
  value=${value%\"}
  value=${value#\"}
  value=${value%\'}
  value=${value#\'}
  printf '%s' "${value:-$2}"
}

# Host part of a postgres:// or redis:// URL.
url_host() {
  sed -E 's#^[^:]+://##; s#^[^/]*@##; s#[:/?].*$##' <<<"$1"
}

if [[ ! -f .env ]]; then
  fail 'Missing .env (copy .env.example and fill it in first).'
fi
command -v flock >/dev/null || fail 'flock (util-linux) is required.'
docker info >/dev/null 2>&1 || fail 'The Docker daemon is not reachable (is it running, and is this run with sudo?).'

# One deploy at a time: a second run would remove the first one's new containers as leftovers.
exec 9>"$LOCK_FILE"
flock -n 9 || fail "Another deploy-worker-host.sh is running on this host ($LOCK_FILE)."

if [[ -n "$(docker compose ps -a -q api)" ]]; then
  fail 'An api container exists on this host, so it looks like the main host: deploy that with ./deploy.sh (it also runs the migrations).'
fi

# Same tag scheme as the main host's deploy: the commit being deployed. safe.directory lets
# newer git read a checkout owned by another user when run with sudo.
if [[ -z "${TAG:-}" ]]; then
  TAG=$(git -c safe.directory="$PWD" rev-parse --short HEAD) ||
    fail "Cannot read the checked-out commit for the image tag. Run: sudo git config --global --add safe.directory '$PWD' (or pass TAG=<commit>)."
fi
export TAG

log 'Checking .env'
# A .env copied from the main host as is points at its own localhost, which is nothing here.
for name in DATABASE_URL REDIS_URL; do
  url=$(env_value "$name" '')
  [[ -n "$url" ]] || fail "$name is not set in .env."
  host=$(url_host "$url")
  case "$host" in
    '' | localhost | 127.* | 0.0.0.0 | host.docker.internal)
      fail "$name points at '$host', which is not the main host from here. Use the main host's private IP (WireGuard, Tailscale or the provider's private network)."
      ;;
  esac
  echo "$name -> $host"
done
if [[ "$(env_value MEDIA_WORKER_ENABLED '')" != true ]]; then
  fail 'MEDIA_WORKER_ENABLED must be true in .env, or worker-media starts but never takes a render job.'
fi

host_cpus=$(nproc)
media_cpus=$(env_value WORKER_MEDIA_CPUS 2)
io_cpus=$(env_value WORKER_IO_CPUS 1)
echo "Host CPUs: $host_cpus | WORKER_MEDIA_CPUS=$media_cpus + WORKER_IO_CPUS=$io_cpus | MEDIA_WORKER_CONCURRENCY=$(env_value MEDIA_WORKER_CONCURRENCY '?') x MEDIA_FFMPEG_THREADS=$(env_value MEDIA_FFMPEG_THREADS 2)"
if awk -v media="$media_cpus" -v io="$io_cpus" -v have="$host_cpus" 'BEGIN { exit !(media > have || io > have) }'; then
  fail "WORKER_MEDIA_CPUS=$media_cpus / WORKER_IO_CPUS=$io_cpus cannot be more than the $host_cpus CPUs of this host."
fi
# worker-io is mostly network-bound; one CPU (and 1-2 GB RAM) stays free for the OS and for
# image builds next to busy workers.
media_room=$(awk -v io="$io_cpus" -v have="$host_cpus" 'BEGIN { room = have - 1 - io; print (room < 1 ? 1 : room) }')
if awk -v want="$media_cpus" -v room="$media_room" 'BEGIN { exit !(want < room) }'; then
  echo "Note: this host only runs workers; WORKER_MEDIA_CPUS can go up to $media_room (keep MEDIA_WORKER_CONCURRENCY x MEDIA_FFMPEG_THREADS about equal to it)."
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

# Built through the api service, the only one with a build section; api is not started here.
log "Building image $IMAGE:$TAG"
docker compose build api

# Read-only checks with the app code in the new image (src/workers/worker-host-preflight.ts):
# Postgres, Redis, clock, migrations, and that QUEUE_PREFIX, R2 and the Google token key are
# the main host's. A wrong value there would do damage, not just fail.
log 'Checking the new image against the main host'
docker compose run --rm --no-deps -T "${WORKERS[0]}" node dist/workers/worker-host-preflight.js

# The image the workers run now: kept for the rollback hint and by the image cleanup below.
previous_image=''
for service in "${WORKERS[@]}"; do
  previous_container=$(docker compose ps -a -q "$service" | head -n 1 || true)
  if [[ -n "$previous_container" ]]; then
    previous_image=$(docker inspect -f '{{.Config.Image}}' "$previous_container" 2>/dev/null || true)
    [[ -n "$previous_image" ]] && break
  fi
done

# An `up` cut off midway (Ctrl-C, SSH drop) can leave the old workers stopped and the new ones
# not started yet.
replacing=0
trap 'if (($? != 0 && replacing)); then echo "Workers may be stopped now: rerun this script to start them." >&2; fi' EXIT

log "Replacing ${WORKERS[*]} (old workers finish their running jobs first, this can take a while)"
replacing=1
docker compose up -d --no-deps "${WORKERS[@]}"
replacing=0

log "Checking the workers stay up (${STARTUP_CHECK_SECONDS}s)"
sleep "$STARTUP_CHECK_SECONDS"
unhealthy=0
for service in "${WORKERS[@]}"; do
  container=$(docker compose ps -a -q "$service" | head -n 1 || true)
  state=$(docker inspect -f '{{.State.Status}} {{.RestartCount}}' "$container" 2>/dev/null || echo 'missing 0')
  if [[ "$state" != 'running 0' ]]; then
    echo "$service is not running cleanly (status, restarts: $state). Recent logs:" >&2
    docker compose logs --tail 50 "$service" >&2
    unhealthy=1
  fi
done
if ((unhealthy)); then
  # Stopping is always safe: the main host keeps processing. Rolling back is only safe to the
  # commit the main host runs; an older worker next to newer ones can process jobs twice.
  echo "Stop the workers of this host (the main host keeps working): sudo docker compose stop ${WORKERS[*]}" >&2
  if [[ -n "$previous_image" && "$previous_image" != "$IMAGE:$TAG" ]]; then
    echo "Or, only if the main host runs that commit, roll back: sudo TAG=${previous_image#"$IMAGE":} docker compose up -d --no-deps ${WORKERS[*]}" >&2
  fi
  exit 1
fi

# Every deploy leaves an image per commit; keep this one and the previous one (rollback).
log 'Removing older worker images'
images=$(docker image ls "$IMAGE" --format '{{.Repository}}:{{.Tag}}' || true)
for image in $images; do
  if [[ "$image" != "$IMAGE:$TAG" && "$image" != "$previous_image" ]]; then
    docker image rm "$image" >/dev/null 2>&1 && echo "Removed $image" || true
  fi
done
docker image prune -f >/dev/null || true

log 'Workers deployed'
docker compose ps "${WORKERS[@]}"
docker compose logs --tail 20 "${WORKERS[@]}"
