#!/usr/bin/env bash
# Why is nothing going out automatically? Checks, on the server, every condition the two
# automatic routes need, and says which one is missing. Shows counts and settings only: no
# personal details, no keys.
#
#   cd /opt/opennjob && bash deploy/why-not-sent.sh
set -uo pipefail
cd "${OPENNJOB_DIR:-/opt/opennjob}" || exit 1
F=.env.production
q() { ./oj exec -T postgres psql -U opennjob -d opennjob -At -c "$1" 2>/dev/null; }
isset() { grep -qE "^$1=.+" "$F" && ! grep -qE "^$1=(''|\"\")?$" "$F"; }
ok() { printf '  OK  %s\n' "$1"; }
no() { printf '  NO  %s\n      -> %s\n' "$1" "$2"; }

echo "== Server"
v="$(./oj exec -T api node -e "fetch('http://127.0.0.1:8080/health').then(r=>r.json()).then(j=>console.log(j.version))" 2>/dev/null)"
[ -n "$v" ] && ok "API running, version $v" || no "API not answering" "bash deploy/update.sh"

echo "== Both routes need"
[ "$(q "select count(*) from users where email_verified_at is not null")" -gt 0 ] 2>/dev/null && ok "your e-mail address is verified" \
  || no "your e-mail address is not verified (nothing is ever sent for an unverified account)" "opennjob.com > Account: verify the address (the verification e-mail needs the e-mail sender below)"
auth="$(q "select (data->>'enabled') || ' ' || coalesce(data->>'scopeVersion','') || ' ' || coalesce(data->>'paused','false') from standing_authorisations limit 1")"
case "$auth" in
  "true od5-email-2026-10-06 false") ok "standing authorisation is on (current wording), not paused" ;;
  true*true) no "you paused the agent" "opennjob.com > Account: resume" ;;
  true*) no "standing authorisation was given to older wording" "opennjob.com > Account: turn it off and on again to agree to the current wording" ;;
  *) no "standing authorisation is off" "opennjob.com > Account: turn on 'Send applications for me'" ;;
esac
[ "$(q "select coalesce(value->>'paused','false') from platform_settings where key='agent.paused'")" = "true" ] && no "the operator pause is on" "bash deploy/enable-system.sh status; resume with the operator pause off" || ok "no operator pause"
auto="$(q "select count(*) from applications where mode='auto' and status in ('draft','confirmed')")"
all="$(q "select count(*) from applications where status in ('draft','confirmed','needs_you')")"
[ "${auto:-0}" -gt 0 ] && ok "$auto prepared application(s) in auto mode, ready to go" \
  || no "no prepared application in auto mode ($all open in all)" "opennjob.com: choose Auto at the top, then Matches > Run agent (only matches at or above your bar are prepared)"

echo "== Route 1: by e-mail to a recruiter (no browser needed, 06:00 or Run agent)"
if isset RESEND_API_KEY || isset SMTP_HOST; then ok "an e-mail sender is set up"; else no "no e-mail sender is set up: no application can be e-mailed, and no report or verification e-mail is sent" "bash deploy/set-smtp.sh (or add RESEND_API_KEY), see deploy/email-dns.md"; fi
withmail="$(q "select count(*) from applications a join jobs j on j.id=a.job_id where a.status in ('draft','confirmed') and a.mode='auto' and j.description ~* '[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}'")"
echo "      $withmail of your ready applications have an e-mail address in the advert"

echo "== Route 2: on Workday / SuccessFactors forms (Chrome open, extension signed in, Start the queue)"
q "select replace(key,'application-system.','') || ': ' || case when (value->>'enabled')='true' then 'ON' else 'off' end from platform_settings where key like 'application-system.%' order by 1" | sed 's/^/      /'
echo "      Where your ready applications' links point:"
hosts="$(q "select n || '  ' || host from (select split_part(apply_url,'/',3) as host, count(*) as n from applications where status in ('draft','confirmed') and mode='auto' group by host) h order by n desc limit 10")"
if [ -n "$hosts" ]; then printf '%s\n' "$hosts" | sed 's/^/        /'; else echo "        (could not read them: run bash deploy/update.sh, then this again)"; fi
echo "      Only links on myworkdayjobs.com / successfactors (with the system ON) go out on a form."
echo "      For a Reed or Adzuna link: Tracker > 'Ready, but you apply' > paste the employer's application page."
