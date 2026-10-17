#!/usr/bin/env bash
# Decisive check: does the stored CV trace against ITSELF with the deployed code? Prints the raw
# CV's own untraceable tokens, whether a few known-present terms are found, and the CV length.
# No full CV text is printed — only short tokens and yes/no probes.
#
#   cd /opt/opennjob && bash deploy/trace-probe.sh
set -uo pipefail
cd "${OPENNJOB_DIR:-/opt/opennjob}" || exit 1

./oj exec -T api node -e '
const { createDefaultDeps } = require("/app/apps/api/dist/deps.js");
const { traceRewrittenCv, traceCheck, preferencesOf } = require("/app/packages/core/dist/index.js");
(async () => {
  const repo = createDefaultDeps(process.env).repository;
  for (const uid of await repo.listUserIds()) {
    const p = await repo.getProfile(uid);
    if (!p) continue;
    const passport = (await repo.getPassport(uid)) || undefined;
    const sources = { cvText: p.cvText, passport, languages: preferencesOf(p).languages, personName: (p.firstName + " " + p.lastName).trim() };
    console.log("== account " + uid);
    console.log("  cvText length: " + (p.cvText ? p.cvText.length : 0) + " chars, lines: " + (p.cvText ? p.cvText.split(/\r?\n/).filter(Boolean).length : 0));
    const self = traceRewrittenCv(p.cvText || "", sources);
    console.log("  RAW CV traced against ITSELF — failing lines: " + self.length);
    const toks = [...new Set(self.flatMap((f) => f.unsupported || []))];
    console.log("  untraceable tokens from the CV itself (" + toks.length + "): " + toks.slice(0, 40).join(", "));
    for (const term of ["PRINCE2", "Telephone", "MCIOB", "earned value", "Common Data"]) {
      const present = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(p.cvText || "");
      const traces = traceCheck({ tailoredCv: term + " held." }, sources).length === 0;
      console.log("  \"" + term + "\": in CV text=" + present + ", traceCheck passes=" + traces);
    }
  }
})().catch((e) => { console.error((e && e.stack) || e); process.exit(1); });
'
