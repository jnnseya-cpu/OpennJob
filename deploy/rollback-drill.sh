#!/usr/bin/env bash
# Rollback drill: proves the previous version can be put back and the current one restored.
# As root on the server, at a quiet time (the site restarts twice, about a minute each):
#
#   cd /opt/opennjob && bash deploy/rollback-drill.sh            # back one commit, then forward
#   ROLLBACK_TO=<commit> bash deploy/rollback-drill.sh           # back to a chosen commit
#
# 1. Takes the auto-update lock, so an update cannot start halfway through.
# 2. Moves to the older commit, rebuilds and restarts (the older code may start on the newer
#    database schema: OPENNJOB_ALLOW_NEWER_SCHEMA=1), and checks /api/health and the sign-in page.
# 3. Moves back to the commit it started on, rebuilds and restarts, and checks again.
# 4. Appends the result and both times to ./backups/rollback-drill.log.
# If the way forward fails it says so and leaves the error visible: run ./oj ps and ./oj logs api.
# Rolling back to a commit from before 8 October 2026 (no OPENNJOB_ALLOW_NEWER_SCHEMA) works only
# when no migration was added since.
set -uo pipefail
DIR="${OPENNJOB_DIR:-/opt/opennjob}"
cd "$DIR" || exit 1
exec 9>"$DIR/.auto-update.lock"
flock -n 9 || { echo "An update is running; try again in a few minutes."; exit 1; }

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
env_value() { grep -E "^$1=" .env.production 2>/dev/null | head -1 | cut -d= -f2- | tr -d "\"'"; }
if [ "$(env_value OPENNJOB_MODE)" = proxy ]; then
  HEALTH="${HEALTH_URL:-http://$(env_value WEB_BIND):$(env_value WEB_PORT)/api/health}"
else
  HEALTH="${HEALTH_URL:-https://$(env_value DOMAIN)/api/health}"
fi
SITE="${HEALTH%/api/health}"
healthy() {
  for _ in $(seq 1 36); do
    curl -fsS --max-time 5 "$HEALTH" 2>/dev/null | grep -q '"status":"ok"' \
      && curl -fsS --max-time 5 "$SITE/signin/" 2>/dev/null | grep -q '/_next/static/' && return 0
    sleep 5
  done
  return 1
}
[ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "Tracked files were edited on this server (git status); not running the drill."; exit 1; }

CURRENT="$(git rev-parse HEAD)"
TARGET="$(git rev-parse "${ROLLBACK_TO:-HEAD~1}")" || exit 1
healthy || { echo "The running version is not healthy now; fix that first."; exit 1; }
log "drill: ${CURRENT:0:7} -> ${TARGET:0:7} -> ${CURRENT:0:7}"
RESULT=PASS

go_to() {
  git reset -q --hard "$1"
  export OPENNJOB_VERSION="$(git log -1 --format='%h %cs' "$1")"
  local t=$(date +%s)
  ./oj up -d --build --remove-orphans >/dev/null 2>&1 && healthy
  local ok=$?
  echo $(( $(date +%s) - t ))
  return $ok
}

export OPENNJOB_ALLOW_NEWER_SCHEMA=1
if BACK_S="$(go_to "$TARGET")"; then log "back on ${TARGET:0:7}: healthy after ${BACK_S}s"; else log "back on ${TARGET:0:7}: NOT healthy after ${BACK_S}s"; RESULT=FAIL; fi
unset OPENNJOB_ALLOW_NEWER_SCHEMA
if FWD_S="$(go_to "$CURRENT")"; then log "forward on ${CURRENT:0:7}: healthy after ${FWD_S}s"; else log "forward on ${CURRENT:0:7}: NOT healthy after ${FWD_S}s: check ./oj ps and ./oj logs api"; RESULT=FAIL; fi

mkdir -p backups
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $RESULT from=${CURRENT:0:7} to=${TARGET:0:7} back_seconds=$BACK_S forward_seconds=$FWD_S" >> backups/rollback-drill.log
log "drill $RESULT"
[ "$RESULT" = PASS ]
