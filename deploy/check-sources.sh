#!/usr/bin/env bash
# Ask each job source that is switched on for one sample search, and show how many jobs came back.
# Use it after adding a key (deploy/set-keys.sh) to see that the key and the source work. As root:
#
#   cd /opt/opennjob && bash deploy/check-sources.sh                          # "electrical engineer" in GB FR BE CA CD AE
#   bash deploy/check-sources.sh "project manager" "AE,GB"                   # your own title and countries
#
# Prints only the source, the country, the number of jobs and the first job's title and employer.
# Never prints a key. Each line is one real call to that source (it counts against its quota).
set -euo pipefail
cd "${OPENNJOB_DIR:-/opt/opennjob}"
[ -x ./oj ] || { echo "Run deploy/install-hostinger.sh first (no ./oj here)." >&2; exit 1; }
TITLE="${1:-electrical engineer}"
COUNTRIES="${2:-GB,FR,BE,CA,CD,AE}"
./oj exec -T -e CHECK_TITLE="$TITLE" -e CHECK_COUNTRIES="$COUNTRIES" api node -e '
const { buildSearchSources } = require("/app/apps/api/dist/deps.js");
const sources = buildSearchSources(process.env, fetch);
const wanted = process.env.CHECK_COUNTRIES.split(",").map((c) => c.trim().toUpperCase()).filter(Boolean);
const what = process.env.CHECK_TITLE;
(async () => {
  if (!sources.length) { console.log("No job source is switched on. Add one: bash deploy/set-keys.sh adzuna | reed | reliefweb | jooble"); return; }
  console.log("Searching for \"" + what + "\". Sources on: " + sources.map((s) => s.label).join(", "));
  for (const country of wanted) {
    const here = sources.filter((s) => !s.countries || s.countries.includes(country));
    if (!here.length) { console.log("  " + country + ": no source covers this country"); continue; }
    for (const s of here) {
      try {
        const jobs = await s.search({ what, country });
        const first = jobs[0] ? " - first: " + jobs[0].title + " (" + (jobs[0].employer || "employer not given") + ")" : "";
        console.log("  " + country + " " + s.label + ": " + jobs.length + " jobs" + first);
      } catch (e) {
        console.log("  " + country + " " + s.label + ": FAILED (" + (e && e.message ? e.message : "error") + ")");
      }
    }
  }
})();'
