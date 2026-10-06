# OpennJob

Working name. An AI job-application assistant. v1 was UK healthcare only. This version
adds **industry packs** (construction and infrastructure; data centres and
mission-critical; energy and grid; rail and transport; francophone Africa and diaspora;
healthcare), **candidate preferences** (languages, countries, cities), French-language
applications, the **80% rule** (`POST /agent/run`) and optional employer posting.

An earlier round made it **deployable**: real user accounts, PostgreSQL, encryption at
rest for the most sensitive data, hardened HTTP, a Dockerfile, docker-compose, a CI
workflow and hand-over documents. The latest round adds a **candidate web app**
(`apps/web`, Next.js 14): register, profile and passport, matches, the agent run,
application review and approval, tracker, interview practice, export and deletion.

This is a tested version of the codebase for a developer to take forward. It is
not a finished product and it has never been used on a real employer's website.
Deployable is not the same as ready for real users: **`GO-LIVE.md` lists what is done
and, more importantly, what is not.** The sections "What is real, what is stubbed" and
"What was NOT verified" below are the honest state of it. Please read those before
promising anything to anyone.

| Document | For |
| --- | --- |
| `README.md` | What it is, how to run it, how it works |
| `GO-LIVE.md` | The checklist: done and tested / not done |
| `CLAUDE.md` | Working on the code with Claude Code: commands, map, rules |
| `deploy/hostinger-vps.md` | **Recommended for the pilot.** One server, `docker-compose.prod.yml`: PostgreSQL, API, web app behind Caddy (HTTPS), nightly backups (written, not executed) |
| `deploy/vercel.md` | Web app on Vercel, API elsewhere (written, not executed) |
| `deploy/gcp-cloud-run.md` | Cloud Run + Cloud SQL + Secret Manager steps (from memory, not executed) |
| `career-agent/README.md` | A separate single-user Python tool (NSEYA Career Agent personal trial); not part of OpennJob |

## What it does

First the user **registers an account** (email, password, acceptance of the terms and
privacy notice) and signs in. Everything below belongs to that account alone.

1. The user stores a **CV** (plain text), their **preferences** (languages, countries,
   cities; all optional) and a **credential passport**: a map of credential id to value
   (NMC PIN, professional membership, security clearance, CSCS, ...), DBS details, a
   right-to-work confirmation, mandatory training with expiry dates, referees.
2. The system **discovers jobs** from its job sources and normalises them into one shape,
   with an industry pack, country, city, region and application language on each.
3. Each job is **scored** against the CV, with the CV sentence that evidences each match.
4. **The 80% rule**: `POST /agent/run` takes every job that is inside the user's
   preferences, that they are eligible for, and that scores at or above the threshold
   (80 by default), and prepares an application draft for it. Jobs below it are left alone.
5. A **supporting statement** is drafted for the job's person specification, by an LLM
   when one is configured, otherwise by a plain no-AI drafter. For a French-language job
   it is drafted in formal French.
6. A **Chrome extension** fills the application form inside the user's own browser.
   Sensitive fields wait for the user. The user stays in control of submitting.
7. **Interview practice**: a question bank per industry pack and STAR-structure feedback,
   given in the language the candidate answered in.

Employers posting jobs is an optional extra (`POST /employer/jobs`). Nothing depends on
it: the product works with no employer job at all, and a test checks that.

## Quick start

You need Node.js 20 or newer (built and tested here on Node 22.22) and npm.

```bash
npm install
npm run build          # builds packages/core, apps/api and apps/extension
npm test               # unit and API integration tests (vitest)
npm run test:e2e       # builds, then runs the browser tests (Playwright + Chromium)
```

Run the API (in-memory store, nothing to install):

```bash
cp .env.example .env   # nothing needs setting for a local try-out
npm start              # http://127.0.0.1:3000 ; JSON log lines on stdout
```

With `OPENNJOB_DEMO_JOBS=true` (the default in `.env.example`) there are 28 fictional
sample jobs (the three v1 healthcare jobs, plus a few per industry pack across 16
countries), so the whole flow can be tried with no API keys. Every employer in them is
invented.

```bash
API=http://127.0.0.1:3000
JSON="Content-Type: application/json"

# Register (fictional person). The versions to accept come from GET /auth/versions.
curl $API/auth/versions
curl -X POST $API/auth/register -H "$JSON" -d '{
  "email":"amara.okafor@example.org","password":"a long fictional passphrase",
  "acceptedTermsVersion":"draft-1","acceptedPrivacyVersion":"draft-1"}'

# Sign in. The reply has "accessToken"; it lasts an hour by default.
TOKEN=$(curl -s -X POST $API/auth/login -H "$JSON" \
  -d '{"email":"amara.okafor@example.org","password":"a long fictional passphrase"}' \
  | node -pe "JSON.parse(require('fs').readFileSync(0)).accessToken")
AUTH="Authorization: Bearer $TOKEN"

curl -X PUT $API/profile -H "$AUTH" -H "$JSON" -d '{
  "firstName":"Amara","lastName":"Okafor","email":"amara.okafor@example.org",
  "phone":"07700 900123","addressLine1":"12 Example Street","city":"Birmingham","postcode":"B1 1AA",
  "cvText":"Healthcare assistant with four years of experience in a care home.\nI hold the Care Certificate and give personal care with dignity.\nTrained in moving and handling. I work well in a team."}'

curl -X PUT $API/passport -H "$AUTH" -H "$JSON" -d '{
  "rightToWorkConfirmed":true,
  "training":[{"name":"Basic life support","expiresOn":"2026-12-01"}],
  "referees":[]}'

curl -X POST $API/jobs/refresh -H "$AUTH"
curl "$API/jobs/matches?min=40" -H "$AUTH"
curl -X POST $API/applications -H "$AUTH" -H "$JSON" -d '{"jobId":"sample:hca-elderly-care","mode":"hybrid"}'
curl -X POST $API/interview/feedback -H "$AUTH" -H "$JSON" -d '{"questionId":"val-compassion","answer":"..."}'

curl $API/account/export -H "$AUTH"                                   # everything held about the account
curl -X DELETE $API/account -H "$AUTH" -H "$JSON" -d '{"password":"a long fictional passphrase"}'   # removes all of it
```

Packs, preferences and the 80% rule (add `preferences` to the same profile body; every
list may be left out or empty, which means "no restriction"):

```bash
# ... "cvText":"...", "preferences":{"languages":["English","French"],"countries":["GB","CD"],"cities":["Birmingham"]}}

curl -X PUT $API/passport -H "$AUTH" -H "$JSON" -d '{
  "rightToWorkConfirmed":true,
  "credentials":{"prof":"MCIOB 0000000","cscs":"00000000","sc":"SC, expires 2028-01"}}'

curl "$API/jobs/matches?pack=dc&region=eu" -H "$AUTH"     # also: country=DE, min=80
curl -X POST $API/agent/run -H "$AUTH" -H "$JSON" -d '{"mode":"hybrid"}'
curl "$API/interview/questions?pack=fr" -H "$AUTH"

# Optional. Needs OPENNJOB_EMPLOYER_KEY to be set on the server; it is not a user's access token.
curl -X POST $API/employer/jobs -H "Authorization: Bearer $EMPLOYER_KEY" -H "$JSON" -d '{
  "title":"Site Manager","employer":"Example Build Ltd","country":"GB","city":"Leeds",
  "applyUrl":"https://example.org/apply/1",
  "description":"Essential\n- CDM 2015 duties.\n- SMSTS certificate."}'
```

