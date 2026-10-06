# CLAUDE.md

Guidance for Claude Code working in this repository. Read `README.md` for the full
description and `GO-LIVE.md` for what is and is not finished.

## What this is

OpennJob is a job-application assistant. A person stores a CV, preferences and a
"credential passport"; the system finds jobs, scores them against the CV, drafts
supporting statements, and a Chrome extension fills application forms in the person's
own browser. It handles sensitive personal data and acts on people's behalf in formal
applications, so the safety rules below matter more than any feature.

It is a tested codebase, not a launched product. It has never been used on a real
employer's website. Do not describe it as production-ready.

## Commands

All from the repository root. Node 20+ (built on 22), npm workspaces.

```bash
npm install                 # install (npm ci in CI)
npm run build               # packages/core, then apps/api, then apps/extension
npm run typecheck           # tsc --noEmit for all three, tests included
npm test                    # vitest: unit + API tests. PostgreSQL tests are SKIPPED without DATABASE_URL
npm run test:pg             # the same, against a throwaway PostgreSQL it starts itself (needs initdb/pg_ctl)
npm run test:e2e            # builds, then Playwright: the extension in Chromium + the built API process
npm run migrate             # apply db/migrations to DATABASE_URL (needs npm run build first)
npm start                   # run the API: node apps/api/dist/main.js (needs npm run build first)
docker compose up --build   # postgres + one-shot migrate + api on 127.0.0.1:3000 (needs .env)

npx vitest run apps/api/test/auth.test.ts          # one file
npx vitest run -t "refuses a second account"       # by test name
npx playwright test apps/extension/test/e2e/real-extension.spec.ts
DATABASE_URL=postgres://... npm test               # run the PostgreSQL tests against your own database
npm run test:pg -- npm run test:e2e                # e2e with a throwaway PostgreSQL
```

- Do not run `playwright install` where Chromium is pre-installed
  (`PLAYWRIGHT_BROWSERS_PATH`); `@playwright/test` is pinned to match that browser.
- `npm test` needs no build (vitest aliases `@opennjob/core` to the TypeScript source).
  The e2e tests need the build; `npm run test:e2e` does it.
- A test run is only complete evidence for PostgreSQL when it says 0 skipped. Skipped
  means the PostgreSQL tests did not run; say so, do not round it up to "passed".
- PostgreSQL tests create a schema named `test_<random>` each, and drop it. They never
  write to `public`.

## Architecture map

```
packages/core/                Pure TypeScript domain logic. No framework, no I/O beyond fetch ports.
  src/policy.ts                 THE SAFETY CORE: decide() for review / hybrid / auto
  src/fields.ts                 classifies form fields: sensitive or not, and what may fill them
  src/matching.ts statement.ts interview.ts packs.ts preferences.ts geo.ts languages.ts passport.ts
  src/repository.ts             Repository interface + InMemoryRepository
  src/usage.ts events.ts llm.ts UsageMeter, EventBus, LlmPort (+ fakes)
  src/sources/                  job-source adapters (response shapes UNVERIFIED against live APIs)
  src/browser.ts                the subset bundled into the extension (policy + fields)
apps/api/                     NestJS REST API
  src/main.ts                   process entry: start, SIGTERM/SIGINT graceful shutdown
  src/server.ts                 startServer(env): start-up checks, migration check, wiring
  src/http.ts                   createApp(): helmet, CORS allow-list, body limit, request log (tests use it too)
  src/deps.ts                   config from env, startupProblems(), createDefaultDeps() (Postgres if DATABASE_URL)
  src/auth.ts                   password rules, bcrypt, JWT sign/verify, RateLimiter
  src/auth.guard.ts             AccessTokenGuard (global), @Public, @EmployerRoute, @CurrentUser, AuthRateLimitGuard
  src/account.service.ts        register, login, export, delete
  src/services.ts               everything else; every method takes userId first
  src/controllers.ts schemas.ts routes and zod validation
  src/postgres.ts               PostgresRepository, PostgresUsageMeter
  src/crypto.ts                 AES-256-GCM field cipher (OPENNJOB_DATA_KEY)
  src/migrations.ts migrate-cli.ts   versioned SQL migrations
  src/logging.ts                JSON logger, request log, SafeExceptionFilter
  test/                         vitest (*.test.ts); test/e2e/*.spec.ts runs the built process under Playwright
apps/extension/               Chrome MV3 extension, bundled by esbuild into dist/
  src/agent/                    scan, blockers (CAPTCHA / login wall), fill, apply the policy
  src/popup/                    popup UI: API address, sign-in, mode, scan, fill
  test/fixtures/                fictional application forms
  test/e2e/                     Playwright tests
db/migrations/                NNN_name.sql, applied in order, tracked in schema_migrations
deploy/gcp-cloud-run.md       Cloud Run + Cloud SQL + Secret Manager steps (from memory, not executed)
Dockerfile docker-compose.yml .github/workflows/ci.yml .env.example
```

