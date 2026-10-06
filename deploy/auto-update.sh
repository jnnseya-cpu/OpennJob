#!/usr/bin/env bash
# Install a new version of OpennJob when one is pushed, and go back if it does not work.
# Run by the systemd timer that deploy/enable-auto-update.sh sets up (every 10 minutes), or by hand:
#
#   bash /opt/opennjob/deploy/auto-update.sh
#
# 1. Fetch the branch. Nothing new: stop.
# 2. Move to the new commit (fast-forward only: local edits to tracked files stop it), rebuild, restart.
#    Migrations run on start, as with every update.
# 3. Check /api/health for up to 3 minutes. Healthy: done. Not healthy, or the build failed: go
#    back to the previous commit, rebuild and restart it, and record that the update was rolled back.
#    A commit that was rolled back is skipped until a newer one arrives.
#
# The settings file (.env.production), compose.local.yml and ./oj are not tracked by git and are not touched.
set -uo pipefail
DIR="${OPENNJOB_DIR:-/opt/opennjob}"
cd "$DIR" || exit 1
exec 9>"$DIR/.auto-update.lock"
flock -n 9 || { echo "Another update is running."; exit 0; }

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
env_value() { grep -E "^$1=" .env.production 2>/dev/null | head -1 | cut -d= -f2- | tr -d "\"'"; }

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
git fetch -q origin "$BRANCH" || { log "fetch failed; nothing changed"; exit 1; }
CURRENT="$(git rev-parse HEAD)"
TARGET="$(git rev-parse "origin/$BRANCH")"
[ "$CURRENT" = "$TARGET" ] && exit 0
if [ "$(cat .auto-update.rejected 2>/dev/null)" = "$TARGET" ]; then exit 0; fi
if ! git merge-base --is-ancestor "$CURRENT" "$TARGET"; then
  log "origin/$BRANCH is not ahead of the running version (history was rewritten); not updating. Update by hand."
  exit 1
fi

if [ "$(env_value OPENNJOB_MODE)" = proxy ]; then
  HEALTH="${HEALTH_URL:-http://$(env_value WEB_BIND):$(env_value WEB_PORT)/api/health}"
else
  HEALTH="${HEALTH_URL:-https://$(env_value DOMAIN)/api/health}"
fi
healthy() {
  for _ in $(seq 1 36); do
    curl -fsS --max-time 5 "$HEALTH" 2>/dev/null | grep -q '"status":"ok"' && return 0
    sleep 5
  done
  return 1
}
log "updating ${CURRENT:0:7} -> ${TARGET:0:7}: $(git log -1 --format=%s "$TARGET")"
if ! git merge -q --ff-only "$TARGET"; then
  log "a tracked file was edited on this server, so the update would overwrite it; not updating. See: git status"
  exit 1
fi
if ./oj up -d --build --remove-orphans >/dev/null 2>&1 && healthy; then
  log "updated to ${TARGET:0:7}; healthy"
  rm -f .auto-update.rejected
  exit 0
fi

log "update to ${TARGET:0:7} failed its health check; going back to ${CURRENT:0:7}"
echo "$TARGET" > .auto-update.rejected
git reset -q --hard "$CURRENT"
./oj up -d --build --remove-orphans >/dev/null 2>&1
if healthy; then log "rolled back to ${CURRENT:0:7}; healthy"; else log "rolled back to ${CURRENT:0:7}, but it is NOT healthy: check ./oj ps and ./oj logs api"; fi
exit 1