Without `DATABASE_URL` all data is held in memory and **is lost when the API stops**.

### The candidate web app

`npm run build` also builds `apps/web` as a static site in `apps/web/out` (plain HTML,
CSS and JavaScript; no Node server runs it). To try it locally:

```bash
# in .env, so the API accepts calls from the site's origin:
#   OPENNJOB_CORS_ORIGINS=http://127.0.0.1:3001
npm start                                   # the API on :3000
npm run dev -w @opennjob/web                # the web app on http://127.0.0.1:3001 (development server)
```

The site finds the API through `/opennjob-config.json`, served next to it
(`apps/web/public/opennjob-config.json`, default `{"apiBase": "http://127.0.0.1:3000"}`).
To deploy, copy `apps/web/out` to any static host, edit that file to the API's address,
and add the site's origin to `OPENNJOB_CORS_ORIGINS`. Nothing has been deployed.

What it does, screen by screen (layout and wording follow
`docs/prototype/opennjob-demo.html`; the data and the matching come from the API):

| Screen | API routes |
| --- | --- |
| Create an account (both consent boxes start unticked), sign in | `GET /auth/versions`, `POST /auth/register`, `POST /auth/login` |
| Profile: details, CV text, languages / countries / cities, credential passport for the chosen pack, DBS, right to work (starts unticked), training with expiry status, referees | `GET/PUT /profile`, `GET/PUT /passport` |
| Matches: pack and region filters, score, evidence, gaps, missing credentials | `GET /jobs/matches`, `POST /jobs/refresh` (the "Look for jobs now" button on an empty catalogue) |
| Run agent: drafts every eligible match at or above the threshold | `POST /agent/run` |
| Review: requirements with CV evidence, editable statement, the pack's declarations to confirm one by one, approve, then "I have submitted it" | `POST /applications`, `PUT /applications/:id/statement`, `POST /applications/:id/confirm`, `POST /applications/:id/submitted` |
| Tracker | `GET /applications` |
| Interview practice | `GET /interview/questions?pack=`, `POST /interview/feedback` |
| Account: download my data, delete account (needs the password), sign out | `GET /account`, `GET /account/export`, `DELETE /account` |

How the web app keeps the product rules:

- **Nothing is sent to an employer from the website.** Approving records the user's
  confirmations; the form is filled by the extension in the user's browser and submitted
  by the user, who then records it with "I have submitted it". In every mode the agent
  run only prepares drafts, and the page says so.
- **Every declaration is confirmed by hand, one at a time, and none starts ticked.** The
  list is the job's pack declarations from `packages/core/src/packs.ts` (one that depends
  on a credential appears only when the job needs that credential), plus "any other
  declaration or 'I confirm' statement on the form". Ticking one means "I will answer
  this myself"; no answer is asked for or stored. There is no "tick all". In review-all
  mode the user also ticks "I have checked every field". The ids recorded are
  `declaration:<id>`, `statement` and `review:all-fields-checked`.
- **Auto mode never submits a form with a sensitive field**: the website submits nothing
  at all, and an auto-mode application shows that its form will wait for the user.
- **No logging.** The web app has no `console` calls; the end-to-end test checks that no
  CV, passport, statement or contact value reaches the browser console or the API log.
- The access token is kept in `sessionStorage` (gone when the tab closes); the password
  is never stored. `localStorage` holds only the chosen mode and pack.
- Not built, and the screens say so: email verification, password reset, password or
  email change, CV upload as PDF or Word, billing, server-side sign-out.

**Landing page, dashboard, charts.** `/` is a public landing page (signed-in visitors go to
`/dashboard/`). The dashboard and the Matches, Tracker, Interview and Profile screens carry charts
(`apps/web/src/components/Charts.tsx`: stat tiles, bar lists, a score histogram with the threshold
line, a pipeline bar), each with hover and keyboard tooltips and a table view; colours validated for
contrast in light and dark. Screenshots: `docs/screenshots/` (fictional account).

**Notifications.** One event engine (`apps/api/src/notifications.ts`) listens to every domain event
and fans each catalogue entry (`packages/core/src/notifications.ts`: 36 events in 10 categories,
14 live, 22 planned for features not built yet, 9 service notices that ignore opt-outs) out to
in-app, e-mail, SMS, push and WhatsApp according to the user's settings. In-app is real; e-mail
goes through Resend when `RESEND_API_KEY` and `OPENNJOB_EMAIL_FROM` are set and is otherwise
recorded in sandbox mode; SMS, push and WhatsApp are not connected and are recorded only. Every
attempt is a delivery row with no message text and no address. Routes: `GET /notifications`,
`POST /notifications/read`, `GET|PUT /notifications/preferences`, `GET /notifications/deliveries`,
`GET /notifications/catalogue`, `GET /notifications/preview?event=`, `POST /notifications/test`.
The web app's Notifications page has the inbox, the settings, and a catalogue view with channel
coverage, delivery outcomes, a branded e-mail preview and "Send test to me". The Resend adapter
was written from its documentation and has never sent a real e-mail.

**Private pilot.** Set `OPENNJOB_REGISTRATION_ALLOWLIST` to the invited email addresses and only
those can register (403 for anyone else); `GET /auth/versions` reports `registration: "invite"` and the
register page says so. Leave it empty to open registration. Existing accounts always sign in.

One API route was added for it: `PUT /applications/:id/statement` saves the user's edit
of a drafted statement (the extension fills the saved text). It is refused once the
application is submitted, is covered by `isolation.test.ts`, and its event carries the
application id and a character count only.

Run it on PostgreSQL:

```bash
# in .env:  DATABASE_URL=postgres://USER:PASSWORD@HOST:5432/DBNAME
#           OPENNJOB_DATA_KEY=<32 random bytes, base64>   (see "Encryption at rest")
npm run build
npm run migrate        # applies db/migrations; safe to run again
npm start
```

Or everything in containers (API + PostgreSQL + a one-shot migration step):

```bash
cp .env.example .env   # set POSTGRES_PASSWORD, OPENNJOB_JWT_SECRET and OPENNJOB_DATA_KEY
docker compose up --build
curl http://127.0.0.1:3000/health
```

**The Docker image was not built and `docker compose` was not run where this was
written** (no Docker daemon). See "What was NOT verified".

### Test results at hand-over

