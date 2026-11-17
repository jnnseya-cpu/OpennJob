#!/usr/bin/env bash
# Set your pay floors (salary expectation and contract day rate) on the server. A job that
# advertises pay BELOW a floor is hidden; one at or above shows; one with no stated pay shows.
# Every other screening answer (notice period, declarations, etc.) is kept unchanged.
#
#   cd /opt/opennjob && bash deploy/set-pay.sh 75000 450
#   cd /opt/opennjob && bash deploy/set-pay.sh            # defaults to 75000 and 450
set -uo pipefail
cd "${OPENNJOB_DIR:-/opt/opennjob}" || exit 1
SALARY="${1:-75000}"
DAYRATE="${2:-450}"
case "$SALARY" in ''|*[!0-9]*) echo "Salary must be a whole number of pounds, e.g. 75000." >&2; exit 1 ;; esac
case "$DAYRATE" in ''|*[!0-9]*) echo "Day rate must be a whole number of pounds, e.g. 450." >&2; exit 1 ;; esac

ready=""
for _ in $(seq 1 30); do
  if ./oj exec -T api node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" 2>/dev/null; then ready=1; break; fi
  sleep 2
done
[ -n "$ready" ] || { echo "The API is not answering yet. Try again in a moment." >&2; exit 1; }

./oj exec -T -e OJ_SALARY="$SALARY" -e OJ_DAYRATE="$DAYRATE" api node -e '
const { signAccessToken, passwordVersion } = require("/app/apps/api/dist/auth.js");
const { Client } = require("pg");
(async () => {
  const secret = process.env.OPENNJOB_JWT_SECRET;
  if (!secret) { console.error("OPENNJOB_JWT_SECRET is not set on the API."); process.exit(1); }
  const port = process.env.PORT || 8080;
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const { rows } = await c.query("select id, password_hash from users order by created_at");
  await c.end();
  if (!rows.length) { console.error("No accounts on this server."); process.exit(1); }
  for (const u of rows) {
    const token = signAccessToken(u.id, secret, 300, new Date(), passwordVersion(u.password_hash)).accessToken;
    const headers = { "content-type": "application/json", authorization: "Bearer " + token };
    const base = "http://127.0.0.1:" + port + "/screening";
    const current = await (await fetch(base, { headers })).json();
    // Keep every existing answer; change only the two pay floors.
    const merged = { ...current, salaryExpectation: process.env.OJ_SALARY, dayRate: process.env.OJ_DAYRATE };
    const res = await fetch(base, { method: "PUT", headers, body: JSON.stringify(merged) });
    if (res.ok) {
      const saved = await res.json();
      console.log("Saved for " + u.id + ": salary floor £" + saved.salaryExpectation + ", day rate floor £" + saved.dayRate);
    } else {
      console.log("Failed for " + u.id + ": HTTP " + res.status + " " + (await res.text()).slice(0, 300));
      process.exitCode = 1;
    }
  }
})().catch((e) => { console.error((e && e.message) || e); process.exit(1); });
'
echo "Done. New jobs are filtered by the new floors from the next search; press Matches > Look for jobs now to refresh."
