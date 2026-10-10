# NSEYA Career Agent (personal trial)

A single-user Python tool, separate from OpennJob, built to the owner's "Developer Build and Test
Requirements" (6 October 2026). It finds construction, grid/energy, infrastructure and
mission-critical vacancies on known employer boards, scores them against an evidence ledger, builds
sealed CV and cover-letter packs, applies through a browser on certified routes, sends a 09:00
London report and prepares interviews from the documents actually sent.

**Who presses submit.** Without standing authorisation the worker and the extension fill ordinary
fields and upload the sealed documents, and you press submit. With standing authorisation
(`python3 -m agent.authorize grant --confirmed`, given once, dated, to a named scope, revocable at any
time) the agent presses submit itself, but only when **all** of these hold: the route is certified
for automatic submission (which needs one supervised, receipt-proven submission on it); the form has
**no declaration and no other sensitive question**; every required question has an answer you
confirmed; raw coverage is at least 80% with every essential met; the vacancy and form were verified
just now; today's cap is not reached; and a re-read of your authorisation, exclusions and inputs
just before the click still allows it. Anything else is filled as far as allowed and waits for you.
The agent never ticks a declaration or consent box, never answers equality or health questions, and
never works around a CAPTCHA or a login.

Not a launched product. No employer application has been submitted with it, no report has reached
an inbox, no paid LLM call has been made, and no live board was called while building this version.
`docs/ACCEPTANCE.md` lists every acceptance case (T01-T60) with its actual result.

## Your data stays local

Everything personal lives in `data/local/` (or `CAREER_DATA`), which is git-ignored: `profile.json`,
`jobs.json`, `answer_library.json`, `search_profiles.json`, your `policy.json` (standing
authorisation, exclusions), the SQLite ledger, packs, sealed attempts, receipts, adapters, documents,
the browser profile and `worker.lock`. Committed `data/*.example.json` files are fictional.

## Set up

```bash
cd career-agent
python3 -m venv .venv && . .venv/bin/activate
python3 -m pip install -r requirements.lock        # the tested lock (requirements.txt holds the ranges)
python3 -m playwright install chromium             # or set CAREER_BROWSER_EXECUTABLE
mkdir -p data/local && cp data/profile.example.json data/local/profile.json   # then replace every value
cp data/jobs.example.json data/local/jobs.json; cp data/answer_library.example.json data/local/answer_library.json
cp data/search_profiles.example.json data/local/search_profiles.json          # set "confirmed": true on profiles you mean
scripts/verify.sh                                   # the regression check (T01)
```

Settings come from environment variables (see `.env.example`; nothing loads a `.env` file).

## Daily use

```bash
python3 -m agent.worker --preflight                 # exits 1 with the fix for each missing piece
python3 -m agent.discovery --once --max-matches 10  # boards in data/boards.json; LLM matching under the budget
python3 -m agent.cli status | gate --job ID | prepare --job ID
python3 -m agent.review confirm-profile --confirmed
python3 -m agent.review review-matching --job ID --confirmed   # first-trial extraction review (not a submit permission)
python3 -m agent.rights add --country "United Kingdom" --right-to-work yes --sponsorship no --document PATH --confirmed
python3 -m agent.authorize status | grant --confirmed | revoke | pause | resume | exclude --employer NAME
python3 -m agent.routes schema --adapter PATH        # the live form schema and its hash
python3 -m agent.routes certify --adapter PATH --confirmed [--auto --job ID]   # --auto needs a supervised receipt on this route
python3 -m agent.routes status | release --route ID --confirmed
python3 -m agent.worker --once                       # dry run: verify, fill and upload, never submit
python3 -m agent.worker --submit                     # automatic where allowed, otherwise waits for you
python3 -m agent.review reconcile --job ID --receipt "Ref from the employer" --confirmed
python3 -m agent.outcomes add --job ID --kind interview_invitation --date YYYY-MM-DD --evidence-file reply.txt
python3 -m agent.outcomes metrics
python3 -m agent.cli report | send-report | schedule | report-reconcile --day YYYY-MM-DD --sent|--not-sent
python3 -m agent.cli export-application --job ID     # the full sealed record of every attempt (T31)
python3 -m agent.cli coverage | import-job --url URL --company C --title T --file advert.txt
python3 -m agent.cli backup --file PATH | restore --file PATH --confirmed
python3 -m agent.interview --job ID [--answer-file a.txt] [--ai]
python3 -m agent.server                              # local API + dashboard at http://127.0.0.1:8765
python3 -m agent.launch --submit [--no-email]        # discovery + worker + scheduler, supervised
```

