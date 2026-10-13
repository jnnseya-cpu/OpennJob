#!/usr/bin/env bash
# For each held application, show ONLY the short facts (words, numbers) a sentence used that could
# not be traced to the CV — and an aggregate of the most common ones across all held applications.
# This reveals why the trace check is holding things, without printing any statement or CV text.
#
#   cd /opt/opennjob && bash deploy/why-held-detail.sh
set -uo pipefail
cd "${OPENNJOB_DIR:-/opt/opennjob}" || exit 1

./oj exec -T api node -e '
const { createDefaultDeps } = require("/app/apps/api/dist/deps.js");
const core = require("/app/packages/core/dist/index.js");
const { traceCheck, traceRewrittenCv, preferencesOf } = core;
(async () => {
  const deps = createDefaultDeps(process.env);
  const repo = deps.repository;
  const users = await repo.listUserIds();
  const tally = new Map();
  let heldTotal = 0, nothingLeft = 0;
  for (const uid of users) {
    const profile = await repo.getProfile(uid);
    if (!profile) continue;
    const passport = (await repo.getPassport(uid)) || undefined;
    const languages = preferencesOf(profile).languages;
    const name = (profile.firstName + " " + profile.lastName).trim();
    const apps = (await repo.listApplications(uid)).filter((a) => a.status === "needs_you");
    for (const a of apps) {
      heldTotal++;
      const job = await repo.getJob(a.jobId);
      const sources = { cvText: profile.cvText, passport, languages, job: job && { title: job.title, employer: job.employer, location: job.location }, personName: name };
      const sf = a.statement ? traceCheck({ statement: a.statement }, sources) : [];
      const cf = a.tailoredCv ? traceRewrittenCv(a.tailoredCv, sources) : [];
      const toks = [];
      for (const f of [...sf, ...cf]) for (const t of (f.unsupported || [])) { toks.push(t); tally.set(t, (tally.get(t) || 0) + 1); }
      const uniq = [...new Set(toks)];
      const left = a.statement ? sf.length : 0;
      const label = (a.jobTitle || "?").slice(0, 40);
      if (uniq.length === 0 && sf.length === 0 && cf.length === 0) {
        console.log("  " + label + " — no failing token now (would clear on next run)");
      } else {
        console.log("  " + label + " — " + sf.length + " statement + " + cf.length + " CV line(s): " + uniq.slice(0, 12).join(", ").slice(0, 160));
      }
    }
  }
  console.log("");
  console.log("Held: " + heldTotal + ". Most common untraceable facts (count x fact):");
  const top = [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
  if (!top.length) console.log("  (none — every held application now traces clean; run the agent to clear them)");
  for (const [t, n] of top) console.log("  " + String(n).padStart(3) + " x  " + t);
})().catch((e) => { console.error((e && e.stack) || e); process.exit(1); });
'
