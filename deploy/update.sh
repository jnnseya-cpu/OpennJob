#!/usr/bin/env bash
# Update OpennJob on this server now, by hand:
#
#   bash /opt/opennjob/deploy/update.sh
#
# Pulls the latest version of the branch, rebuilds and restarts, and records the version so the
# Account screen shows which one is running ("Server version"). Then checks the health of the API.
set -euo pipefail
cd "${OPENNJOB_DIR:-/opt/opennjob}"
[ -x ./oj ] || { echo "Run deploy/install-hostinger.sh first (no ./oj here)." >&2; exit 1; }
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
git pull --ff-only origin "$BRANCH"
export OPENNJOB_VERSION="$(git log -1 --format='%h %cs')"
echo "== Building and restarting version $OPENNJOB_VERSION"
./oj up -d --build --remove-orphans
for _ in $(seq 1 36); do
  if ./oj exec -T api node -e "fetch('http://127.0.0.1:8080/health').then(r=>r.json()).then(j=>{console.log(JSON.stringify(j));process.exit(j.status==='ok'?0:1)},()=>process.exit(1))" 2>/dev/null; then
    echo "== Running $OPENNJOB_VERSION. Reload the app (close and reopen it on a phone)."
    exit 0
  fi
  sleep 5
done
echo "The API did not become healthy. See: ./oj ps   and   ./oj logs --tail=100 api" >&2
exit 1
