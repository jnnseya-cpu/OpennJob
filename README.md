# OpennJob

Working name. An AI job-application assistant. v1 was UK healthcare only. This version
adds **industry packs** (construction and infrastructure; data centres and
mission-critical; energy and grid; rail and transport; francophone Africa and diaspora;
healthcare), **candidate preferences** (languages, countries, cities), French-language
applications, the **80% rule** (`POST /agent/run`) and optional employer posting.

This is a tested version of the codebase for a developer to take forward. It is
not a finished product and it has never been used on a real employer's website. The
sections "What is real, what is stubbed" and "What was NOT verified" below are the
honest state of it. Please read those before promising anything to anyone.

## What it does

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

Run the API:

```bash
cp .env.example .env   # then set OPENNJOB_API_TOKEN to a long random value
npm start              # http://127.0.0.1:3000
```

With `OPENNJOB_DEMO_JOBS=true` (the default in `.env.example`) there are 28 fictional
sample jobs (the three v1 healthcare jobs, plus a few per industry pack across 16
countries), so the whole flow can be tried with no API keys. Every employer in them is
invented.

```bash
TOKEN=the-value-you-put-in-.env
API=http://127.0.0.1:3000
AUTH="Authorization: Bearer $TOKEN"
JSON="Content-Type: application/json"

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

# Optional. Needs OPENNJOB_EMPLOYER_KEY to be set on the server; it is not the user's token.
curl -X POST $API/employer/jobs -H "Authorization: Bearer $EMPLOYER_KEY" -H "$JSON" -d '{
  "title":"Site Manager","employer":"Example Build Ltd","country":"GB","city":"Leeds",
  "applyUrl":"https://example.org/apply/1",
  "description":"Essential\n- CDM 2015 duties.\n- SMSTS certificate."}'
```

All data is held in memory. **It is lost when the API stops.**

### Test results at hand-over

Run on 6 October 2026, Node 22.22.0, npm 10.9.4, Linux, with `npm run build`, `npm test`
and `npm run test:e2e` from the repository root. (v1 was run from a clean checkout after
`rm -rf node_modules`; this time the existing `node_modules` was used. No dependency
changed.)

| Command | Result |
| --- | --- |
| `npm test` | 16 test files, 438 tests passed, 0 failed |
| `npm run test:e2e` | 51 tests passed, 0 failed (45 against the injected content script, 6 through the real loaded extension and real API) |

v1 had 221 and 32. The v1 test files still hold their 221 and 32 tests and all of them
pass. The new tests are in new files (`packs*.test.ts`, `preferences.test.ts`,
`french.test.ts`, `pack-forms.spec.ts`), plus one test added to `real-extension.spec.ts`.

No test is skipped. Green tests show the code does what the tests describe on the
fixtures. They do not show it works on real websites or against the live job APIs.

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
4. Start the API (`npm start`). Pin the OpennJob icon, open it, open **Connection**, enter
   the API address (`http://127.0.0.1:3000`) and your `OPENNJOB_API_TOKEN`, press
   **Save and load my data**.
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
  apps/api/                 NestJS REST API over packages/core
  apps/extension/           Chrome Manifest V3 extension, bundled with esbuild into dist/
    src/agent/                scan the form, detect blockers, fill, apply the policy
    src/popup/                the popup UI
    test/fixtures/            fictional application forms
    test/e2e/                 Playwright tests
  db/schema.sql             PostgreSQL tables (not used by the app yet)
