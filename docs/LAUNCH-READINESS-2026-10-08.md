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

Third pass (same day):

| ID | Severity | Defect | Fix | Test |
|---|---|---|---|---|
| D17 | P3 | Site policy allowed every inline script, and the kept sign-in is in `localStorage`: one injected script could read it | Each page carries its own policy allowing only its own inline scripts by SHA-256 (`apps/web/scripts/csp.mjs`, run by `npm run build`); the browser enforces it as well as Caddy's header | e2e: every page has a hash-only policy; no screen reported a blocked script; an injected script does not run |
| D18 | P2 | Rolling back across a release that added a migration could not work: the older code refused the newer schema, so an automatic rollback left the site down | During a rollback (`OPENNJOB_ALLOW_NEWER_SCHEMA=1`, set by `auto-update.sh` and `rollback-drill.sh`) older code accepts migrations newer than all of its own; a gap is still refused | `migrations.test.ts` (PostgreSQL); built-process run: migrate refused without the flag, accepted with it, API healthy on the newer schema |
| D19 | P3 | Auto-update rolled back only on an API failure; a broken web app passed | Health check also requires the sign-in page with its scripts | `bash -n`; not run on the server |
| D20 | P4 | Wrong passwords for a known e-mail address from one machine locked its owner out everywhere for 15 minutes | Counted per account and client address; a 10x higher limit per account across all addresses still stops guessing from many machines | `auth.test.ts` (owner elsewhere signs in; distributed guessing still stopped) |
| D21 | P4 | `/health` told anyone which commit was running | Version moved to `GET /health/version`, signed-in only (Account page uses it) | API suite, isolation test |
| D22 | P4 | `/agent/status` made about a dozen database reads one after another (p50 270 ms under load) | Independent reads run together | load test below |

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

* Residual (P4): the kept sign-in is still in `localStorage`. With the hash-only script policy (D17) an
  injected script no longer runs, which is what made this exploitable; an HttpOnly cookie would remove
  it entirely but needs the API and the site on one origin in every set-up (tests run them apart).

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

## 12a. Operational drills (third pass)

| Drill | Tool | Result here | On the server |
|---|---|---|---|
| Backup restore | `deploy/restore-drill.sh` | PASS against PostgreSQL 16 (psql mode): all 17 tables present, counts equal, migration 007, restored in under 1 s; a truncated dump is refused (FAIL, exit 1) | NOT RUN: Docker mode (throwaway `postgres:16`, no network) could not run here (no Docker daemon). Run it: `bash deploy/restore-drill.sh`; result in `backups/restore-drill.log` |
| Rollback | `deploy/rollback-drill.sh` | Rollback onto a newer schema proven with the built API (D18) | NOT RUN: back one commit and forward again, both health-checked and timed; result in `backups/rollback-drill.log` |
| Load | `scripts/load-test.mjs` | PASS, 50 people for 30 s, built API + PostgreSQL in this container: 19,011 requests, 633/s, p50 53 ms, p95 228 ms, p99 280 ms, 0 errors, 212 MB | NOT RUN against production (needs a test account's token; keep it short) |
| Stress | same, 200 people | 18,470 requests, 613/s, p95 972 ms, p99 1,067 ms, **0 errors**, 228 MB. One API process saturates at about 620 requests a second; latency rises, nothing fails. The pilot target (p95 under 800 ms) holds to roughly 150 people at once | — |
| Outside uptime | `.github/workflows/uptime.yml` (every 10 min: API health, sign-in page, certificate 14+ days) | NOT RUN: the container's network blocks opennjob.com, and GitHub runs schedules only from `main` | Merge to `main` (or copy the file there); GitHub e-mails the owner when a run fails |
| Data-processing agreements | — | NOT APPLICABLE to code | Anthropic publishes a DPA that is part of its Commercial Terms (anthropic.com/legal/data-processing-addendum); Hostinger publishes one at hostinger.com/legal/dpa. Read, accept and keep a dated copy of each; list both as subprocessors in the privacy notice |
| AI credit | `deploy/check-ai.sh` | — | Top up at console.anthropic.com and set a monthly spend limit there; then `bash deploy/check-ai.sh` must say "OK the AI answered" |
| Real automatic submission | `deploy/supervised-test.md` | — | Needs the person signed in on the employer's site, a right-to-work record in Profile, and AI credit; then one supervised run, receipt recorded |

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
