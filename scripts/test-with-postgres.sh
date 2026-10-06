#!/usr/bin/env bash
# Runs the tests that need a live PostgreSQL against a THROWAWAY instance: initdb in a
# temporary directory, start it on a spare port, run the command, stop it, delete it.
#
#   npm run test:pg                      # vitest, including every PostgreSQL-backed test
#   npm run test:pg -- npm run test:e2e  # any other command, with DATABASE_URL set for it
#
# It needs the PostgreSQL server binaries (initdb, pg_ctl), not just the client. It never
# touches a database you already have: it only sets DATABASE_URL for the command it runs.
# PostgreSQL refuses to run as root, so as root it runs the server as the `postgres` user.
set -euo pipefail

find_bin() {
  if command -v initdb >/dev/null 2>&1; then dirname "$(command -v initdb)"; return; fi
  for d in /usr/lib/postgresql/*/bin /usr/local/opt/postgresql@*/bin /opt/homebrew/opt/postgresql@*/bin /usr/pgsql-*/bin; do
    if [ -x "$d/initdb" ]; then echo "$d"; fi
  done | sort -V | tail -1
}
BIN="$(find_bin)"
if [ -z "$BIN" ]; then
  echo "test-with-postgres: no PostgreSQL server binaries found (initdb). Install PostgreSQL 16, or set DATABASE_URL yourself and run 'npm test'." >&2
  exit 1
fi

PORT="${OPENNJOB_TEST_PG_PORT:-54329}"
DIR="$(mktemp -d "${TMPDIR:-/tmp}/opennjob-pg-XXXXXX")"
chmod 755 "$DIR"
AS=()
if [ "$(id -u)" = "0" ]; then
  chown postgres "$DIR"
  AS=(runuser -u postgres --)
fi

cleanup() {
  "${AS[@]}" "$BIN/pg_ctl" -D "$DIR/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$DIR"
}
trap cleanup EXIT

"${AS[@]}" "$BIN/initdb" -D "$DIR/data" -A trust -U postgres >/dev/null
"${AS[@]}" "$BIN/pg_ctl" -D "$DIR/data" -o "-p $PORT -k $DIR -c listen_addresses=127.0.0.1" -l "$DIR/log" -w start >/dev/null
"${AS[@]}" "$BIN/createdb" -h 127.0.0.1 -p "$PORT" -U postgres opennjob_test

export DATABASE_URL="postgres://postgres@127.0.0.1:$PORT/opennjob_test"
echo "test-with-postgres: $("$BIN/postgres" --version) on port $PORT (throwaway, in $DIR)"
if [ "$#" -eq 0 ]; then set -- npx vitest run; fi
"$@"
