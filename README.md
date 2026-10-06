# OpennJob v1

Working name. An AI job-application agent. Launch niche: UK healthcare jobs (nurses,
healthcare assistants, support workers).

This is a first, tested version of the codebase for a developer to take forward. It is
not a finished product and it has never been used on a real employer's website. The
sections "What is real, what is stubbed" and "What was NOT verified" below are the
honest state of it. Please read those before promising anything to anyone.

## What it does

1. The user stores a **CV** (plain text) and a **credential passport**: NMC PIN, DBS
   details, a right-to-work confirmation, mandatory training with expiry dates, referees.
2. The engine pulls **jobs** from free job sources and normalises them into one shape.
3. Each job is **scored** against the CV, with the CV sentence that evidences each match.
4. A **supporting statement** is drafted for the job's person specification, by an LLM
   when one is configured, otherwise by a plain no-AI drafter.
5. A **Chrome extension** fills the application form inside the user's own browser.
   Sensitive fields wait for the user. The user stays in control of submitting.
6. **Interview practice**: a healthcare question bank and STAR-structure feedback.

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

With `OPENNJOB_DEMO_JOBS=true` (the default in `.env.example`) there are three fictional
sample jobs, so the whole flow can be tried with no API keys:

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

All data is held in memory. **It is lost when the API stops.**

### Test results at hand-over

Run from a clean checkout (`rm -rf node_modules`, then the four commands above) on
6 October 2026, Node 22.22.0, npm 10.9.4, Linux:

| Command | Result |
| --- | --- |
| `npm test` | 10 test files, 221 tests passed, 0 failed |
| `npm run test:e2e` | 32 tests passed, 0 failed (27 against the injected content script, 5 through the real loaded extension and real API) |

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
apps/extension/test/fixtures` and then open `http://localhost:8080/nhs-style-application.html`;
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
professional registration / PIN, DBS, criminal convictions or cautions, right to work /
visa / immigration, fitness to practise, safeguarding, health declarations, equality
monitoring, referees' details, or any "I declare / I confirm" statement. When unsure the
code classes a field as sensitive.

Rules that hold in every mode (each is covered by tests):

- A sensitive field is never written until the user confirms that field. It is outlined
  on the page so the user can see it is being held.
- **OpennJob never answers** convictions, fitness to practise, safeguarding, health or
  equality-monitoring questions, or "I declare" tick boxes. It stores no answers for
  them. The user answers those personally, every time.
- Right to work is only ever offered as "Yes", and only if the user stored that
  confirmation. A stored "no" never ticks or selects anything.
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
    src/matching.ts           scoring, eligibility, criteria extraction (LLM + fallback)
    src/statement.ts          supporting-statement prompt, no-LLM drafter
    src/policy.ts             THE SAFETY CORE: review / hybrid / auto rules
    src/fields.ts             form-field classification (sensitive? which data goes in?)
    src/interview.ts          question bank, STAR prompt, heuristic scorer
    src/passport.ts           training-expiry checks (injectable clock)
    src/llm.ts                LlmPort, AnthropicLlm, FakeLlm
    src/usage.ts              UsageMeter (ACU), in-memory meter, BitriPayBillingPort (seam)
    src/events.ts             EventBus, in-process implementation
    src/repository.ts         Repository interface, in-memory implementation
    src/sources/              Greenhouse, Lever, Ashby, Adzuna, Reed adapters, de-duplication
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

Every route except `GET /health` needs `Authorization: Bearer <OPENNJOB_API_TOKEN>`.

| Route | Purpose |
| --- | --- |
| `PUT /profile`, `GET /profile` | Contact details and CV text |
| `PUT /passport`, `GET /passport` | Credential passport; the reply includes training-expiry status |
| `POST /jobs/refresh` | Runs the configured job sources, de-duplicates, stores |
| `GET /jobs/matches?min=` | Jobs scored against the CV, with evidence; `min` is 0 to 100 |
| `POST /applications` | Creates a draft with a supporting statement (`{ jobId, mode }`) |
| `POST /applications/:id/confirm` | Records which sensitive fields the user confirmed (names, not values) |
| `POST /applications/:id/submitted` | Records that the form was submitted |
| `GET /applications`, `GET /applications/:id` | List / read |
| `POST /interview/feedback` | STAR feedback (`{ questionId or question, answer }`) |
| `GET /interview/questions?role=&category=` | The question bank |
| `GET /usage` | ACU usage records and totals |
| `GET /health` | Liveness, no auth |

`GET /applications/:id`, `GET /interview/questions`, `GET /usage` and `GET /health` were
added beyond the brief because the extension and a developer need them.

### How matching works

- Score = round(100 x matched weight / total weight); essential criteria weigh 2,
  desirable weigh 1. A criterion is met when any of its keywords appears in the CV,
  ignoring case.
- "Appears" means: starting at a word boundary. Keywords of four or more letters may be
  followed by an ending ("medication" matches "medications"); shorter ones (NMC, RN,
  HCA) must be whole words, so "RN" does not match "learn". This is slightly stricter
  than a plain substring test and is deliberate.
- `eligible` is false only when the job requires registration and no NMC PIN is stored.
  `POST /applications` refuses (HTTP 422) to draft for a job the user is not eligible for.
- OpennJob does not check an NMC PIN with the NMC. It stores what the user typed.

## What is real, what is stubbed

**Real and tested**

- All seven core modules, with unit tests.
- The NestJS API, with integration tests over HTTP (supertest).
- The extension's form scanning, field classification, filling, blocker detection and
  mode rules, tested in Chromium against the fixture forms.
- The complete chain in one test file (`real-extension.spec.ts`): the built API process,
  the unpacked extension loaded in Chromium, the popup, the content script injected by
  `chrome.scripting`, and a fixture form.
- `db/schema.sql` was applied to a throwaway PostgreSQL 16 instance and loads cleanly.
  Nothing reads or writes those tables.

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
| Criteria extraction without an LLM | Recognises about 25 healthcare terms. It will miss unusual criteria and cannot read nuance. |
| "Requires registration" detection | A heuristic on the job title and wording. It can be wrong in both directions. |
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

OpennJob handles personal data, and some of the most sensitive kinds.

- **CVs, contact details, NMC PINs, DBS certificate details and supporting statements
  are personal data.**
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

1. Check the five job-source adapters against the live APIs and their terms of use.
2. Make one real Anthropic call end to end; confirm the model name; review statement
   quality with real nurses' CVs (with their consent).
3. Real authentication and a `PostgresRepository`; encrypt the passport.
4. DPIA, consent screens and privacy notice, before any real user's data.
5. Try the extension on real forms, by hand, in hybrid mode only, with permission where
   a site's terms require it. Expect to extend the form coverage listed above.
6. Move the popup to a side panel so the user can see the form while confirming.
7. PDF and Word CV import.
8. Terms-of-use checks or partnerships for NHS Jobs and Trac.
9. BitriPay billing adapter and a real ACU rate card.
10. Keep auto mode switched off for real users until hybrid has a track record.
