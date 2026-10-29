#!/usr/bin/env bash
# Bring this server up to date in one go, and keep it up to date from then on. As root:
#
#   cd /opt/opennjob && git pull && bash deploy/catch-up.sh
#
# 1. Puts the code on the pilot branch (claude/busy-fermat-9hhn11, or OPENNJOB_BRANCH) and pulls
#    every change pushed to it. Local edits to tracked files stop it (nothing is overwritten).
# 2. Raises settings that older versions of .env.production set too low (searches per person,
#    daily AI limits). Keys and passwords are not touched.
# 3. Rebuilds and restarts (database migrations run on start), and checks the API is healthy.
# 4. Turns on automatic updates: every 10 minutes, with rollback if a new version is unhealthy.
# 5. Lists what changed since the version that was running.
set -euo pipefail
DIR="${OPENNJOB_DIR:-/opt/opennjob}"
BRANCH="${OPENNJOB_BRANCH:-claude/busy-fermat-9hhn11}"
cd "$DIR"
[ "$(id -u)" -eq 0 ] || { echo "Run as root (sudo bash deploy/catch-up.sh)." >&2; exit 1; }
[ -x ./oj ] && [ -f .env.production ] || { echo "Run deploy/install-hostinger.sh first (no ./oj or .env.production here)." >&2; exit 1; }

BEFORE="$(git rev-parse --short HEAD)"
echo "== Code: branch $BRANCH (running $BEFORE)"
git fetch -q origin "$BRANCH"
[ "$(git rev-parse --abbrev-ref HEAD)" = "$BRANCH" ] || git checkout -q "$BRANCH"
git merge -q --ff-only "origin/$BRANCH" || { echo "A tracked file was edited on this server; see 'git status'. Nothing was updated." >&2; exit 1; }
AFTER="$(git rev-parse --short HEAD)"

echo "== Settings"
F=.env.production
value() { grep -E "^$1=" "$F" | head -1 | cut -d= -f2- | tr -d "\"'" || true; }
raise() { # raise KEY MIN: set KEY to MIN when it is missing or lower
  local v; v="$(value "$1")"
  if ! [[ "$v" =~ ^[0-9]+$ ]] || [ "$v" -lt "$2" ]; then
    grep -vE "^$1=" "$F" > "$F.new" || true
    printf "%s='%s'\n" "$1" "$2" >> "$F.new"
    cat "$F.new" > "$F"; rm -f "$F.new"; chmod 600 "$F"
    echo "   $1: ${v:-unset} -> $2"
  fi
}
raise OPENNJOB_SEARCH_MAX_QUERIES_PER_USER 40
raise OPENNJOB_SEARCH_MAX_QUERIES_PER_REFRESH 150
# The owner asked for no AI limits (7 October 2026): a number left from an older settings file
# would hold drafts without AI ("the daily AI spending limit was reached"). Spending still shows on
# the Anthropic Console, where a monthly limit can be set.
unlimit() {
  local v; v="$(value "$1")"
  if [[ "$v" =~ ^[0-9]+$ ]]; then
    grep -vE "^$1=" "$F" > "$F.new" || true
    printf "%s='unlimited'\n" "$1" >> "$F.new"
    cat "$F.new" > "$F"; rm -f "$F.new"; chmod 600 "$F"
    echo "   $1: $v -> unlimited"
  fi
}
unlimit OPENNJOB_LLM_DAILY_ACU_PER_USER
unlimit OPENNJOB_LLM_DAILY_ACU_TOTAL
unlimit OPENNJOB_LLM_CRITERIA_MAX_JOBS
# The OpennJob extension must be allowed to call the API (its ID is fixed in its manifest).
EXT_ORIGIN=chrome-extension://hempmcajfhphflmemhidmgbfookifiim
CORS="$(value OPENNJOB_CORS_ORIGINS)"
if [ -n "$CORS" ] && [[ ",$CORS," != *",$EXT_ORIGIN,"* ]]; then
  grep -vE "^OPENNJOB_CORS_ORIGINS=" "$F" > "$F.new" || true
  printf "OPENNJOB_CORS_ORIGINS='%s'\n" "$CORS,$EXT_ORIGIN" >> "$F.new"
  cat "$F.new" > "$F"; rm -f "$F.new"; chmod 600 "$F"
  echo "   OPENNJOB_CORS_ORIGINS: added the extension"
fi

OPENNJOB_VERSION="$(git log -1 --format='%h %cs')"
export OPENNJOB_VERSION
echo "== Building and restarting $OPENNJOB_VERSION (a few minutes)"
./oj up -d --build --remove-orphans
ok=""
for _ in $(seq 1 36); do
  if ./oj exec -T api node -e "fetch('http://127.0.0.1:8080/health').then(r=>r.json()).then(j=>process.exit(j.status==='ok'?0:1),()=>process.exit(1))" 2>/dev/null; then ok=1; break; fi
  sleep 5
done
[ -n "$ok" ] || { echo "The API did not become healthy. See: ./oj ps   and   ./oj logs --tail=100 api" >&2; exit 1; }

echo "== Automatic updates"
bash deploy/enable-auto-update.sh >/dev/null
systemctl is-active --quiet opennjob-update.timer && echo "   on: every 10 minutes, rolls back if a new version is unhealthy (history: journalctl -u opennjob-update)"

echo "== Running $OPENNJOB_VERSION"
if [ "$BEFORE" != "$AFTER" ]; then
  echo "   Changes brought in ($BEFORE -> $AFTER):"
  git log --format='   - %s (%cs)' "$BEFORE..$AFTER"
else
  echo "   It was already up to date."
fi
echo "   Not switched on by this script (keys you choose to add): bash deploy/set-keys.sh reliefweb | jooble"
echo "   Close and reopen the app on your phone; Account shows the server version."
