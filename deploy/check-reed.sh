#!/usr/bin/env bash
# Check what live Reed really sends, against what OpennJob expects (written from memory of Reed's
# API docs). Makes 1 search and up to 20 advert calls with the server's REED_API_KEY. As root:
#
#   cd /opt/opennjob && bash deploy/check-reed.sh                       # "project manager" in Birmingham
#   bash deploy/check-reed.sh "planner" "Coventry"
#
# Prints field names, counts and site names only: no key, no advert text, no e-mail address.
set -euo pipefail
cd "${OPENNJOB_DIR:-/opt/opennjob}"
[ -x ./oj ] || { echo "Run deploy/install-hostinger.sh first (no ./oj here)." >&2; exit 1; }
./oj exec -T -e CHECK_TITLE="${1:-project manager}" -e CHECK_PLACE="${2:-Birmingham}" api node -e '
const key = (process.env.REED_API_KEY || "").trim();
if (!key) { console.log("NO  REED_API_KEY is not set: bash deploy/set-keys.sh reed"); process.exit(0); }
const auth = { Authorization: "Basic " + Buffer.from(key + ":").toString("base64") };
const get = async (url) => {
  const r = await fetch(url, { headers: auth, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
};
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const host = (u) => { try { return new URL(u).hostname; } catch { return "not an address"; } };
(async () => {
  const q = new URLSearchParams({ keywords: process.env.CHECK_TITLE, locationName: process.env.CHECK_PLACE, resultsToTake: "20" });
  let search;
  try { search = await get("https://www.reed.co.uk/api/1.0/search?" + q); } catch (e) { console.log("NO  search failed: " + e.message); return; }
  const results = Array.isArray(search.results) ? search.results : [];
  console.log("== Search: " + results.length + " results");
  console.log("   fields in a result: " + (results[0] ? Object.keys(results[0]).sort().join(", ") : "(none)"));
  const expected = ["jobId", "employerName", "jobTitle", "locationName", "jobDescription", "jobUrl"];
  const missing = expected.filter((k) => results[0] && !(k in results[0]));
  console.log(missing.length ? "   NO  missing fields OpennJob reads: " + missing.join(", ") : "   OK  every field OpennJob reads is there");
  let fields = new Set(), external = 0, mail = 0, mailInSnippet = 0, longer = 0, failed = 0;
  const hosts = {};
  for (const j of results) {
    if (EMAIL.test(String(j.jobDescription || ""))) mailInSnippet += 1;
    let d;
    try { d = await get("https://www.reed.co.uk/api/1.0/jobs/" + encodeURIComponent(j.jobId)); } catch { failed += 1; continue; }
    Object.keys(d).forEach((k) => fields.add(k));
    const text = String(d.jobDescription || "");
    if (text.length > String(j.jobDescription || "").length) longer += 1;
    if (EMAIL.test(text) || EMAIL.test(String(d.contactEmail || d.email || ""))) mail += 1;
    const ext = String(d.externalUrl || "");
    if (ext) { external += 1; const h = host(ext); hosts[h] = (hosts[h] || 0) + 1; }
  }
  const n = results.length - failed;
  console.log("== Whole adverts: " + n + " read" + (failed ? ", " + failed + " failed" : ""));
  console.log("   fields in an advert: " + [...fields].sort().join(", "));
  console.log("   " + longer + " of " + n + " are longer than the search snippet");
  console.log("   " + mailInSnippet + " snippets and " + mail + " whole adverts name an e-mail address (route 1: sent by e-mail)");
  console.log("   " + external + " give the employer’s own page (externalUrl):");
  for (const [h, c] of Object.entries(hosts).sort((a, b) => b[1] - a[1])) console.log("      " + c + "  " + h);
  console.log("   Only myworkdayjobs.com / successfactors sites can go out on a form (route 2).");
})();'
