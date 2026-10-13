#!/usr/bin/env bash
# Why are prepared applications sitting in "Needs you"? Groups open applications by the reason
# they are held, so you can see whether it is the trace check, OpennJob's own daily AI limit, or
# the daily application limit. Counts only: no CV text, no statements, no personal details.
#
#   cd /opt/opennjob && bash deploy/why-held.sh
set -uo pipefail
cd "${OPENNJOB_DIR:-/opt/opennjob}" || exit 1
q() { ./oj exec -T postgres psql -U opennjob -d opennjob -At -c "$1" 2>/dev/null; }

echo "== Open applications by status"
q "select '  ' || status || ': ' || count(*) from applications where status in ('draft','confirmed','needs_you') group by status order by 2 desc"

echo "== Held applications by reason (one application can have more than one reason)"
held="$(q "select '  ' ||
  case r
    when 'trace-check' then 'trace-check   (a sentence could not be traced to the CV)'
    when 'llm-ceiling' then 'llm-ceiling   (OpennJob daily AI limit reached; drafted without AI)'
    when 'daily-limit' then 'daily-limit   (today''s application limit reached)'
    else r
  end || ': ' || count(*)
  from (select unnest(hold_reasons) as r from applications where status='needs_you') x
  group by r order by 2 desc")"
if [ -n "$held" ]; then printf '%s\n' "$held"; else echo "  (none held)"; fi

echo "== Of the held, how many are held ONLY by the trace check"
q "select '  trace-check only: ' || count(*) from applications
   where status='needs_you' and hold_reasons = array['trace-check']"
q "select '  trace-check + AI limit: ' || count(*) from applications
   where status='needs_you' and 'trace-check' = any(hold_reasons) and 'llm-ceiling' = any(hold_reasons)"

echo "== AI limit (NFR-5) — current settings"
grep -E '^OPENNJOB_LLM_(DAILY_ACU_PER_USER|DAILY_ACU_TOTAL|CRITERIA_MAX_JOBS)=' .env.production 2>/dev/null | sed 's/^/  /' || echo "  (not set in .env.production; defaults apply)"
echo "      Raise these (cheap on Haiku) if llm-ceiling holds many, then: ./oj up -d --force-recreate api"
echo "      To clear existing holds so they are re-drafted with AI: Matches > Run agent again."