Run on 6 October 2026, Node 22.22.0, npm 10.9.4, Linux, from the repository root, after
`npm install` and `npm run build`. PostgreSQL was 16.15, a throwaway instance started
by `scripts/test-with-postgres.sh` (`initdb` and `pg_ctl` in a temporary directory, run
as a non-root user, deleted afterwards).

| Command | Result |
| --- | --- |
| `npm test` (no `DATABASE_URL`) | 24 test files, 540 passed, 0 failed, **91 skipped** (the PostgreSQL-backed tests) |
| `npm run test:pg` (the same, with a live PostgreSQL) | 24 test files, **631 passed**, 0 failed, 0 skipped |
| `npm run test:e2e` (no `DATABASE_URL`) | 70 passed, 0 failed, **1 skipped** (the API process on PostgreSQL); the 10 web-app tests ran on the in-memory store |
| `npm run test:pg -- npx playwright test` (with a live PostgreSQL, after `npm run build`) | **71 passed**, 0 failed, 0 skipped; the 10 web-app tests ran on PostgreSQL with encryption on |

A run that says "skipped" has not tested PostgreSQL. The numbers that count are the two
with a live database, and CI is set up to produce those (it has a postgres service
container). The CI workflow itself has never run.

What the numbers are made of:

- **vitest, 630.** The 438 tests that existed before this round are all still there and
  pass (their 16 files; the edits to them are listed below). 192 are new, in 8 files
  under `apps/api/test/`: `repository.contract.test.ts` (81: one suite of 27, against the
  in-memory store, PostgreSQL in plain text, and PostgreSQL encrypted), `isolation.test.ts`
  (32: 16 per store), `auth.test.ts` (24), `crypto.test.ts` (16), `http.test.ts` (11),
  `migrations.test.ts` (10), `account.test.ts` (9), `server.test.ts` (9).
- **Playwright, 61.** 45 against the injected content script (unchanged). 10 through the
  real loaded extension and the real built API (6 before; 4 new, for sign-in, a second
  account, and token expiry twice). 6 new that run the built API as a process
  (`apps/api/test/e2e/api-process.spec.ts`).

Changes made to tests that already existed, all forced by replacing the shared token
with accounts; no assertion was removed or loosened:

- `apps/api/test/helpers.ts`: the test app now starts with one account (id `dev-user`,
  as before) and a real access token for it, instead of a shared token.
- `apps/api/test/api.test.ts`: `GET /health` is now expected to return
  `{ status, persistence, database }`; "no token configured" became "no signing secret
  configured"; two config literals lost `apiToken`.
- `apps/api/test/config.test.ts`, `apps/api/test/packs.test.ts`: `OPENNJOB_API_TOKEN`
  became `OPENNJOB_JWT_SECRET`, and the expected default configuration grew.
- `apps/extension/test/e2e/real-extension.spec.ts`: the test registers accounts over
  HTTP and the popup signs in with an email address and password instead of a pasted token.

The web-app round added: one vitest test (`PUT /applications/:id/statement` in
`api.test.ts`); new assertions for that route in `isolation.test.ts`, `http.test.ts` and
`repository.contract.ts` (no assertion removed or loosened; the request-log test's
minimum line count went from 22 to 23 because it now makes one more request); and 10
Playwright tests in `apps/web/test/e2e/web-app.spec.ts`, which run the built web app in
Chromium at phone size against the built API process (register, profile and passport,
matches and filters, agent run in auto mode, review and approve, review-all mode,
interview practice, export and deletion, session expiry and sign-out, and a final check
that no personal data reached the browser console or the API log).

Green tests show the code does what the tests describe on the fixtures. They do not show
it works on real websites, against the live job APIs, or in a real deployment.

### Notes on the browser tests

- `@playwright/test` is pinned to 1.56.1 because that version drives the Chromium build
  (revision 1194) that was pre-installed where this was built. On another machine either
  run `npx playwright install chromium` once, or set `OPENNJOB_CHROMIUM_PATH` to a Chromium
  binary.
- If `PLAYWRIGHT_BROWSERS_PATH` is set in your shell, Playwright looks for browsers there.

## Loading the extension in Chrome

1. `npm run build` (creates `apps/extension/dist`).
2. Open `chrome://extensions`, switch on **Developer mode** (top right).
3. Click **Load unpacked** and choose the folder `apps/extension/dist`.
4. Start the API (`npm start`) and register an account (see Quick start; the popup can
   sign in but cannot register). Pin the OpennJob icon and open it. Under **Connection**
   set the API address (`http://127.0.0.1:3000` is the default) and press **Save
   address**. Enter your email address and password and press **Sign in**.
5. On an application form: open OpennJob, choose the application (for its statement),
   press **Scan this page**, tick what needs ticking, press **Fill**.

