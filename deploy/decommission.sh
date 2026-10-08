#!/usr/bin/env bash
# Wind OpennJob down so nothing keeps running or charging. Run as root on the server:
#
#   cd /opt/opennjob && bash deploy/decommission.sh          # asks before each step
#   cd /opt/opennjob && bash deploy/decommission.sh --yes    # no questions
#
# It does three things, in order:
#   1. Turns off the auto-update timer, so no new version deploys.
#   2. Blanks the AI keys in .env.production, so nothing can call a paid AI even if it restarts.
#   3. Stops and removes the containers (./oj down). The database volume is KEPT, so no data is
#      lost: a person can still export or delete their account first (see below).
#
# It does NOT delete the database, the backups, or anything at the AI provider or the host.
# Capping or deleting the AI key at the provider, and exporting or deleting account data, are
# yours to do and are explained at the end. Re-start later with: ./oj up -d --build
set -uo pipefail
cd "${OPENNJOB_DIR:-/opt/opennjob}" || { echo "Run this from the OpennJob directory (usually /opt/opennjob)."; exit 1; }
[ "$(id -u)" = 0 ] || { echo "Run as root (the timer and .env.production need it)."; exit 1; }

YES=0
[ "${1:-}" = "--yes" ] && YES=1
ask() { [ "$YES" = 1 ] && return 0; printf '%s [y/N] ' "$1"; read -r a; [ "$a" = y ] || [ "$a" = Y ]; }

echo "== 1. Auto-update timer"
if ask "Turn off the auto-update timer?"; then
  if [ -f deploy/enable-auto-update.sh ]; then bash deploy/enable-auto-update.sh off
  else systemctl disable --now opennjob-update.timer 2>/dev/null || true; fi
  echo "  off."
else echo "  left on."; fi

echo "== 2. AI keys in .env.production"
if [ -f .env.production ] && ask "Blank ANTHROPIC_API_KEY, GEMINI_API_KEY and OPENAI_API_KEY in .env.production?"; then
  cp -a .env.production ".env.production.bak.$(date +%Y%m%d-%H%M%S)"
  for K in ANTHROPIC_API_KEY GEMINI_API_KEY OPENAI_API_KEY; do
    if grep -qE "^$K=" .env.production; then sed -i "s|^$K=.*|$K=|" .env.production; fi
  done
  echo "  blanked (a dated .env.production.bak copy was kept on this machine only)."
  echo "  This stops OpennJob using the key. It does NOT cap it at the provider: do that too (below)."
else echo "  left as they are."; fi

echo "== 3. Containers"
if ask "Stop and remove the containers now (the database volume is kept)?"; then
  if [ -x ./oj ]; then ./oj down
  else docker compose -f docker-compose.prod.yml down; fi
  echo "  down. The site is now offline. Data is kept in the Docker volume."
else echo "  left running."; fi

cat <<'NEXT'

== Still yours to do (I cannot do these for you)
  - AI provider: cap or delete the key at console.anthropic.com (Billing > set a $0/low limit,
    or API keys > revoke). Blanking it here stops OpennJob using it; it does not change your
    account at Anthropic.
  - Your account data: while the site is up, each person can export it (Account > Export) or
    delete it (Account > Delete account). Once the containers are down, bring them back with
    ./oj up -d --build to do this, then run step 3 again.
  - Backups: ./backups still holds database dumps on this machine. Delete them when you no
    longer need them: rm -f backups/*.dump
  - To wipe the database volume entirely (NO undo, after everyone has exported what they need):
      ./oj down -v
NEXT
echo "Done."
