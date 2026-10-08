#!/usr/bin/env bash
# Backup restore drill: proves the newest nightly backup can be restored. As root on the server:
#
#   cd /opt/opennjob && bash deploy/restore-drill.sh
#
# 1. Takes the newest ./backups/*.dump (or BACKUP_FILE=...).
# 2. Starts a throwaway PostgreSQL 16 container with no network, restores the dump into it, and
#    times the restore.
# 3. Compares it with the live database: every table present, row counts, the latest migration,
#    and that accounts, profiles and applications came back. Counts may be a little lower than
#    live (the dump is up to a day old); a table that is empty in the restore but not live fails.
# 4. Removes the container and appends the result to ./backups/restore-drill.log.
#
# It never writes to the live database and prints counts only: no personal data.
# For a test run without Docker: DRILL_TARGET_URL=postgres://... (an empty database) and
# LIVE_URL=postgres://... use psql/pg_restore directly.
set -uo pipefail
cd "${OPENNJOB_DIR:-/opt/opennjob}" 2>/dev/null || true

BACKUP="${BACKUP_FILE:-$(ls -1t backups/*.dump 2>/dev/null | head -1)}"
[ -n "$BACKUP" ] && [ -s "$BACKUP" ] || { echo "No backup found in ./backups (or BACKUP_FILE is empty). Is the backup service running? ./oj ps backup"; exit 1; }
LOG="${DRILL_LOG:-backups/restore-drill.log}"
NAME="opennjob-restore-drill-$$"

live() {
  if [ -n "${LIVE_URL:-}" ]; then psql "$LIVE_URL" -At -v ON_ERROR_STOP=1 -c "$1"
  else ./oj exec -T postgres psql -U opennjob -d opennjob -At -v ON_ERROR_STOP=1 -c "$1"; fi
}
target() {
  if [ -n "${DRILL_TARGET_URL:-}" ]; then psql "$DRILL_TARGET_URL" -At -v ON_ERROR_STOP=1 -c "$1"
  else docker exec "$NAME" psql -U postgres -d drill -At -v ON_ERROR_STOP=1 -c "$1"; fi
}
cleanup() { [ -z "${DRILL_TARGET_URL:-}" ] && docker rm -f "$NAME" >/dev/null 2>&1; }
trap cleanup EXIT

echo "== Restoring $(basename "$BACKUP") ($(du -h "$BACKUP" | cut -f1), made $(date -u -r "$BACKUP" +%Y-%m-%dT%H:%MZ))"
START=$(date +%s)
if [ -n "${DRILL_TARGET_URL:-}" ]; then
  pg_restore --no-owner --no-privileges --exit-on-error -d "$DRILL_TARGET_URL" "$BACKUP" || { echo "FAIL: pg_restore failed"; exit 1; }
else
  docker run -d --rm --name "$NAME" --network none -e POSTGRES_PASSWORD=drill -e POSTGRES_DB=drill postgres:16 >/dev/null || { echo "FAIL: could not start a PostgreSQL container"; exit 1; }
  for _ in $(seq 1 60); do docker exec "$NAME" pg_isready -U postgres -d drill >/dev/null 2>&1 && break; sleep 1; done
  docker cp "$BACKUP" "$NAME:/tmp/drill.dump" >/dev/null
  docker exec "$NAME" pg_restore -U postgres -d drill --no-owner --no-privileges --exit-on-error /tmp/drill.dump || { echo "FAIL: pg_restore failed"; exit 1; }
fi
SECONDS_TAKEN=$(( $(date +%s) - START ))

TABLES_SQL="select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by 1"
LIVE_TABLES="$(live "$TABLES_SQL")" || { echo "FAIL: could not read the live database"; exit 1; }
FAIL=0
printf '%-32s %10s %10s\n' table live restored
for t in $LIVE_TABLES; do
  l="$(live "select count(*) from \"$t\"")"
  r="$(target "select count(*) from \"$t\"" 2>/dev/null)" || r="MISSING"
  mark=""
  if [ "$r" = MISSING ]; then mark="  <- missing"; FAIL=1
  elif [ "$l" -gt 0 ] && [ "$r" -eq 0 ]; then mark="  <- empty"; FAIL=1; fi
  printf '%-32s %10s %10s%s\n' "$t" "$l" "$r" "$mark"
done
LM="$(live "select max(version) from schema_migrations")"; RM="$(target "select max(version) from schema_migrations")"
echo "latest migration: live $LM, restored $RM"
[ "$RM" = "$LM" ] || { echo "  <- the backup is from before the latest migration (fine if a migration ran today; otherwise the backup is stale)"; }
for t in users schema_migrations; do
  [ "$(target "select count(*) > 0 from \"$t\"")" = t ] || { echo "FAIL: $t is empty in the restore"; FAIL=1; }
done

RESULT=$([ "$FAIL" = 0 ] && echo PASS || echo FAIL)
echo "== $RESULT: restored in ${SECONDS_TAKEN}s"
mkdir -p "$(dirname "$LOG")"
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $RESULT backup=$(basename "$BACKUP") restore_seconds=$SECONDS_TAKEN migration=$RM" >> "$LOG"
[ "$FAIL" = 0 ]
