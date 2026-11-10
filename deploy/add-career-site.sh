#!/usr/bin/env bash
# Add an employer's careers site to the daily search, as root on the server:
#
#   cd /opt/opennjob
#   bash deploy/add-career-site.sh "https://examplegrid.wd3.myworkdayjobs.com/en-GB/Careers" "Example Grid" GB
#   bash deploy/add-career-site.sh "https://jobs.example.org" "Example Build" GB      # a SuccessFactors career site
#   bash deploy/add-career-site.sh list                                              # what is listed
#   bash deploy/add-career-site.sh remove jobs.nationalgrid.com                      # take a site off the list
#
# The address is the careers site's search page as the browser shows it. Workday sites end in
# myworkdayjobs.com; any other address is taken as an SAP SuccessFactors career site.
# A site is searched only after someone read its terms of use (CLAUDE.md rule 5): the script asks.
# Each job found comes with the employer's own application page, which the extension's queue
# applies on when that system is switched on (deploy/enable-system.sh).
set -euo pipefail
cd "${OPENNJOB_DIR:-/opt/opennjob}"
F=.env.production
[ -f "$F" ] && [ -x ./oj ] || { echo "Run deploy/install-hostinger.sh first (no $F or ./oj here)." >&2; exit 1; }
current() { grep -E '^OPENNJOB_CAREER_SITES=' "$F" | head -1 | cut -d= -f2- | sed "s/^['\"]//; s/['\"]$//" || true; }

if [ "${1:-list}" = list ]; then
  sites="$(current)"
  [ -n "$sites" ] || { echo "No careers site is listed yet."; exit 0; }
  printf '%s\n' "$sites" | tr ',' '\n' | sed 's/^ */  /'
  [ -f career-sites.log ] && { echo "Terms checks recorded:"; sed 's/^/  /' career-sites.log; }
  exit 0
fi

if [ "${1:-}" = remove ]; then
  HOST_OUT="$(printf '%s' "${2:-}" | sed -E 's#^https://##; s#/.*##' | tr '[:upper:]' '[:lower:]')"
  [ -n "$HOST_OUT" ] || { echo "Give the site's address or host name to remove." >&2; exit 1; }
  KEPT="$(current | tr ',' '\n' | grep -v "://$HOST_OUT[/|]" | paste -sd, - || true)"
  grep -vE '^OPENNJOB_CAREER_SITES=' "$F" > "$F.tmp" || true
  [ -n "$KEPT" ] && printf "OPENNJOB_CAREER_SITES='%s'\n" "$KEPT" >> "$F.tmp"
  mv "$F.tmp" "$F"; chmod 600 "$F"
  ./oj up -d api >/dev/null
  echo "Removed $HOST_OUT. Still listed:"; printf '%s\n' "${KEPT:-(none)}" | tr ',' '\n' | sed 's/^/  /'
  exit 0
fi

URL="${1:-}"; EMPLOYER="${2:-}"; COUNTRY="$(printf '%s' "${3:-}" | tr '[:lower:]' '[:upper:]')"
[[ "$URL" =~ ^https://[^/|,\ ]+ ]] || { echo "Give the site's https:// address first." >&2; exit 1; }
[ -n "$EMPLOYER" ] && [[ "$EMPLOYER" != *[\|,]* ]] || { echo "Give the employer's name second (no | or comma)." >&2; exit 1; }
[[ "$COUNTRY" =~ ^[A-Z]{2}$ ]] || { echo "Give the country third, as two letters (GB, AE, FR...)." >&2; exit 1; }
HOST="$(printf '%s' "$URL" | sed -E 's#^https://([^/]+).*#\1#' | tr '[:upper:]' '[:lower:]')"
case "$HOST" in *.myworkdayjobs.com|*.myworkdaysite.com) KIND=workday ;; *) KIND=successfactors ;; esac
echo "$EMPLOYER: a $KIND careers site at $HOST, jobs in $COUNTRY."