Data flow for a request: `AccessTokenGuard` verifies the JWT and that the account still
exists, and puts the user id on the request. Controllers read it with `@CurrentUser()`
and pass it to the service. The service passes it to the `Repository`. Nothing reads a
user id from a body, query or path.

## Non-negotiable rules

These are product rules, not style. Do not weaken them, and do not weaken the tests that
hold them, whatever a task seems to ask. If a request conflicts with one, stop and say so.

1. **Never answer a declaration for the user.** Convictions and cautions, security
   clearance and vetting, visa sponsorship / work permit / work authorisation, conflict
   of interest, fitness to practise, safeguarding, health, equality monitoring, and any
   "I declare / I confirm" box are answered by the person, every time. The code holds no
   fill value for them and must not gain one. Do not store those answers.
2. **A sensitive field is confirmed by the user before it is written. It is never
   auto-filled.** In every mode. Bulk "tick all" exists only for ordinary fields.
3. **Auto mode never submits a form that has any sensitive field**, even after the user
   has confirmed those fields. It submits only a form with no sensitive field, at least
   one field, and no empty required field. `review` and `hybrid` never submit.
4. **No CAPTCHA solving and no bot-evasion.** On a CAPTCHA or a login wall the agent
   stops and says why. No proxy rotation, fingerprint spoofing, stealth plugins, headless
   detection workarounds, or anything meant to get past a site's defences.
5. **No automation against a site whose terms forbid it.** No scrapers or automated
   access for NHS Jobs, Trac, LinkedIn, Indeed or any other site without a terms-of-use
   check or a partnership. A new job source or target site needs that check first.
6. **Never log or commit personal data.** No CV text, passport values, statements,
   contact details, passwords or tokens in logs, events, error messages, test snapshots
   or the repository. Event payloads carry ids and counters only. Every sample person,
   CV and employer in code, tests and docs is clearly fictional (`example.org`, 07700
   900xxx numbers, "(fictional)"). No real secrets in the repository, ever; `.env` is
   git-ignored and `.env.example` holds no values.
7. **Every query on personal data is scoped by the authenticated user id.** A new route
   must be added to `apps/api/test/isolation.test.ts` (it fails if a route is missing).
8. **Be honest about what was verified.** If something was not run, say it was not run.
   Do not mark anything in `GO-LIVE.md` as done without a test or a real-world check.

The decision logic is one pure function, `decide()` in `packages/core/src/policy.ts`,
with a sweep test over about 68,000 combinations. The extension bundles that same file.
Changing it changes what the product does to people's applications: treat any edit there
as needing explicit sign-off from the owner.

## Conventions

- TypeScript strict, `noUncheckedIndexedAccess`. No `any`; no non-null `!` in `src/`.
- `packages/core` imports no framework and nothing from `apps/`. Database and HTTP code
  lives in `apps/api`.
- NestJS: explicit `@Inject(...)` on every constructor parameter; zod (`ZodPipe`), not
  class-validator. The test transpiler does not emit decorator metadata.
- Request schemas are `.strict()`: unknown keys are a 400. Keep it that way.
- Collaborators come in through `OpennJobDeps` (`deps.ts`); tests swap in fakes with
  `createTestApp({ ... })`. Time comes from `deps.clock`, ids from `deps.newId`.
- Persistence goes through the `Repository` interface only. A change to it must be made
  in both implementations and covered in `apps/api/test/repository.contract.ts`, which
  runs against both.
- Schema changes are a new file in `db/migrations/`. Never edit an applied migration:
  the runner checks checksums and refuses.
- New personal-data columns are encrypted through `FieldCipher` with a context string
  that names the column and the user.
- Logging goes through `deps.logger` with a fixed set of fields. Never log a request
  body, a query string, a header or an error message from a driver.
- Tests: vitest for unit and API (`supertest` against `createApp`), Playwright for the
  extension and the built process. Add tests with the change. Do not skip or delete a
  test to get green; fix the code or say why the test is wrong.
- Extension: page-derived text goes into the popup with `textContent` only. Permissions
  stay at `activeTab`, `scripting`, `storage`.
- Plain British English in docs and messages. No marketing language.
- Commits: one logical change, imperative subject. Do not push unless asked.

## Next task
The candidate web app. Read `docs/WEB-APP-BRIEF.md` and open `docs/prototype/opennjob-demo.html` first.
