# Launch readiness review, 8 October 2026

Scope: the repository at the commit that adds this file (branch `claude/busy-fermat-9hhn11`), tested in a
cloud container with a throwaway PostgreSQL 16 and Chromium. The production server (one Hostinger VPS,
`opennjob.com`) and its database, backups, logs and DNS were **not** accessible from the test environment.

## 1. Verdict

**NO-GO for a public launch.** The service is suitable only for the current invite-only pilot (one
applicant, registration restricted by `OPENNJOB_REGISTRATION_ALLOWLIST`), under the restrictions in section 16.

Reasons, in order: the core promise (an application submitted automatically on a real employer site) has
never completed once in production; backups have never been restored; rollback is automatic but untested;
there is no load test, no alerting test and no external monitoring; privacy and processor agreements
(AI provider, hosting) are not in place; the AI account had run out of credit during the review.

## 2. Technology stack identified

| Area | What is used |
|---|---|
| Frontend | Next.js 14.2.35 (App Router, `output: 'export'`, static files), React 18.3.1 |
| Backend | NestJS on Node 22 (`apps/api`), zod validation, helmet |
| Database | PostgreSQL 16, versioned SQL migrations (`db/migrations`, 007 files), AES-256-GCM field encryption |
| Authentication | Own: bcrypt (cost 12), HS256 JWT access tokens (1 h), rotating refresh tokens (60 days, "keep me signed in"), e-mail verification, password reset, DB-backed rate limits |
| Browser agent | Chrome MV3 extension (`apps/extension`): fills forms, multi-step Workday/SuccessFactors queue |
| AI | Anthropic Claude (default) or Gemini/OpenAI through `OPENNJOB_LLM_PROVIDER` |
| Job sources | Adzuna, Reed, Jooble, ReliefWeb, Greenhouse/Lever/Ashby boards, employer Workday/SuccessFactors careers sites |
| E-mail | Resend or SMTP |
| Hosting | One VPS: Docker Compose (`docker-compose.prod.yml`), Caddy (TLS, headers), PostgreSQL, a backup container; auto-update timer with health check and rollback |
| Payments | None |
| Separate tool | `career-agent/` (Python, single user), not part of OpennJob |

## 3. Files removed or consolidated

| File | Why |
|---|---|
| `docs/WEB-APP-BRIEF.md` | Unreferenced; described a web app "to build next" that now exists |
| `sameCity` in `packages/core/src/geo.ts` | Exported, used nowhere |
| `docker-compose.yml` | Kept for local use; now passes `OPENNJOB_REGISTRATION_ALLOWLIST` like production |
| `deploy/hostinger-vps.md` | Corrected the migration count it tells the operator to expect |

Not removed (decisions for the owner): `deploy/vercel.md` and `deploy/gcp-cloud-run.md` (documented
alternatives, never run), the old non-search Adzuna/Reed adapters (used only by tests),
`BitriPayBillingPort` (billing placeholder), `docs/prototype/`, old screenshots.

## 4. Dependencies

* Package manager: npm workspaces, one `package-lock.json`. Node 22 in the Docker image, `engines: >=20`.
* `mammoth` (Word CV reader) pulled `argparse@1` → `sprintf-js` (DoS advisory) for its command-line tool
  only. The library never loads it; an `overrides` entry moves it to `argparse@2`. 3 moderate advisories gone.
* Remaining `npm audit --omit=dev`: **next (critical) and its bundled postcss (high)**. Not reachable: the web
  app is a static export served by Caddy; no Next.js server, image optimiser, server components or rewrites
  run in production, and postcss only processes the project's own CSS at build time. Upgrading to Next 16 is a
  major change and is deferred, with this justification.

## 5. Build

`npm run typecheck`: clean. `npm run build`: clean (core, API, extension, static web). No `@ts-ignore`, no
disabled checks were added.

## 6. Defects found and fixed in this review

| ID | Severity | Defect | Fix | Test |
|---|---|---|---|---|
| D1 | P1 | A job pasted through "Apply to a job you found" was stored in the shared job table: other accounts saw it in Matches, the agent could prepare it for them, and their applications could be moved onto it (and e-mailed to an address it names). Cross-account leak. | Pasted jobs (`source: 'link'`) are excluded from every other account's matches, agent run and copy-matching | `isolation.test.ts`, both stores |
| D2 | P3 | Job links from outside sources were stored unchecked; a `javascript:` link would be rendered as a link | `normaliseJob` keeps only `http(s)` links | existing source tests |
| D3 | P3 | PDF CV parsing read every page of an uploaded file | At most 30 pages are read | build + CV tests |
| D4 | P3 | The provider's raw error (request ids, account wording) was copied into the person's application warnings | Plain-language cause only (`llmFailureWarning`) | `statement.test.ts` |
| D5 | P3 | With the AI failing, every agent run closed and re-made the same 20 applications | Not retried within 12 hours of a failed AI attempt | API suite |
| D6 | P2 | An application held on an unanswered form question could not be answered anywhere in the app | Answer box on the review page, calling `POST /applications/:id/answer` | API route tested; UI not covered by an automated test |
| D7 | P3 | Wording said declarations are always the person's, contradicting owner decision OD-6 (extension popup, mode help, account page, landing page) | Reworded to what the code does | e2e suite |
| D8 | P3 | The 80% threshold was shown as fixed; the real bar can differ | The web app loads the real bar on start | e2e suite |
| D9 | P4 | `.env.example` turned fictional demo jobs on | Off | — |
| D10 | P4 | `notifications/preview` query accepted unknown keys | `.strict()` | API suite |

