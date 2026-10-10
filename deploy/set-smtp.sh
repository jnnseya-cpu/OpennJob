#!/usr/bin/env bash
# Turn on e-mail through a mailbox over SMTP (Hostinger Email by default), on the server:
#
#   cd /opt/opennjob && bash deploy/set-smtp.sh [mailbox-address]
#
# Asks for the mailbox password without showing it, stores it only in .env.production
# (readable by root only), restarts the API, and checks that the mailbox accepts the login.
# Nothing is sent by the check.
set -euo pipefail
cd "${OPENNJOB_DIR:-/opt/opennjob}"
F=.env.production
[ -f "$F" ] || { echo "No $F here: run deploy/install-hostinger.sh first." >&2; exit 1; }
[ -x ./oj ] || { echo "No ./oj here: run deploy/install-hostinger.sh first." >&2; exit 1; }

current() { grep -E "^$1=" "$F" | head -1 | cut -d= -f2- | tr -d "\"'" || true; }
MAILBOX="${1:-$(current SMTP_USER)}"; MAILBOX="${MAILBOX:-$(current ACME_EMAIL)}"
HOST="${SMTP_HOST:-smtp.hostinger.com}"
PORT="${SMTP_PORT:-465}"

read -r -p "Mailbox address [$MAILBOX]: " answer </dev/tty; MAILBOX="${answer:-$MAILBOX}"
read -r -s -p "Password of $MAILBOX (not shown): " PASSWORD </dev/tty; echo
[ -n "$PASSWORD" ] || { echo "No password given; nothing changed." >&2; exit 1; }
case "$PASSWORD" in *"'"*) echo "The password contains a single quote ('), which the settings file cannot hold. Change the mailbox password in Hostinger and run this again." >&2; exit 1 ;; esac

tmp="$(mktemp)"; chmod 600 "$tmp"
grep -vE '^(SMTP_HOST|SMTP_PORT|SMTP_USER|SMTP_PASSWORD)=' "$F" > "$tmp" || true
{
  echo "SMTP_HOST=$HOST"
  echo "SMTP_PORT=$PORT"
  echo "SMTP_USER=$MAILBOX"
  printf "SMTP_PASSWORD='%s'\n" "$PASSWORD"   # single quotes: taken literally, even with \$ or #
} >> "$tmp"
cat "$tmp" > "$F"; rm -f "$tmp"; chmod 600 "$F"
unset PASSWORD

echo "== Restarting the API with SMTP"
./oj up -d api >/dev/null

echo "== Checking the login at $HOST:$PORT (nothing is sent)"
for _ in $(seq 1 20); do ./oj exec -T api true >/dev/null 2>&1 && break; sleep 2; done
./oj exec -T api node -e '
const n = require("nodemailer"); const e = process.env; const tls = e.SMTP_PORT === "465";
n.createTransport({ host: e.SMTP_HOST, port: Number(e.SMTP_PORT), secure: tls, requireTLS: !tls, auth: { user: e.SMTP_USER, pass: e.SMTP_PASSWORD }, connectionTimeout: 15000 })
 .verify().then(() => console.log("SMTP login OK: e-mail is on."), (err) => { console.log("SMTP login FAILED (" + (err.code || err.name) + "). Check the address and password in Hostinger, then run this again."); process.exit(1); });'