## Rules the code enforces

- **Exact 80% floor.** Coverage is computed in Decimal (met 1, partial 0.5, unknown and unmet 0);
  eligibility is raw coverage >= 80 with nothing rounded first, so 79.999 is not eligible. Display
  floors. An unresolved essential blocks at any score. Model scorecards need finite weights totalling
  100, a state and an essential flag for every requirement, and exact advert quotations.
- **Evidence only.** Citations must exist in your ledger and be confirmed by you. Job text is
  untrusted data: an instruction inside an advert cannot add evidence or credentials (T14). Packs copy
  evidence lines exactly, leave out unknown dates and refuse placeholders.
- **One posting, one application.** Identity is employer plus posting id, or the canonical URL with
  tracking parameters removed; every original URL is kept as provenance.
- **Transactional claims.** ready to submitting, the attempt, its event and the daily cap are one
  compare-and-swap transaction shared by the worker and the extension; a loser never clicks (T27).
- **Sealed attempts.** Before a click the agent writes, once and read-only, the snapshot (JD and its
  hash, scorecard, versions of profile, policy and answers, every filled answer, CV and cover hashes,
  route and certification), validated against `contracts/attempt-snapshot.schema.json`, with copies of
  the documents.
- **Live checks.** The JD is verified at its own URL when the route has one; closed, gone or
  past-deadline vacancies are withdrawn; redirects outside the route stop; a form that differs from its
  certified schema stops and counts towards quarantine (three failures).
- **Receipts.** submitted needs a new, visible receipt matching the route's job-specific pattern and
  correlated with this posting. A claim the agent never clicked is failed after a crash; anything after
  the click without a receipt is uncertain and never retried automatically. A screenshot failure does
  not lose a proven receipt.
- **Answers.** Unknown required answers stay unknown and hold the application; salary history and
  target day rate are never a floor or an expected-salary answer. Style notes and facts are versioned
  separately: a factual change makes prepared packs stale, a style change does not.
- **Right to work and sponsorship** come only from per-country records backed by a document you
  attached (`agent/rights.py`). An advert offering sponsorship does not prove you are eligible for it.
- **Budget.** No LLM call without `LLM_BUDGET_GBP_DAILY`; each call reserves its worst case first;
  timeouts are charged; nothing is retried automatically.
- **Report.** One digest per London day at 09:00, event-based with watermarks, a labelled catch-up when
  the host was off, an outbox that never re-sends an ambiguous message.

## Tests

```bash
scripts/verify.sh                         # compileall, node --check, the whole suite
python3 scripts/release_gate.py --check   # the same run, mapped to T01-T60 in docs/ACCEPTANCE.md
```

125 tests on fictional data, including real Chromium runs over local HTTPS against fixture forms
that record every POST: automatic submission, multi-step and iframe routes, redirects, changed forms
and quarantine, unknown answers, sensitive questions and pre-selected answers, receipts and crashes,
the live dashboard with refused or missing speech, and the 09:00 schedule across both 2026/27 clock
changes. No test touches the network beyond 127.0.0.1.

## Not done or not verified

- No route has been certified on a real employer site, so automatic submission has never run on one.
  The first real route needs a supervised submission with a genuine receipt (T52).
- Discovery was not run against the live boards in this build; check each board's terms first
  (`data/source_registry.json` lists 30 targets, none with terms recorded as checked).
- No LLM key: matching, tailoring and coaching were tested only with fake transports.
- No SMTP delivery tested; SMTP acceptance is not proof of inbox delivery.
- T15 (a human-labelled 50-JD evaluation) needs labelled data that was not supplied.
- Single user, local only: no multi-tenant isolation (commercial B20-B22 are off by decision).