To try it safely, open the fixture forms in `apps/extension/test/fixtures/` (they need to
be served over http, for example `python3 -m http.server 8080 --directory
apps/extension/test/fixtures` and then open `http://localhost:8080/nhs-style-application.html`,
`construction-application.html` or `candidature-fr.html`;
Chrome does not give extensions access to `file://` pages unless you allow it on the
extension's details page). I have not done this by hand in desktop Chrome: the automated
test drives the same popup in headless Chromium.

The extension asks for three permissions only: `activeTab`, `scripting`, `storage`. It
does nothing on any page until the user opens it and presses a button on that page.

**Signing in.** The popup sends the email address and password to `POST /auth/login` at
the configured address and keeps what comes back: the access token (a JWT), when it
expires, and the email address, in `chrome.storage.local`. The password is not kept.
Every API call carries the token. When the token has run out (the popup checks the time,
and the API replies 401), the popup forgets it, clears what it had loaded and shows the
sign-in form again with "Your session has expired. Sign in again." There are no refresh
tokens. The API address must be `https://`, except for `localhost` / `127.0.0.1`: the
popup will not send a password over plain http to another machine. Changing the address
signs you out, so a token is never sent to an API that did not issue it.

In production the API accepts only the extension origins you list in
`OPENNJOB_CORS_ORIGINS` (`chrome-extension://<id>`). Outside production any extension
origin is accepted, which is what makes "Load unpacked" work in development.

## The three modes and the sensitive-field rule

| Mode | What the agent fills | Who presses submit |
| --- | --- | --- |
| `review` | Only the fields the user has ticked, one by one. | The user. Always. |
| `hybrid` (default) | Ordinary fields straight away. Each sensitive field only after the user ticks it. | The user. Always. |
| `auto` | Same as hybrid. | The agent, but **only** when the form has no sensitive field at all, has at least one field, and no required field is empty. Otherwise the user. |

**A field is sensitive** when its label, name, id, placeholder or section heading mentions:
professional registration / PIN, a professional membership or CSCS card number, DBS,
criminal convictions or cautions, security clearance / vetting, right to work / visa
sponsorship / work permit / work authorisation / immigration, conflict of interest,
fitness to practise, safeguarding, health declarations, equality monitoring, referees'
details, or any "I declare / I confirm" statement. The French wording of the same
questions is covered too: casier judiciaire, permis de travail, droit de travailler,
références, déclaration sur l'honneur. When unsure the code classes a field as sensitive.

**The 80% rule does not change any of this.** `POST /agent/run` only prepares drafts in
the API. It does not open, fill or submit a form. `packages/core/src/policy.ts` and its
tests are unchanged from v1: the user confirms every sensitive field, and in auto mode a
form containing any sensitive field waits for the user.

Rules that hold in every mode (each is covered by tests):

- A sensitive field is never written until the user confirms that field. It is outlined
  on the page so the user can see it is being held.
- **OpennJob never answers** convictions, security clearance / vetting, visa sponsorship
  / work permit / work authorisation, conflict of interest, fitness to practise,
  safeguarding, health or equality-monitoring questions, or "I declare" tick boxes. It
  holds no fill value for them. (A security-clearance line in the passport is used for
  eligibility only; it is never typed into a form.) The user answers those personally,
  every time.
- Right to work is only ever offered as "Yes", and only if the user stored that
  confirmation. A stored "no" never ticks or selects anything. The stored confirmation
  is about the UK: it is not offered when the question names another country ("right to
  work in Ireland") or is asked in French.
- A professional membership number and a CSCS card number are filled from the passport,
  each only after the user confirms that field. A "languages spoken" field is ordinary
  and is filled from the passport's languages line, or else the selected languages.
- A form with any sensitive field is **never submitted by the agent**, in any mode, even
  after the user has confirmed those fields. This is the stricter of two possible
  readings of the brief ("auto ... otherwise it holds for the user"); it is a one-line
  change in `packages/core/src/policy.ts` if you decide otherwise, and the tests will
  tell you what else that affects.
- Password fields are never read or written. Hidden fields are never written.
- What the user has already typed or chosen is never overwritten.
- If the page has a CAPTCHA or is a sign-in page, the agent does nothing and says so.
  There is no CAPTCHA solving, no proxying, and nothing that tries to avoid a site's
  bot checks, anywhere in this code.

The decision logic is one pure function, `decide()` in `packages/core/src/policy.ts`.
The extension bundles that same file, so the code that runs in the browser is the code
the unit tests sweep (about 68,000 combinations of mode, fields and confirmations).

## Architecture map

```
opennjob/
  packages/core/            Pure TypeScript domain logic. No framework. Unit-tested.
    src/packs.ts              the six industry packs; classifyPack(job)
    src/geo.ts                ISO country list, regions, regionOf(country), known cities
    src/languages.ts          selectable languages, French/English detection
    src/preferences.ts        inScope(job, preferences): the candidate's scope rule
    src/matching.ts           scoring, eligibility, criteria extraction (LLM + fallback)
    src/statement.ts          supporting-statement prompt (English / formal French), no-LLM drafter
    src/policy.ts             THE SAFETY CORE: review / hybrid / auto rules (unchanged from v1)
    src/fields.ts             form-field classification (sensitive? which data goes in?), English and French labels
    src/interview.ts          healthcare bank, per-pack bank, STAR prompt, heuristic scorer
    src/passport.ts           credential accessors, training-expiry checks (injectable clock)
    src/llm.ts                LlmPort, AnthropicLlm, FakeLlm
    src/usage.ts              UsageMeter (ACU), in-memory meter, BitriPayBillingPort (seam)
    src/events.ts             EventBus, in-process implementation
    src/repository.ts         Repository interface, in-memory implementation
    src/sources/              Greenhouse, Lever, Ashby, Adzuna, Reed adapters, demo jobs, de-duplication
    src/browser.ts            the subset the extension bundles (policy + fields)
    src/web.ts                the subset the web app imports (packs, countries, languages)
  apps/api/                 NestJS REST API over packages/core
    src/main.ts               process entry; graceful shutdown on SIGTERM / SIGINT
    src/server.ts             start-up checks (secrets in production, migrations applied), wiring
    src/http.ts               helmet, CORS allow-list, body size limit, request log
    src/deps.ts               configuration from the environment; PostgreSQL or in-memory
    src/auth.ts               password rules, bcrypt, JWT, rate limiter
    src/auth.guard.ts         access-token guard, @CurrentUser, rate-limit guard
    src/account.service.ts    register, login, export, delete
    src/services.ts           profile, passport, jobs, matching, applications, interview, usage
    src/postgres.ts           PostgresRepository, PostgresUsageMeter (pg)
    src/crypto.ts             AES-256-GCM encryption of CV text, passport, statements
    src/migrations.ts         the migration runner; migrate-cli.ts is `npm run migrate`
    src/logging.ts            JSON logger, request log, error filter
  apps/web/                 candidate web app: Next.js 14, App Router, static export to out/
    src/app/                  one folder per screen: signin, register, profile, matches, review, tracker, interview, account
    src/components/AppShell.tsx   header (pack, mode), tab bar, sign-in guard
    src/lib/api.ts            the only API client: address from /opennjob-config.json, token in sessionStorage
    src/lib/declarations.ts   what the user confirms on the review screen
    test/e2e/                 Playwright: the built site + the built API process
  apps/extension/           Chrome Manifest V3 extension, bundled with esbuild into dist/
    src/agent/                scan the form, detect blockers, fill, apply the policy
    src/popup/                the popup UI: API address, sign-in, mode, scan, fill
    test/fixtures/            fictional application forms
    test/e2e/                 Playwright tests
  db/migrations/            versioned SQL migrations (001 was db/schema.sql)
  deploy/gcp-cloud-run.md   Cloud Run steps (from memory, not executed)
  Dockerfile, docker-compose.yml, .github/workflows/ci.yml, .env.example
  scripts/test-with-postgres.sh   `npm run test:pg`: tests against a throwaway PostgreSQL
```

### REST API

Every route needs `Authorization: Bearer <access token>`, where the token comes from
`POST /auth/login` or `POST /auth/register`. The exceptions: `GET /health` and the three
`/auth` routes need none, and `POST /employer/jobs` takes `OPENNJOB_EMPLOYER_KEY`
instead. The user a request acts for is taken from the token and from nowhere else.

| Route | Purpose |
| --- | --- |
| `GET /auth/versions` | The terms and privacy-notice versions registration must accept |
| `POST /auth/register` | `{ email, password, acceptedTermsVersion, acceptedPrivacyVersion }`; creates the account, records consent, returns an access token |
| `POST /auth/login` | `{ email, password }`; returns `{ accessToken, tokenType, expiresIn, expiresAt, user }` |
| `GET /account` | The signed-in account: id, email, when created, consent record |
| `GET /account/export` | Everything held about the account, as JSON: account, profile, passport, applications, events, usage |
| `DELETE /account` | `{ password }`; deletes the account and all of its data |
| `PUT /profile`, `GET /profile` | Contact details, CV text and `preferences: { languages, countries, cities }` |
| `PUT /passport`, `GET /passport` | Credential passport (`credentials: { id: value }`, v1 `nmcPin` still accepted); the reply includes training-expiry status |
| `POST /jobs/refresh` | Runs the configured job sources, de-duplicates, stores |
| `GET /jobs/matches?min=&pack=&region=&country=` | In-scope jobs scored against the CV, with evidence; `min` is 0 to 100; `pack` is `con`, `dc`, `en`, `rail`, `fr` or `hc`; `region` is `uk`, `eu`, `africa`, `mena`, `am`, `apac` or `other`; `country` is an ISO code |
| `POST /agent/run` | The 80% rule: prepares a draft for every in-scope, eligible job at or above the threshold (`{ mode }`, default `hybrid`) |
| `POST /employer/jobs` | Optional. Stores an employer's job with `origin: 'employer'`. Separate key. |
| `POST /applications` | Creates a draft with a supporting statement (`{ jobId, mode }`) |
| `PUT /applications/:id/statement` | `{ statement }`; saves the user's own edit of the drafted statement. 409 once submitted |
| `POST /applications/:id/confirm` | Records which sensitive fields the user confirmed (names, not values) |
| `POST /applications/:id/submitted` | Records that the form was submitted |
| `GET /applications`, `GET /applications/:id` | List / read |
| `POST /interview/feedback` | STAR feedback (`{ questionId or question, answer }`) |
| `GET /interview/questions?role=&category=` | The healthcare question bank |
| `GET /interview/questions?pack=` | The questions of one industry pack (ids such as `rail-2`, usable as `questionId`) |
| `GET /usage` | ACU usage records and totals |
| `GET /health` | `{ status, persistence, database }`; 503 when the database cannot be reached. No auth |

`GET /applications/:id`, `GET /interview/questions`, `GET /usage` and `GET /health` were
added beyond the v1 brief because the extension and a developer need them.

### Accounts

- **Passwords.** At least 12 characters, at most 72 bytes (bcrypt reads no more), at
  least 5 different characters, not one of a short list of common passwords, and not
  containing the email address. Stored as a bcrypt hash (cost `OPENNJOB_BCRYPT_ROUNDS`,
  default 12); the password itself is never stored or logged.
- **Access tokens.** JWT, HS256, signed with `OPENNJOB_JWT_SECRET`, valid for
  `OPENNJOB_JWT_TTL_SECONDS` (default one hour). The guard checks signature, algorithm,
  issuer, audience and expiry, and that the account still exists, on every request.
  There are no refresh tokens and no server-side sign-out: a token works until it
  expires or its account is deleted.
- **Start-up.** With `NODE_ENV=production` the API refuses to start without
  `OPENNJOB_JWT_SECRET` (at least 32 characters) and without `OPENNJOB_DATA_KEY`.
  Outside production a missing secret is replaced by a random one for that run.
- **Rate limit.** `/auth/*` allows `OPENNJOB_AUTH_RATE_LIMIT_MAX` attempts (default 10)
  per client address, and per email address, per window (default 15 minutes), then
  replies 429 with `Retry-After`. The counts are in the memory of one process.
- **Consent.** Registration must carry `acceptedTermsVersion` and
  `acceptedPrivacyVersion`, equal to the server's current versions
  (`OPENNJOB_TERMS_VERSION`, `OPENNJOB_PRIVACY_VERSION`). They are stored with the time.
  The defaults are `draft-1` because **the documents themselves do not exist yet**.
- **Separation.** Every profile, passport, preference, application, agent run, match,
  usage record and event belongs to one account. `apps/api/test/isolation.test.ts` runs
  every route as a second user against the first user's data, on both stores, and fails
  if the API has a route the test does not name. Jobs are a shared catalogue.
- **Export and deletion.** `GET /account/export` and `DELETE /account` (which asks for
  the password again). Deletion removes the profile, passport, applications, events and
  usage records; in PostgreSQL the test reads every table afterwards.
- **Not there:** email verification, password reset, change of password or email,
  multi-factor authentication, account lock-out, admin tools. See `GO-LIVE.md`.

### PostgreSQL and migrations

- `DATABASE_URL` set: `PostgresRepository` and `PostgresUsageMeter` (the `pg` driver).
  Not set: the in-memory store. Both implement the same `Repository` interface, and one
  contract suite (`apps/api/test/repository.contract.ts`) runs against both.
- The schema is in `db/migrations/NNN_name.sql`. `npm run migrate` applies whatever the
  database does not have, each file in its own transaction, and records it in the
  `schema_migrations` table with a checksum. Running it again does nothing. It refuses
  to continue if an applied file was edited afterwards. To change the schema, add a file.
- The API does not migrate by itself. It checks at start-up and refuses to start on a
  database that is missing migrations.
- PostgreSQL 16 is what it was run against.

### Encryption at rest

With `OPENNJOB_DATA_KEY` set (exactly 32 bytes, base64), these are encrypted with
AES-256-GCM before they reach PostgreSQL: **CV text** (`profiles.cv_text`), **the whole
credential passport** (`passports.data`) and **supporting statements**
(`applications.statement`). Each value has its own random nonce, and is bound to its
place (which column, which user), so a value altered in the database, or copied into
another user's row, fails to decrypt and the request fails rather than returning it.

What is **not** encrypted by the application: names, contact details and preferences
in `profiles`, account email addresses, job data, event and usage records; and nothing
in the in-memory store. Use disk-level encryption on the database as well.

**Key management and rotation are the operator's job.** The code reads one key from one
environment variable. It does not generate, store, back up, version or rotate keys.

- Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
- Keep it in a secret manager, never in the repository or the image, and keep a
  recoverable copy somewhere separate. **If the key is lost, the encrypted data cannot
  be read by anyone.**
- There is no rotation. Changing `OPENNJOB_DATA_KEY` makes every existing encrypted row
  unreadable. Rotating means writing a tool that reads each row with the old key and
  writes it with the new one; that tool does not exist.
- Rows written before a key was set are plain text; they are read as they are and
  become ciphertext the next time they are saved. Removing the key afterwards makes the
  encrypted rows unreadable (the API returns an error, not ciphertext).

### Logging and HTTP hardening

- **Logs** are JSON lines on stdout / stderr. One line per request: request id, method,
  path without the query string, status, duration, user id (the opaque account id).
  Bodies, headers and query strings are never logged. An unexpected error is logged by
  its type and code only, because a database error message can quote the data that
  caused it. A test drives every route and checks that no CV, passport or statement
  content, password, token or email address appears; another checks the real process's
  output.
- **Headers.** `helmet` with a deny-everything content policy (the API serves JSON
  only), `Cache-Control: no-store`, an `X-Request-Id` on every response.
- **CORS.** `OPENNJOB_CORS_ORIGINS` is the allow-list. Any `chrome-extension://` origin
  is also accepted outside production (`OPENNJOB_CORS_ALLOW_ANY_EXTENSION`).
- **Body size.** `OPENNJOB_BODY_LIMIT`, default 256kb; larger requests get 413.
- **Behind a proxy** set `OPENNJOB_TRUST_PROXY` so the rate limit sees the caller's
  address. The API itself speaks plain HTTP: TLS is the proxy's job.

### Deployment files

- `Dockerfile`: multi-stage, production dependencies only, runs as the non-root `node`
  user, listens on `0.0.0.0:8080`, has a health check, and starts `node` directly so
  SIGTERM reaches it.
- `docker-compose.yml`: `postgres` (16), a one-shot `migrate`, then `api` on
  `127.0.0.1:3000`. Secrets come from `.env`; none has a default.
- `.github/workflows/ci.yml`: install, build, typecheck, migrate, vitest with a postgres
  service container, Playwright; and a second job that builds the image.
- `deploy/gcp-cloud-run.md`: gcloud steps for Cloud Run + Cloud SQL + Secret Manager.
- Graceful shutdown: on SIGTERM or SIGINT the API stops accepting connections, lets
  requests in flight finish, closes the database pool and exits 0.

None of the four was run for real: no Docker daemon, no GitHub runner and no Google
Cloud project were available. See "What was NOT verified".

### Industry packs

`packages/core/src/packs.ts` holds the registry: `Pack { id, name, credentialFields,
declarations, questions }`. Ids, names, credential fields, declarations and questions
are the ones the product demo uses.

| Id | Name | Passport lines |
| --- | --- | --- |
| `con` | Construction and infrastructure | `prof`, `sc`, `cdm`, `pm`, `cscs`, `smsts`, `pts`, `lang`, `rtw` |
| `dc` | Data centres and mission-critical | same |
| `en` | Energy and grid | same |
| `rail` | Rail and transport | same |
| `fr` | Francophone Africa and diaspora | same |
| `hc` | Healthcare | `pin`, `dbs`, `rtw` |

- `classifyPack(job)` sorts a job into a pack from the words in its title and
  description (healthcare first; then the francophone pack for a job in a French-speaking
  African country or about the diaspora; then data centres, rail, energy, construction).
  It returns nothing for a job that fits no pack. It is a keyword heuristic.
- A job may carry `requiredCredential` (`pin`, `sc`, ...). `requiresRegistration: true`
  still works and means `requiredCredential: 'pin'`. A job is only "eligible" when that
  credential is in the passport. OpennJob stores what the user typed and verifies none of
  it: not an NMC PIN, not a membership number, not a security clearance.
- Every job has `pack`, `country` (ISO 3166-1 alpha-2), `city`, `region` (always derived
  from the country by `regionOf()`), `language` (`en` or `fr`) and `origin`
  (`discovered` or `employer`). When a source does not state them they are inferred from
  the location text and the wording, and left out when that fails.
- **French.** When `job.language` is `fr` the LLM is asked for formal French
  (vouvoiement), and told that translating the CV's evidence must not add to it. The
  no-LLM drafter opens with a fixed French salutation and then copies the CV's sentences
  as they are (it cannot translate). The rule that a statement may only use evidence
  from the CV is the same in both languages and is tested in both.

### Candidate preferences

`preferences: { languages, countries, cities }` on the profile. **If nothing is selected,
everything is available.** `inScope(job, preferences)` in
`packages/core/src/preferences.ts` is the whole rule:

- **countries** (ISO codes): empty means any country. Otherwise the job must be in one of
  them. A job whose country is unknown is out of scope while any country is selected.
- **cities**: a city only narrows the country it belongs to. With Birmingham selected,
  UK jobs must be in Birmingham; a job in another selected country that has no selected
  city still passes; and with no country selected, the rest of the world is unaffected.
  OpennJob knows the country of 27 cities (the demo's list); any other city is
  written with its country code, for example `"Lille, FR"`.
- **languages**: empty excludes nothing. Otherwise the language the application is
  written in must be one of them. Only English and French applications exist, so
  selecting only (say) German and Lingala puts every job out of scope.
- **A selected language is also evidence** for a criterion that asks for that language
  ("French, fluent"), when the CV does not already evidence it. The match says so
  (`statedLanguage`) and has no CV sentence for it. **An empty list is never evidence of
  speaking a language**, even though for scope an empty list excludes nothing.

`GET /jobs/matches` and `POST /agent/run` both apply it. The `pack`, `region` and
`country` filters on `/jobs/matches` narrow that list further; they never widen it.
Country codes are validated against a full ISO 3166-1 alpha-2 list in
`packages/core/src/geo.ts` (see "What was NOT verified").

### The 80% rule

- The threshold comes from `OPENNJOB_APPLY_THRESHOLD` (a whole number from 0 to 100;
  default 80; anything unreadable leaves 80 in force). It is the operator's setting, not
  a field of the request.
- `POST /agent/run` scores every stored job. A job is taken when it is in scope, the
  user is eligible for it, and its score is at or above the threshold. Each one gets an
  application **draft**, exactly as `POST /applications` would make. A job that already
  has an application is not drafted again. The reply lists what was prepared and counts
  what was skipped and why.
- That is all it does. Filling and submitting still happen in the extension under the
  mode rules above.

### Discovery first; employer posting is optional

Jobs are found by the system from its sources. `POST /employer/jobs` is an extra way in:
it stores a job with `origin: 'employer'`, after which it is matched, scoped and drafted
exactly like a discovered job. The route is closed (HTTP 401) unless
`OPENNJOB_EMPLOYER_KEY` is set, a user's access token does not open it, and the employer
key opens no other route. A single shared employer key is a placeholder: there are no
employer accounts, and nothing checks who the employer is or moderates what is posted.

### How matching works

- Score = round(100 x matched weight / total weight); essential criteria weigh 2,
  desirable weigh 1. A criterion is met when any of its keywords appears in the CV,
  ignoring case.
- "Appears" means: starting at a word boundary. Keywords of four or more letters may be
  followed by an ending ("medication" matches "medications"); shorter ones (NMC, RN,
  HCA) must be whole words, so "RN" does not match "learn". This is slightly stricter
  than a plain substring test and is deliberate.
- A criterion that asks for a language is also met when the candidate selected that
  language in their preferences (see "Candidate preferences").
- `eligible` is false only when the job requires a credential (an NMC PIN, security
  clearance) that is not stored in the passport.
  `POST /applications` refuses (HTTP 422) to draft for a job the user is not eligible for.
- OpennJob does not check an NMC PIN with the NMC, or any other credential with anyone.
  It stores what the user typed.

## What is real, what is stubbed

**Real and tested**

- All the core modules, with unit tests, including the scope rule checked against a
  brute-force statement of itself over 4,096 combinations.
- The NestJS API, with integration tests over HTTP (supertest).
- The extension's form scanning, field classification, filling, blocker detection and
  mode rules, tested in Chromium against the fixture forms.
- The complete chain in one test file (`real-extension.spec.ts`): the built API process,
  the unpacked extension loaded in Chromium, the popup, the content script injected by
  `chrome.scripting`, and a fixture form.
- Accounts, the PostgreSQL repository, migrations, encryption at rest, export and
  deletion, the request log and the start-up checks, each with tests; the
  PostgreSQL-backed ones were run against a live, throwaway PostgreSQL 16.
- The built API as a real process: refusing to start, JSON logs, SIGTERM
  (`apps/api/test/e2e/api-process.spec.ts`).

**Stubbed, placeholder or missing**

| Area | State |
| --- | --- |
| Persistence | PostgreSQL when `DATABASE_URL` is set; otherwise in memory and lost on restart. No backups, no retention rule. |
| Authentication | Real accounts with bcrypt and JWT. Missing: email verification, password reset, password change, refresh tokens, server-side sign-out, multi-factor authentication. |
| Candidate web app | `apps/web`, tested in headless Chromium against the built API. Never deployed, never used by a real person, never tried on a real phone. No content-security policy is configured for it (Next.js inlines scripts, so a policy needs `'unsafe-inline'` or nonces; not done). |
| Encryption | CV text, passport and statements only, and only in PostgreSQL. One key, no rotation. |
| Terms and privacy notice | The versions accepted at registration (`draft-1`) refer to documents that do not exist. |
| LLM | `AnthropicLlm` uses the official `@anthropic-ai/sdk`, but **no real call to Anthropic has been made by this code** (no API key was available where it was built). Its request/response mapping is tested with a stub client. |
| Model name | `OPENNJOB_MODEL` must be set. If it is not, the code falls back to `PLACEHOLDER_MODEL_CONFIRM_BEFORE_USE` in `packages/core/src/llm.ts` and warns. That placeholder has not been checked against Anthropic's current model list. |
| Billing | `UsageMeter` records ACU per LLM call (in the `usage_records` table with PostgreSQL). The ACU formula (1 ACU per 1,000 tokens) is a placeholder. `BitriPayBillingPort` is an interface with **no implementation**; it states what OpennJob needs and does not describe BitriPay's real API. |
| Events | In-process `EventBus`. Events are also appended to the event log (the `events` table with PostgreSQL). |
| CV input | Plain text only. No PDF or Word parsing. |
| Statement drafting without an LLM | A list of the matching sentences copied from the CV, in criteria order. It cannot invent anything, and it is not polished prose. |
| LLM statement check | The prompt forbids invented experience and a cheap check flags criteria the CV does not evidence but the draft mentions. That is a warning, not a guarantee. The user must read every AI-drafted statement. |
| Criteria extraction without an LLM | Recognises about 25 healthcare terms and about 28 construction, data-centre, energy and rail terms. It will miss unusual criteria and cannot read nuance. It does not read French adverts well: a French advert needs the LLM, or criteria supplied with the job. |
| "Requires registration" / "requires security clearance" detection | Heuristics on the job title and wording. They can be wrong in both directions. |
| Pack classification | Keyword lists. A job can land in the wrong pack or in none. |
| Country, city and language of a discovered job | Taken from the source when it says; otherwise guessed from the location text (a table of 27 cities plus country names) and from counting common French and English words. Jobs it cannot place have no country, and are out of scope for anyone who selected a country. |
| French statements without an LLM | Only the opening line is French. The CV's sentences are copied untranslated, and the draft says so. |
| Interview feedback in French without an LLM | A much smaller cue list than the English one, tried only on the test answers. |
| Employer posting | One shared key, no employer accounts, no moderation, no editing or withdrawing a posting. |
| Job refresh | Any signed-in user can call `POST /jobs/refresh`, which refreshes the shared catalogue. No scheduler. |
| Preferences | Languages, countries and cities only. No salary, contract type, distance or remote-working preference. |
| Interview scoring without an LLM | Looks for wording that signals Situation / Task / Action / Result. It cannot judge whether an answer is true, safe or relevant. |
| Extension UI | A popup. It closes when the user clicks on the page, which loses the ticks. A Chrome side panel would fix that. It can sign in but not register. No icons, no onboarding, no error reporting. |
| Extension storage | The access token is kept in `chrome.storage.local`, unencrypted, until it expires or the user signs out. |
| Form coverage | Text boxes, text areas, drop-downs, tick boxes and yes/no radio groups in an ordinary HTML form. Not handled: multi-page forms, file uploads (CV upload), date pickers made of several boxes, fields inside iframes or shadow DOM, custom drop-down widgets. |
| Rate limiting | `/auth/*` only, counted per process. Nothing on other routes. |
| Monitoring, alerting, backups, hosting, TLS | None. The deployment files exist; nothing is deployed. |

## What was NOT verified

- **The Docker image.** `docker build` and `docker compose up` were not run: there was
  no Docker daemon. The Dockerfile's commands were run by hand outside Docker (install,
  build, production-only install, then the result started as a non-root user against
  PostgreSQL, where it migrated, served `/health` and stopped). That checks the commands,
  not the image.
- **The GitHub Actions workflow.** Written, never executed.
- **The Cloud Run guide.** `deploy/gcp-cloud-run.md` was written from memory. No command
  in it was run.
- **PostgreSQL versions other than 16**, managed PostgreSQL (Cloud SQL), TLS to the
  database, and connection through the Cloud SQL socket: none tried.
- **Behaviour under load**, with more than one API instance, or over a long run.
- **An independent security review.** None. The accounts, the separation between users
  and the encryption were written and tested by the same author.
- **Job-source response shapes.** The Greenhouse, Lever, Ashby, Adzuna and Reed
  endpoints and response shapes in `packages/core/src/sources/` are from memory of the
  public docs and have not been checked against the live APIs today. The same warning
  is at the top of each adapter. Every adapter test uses a hand-written fixture in that
  remembered shape; no test makes a live call. Expect to adjust field names when you
  first point them at the real services. Each provider's API terms of use (attribution,
  caching, permitted use) have not been reviewed either.
- **Adzuna country list.** The Adzuna adapter takes a country code and puts it in the URL
  path (`gb`, `us`, `fr`, `de`, `za`, ...; set `ADZUNA_COUNTRIES`). The list of codes
  Adzuna supports (`ADZUNA_COUNTRIES_UNVERIFIED` in
  `packages/core/src/sources/adzuna.ts`) is from memory and has not been checked against
  Adzuna's documentation or the live API. The adapter therefore accepts any two-letter
  code rather than enforce a list it cannot vouch for.
- **French field detection.** It has only been tested on the one French fixture form
  (`candidature-fr.html`), which was written for this project. Real French, Belgian,
  Congolese or Senegalese forms will use wording it does not know.
- **Non-UK right-to-work and data-protection rules.** Everything here was written with
  UK rules in mind. Right-to-work, visa and work-permit rules, what an employer may ask
  an applicant, and data-protection law all differ by country (for example GDPR in the
  EU, and national laws in the DRC, Senegal, Côte d'Ivoire, the Gulf states, the US and
  Canada). Each country needs a legal check by a qualified adviser before real users
  apply to jobs there. The stored right-to-work confirmation means the UK only.
- **The ISO country list.** The 249 codes in `packages/core/src/geo.ts` were typed from
  memory and checked only against the region data that ships with Node (every code is a
  region Node knows). They were not compared with the ISO register. The grouping into
  regions is OpennJob's own.
- **The demo data against the demo.** Pack ids, names, credential fields, declarations,
  questions and the demo jobs were copied from the reference file supplied for this
  work. The demo itself was not run or seen.
- **Real employer websites.** The extension has only ever run on the fictional forms in
  `apps/extension/test/fixtures/`. It has not been tried on NHS Jobs, Trac, any NHS
  trust's site, any agency site or any applicant tracking system. Real forms will break
  it in ways the fixtures do not.
- **A real Anthropic call**, as above.
- **Chrome Web Store requirements.** Not reviewed.
- **Node 20.** `engines` says Node 20 or newer and nothing newer is used on purpose, but
  it was only run on Node 22.22.
- **Legal position.** The data-protection notes below are a checklist for a
  conversation with a qualified adviser. They are not legal advice.

### One thing the end-to-end test simulates

In real use the user clicks the OpennJob icon, which gives the extension `activeTab`
access to that tab. An automated test cannot click the browser toolbar. So
`real-extension.spec.ts` loads a copy of `dist/` whose manifest also has host permission
for `http://127.0.0.1/*` (the fixture server), and the popup accepts a `?tabId=` query
parameter to say which tab to work on. The JavaScript is the built extension unchanged;
the shipped `manifest.json` does not contain that permission.

## NHS Jobs, Trac, LinkedIn and Indeed

There are **no scrapers and no automation for NHS Jobs, Trac, LinkedIn or Indeed** in
this codebase, on purpose. Each of those needs a terms-of-use check or a partnership
before any automated access (fetching listings, logging in, or submitting). Until that
is done, the route for those sites is the extension: user-driven, in the user's own
logged-in browser session, on the page the user has opened, with the user pressing
submit. Even that should be checked against each site's terms before launch, because
some sites restrict automated form filling as well as scraping.

## UK GDPR notes

These notes are about the UK. Jobs in other countries bring those countries' rules with
them; see "What was NOT verified".

OpennJob handles personal data, and some of the most sensitive kinds.

- **CVs, contact details, NMC PINs, membership and card numbers, security-clearance
  details, DBS certificate details, preferences and supporting statements are personal
  data.** Holding someone's security-clearance status may carry obligations of its own;
  ask before storing it for real users.
- **Declarations are high risk.** Health and equality-monitoring answers are special
  category data (UK GDPR Article 9). Convictions and cautions are criminal-offence data
  (Article 10). v1 deliberately stores none of these answers and never fills them. Keep
  it that way unless there is a clear lawful basis and a documented reason.
- **Referees are third parties.** Their names and contact details are their personal
  data, given by someone else.
- **Before any real user:** complete a **DPIA** (this is automated processing of
  sensitive data to make job applications, which is likely to need one); obtain
  **explicit, informed consent** for storing the passport and for the agent acting on
  the user's behalf, with a plain explanation of each mode; write a privacy notice;
  register with the ICO if not already registered.
- **LLM provider.** With an LLM configured, CV text and job adverts are sent to
  Anthropic. That makes Anthropic a processor: a data processing agreement, a check on
  where data is processed (international transfers), and their retention and training
  settings all need confirming. Tell users plainly that their CV is sent to an AI
  provider.
- **Security.** This version has per-user authentication, encrypts the CV, the passport
  and statements at rest in PostgreSQL, and keeps secrets out of the repository. It does
  not provide HTTPS (a proxy must), key management, or an independent security test.
- **Consent.** Registration records which versions of the terms and privacy notice were
  accepted and when. That record is only worth something once those documents exist and
  say plainly what the product does, including each mode and the use of an AI provider.
- **Retention and rights.** Export (`GET /account/export`) and deletion
  (`DELETE /account`) exist. Still to decide: how long data is kept, and what happens to
  backups and logs when an account is deleted.
- **Events and logs.** Event payloads carry ids and counters only, by design, and a
  test checks no CV text, contact details or PIN leak into them. Keep that rule when
  Kafka is added.
- **Accuracy and honesty.** An application is a formal statement by the applicant. The
  product must not submit anything the user has not seen. That is why review and hybrid
  never submit, and why auto is so narrow.

## Later seams (deliberately not built)

- **Kafka.** Not added. Domain events go through the `EventBus` interface
  (`packages/core/src/events.ts`); a Kafka-backed implementation can replace
  `InProcessEventBus` without touching the publishers.
- **LangGraph.** Not added. The flow (match, draft, confirm, fill, submit) is plain
  function calls today. If multi-step agent orchestration is wanted later, the pure
  functions in `packages/core` are the nodes; `LlmPort` is the model boundary.
- **BitriPay.** `BitriPayBillingPort` in `packages/core/src/usage.ts`.

## Known issues

- `npm audit --omit=dev` reports advisories in **Next.js 14** (and the `postcss` it
  bundles). The brief asked for Next.js 14; the fixes are in later major versions. Most
  of the advisories concern the Next.js server (image optimiser, server components,
  server actions, middleware, rewrites), which a static export does not run; not all of
  them have been read one by one. Decide whether to move to a supported major version
  before deploying.

- `npm audit` reports advisories in **vitest's own dependencies** (`tinypool`,
  `@vitest/mocker`). vitest is a development-only test runner; it is not part of the API
  or the extension. The fixes are in vitest 5, which needs Node 22.12+, and in vitest
  4.1.11, which failed to install with npm 10.9.4 where this was built (an npm resolver
  crash). Upgrade when you settle the Node version.
