#!/usr/bin/env bash
# Why are prepared applications sitting in "Needs you"? Groups open applications by the reason
# they are held, so you can see whether it is the trace check, OpennJob's own daily AI limit, or
# the daily application limit. Counts only: no CV text, no statements, no personal details.
#
#   cd /opt/opennjob && bash deploy/why-held.sh
set -uo pipefail
cd "${OPENNJOB_DIR:-/opt/opennjob}" || exit 1
q() { ./oj exec -T postgres psql -U opennjob -d opennjob -At -c "$1" 2>/dev/null; }

echo "== Applications by status (all)"
out="$(q "select '  ' || status || ': ' || count(*) from applications group by status order by count(*) desc")"
[ -n "$out" ] && printf '%s\n' "$out" || echo "  (could not read the database)"

echo "== Held applications by reason (one application can have more than one reason)"
# hold_reasons is JSONB (e.g. ["trace-check","llm-ceiling"]); expand it to one row per reason.
held="$(q "select '  ' ||
  case r
    when 'trace-check' then 'trace-check   (a sentence could not be traced to the CV)'
    when 'llm-ceiling' then 'llm-ceiling   (OpennJob daily AI limit reached; drafted without AI)'
    when 'daily-limit' then 'daily-limit   (today''s application limit reached)'
    else r
  end || ': ' || count(*)
  from (select jsonb_array_elements_text(hold_reasons) as r from applications where status='needs_you') x
  group by r order by count(*) desc")"
if [ -n "$held" ]; then printf '%s\n' "$held"; else echo "  (none held)"; fi

echo "== Of the held, how the trace check and the AI limit overlap"
q "select '  trace-check only:      ' || count(*) from applications where status='needs_you' and hold_reasons = '[\"trace-check\"]'::jsonb"
q "select '  trace-check + AI limit: ' || count(*) from applications where status='needs_you' and hold_reasons @> '[\"trace-check\"]'::jsonb and hold_reasons @> '[\"llm-ceiling\"]'::jsonb"

echo "== AI limit (NFR-5) — current settings"
grep -E '^OPENNJOB_LLM_(DAILY_ACU_PER_USER|DAILY_ACU_TOTAL|CRITERIA_MAX_JOBS)=' .env.production 2>/dev/null | sed 's/^/  /' || echo "  (not set in .env.production; defaults apply)"
echo "      Raise these (cheap on Haiku) if llm-ceiling holds many, then: ./oj up -d --force-recreate api"
echo "      To clear existing holds (re-check with the current trace logic, re-draft with AI): Matches > Run agent."
