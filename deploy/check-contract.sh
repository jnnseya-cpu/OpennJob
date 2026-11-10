#!/usr/bin/env bash
# Where do contract / temporary roles go? Counts stored jobs by contract type, then for your
# account shows how many contract roles survive each filter (in scope, pay, score >= 70).
# Counts only; no personal data.
#
#   cd /opt/opennjob && bash deploy/check-contract.sh
set -uo pipefail
cd "${OPENNJOB_DIR:-/opt/opennjob}" || exit 1
q() { ./oj exec -T postgres psql -U opennjob -d opennjob -At -c "$1" 2>/dev/null; }

echo "== Stored jobs by contract type"
out="$(q "select '  ' || coalesce(contract_type,'(unknown)') || ': ' || count(*) from jobs group by contract_type order by count(*) desc")"
[ -n "$out" ] && printf '%s\n' "$out" || echo "  (could not read the database)"

echo "== Contract roles through your filters"
./oj exec -T api node -e '
const { createDefaultDeps } = require("/app/apps/api/dist/deps.js");
const core = require("/app/packages/core/dist/index.js");
const { inScope, payFits, payExpectationOf, preferencesOf, matchJob } = core;
(async () => {
  const deps = createDefaultDeps(process.env);
  const repo = deps.repository;
  const threshold = Number(process.env.OPENNJOB_APPLY_THRESHOLD || 70) || 70;
  for (const uid of await repo.listUserIds()) {
    const profile = await repo.getProfile(uid);
    if (!profile) continue;
    const prefs = preferencesOf(profile);
    const passport = (await repo.getPassport(uid)) || undefined;
    const pay = payExpectationOf(await repo.getScreeningAnswers(uid));
    const jobs = await repo.listJobs();
    const contract = jobs.filter((j) => j.contractType === "contract");
    let inScopeN = 0, payN = 0, scoreN = 0;
    for (const j of contract) {
      const scoped = inScope(j, prefs);
      if (scoped) inScopeN++;
      const paid = scoped && payFits(j, pay);
      if (paid) payN++;
      if (paid && matchJob(j, profile.cvText, passport, prefs).score >= threshold) scoreN++;
    }
    console.log("  account " + uid);
    console.log("    contract roles stored:     " + contract.length);
    console.log("    in your scope:             " + inScopeN);
    console.log("    and pay fits (day/salary): " + payN);
    console.log("    and score >= " + threshold + "%:          " + scoreN + "   <- these would show as matches");
    console.log("    your search types:         " + (prefs.searchTypes && prefs.searchTypes.length ? prefs.searchTypes.join(", ") : "(none set = all allowed)"));
    console.log("    your day rate / salary:    " + JSON.stringify(pay));
  }
})().catch((e) => { console.error((e && e.stack) || e); process.exit(1); });
'