echo "OpennJob will search this site by job title each morning, reading up to 20 adverts per title."
read -r -p "Have you read this site's terms of use, and do they allow automated job searching? [y/N]: " a </dev/tty
[ "$a" = y ] || [ "$a" = Y ] || { echo "Nothing changed. Read the terms first (usually linked at the foot of the careers site)."; exit 1; }
read -r -p "Your name (recorded with today's date as the terms check): " who </dev/tty
[ -n "$who" ] || { echo "A name is needed. Nothing changed."; exit 1; }

ENTRY="$URL|$EMPLOYER|$COUNTRY"
SITES="$(current)"
if printf '%s' "$SITES" | tr ',' '\n' | grep -qF "$URL|"; then echo "Already listed."; exit 0; fi
NEW="${SITES:+$SITES,}$ENTRY"
grep -vE '^OPENNJOB_CAREER_SITES=' "$F" > "$F.tmp" || true
printf "OPENNJOB_CAREER_SITES='%s'\n" "$NEW" >> "$F.tmp"
mv "$F.tmp" "$F"; chmod 600 "$F"
printf '%s  %s  %s  terms read by %s\n' "$(date -u +%Y-%m-%d)" "$HOST" "$EMPLOYER" "$who" >> career-sites.log

# A SuccessFactors site on the employer's own domain: the queue must know that domain runs SuccessFactors.
if [ "$KIND" = successfactors ] && ! [[ "$HOST" =~ (successfactors|sapsf|jobs2web)\. ]]; then
  KEY="$(grep -E '^OPENNJOB_OPERATOR_KEY=' "$F" | head -1 | cut -d= -f2- | tr -d "\"'" || true)"
  if [ -n "$KEY" ]; then
    ./oj exec -T -e OP_KEY="$KEY" -e OP_HOST="$HOST" api node -e '
const h = { Authorization: "Bearer " + process.env.OP_KEY, "Content-Type": "application/json" };
(async () => {
  const s = await (await fetch("http://127.0.0.1:8080/operator/status", { headers: h })).json();
  const sf = (s.systems || []).find((x) => x.id === "successfactors") || {};
  const extraHosts = [...new Set([...(sf.extraHosts || []), process.env.OP_HOST])];
  const body = { enabled: !!sf.enabled, extraHosts };
  for (const k of ["termsCheckedAt", "supervisedSubmissionAt", "note"]) if (sf[k]) body[k] = sf[k];
  const r = await fetch("http://127.0.0.1:8080/operator/systems/successfactors", { method: "PUT", headers: h, body: JSON.stringify(body) });
  console.log(r.ok ? "  The queue now treats " + process.env.OP_HOST + " as SuccessFactors." : "  Could not add the domain to SuccessFactors (" + r.status + "): bash deploy/enable-system.sh successfactors");
})();' || true
  else
    echo "  Add $HOST as one of SuccessFactors' domains: bash deploy/enable-system.sh successfactors"
  fi
fi

echo "== Restarting the API with the new list"
./oj up -d api >/dev/null
for _ in $(seq 1 30); do ./oj exec -T api node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" 2>/dev/null && break; sleep 2; done

echo "== One test search on the site (project manager)"
./oj exec -T -e CHECK_COUNTRY="$COUNTRY" -e CHECK_HOST="$HOST" api node -e '
const { buildSearchSources } = require("/app/apps/api/dist/deps.js");
const s = buildSearchSources(process.env, fetch).filter((x) => x.name === "workday" || x.name === "successfactors");
(async () => {
  for (const src of s) {
    try {
      const jobs = (await src.search({ what: "project manager", country: process.env.CHECK_COUNTRY })).filter((j) => (j.applyUrl || "").includes(process.env.CHECK_HOST));
      console.log("  " + jobs.length + " jobs" + (jobs[0] ? ", first: " + jobs[0].title + " (" + (jobs[0].city || jobs[0].location) + ")" : ""));
    } catch (e) { console.log("  FAILED: " + (e && e.message ? e.message : "error") + " (the site may work differently from what OpennJob expects; tell the developer)"); }
  }
})();'
echo "Listed. It is searched from the next 06:00 run, or Matches > Look for jobs now."
echo "Record the terms check in docs/sources.md (career-sites row): date, site, your name."