- The API uses explicit `@Inject(...)` on every constructor parameter and zod (not
  class-validator) for validation. Both are so the app does not depend on TypeScript's
  `emitDecoratorMetadata`, which the test runner's transpiler does not produce.

## Next steps, in the order I would do them

1. Check the five job-source adapters against the live APIs and their terms of use,
   including which countries Adzuna really supports.
2. Make one real Anthropic call end to end; confirm the model name; review statement
   quality with real nurses' CVs (with their consent).
3. Email verification and password reset (the web app exists; these do not). Try the
   web app on real phones; decide on the Next.js version (see Known issues).
4. Privacy policy and terms, DPIA, ICO check, before any real user's data; and a legal
   check per country before offering jobs outside the UK.
5. Build the image, run `docker compose up`, run the CI workflow, and deploy to a
   staging environment with TLS, backups (restore one) and alerting. Decide key
   management for `OPENNJOB_DATA_KEY`. Commission an independent security test.
6. Try the extension on real forms, English and French, by hand, in hybrid mode only,
   with permission where a site's terms require it. Expect to extend the form coverage
   listed above.
7. Move the popup to a side panel so the user can see the form while confirming.
8. PDF and Word CV import.
9. Terms-of-use checks or partnerships for NHS Jobs and Trac.
10. BitriPay billing adapter and a real ACU rate card.
11. Keep auto mode switched off for real users until hybrid has a track record.

`GO-LIVE.md` has the full list.
