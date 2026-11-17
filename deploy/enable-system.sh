#!/usr/bin/env bash
# Switch an application system (Workday, SAP SuccessFactors, Greenhouse, Lever, Ashby, Workable)
# on or off for the queue, as root on the server:
#
#   cd /opt/opennjob
#   bash deploy/enable-system.sh status                 # what is on, with the evidence recorded
#   bash deploy/enable-system.sh workday                # switch Workday on (asks for the evidence)
#   bash deploy/enable-system.sh successfactors         # the same for SuccessFactors (and the employer's own domains)
#   bash deploy/enable-system.sh workday off            # switch it off
#
# A system may be switched on only with two pieces of evidence (APP-9, CLAUDE.md rule 5):
#   1. someone read that system's terms of use, and the employer's, and they allow this use;
#   2. one supervised real submission on it worked (deploy/supervised-test.md says how).
# The queue then fills and submits on that system under the person's standing authorisation, and
# still never answers a declaration, never ticks a consent box and stops at any sign-in or CAPTCHA.
set -euo pipefail
cd "${OPENNJOB_DIR:-/opt/opennjob}"
F=.env.production
[ -f "$F" ] && [ -x ./oj ] || { echo "Run deploy/install-hostinger.sh first (no $F or ./oj here)." >&2; exit 1; }

value() { grep -E "^$1=" "$F" | head -1 | cut -d= -f2- | tr -d "\"'" || true; }
KEY="$(value OPENNJOB_OPERATOR_KEY)"
if [ -z "$KEY" ]; then
  KEY="$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 40)"
  printf "OPENNJOB_OPERATOR_KEY='%s'\n" "$KEY" >> "$F"; chmod 600 "$F"
  echo "== Created an operator key (stored only in $F); restarting the API"
  ./oj up -d api >/dev/null
  for _ in $(seq 1 30); do ./oj exec -T api node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" 2>/dev/null && break; sleep 2; done
fi

# call METHOD PATH [JSON]: the operator API from inside the api container (the key never leaves the server).
call() {
  ./oj exec -T -e OP_KEY="$KEY" -e OP_METHOD="$1" -e OP_PATH="$2" -e OP_BODY="${3:-}" api node -e '
fetch("http://127.0.0.1:8080" + process.env.OP_PATH, { method: process.env.OP_METHOD, headers: { Authorization: "Bearer " + process.env.OP_KEY, "Content-Type": "application/json" }, ...(process.env.OP_BODY ? { body: process.env.OP_BODY } : {}) })
  .then(async (r) => { const t = await r.text(); if (!r.ok) { console.error("The API replied " + r.status + ": " + t); process.exit(1); } console.log(t); });'
}

SYSTEM="${1:-status}"
if [ "$SYSTEM" = status ]; then
  call GET /operator/status | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);for(const x of j.systems||[])console.log((x.enabled?"ON  ":"off ")+x.id.padEnd(16)+(x.extraHosts?.length?" extra hosts: "+x.extraHosts.join(", "):"")+(x.supervisedSubmissionAt?" supervised "+x.supervisedSubmissionAt.slice(0,10):""))})' 2>/dev/null || call GET /operator/status
  exit 0
fi
case "$SYSTEM" in workday|successfactors|greenhouse|lever|ashby|workable) ;; *) echo "Unknown system: $SYSTEM" >&2; sed -n '2,10p' "$0"; exit 1 ;; esac

if [ "${2:-on}" = off ]; then
  call PUT "/operator/systems/$SYSTEM" '{"enabled":false}' >/dev/null && echo "$SYSTEM is off: the queue holds its applications for the person."
  exit 0
fi

echo "Switching $SYSTEM on needs the evidence."
read -r -p "Have you read $SYSTEM's terms of use (and the employer's), and do they allow this use? [y/N]: " a </dev/tty
[ "$a" = y ] || [ "$a" = Y ] || { echo "Nothing changed."; exit 1; }
read -r -p "Date of the supervised real submission that worked (YYYY-MM-DD; see deploy/supervised-test.md): " d </dev/tty
[[ "$d" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || { echo "A date like 2026-10-08 is needed. Nothing changed."; exit 1; }
read -r -p "Note (which employer and job it was tested on): " note </dev/tty
read -r -p "The employer's own domains running $SYSTEM, comma-separated (e.g. jobs.example.org), or empty: " hosts </dev/tty
HOSTS_JSON="$(printf '%s' "$hosts" | tr ',' '\n' | sed 's/^ *//; s/ *$//' | grep . | sed 's/.*/"&"/' | paste -sd, - || true)"
NOTE_JSON="$(printf '%s' "$note" | sed 's/\\/\\\\/g; s/"/\\"/g' | head -c 400)"
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
BODY="{\"enabled\":true,\"termsCheckedAt\":\"$NOW\",\"supervisedSubmissionAt\":\"${d}T12:00:00Z\",\"note\":\"$NOTE_JSON\"${HOSTS_JSON:+,\"extraHosts\":[$HOSTS_JSON]}}"
call PUT "/operator/systems/$SYSTEM" "$BODY" >/dev/null
echo "$SYSTEM is on. Record the terms check in docs/sources.md and GO-LIVE.md (date and your name)."