```

### REST API

Every route except `GET /health` needs `Authorization: Bearer <OPENNJOB_API_TOKEN>`,
apart from `POST /employer/jobs`, which takes `OPENNJOB_EMPLOYER_KEY` instead.

| Route | Purpose |
| --- | --- |
| `PUT /profile`, `GET /profile` | Contact details, CV text and `preferences: { languages, countries, cities }` |
| `PUT /passport`, `GET /passport` | Credential passport (`credentials: { id: value }`, v1 `nmcPin` still accepted); the reply includes training-expiry status |
| `POST /jobs/refresh` | Runs the configured job sources, de-duplicates, stores |
| `GET /jobs/matches?min=&pack=&region=&country=` | In-scope jobs scored against the CV, with evidence; `min` is 0 to 100; `pack` is `con`, `dc`, `en`, `rail`, `fr` or `hc`; `region` is `uk`, `eu`, `africa`, `mena`, `am`, `apac` or `other`; `country` is an ISO code |
| `POST /agent/run` | The 80% rule: prepares a draft for every in-scope, eligible job at or above the threshold (`{ mode }`, default `hybrid`) |
| `POST /employer/jobs` | Optional. Stores an employer's job with `origin: 'employer'`. Separate key. |
| `POST /applications` | Creates a draft with a supporting statement (`{ jobId, mode }`) |
| `POST /applications/:id/confirm` | Records which sensitive fields the user confirmed (names, not values) |
| `POST /applications/:id/submitted` | Records that the form was submitted |
| `GET /applications`, `GET /applications/:id` | List / read |
| `POST /interview/feedback` | STAR feedback (`{ questionId or question, answer }`) |
| `GET /interview/questions?role=&category=` | The healthcare question bank |
| `GET /interview/questions?pack=` | The questions of one industry pack (ids such as `rail-2`, usable as `questionId`) |
| `GET /usage` | ACU usage records and totals |
| `GET /health` | Liveness, no auth |

`GET /applications/:id`, `GET /interview/questions`, `GET /usage` and `GET /health` were
added beyond the v1 brief because the extension and a developer need them.

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
`OPENNJOB_EMPLOYER_KEY` is set, the user's token does not open it, and the employer key
opens no other route. A single shared employer key is a placeholder like the user
token: there are no employer accounts, and nothing checks who the employer is or
moderates what is posted.

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
- `db/schema.sql` (with the new columns) was applied to a fresh, throwaway PostgreSQL 16
  instance and loads cleanly. Nothing reads or writes those tables. It is a create
  script, not a migration: it adds no columns to a database made from the v1 file.

**Stubbed, placeholder or missing**

| Area | State |
| --- | --- |
| Persistence | In-memory only. There is no `PostgresRepository`. Data is lost on restart. |
| Authentication | One shared bearer token and one hard-coded user (`dev-user`). A placeholder, not real auth: no accounts, sessions, per-user separation or rotation. |
| LLM | `AnthropicLlm` uses the official `@anthropic-ai/sdk`, but **no real call to Anthropic has been made by this code** (no API key was available where it was built). Its request/response mapping is tested with a stub client. |
| Model name | `OPENNJOB_MODEL` must be set. If it is not, the code falls back to `PLACEHOLDER_MODEL_CONFIRM_BEFORE_USE` in `packages/core/src/llm.ts` and warns. That placeholder has not been checked against Anthropic's current model list. |
| Billing | `UsageMeter` records ACU per LLM call in memory. The ACU formula (1 ACU per 1,000 tokens) is a placeholder. `BitriPayBillingPort` is an interface with **no implementation**; it states what OpennJob needs and does not describe BitriPay's real API. |
| Events | In-process `EventBus`. Events are also appended to the (in-memory) event log. |
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
| Preferences | Languages, countries and cities only. No salary, contract type, distance or remote-working preference. |
| Interview scoring without an LLM | Looks for wording that signals Situation / Task / Action / Result. It cannot judge whether an answer is true, safe or relevant. |
| Extension UI | A popup. It closes when the user clicks on the page, which loses the ticks. A Chrome side panel would fix that. No icons, no onboarding, no error reporting. |
| Extension storage | The API token is kept in `chrome.storage.local`, unencrypted. |
| Form coverage | Text boxes, text areas, drop-downs, tick boxes and yes/no radio groups in an ordinary HTML form. Not handled: multi-page forms, file uploads (CV upload), date pickers made of several boxes, fields inside iframes or shadow DOM, custom drop-down widgets. |
| Rate limiting, logging, monitoring, deployment | None. |

## What was NOT verified

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
- **Security.** Encrypt the passport at rest, use real per-user authentication, use
  HTTPS, and keep secrets out of the repository. None of that exists in v1.
- **Retention and rights.** Decide how long data is kept; build export and deletion
  (the schema uses `ON DELETE CASCADE` from `users` to make deletion straightforward).
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
- **PostgreSQL.** `Repository` interface plus `db/schema.sql`.

## Known issues

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
3. Real authentication and a `PostgresRepository`; encrypt the passport.
4. DPIA, consent screens and privacy notice, before any real user's data; and a legal
   check per country before offering jobs outside the UK.
5. Try the extension on real forms, English and French, by hand, in hybrid mode only,
   with permission where a site's terms require it. Expect to extend the form coverage
   listed above.
6. Move the popup to a side panel so the user can see the form while confirming.
7. PDF and Word CV import.
8. Terms-of-use checks or partnerships for NHS Jobs and Trac.
9. BitriPay billing adapter and a real ACU rate card.
10. Keep auto mode switched off for real users until hybrid has a track record.
