#!/usr/bin/env bash
# Set a new password for an OpennJob account, on the server, as root (for when the reset e-mail
# cannot be used). The password is typed without being shown, checked against the same rules as
# the website, stored only as a bcrypt hash, and never written to a file or the shell history.
# Every "keep me signed in" session of that account is ended.
#
#   cd /opt/opennjob && bash deploy/set-password.sh
set -euo pipefail
cd "${OPENNJOB_DIR:-/opt/opennjob}"
[ -x ./oj ] || { echo "Run deploy/install-hostinger.sh first (no ./oj here)." >&2; exit 1; }

psqlq() { ./oj exec -T postgres psql -U opennjob -d opennjob -At "$@"; }
mapfile -t EMAILS < <(psqlq -c "select email from users order by created_at;")
[ "${#EMAILS[@]}" -gt 0 ] || { echo "There is no account on this server." >&2; exit 1; }
DEFAULT="${EMAILS[0]}"
read -r -p "Account e-mail [$DEFAULT]: " EMAIL </dev/tty
EMAIL="$(printf '%s' "${EMAIL:-$DEFAULT}" | tr '[:upper:]' '[:lower:]')"
printf '%s\n' "${EMAILS[@]}" | grep -qxF "$EMAIL" || { echo "No account with that e-mail." >&2; exit 1; }

read -r -s -p "New password (at least 12 characters, not shown): " P1 </dev/tty; echo
read -r -s -p "The same again: " P2 </dev/tty; echo
[ "$P1" = "$P2" ] || { echo "The two did not match. Nothing changed." >&2; exit 1; }

# Checked and hashed with the API's own code, inside its container.
HASH="$(./oj exec -T -e NEWPW="$P1" -e ACCOUNT="$EMAIL" api node -e '
const { passwordProblems, hashPassword } = require("/app/apps/api/dist/auth.js");
const problems = passwordProblems(process.env.NEWPW, process.env.ACCOUNT);
if (problems.length) { console.error("The password " + problems.join(", ") + ". Nothing changed."); process.exit(2); }
hashPassword(process.env.NEWPW, Number(process.env.OPENNJOB_BCRYPT_ROUNDS || 12)).then((h) => process.stdout.write(h));')" || { unset P1 P2; exit 1; }
unset P1 P2

psqlq -v h="$HASH" -v e="$EMAIL" <<'SQL' >/dev/null
UPDATE users SET password_hash = :'h' WHERE email = :'e';
UPDATE auth_tokens SET used_at = now() WHERE kind = 'refresh' AND used_at IS NULL AND user_id = (SELECT id FROM users WHERE email = :'e');
SQL
echo "Password changed for $EMAIL. Sign in with it on the website and in the extension."
