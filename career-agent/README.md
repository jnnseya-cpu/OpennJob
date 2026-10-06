# NSEYA Career Agent (personal trial)

A single-user Python tool, separate from OpennJob, built from the owner's own source package and
specification (October 2026). It finds construction and infrastructure vacancies on known employer
boards, scores them against an evidence ledger, builds sealed CV and cover-letter packs, fills
application forms in a browser, and sends a 09:00 London report.

**You submit every application yourself.** The worker and the extension fill ordinary fields and
upload the sealed documents. They never tick a declaration or consent box and never press submit.
You answer the declarations (work rights, sponsorship, clearance, convictions, "I confirm") and click
the employer's submit button; the agent then records the receipt and a screenshot. This replaces the
"standing authorisation / automatic submit" mode in the original package, by the owner's decision on
6 October 2026, to match the rules of the OpennJob repository it lives in.

Not a launched product. No employer application has been submitted with it, no report e-mail has been
delivered, no LLM call has been made, and no live job board was called while building this version.

## Your data stays local

Everything personal lives in `data/local/` (or `CAREER_DATA`), which is git-ignored: `profile.json`,
`jobs.json`, `answer_library.json`, `search_profiles.json`, the SQLite database, packs, receipts,
adapters, the browser profile and `worker.lock`. The committed `data/*.example.json` files are
fictional. `dashboard/data.json` (made by `export-dashboard`) is git-ignored too.

## Set up

```bash
cd career-agent
python3 -m venv .venv && . .venv/bin/activate
python3 -m pip install -r requirements.txt
python3 -m playwright install chromium      # or set CAREER_BROWSER_EXECUTABLE
mkdir -p data/local && cp data/profile.example.json data/local/profile.json   # then replace every value
cp data/jobs.example.json data/local/jobs.json; cp data/answer_library.example.json data/local/answer_library.json
cp data/search_profiles.example.json data/local/search_profiles.json
```

Settings come from environment variables (see `.env.example`; nothing loads a `.env` file).

## Daily use

```bash
python3 -m agent.cli seed                    # load data/local/jobs.json
python3 -m agent.cli status                  # every job, its score and application state
python3 -m agent.discovery --once --max-matches 10   # read known boards (data/boards.json); LLM matching, capped
python3 -m agent.cli match --job ID          # LLM requirement extraction (validated; marked unreviewed)
python3 -m agent.cli gate --job ID           # what still blocks this job
python3 -m agent.cli prepare --job ID        # sealed pack in data/local/packs/ID (80% or more only)
python3 -m agent.review confirm-profile --confirmed
python3 -m agent.review verify-job --job ID --confirmed      # you checked the live advert (valid 15 minutes)
python3 -m agent.review approve-pack --job ID --adapter data/local/adapters/ID.json --confirmed
python3 -m agent.worker --once               # dry run: fill and upload, never submit
python3 -m agent.worker --submit             # fill, upload, wait for YOUR submit, capture the receipt
python3 -m agent.review reconcile --job ID --receipt "Ref from the employer's email" --confirmed
python3 -m agent.review retry --job ID --confirmed           # failed or blocked back to ready (never uncertain)
python3 -m agent.cli report | send-report | schedule         # 09:00 Europe/London digest
python3 -m agent.launch --submit [--no-email]                # discovery + worker (assist) + scheduler
python3 -m agent.interview --job ID [--answer-file a.txt]    # LLM preparation from the submitted pack
python3 -m agent.server                      # loopback API for the extension (127.0.0.1:8765)
python3 -m agent.cli export-dashboard        # writes dashboard/data.json for the static dashboard
```

## Rules the code enforces

- Score = weighted requirement coverage (met 1, partial 0.5, unknown and unmet 0), rounded **down**.
  Minimum 80, and the code refuses a lower threshold. An unresolved essential blocks at any score.
- Evidence citations must exist in the ledger and be confirmed by you; LLM quotations must be exact
  substrings of the advert; weights must total 100. LLM output is marked unreviewed.
- Packs copy evidence lines exactly, leave out unknown dates, refuse placeholders, and are sealed
  with SHA-256; a changed pack or document is refused before filling.
- Declarations are never filled (`agent/answers.py`). A library entry such as `uk_right_to_work` is used
  for the matching gates only.
- CAPTCHA, login walls, redirects and a changed description stop the worker; it never works around them.
- `submitted` needs a receipt. A page that leaves before a receipt shows is `uncertain` and is never
  retried automatically; a worker restart turns `submitting` into `uncertain`. One worker at a time.
- 20 attempts a day at most (an attempt counts even if you then do not submit).

## Tests

```bash
cd career-agent && .venv/bin/python -m unittest discover -s tests     # or, from the repo root: npm run test:agent
```

50 tests, all on fictional data: the control rules, sources against recorded response shapes, LLM
validation with a fake transport, discovery, deterministic documents, the scheduler across BST and
GMT, the loopback server, the review commands, and real Chromium runs of the worker, the extension's
fill code and the dashboard against `fixtures/application.html`. No test touches the network.

## Not done or not verified

- No real employer adapter; no route has been tried on a real employer site. Treat every route as
  untested until a controlled first application succeeds.
- Discovery was not run against the live boards in this build. The source package reports a small
  live smoke test of three SmartRecruiters listings; that was not repeated here. Check each board's
  terms of use before automating against it.
- No LLM key, so `match`, `tailor` and `interview` were tested only against a fake transport.
- No SMTP delivery tested. SMTP acceptance is not proof of inbox delivery.
- The extension was not loaded into Chrome; its page functions were tested in Chromium.
- Single user, local only: no multi-tenant isolation, no encryption at rest, a shared-token loopback API.
