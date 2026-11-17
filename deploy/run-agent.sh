#!/usr/bin/env bash
# Trigger an agent run on the server — the same thing as pressing "Run agent" on the website.
# It re-checks every held application with the current trace logic (clearing holds whose documents
# now trace clean), re-drafts any left without AI, and prepares new matches at or above the bar.
#
# Default mode 'hybrid' only PREPARES: nothing is sent to an employer. Pass 'auto' to also e-mail
# the applications whose advert names a recruiter's address, under your standing authorisation
# (the same send the 06:00 run does). No form is ever submitted by this script, in any mode.
#
#   cd /opt/opennjob && bash deploy/run-agent.sh          # prepare and re-check only
#   cd /opt/opennjob && bash deploy/run-agent.sh auto     # also send by e-mail where possible
#
# Afterwards:  bash deploy/why-held.sh
set -uo pipefail
cd "${OPENNJOB_DIR:-/opt/opennjob}" || exit 1
MODE="${1:-hybrid}"
case "$MODE" in hybrid|auto|review) ;; *) echo "Mode must be hybrid, auto or review." >&2; exit 1 ;; esac

# Wait for the API to answer: a recent restart (./oj up) may still be starting, which otherwise
# shows as "fetch failed".
ready=""
for _ in $(seq 1 30); do
  if ./oj exec -T api node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" 2>/dev/null; then ready=1; break; fi
  sleep 2
done
[ -n "$ready" ] || { echo "The API is not answering yet. Try again in a moment, or: ./oj logs --tail=50 api" >&2; exit 1; }

./oj exec -T -e OJ_MODE="$MODE" api node -e '
const { signAccessToken, passwordVersion } = require("/app/apps/api/dist/auth.js");
const { Client } = require("pg");
(async () => {
  const mode = process.env.OJ_MODE || "hybrid";
  const secret = process.env.OPENNJOB_JWT_SECRET;
  if (!secret) { console.error("OPENNJOB_JWT_SECRET is not set on the API."); process.exit(1); }
  const port = process.env.PORT || 8080;
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const { rows } = await c.query("select id, password_hash from users order by created_at");
  await c.end();
  if (!rows.length) { console.error("No accounts on this server."); process.exit(1); }
  for (const u of rows) {
    // A short-lived token for this account, signed exactly as the API signs a login.
    const { accessToken } = signAccessToken(u.id, secret, 300, new Date(), passwordVersion(u.password_hash));
    const res = await fetch("http://127.0.0.1:" + port + "/agent/run", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + accessToken },
      body: JSON.stringify({ mode }),
    });
    let body; try { body = await res.json(); } catch { body = await res.text(); }
    if (res.ok && body && typeof body === "object") {
      const e = body.emailed; // { sent, failed, wait? } in auto mode, else undefined
      const emailed = e && typeof e === "object" ? "sent " + (e.sent || 0) + ", failed " + (e.failed || 0) : undefined;
      console.log(
        "run ok (mode " + mode + "): prepared " + (body.prepared ? body.prepared.length : 0) +
        ", redrafted " + (body.redrafted || 0) +
        ", closed below bar " + (body.closedBelowBar || 0) +
        (emailed !== undefined ? ", e-mailed (" + emailed + ")" : ""),
      );
    } else {
      console.log("run failed: HTTP " + res.status + " " + (typeof body === "string" ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300)));
      process.exitCode = 1;
    }
  }
})().catch((e) => { console.error((e && e.message) || e); process.exit(1); });
'
echo "Now check what cleared:  bash deploy/why-held.sh"
