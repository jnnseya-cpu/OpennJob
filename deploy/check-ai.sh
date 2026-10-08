#!/usr/bin/env bash
# Is the AI (Claude, Gemini or OpenAI) really working for OpennJob? As root on the server:
#
#   cd /opt/opennjob && bash deploy/check-ai.sh
#
# Shows whether the key reached the API, the model, OpennJob's own daily AI allowance and today's
# use, how many applications were written with and without AI, and makes ONE tiny real call to
# the AI (a few tokens). Never prints the key or any CV or application text.
set -uo pipefail
cd "${OPENNJOB_DIR:-/opt/opennjob}" || exit 1
q() { ./oj exec -T postgres psql -U opennjob -d opennjob -At -c "$1" 2>&1; }

echo "== Settings the API is running with"
./oj exec -T api node -e '
const { loadConfig, limitsOf } = require("/app/apps/api/dist/deps.js");
const c = loadConfig(process.env), l = limitsOf(c);
const provider = (process.env.OPENNJOB_LLM_PROVIDER || "").trim().toLowerCase() || "anthropic";
const keyName = provider === "gemini" ? "GEMINI_API_KEY" : provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
const key = (process.env[keyName] || "").trim();
console.log("  AI provider:    " + provider);
console.log("  key:            " + (key ? "set (" + key.length + " characters, starts " + key.slice(0, 5) + "...)" : "NOT SET: bash deploy/set-keys.sh " + (provider === "anthropic" ? "claude" : provider)));
console.log("  model:          " + ((provider === "anthropic" ? process.env.OPENNJOB_MODEL : process.env.OPENNJOB_LLM_MODEL) || "(default)"));
const cap = (n) => (Number.isFinite(n) ? n + " units a day" : "unlimited");
console.log("  daily allowance per person: " + cap(l.llmDailyAcuPerUser) + "; everyone: " + cap(l.llmDailyAcuTotal));
console.log("  AI reads job requirements:  " + (c.llmCriteria ? "yes" : "no"));
' 2>&1 | sed 's/^/ /'

echo "== AI used today (London day; 1 unit = 1,000 tokens)"
q "select coalesce(round(sum(acu)::numeric,1),0) || ' units in ' || count(*) || ' calls' from usage_records where at >= (date_trunc('day', now() at time zone 'Europe/London') at time zone 'Europe/London')" | sed 's/^/  /'
q "select '  ' || purpose || ': ' || round(sum(acu)::numeric,1) || ' units' from usage_records where at >= (date_trunc('day', now() at time zone 'Europe/London') at time zone 'Europe/London') group by purpose order by sum(acu) desc limit 6"

echo "== Open applications: how their documents were written"
q "select '  ' || count(*) || ' ' || case statement_source when 'llm' then 'with AI' else 'without AI' end from applications where status in ('draft','needs_you','confirmed') group by statement_source"

echo "== One real call to the AI"
./oj exec -T api node -e '
const { buildLlm } = require("/app/apps/api/dist/deps.js");
const llm = buildLlm(process.env);
if (!llm) { console.log("  NO  no AI key for the chosen provider"); process.exit(0); }
const t = Date.now();
llm.complete({ system: "Reply with the single word OK.", prompt: "Say OK.", maxTokens: 16 })
  .then((r) => console.log("  OK  the AI answered (" + (r.text || "").trim().slice(0, 10) + ") in " + ((Date.now() - t) / 1000).toFixed(1) + "s with model " + llm.model))
  .catch((e) => console.log("  NO  the call failed: " + (e && (e.status ? "HTTP " + e.status + " " : "") + (e.message || e.name || "error")).slice(0, 300)));
' 2>&1
echo "If the call is OK: Matches > Run agent rewrites up to 20 applications made without AI (not ones you edited)."