Second pass (same day):

| ID | Severity | Defect | Fix | Test |
|---|---|---|---|---|
| D11 | P4 | A token without the password-version claim was not checked against a password reset | The claim is required; a token without it is refused | `auth.test.ts` |
| D12 | P4 | A spent refresh token used again did not end the account's other kept sign-ins | Reuse more than a minute after rotation revokes every refresh token of the account (a second tab at the same moment does not) | `session.test.ts`, repository contract (both stores) |
| D13 | P4 | `/notifications/test` had no per-person limit and reaches a real inbox | 5 an hour per person, then 429 | `notifications.test.ts` |
| D14 | P4 | E-mail subject and sender name were not flattened; a job title with a line break reached the mail header | Line breaks and tabs become spaces (Resend and SMTP) | `notifications.test.ts` |
| D15 | P4 | SMS, push and WhatsApp could be switched on with nothing behind them | Disabled until connected (one already on can still be switched off) | e2e suite |
| D16 | P4 | Demo jobs could run in production without notice; README called them the default | Start-up warning in production; README corrected | — |

Earlier the same day (separate commits): sentences the CV does not support are now taken out instead of
holding the application; the queue names why nothing is ready; running the agent in Auto takes over
applications prepared in another mode.

## 7. Security review (code reading; no penetration test against production)

Verified correct: password hashing and policy, timing-safe login, JWT algorithm/issuer/audience/expiry,
one-time tokens (hashed, single use, expiring), rate limits on every credential route, user-scoped queries
and an isolation test covering every route, timing-safe operator/employer keys, `.strict()` request bodies,
parameterised SQL, no server-side fetch of user-supplied URLs, bearer tokens (no cookies, no CSRF surface),
CORS allow-list, helmet + Caddy headers (HSTS, nosniff, frame denial, no-referrer), personal data kept out of
logs, field encryption at rest, extension writes page text with `textContent` only.

Open (not fixed, documented):

* P3: the 60-day refresh token is kept in `localStorage` while the site CSP allows inline scripts; an XSS
  would expose it. Fix: nonce/hash CSP or an HttpOnly cookie for refresh.
  Not fixed in this pass: a hash-based CSP has to be generated from each build into the Caddy
  configuration, which could not be run here, and a wrong CSP blanks the site without tripping the
  API health-check rollback.
* P4: per-e-mail sign-in limit lets someone lock a known address out for 15 minutes.
* P4: `/health` shows the deployed commit.

## 8–12. Areas not tested (BLOCKED or NOT TESTED)

| Area | Status | Why |
|---|---|---|
| Real automatic submission on an employer site | NOT TESTED / never achieved | needs the person's sign-in on the employer site; no supervised run has completed |
| Backup restoration | BLOCKED | no server access; never restored |
| Rollback | PARTIAL | `deploy/auto-update.sh` rolls back on a failed health check; never exercised deliberately |
| Load, stress, soak | NOT TESTED | no production-like environment; one VPS, no targets defined |
| Monitoring and alerts | PARTIAL | operator e-mail alerts exist in code; no uptime monitor, no alert test |
| Mobile/PWA | PARTIAL | layouts tested at phone width in e2e (no horizontal scroll); no PWA manifest or service worker; the extension needs desktop Chrome, so a native/hybrid app is NO-GO until the web flow is proven |
| Accessibility | PARTIAL | labels and keyboard use covered by tests; no audit with a screen reader |
| Payments | NOT APPLICABLE | none |
| Privacy | PARTIAL | export and deletion of an account are tested; no processor agreements with the AI provider or host; privacy notice "in preparation" |
| AI quality evaluation | NOT TESTED | no evaluation set; outputs are trace-checked against the CV |

## 13. Tests run for this review

* `npm run typecheck` — pass.
* `npm run test:pg` — 54 files, 950 tests, 0 failed, 0 skipped (PostgreSQL 16 throwaway database), after the second pass.
* `npm run test:e2e` — 115 passed, 1 skipped (the skipped one needs PostgreSQL in the web e2e run), after the second pass.
* `npm audit --omit=dev` — 2 advisories, justified in section 4.

## 14–17. Required actions and launch configuration

Before any wider launch (owner / operator):

1. Complete one supervised automatic submission on a real Workday or SuccessFactors site and record the receipt.
2. Restore a backup into an isolated database and record the time it took.
3. Add an external uptime check on `/api/health` and confirm the operator alert e-mail arrives.
4. Top up or replace the AI account; set a spending limit at the provider.
5. Data processing agreements with the AI provider and the host; publish the privacy notice and terms.
6. Move the refresh token out of `localStorage` or tighten the CSP (P3 above).

Launch configuration now: invite-only (`OPENNJOB_REGISTRATION_ALLOWLIST`), demo jobs off, automatic
submission only on systems the operator switched on, standing authorisation per person, daily submission
limit, operator pause available (`deploy/enable-system.sh`), stop everything with `./oj down`.

**This release is not approved for public launch.**
