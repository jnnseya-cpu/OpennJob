# Requirements traceability (OpennJob Build and Test Requirements)

Every requirement and required test case from the owner's "OpennJob Build and Test Requirements",
with what proves it in this repository. Status words:

- **Tested**: built, and the named tests pass in the evidence run below.
- **Partly**: built, but part of the requirement needs something no test here can supply.
- **Not done**: not built or not checked. The reason is given.

A test on fictional forms proves the code. It does not prove the product works on an employer's
site; only a supervised real submission does (section 7.3 of the requirements).

Paths: `api/` is `apps/api/test/`, `web/` is `apps/web/test/e2e/`, `ext/` is
`apps/extension/test/e2e/`, `core/` is `packages/core/test/`.

## Evidence run

6 October 2026, on the branch `claude/busy-fermat-9hhn11`, from the repository root:

| Command | Result |
|---|---|
| `npm run typecheck` | clean |
| `npm run test:pg` (vitest against a throwaway PostgreSQL 16) | 32 files, 781 passed, 0 failed, 0 skipped |
| `npm test` (no database) | 667 passed, 0 failed, 114 skipped (the PostgreSQL tests; not evidence for PostgreSQL) |
| `npm run test:pg -- npx playwright test` (after `npm run build`) | 87 passed, 0 failed, 0 skipped |
| `npx playwright test` (no database) | 86 passed, 0 failed, 1 skipped (the API process on PostgreSQL) |
| `npm run test:agent` (career-agent) | 125 tests, OK |

## 4.1 Accounts and profile

| ID | Status | Evidence |
|---|---|---|
| ACC-1 register, sign in, own data only | Tested | `api/auth.test.ts`, `api/isolation.test.ts` (every route), `web/web-app.spec.ts` |
| ACC-2 e-mail verified before any submission | Tested | `api/spec-p4.test.ts` (ACC-2), `ext/queue.spec.ts` (verifies through the dev mailbox before the queue runs), `web/account-flows.spec.ts` (banner, e-mailed link) |
| ACC-3 password reset by e-mail | Tested | `api/spec-p4.test.ts` (ACC-3: same reply for unknown addresses, one use, old sessions end), `web/account-flows.spec.ts` |
| ACC-4 export and delete everything | Tested | `api/account.test.ts`, `api/spec-p4.test.ts` (T-20), `web/web-app.spec.ts` |
| PRO-1 CV upload as PDF or Word, shown and editable | Tested | `api/spec-p4.test.ts` (PRO-1, real PDF and .docx fixtures), `web/account-flows.spec.ts` |
| PRO-2 languages, countries, cities | Tested | `core/preferences.test.ts` (T-02) |
| PRO-3 search types | Tested | `core/preferences.test.ts` (T-04) |
| PRO-4 passport fields per pack | Tested | `core/packs-fields.test.ts`, `ext/pack-forms.spec.ts` |

## 4.2 Discovery and matching

| ID | Status | Evidence |
|---|---|---|
| DIS-1 no feature depends on employers | Tested | `api/spec-p4.test.ts` (T-19) |
| DIS-2 adapters checked against recorded live responses | **Not done** | The job boards could not be reached from the build environment. Fixtures are still written from public documentation. |
| DIS-3 contract type, country, city, language, pack, origin on every job | Tested | `core/preferences.test.ts`, `core/sources.test.ts`, `api/repository.contract.ts` |
| DIS-4 discovery daily for each active account | Tested | `api/spec-p4.test.ts` (DIS-4: 06:00 London, once per day across instances). Runs only with `OPENNJOB_SCHEDULER=true`. |
| DIS-5 terms check recorded in docs/sources.md | Partly | `core/sources-register.test.ts` fails if an adapter has no row. **No source's terms have been checked.** |
| DIS-6 employers may post; works with zero | Tested | `api/spec-applying.test.ts`, `api/spec-p4.test.ts` (T-19) |
| MAT-1 essential weighted twice | Tested | `core/matching.test.ts` |
| MAT-2 80% floor | Tested | `api/spec-applying.test.ts` (T-01) |
| MAT-3 out of scope or missing credential never applied to | Tested | `core/matching.test.ts`, `api/api.test.ts` |
| MAT-4 every criterion met or gap, with the evidence | Tested | `api/api.test.ts`, `web/web-app.spec.ts` (review screen) |

## 4.3 Truthful tailoring

| ID | Status | Evidence |
|---|---|---|
| TAI-1 statements use only CV, passport and languages | Tested | `core/statement.test.ts`, `core/preferences.test.ts` (T-03) |
| TAI-2 tailored CV adds nothing | Tested | `core/tailoring.test.ts` |
| TAI-3 trace check holds failures | Tested | `core/tailoring.test.ts` (T-05), `api/spec-applying.test.ts` |
| TAI-4 French documents for French adverts | Tested | `core/french.test.ts` |
| TAI-5 gaps listed, not written around | Tested | `core/statement.test.ts`, `api/api.test.ts` |
| TAI-6 exact documents stored, encrypted | Tested | `api/spec-applying.test.ts` (T-06), `api/repository.contract.ts` (PostgreSQL, encrypted columns) |

## 4.4 Applying

| ID | Status | Evidence |
|---|---|---|
| APP-1 three modes | Tested | `core/policy.test.ts` (sweep), `ext/real-extension.spec.ts` |
| APP-2 standing authorisation, dated, revocable | Tested | `api/spec-queue.test.ts` (APP-2, T-09), `web/account-flows.spec.ts` (WEB-3) |
| APP-3 queue without per-application approval | Tested on fictional forms | `api/spec-queue.test.ts` (T-07), `ext/queue.spec.ts`. Never run on a real employer site. |
| APP-4 sensitive field never filled before confirmation | Tested | `core/policy.test.ts`, `ext/real-extension.spec.ts` |
| APP-5 CAPTCHA or login wall stops with a reason | Tested | `ext/real-extension.spec.ts`, `ext/queue.spec.ts` (T-13) |
| APP-6 never twice | Tested | `api/spec-applying.test.ts` (T-10), `api/config.test.ts` |
| APP-7 submitted only with a receipt | Tested | `api/spec-queue.test.ts` (T-11), `web/account-flows.spec.ts` (receipt in the tracker) |
| APP-8 daily limit | Tested | `api/spec-applying.test.ts` (T-12) |
| APP-9 one adapter per system, enabled after a supervised real submission | Partly | `api/spec-queue.test.ts` (off until the operator records a terms check and a supervised submission). **No real system has been enabled: no supervised real submission has been made.** |
| APP-10 person's pause and operator's pause | Tested | `api/spec-queue.test.ts` (T-22), `web/account-flows.spec.ts` |
| SCR-1 ordinary answers stored once | Tested | `core/screening.test.ts`, `ext/queue.spec.ts` (T-14), `web/account-flows.spec.ts` |
| SCR-2 unknown question holds; answer saved | Tested | `api/spec-queue.test.ts` (T-14) |
| SCR-3 declarations never stored | Tested | `core/screening.test.ts`, `api/spec-queue.test.ts`, `web/account-flows.spec.ts` (refused on save) |

## 4.5 Tracking, reporting and interview preparation

| ID | Status | Evidence |
|---|---|---|
| REP-1 tracker statuses | Tested | `web/web-app.spec.ts`, `web/account-flows.spec.ts` |
| REP-2 09:00 London report, quiet days included | Tested | `api/spec-p4.test.ts` (T-15 on both sides of both 2026/27 clock changes, T-16). **No report has reached a real inbox.** |
| REP-3 no CV text or declaration content | Tested | `api/spec-p4.test.ts` (T-17) |
| REP-4 SPF and DKIM; the person can pause it | Partly | Pause: `api/spec-p4.test.ts`, `web/account-flows.spec.ts`. **SPF and DKIM: not done**, no sending domain exists. |
| INT-1 interview from the advert and the documents sent | Tested | `api/spec-p4.test.ts` (T-18), `web/account-flows.spec.ts` |
| INT-2 pack questions, STAR feedback | Tested | `core/interview.test.ts`, `web/web-app.spec.ts` |

## 4.6 Candidate web app

| ID | Status | Evidence |
|---|---|---|
| WEB-1 Next.js 14 app on the existing API | Tested | `web/web-app.spec.ts`, `web/same-origin.spec.ts`, `web/account-flows.spec.ts` |
| WEB-2 400 px, no sideways scrolling | Tested | `web/web-app.spec.ts` (390 px viewport, `noSideScroll`), all web tests run at 390 px |
| WEB-3 authorisation screen states the scope, can revoke | Tested | `web/account-flows.spec.ts` |
| WEB-4 simulated or unavailable things labelled | Tested | Sample jobs, sandbox e-mail, drafts without AI and built-in interview feedback are labelled; `web/web-app.spec.ts` checks the sample-jobs and no-AI labels |

## 5. Safety and data protection

| ID | Status | Evidence |
|---|---|---|
| SAF-1 no declaration answered | Tested | `core/policy.test.ts`, `core/screening.test.ts`, `ext/queue.spec.ts` |
| SAF-2 no submission with a sensitive field | Tested | `core/policy.test.ts` (about 68,000 combinations), `api/spec-queue.test.ts` (T-08) |
| SAF-3 no CAPTCHA solving or evasion | Tested | `ext/real-extension.spec.ts`; nothing of the kind exists in the code |
| SAF-4 no automation against forbidding sites | Partly | `docs/sources.md`; the extension's per-site permission is granted by the person. No terms check recorded. |
| SAF-5 no personal data in logs, e-mails, errors | Tested | `api/spec-p4.test.ts` (T-17), `web/web-app.spec.ts` and `web/account-flows.spec.ts` (console and API log) |
| SAF-6 user-scoped queries, every route in the isolation test | Tested | `api/isolation.test.ts` (fails if a route is not listed) |
| SAF-7 policy.ts changes need sign-off | Held | `packages/core/src/policy.ts` unchanged in phases 4 and 5 |
| DP-1 consent versions recorded | Tested | `api/auth.test.ts` |
| DP-2 personal data encrypted at rest | Tested | `api/crypto.test.ts`, `api/repository.contract.ts` (PostgreSQL) |
| DP-3 impact assessment | **Not done** | Needs a qualified person. |
| DP-4 privacy policy, terms, ICO | **Not done** | Needs a qualified person. |
| DP-5 retention with automatic deletion | Tested | `api/spec-p4.test.ts`, `api/repository.contract.ts`. Off until `OPENNJOB_RETENTION_DAYS` is set; the period itself is the owner's decision. |
| DP-6 per-country legal check | **Not done** | Needs a qualified person. |

## 6. Non-functional requirements

| ID | Status | Evidence |
|---|---|---|
| NFR-1 refuses production start without secrets | Tested | `api/server.test.ts`, `api/auth.test.ts` |
| NFR-2 shared rate limit | Tested | `api/spec-p4.test.ts` (two app instances over one store) |
| NFR-3 matches for 5,000 jobs under 1 s | Tested | `api/spec-p4.test.ts`, in memory on the build machine. Not measured on production hardware or PostgreSQL. |
| NFR-4 operator alert within 15 minutes | Tested | `api/spec-p4.test.ts` (alert at the failed run; the scheduler checks every minute). No real operator inbox. |
| NFR-5 LLM ceiling | Tested | `api/spec-applying.test.ts` (T-21) |
| NFR-6 daily backup and a timed restore | **Not done** | `deploy/` describes backups; none has been restored. |
| NFR-7 WCAG 2.2 AA | **Not done** | No audit. |
| NFR-8 Chrome, Safari, Edge, Firefox | **Not done** | Tested in Chromium only. |
| NFR-9 model name from configuration | Partly | `api/config.test.ts`; not confirmed against the provider's current list (no key). |
| NFR-10 London time across clock changes | Tested | `api/spec-p4.test.ts` (T-15), `core/tailoring.test.ts` (daily limit) |

## 7.2 Required test cases

| Test | Where | Status |
|---|---|---|
| T-01 | `api/spec-applying.test.ts` | Passes |
| T-02 | `core/preferences.test.ts` | Passes |
| T-03 | `core/preferences.test.ts` | Passes |
| T-04 | `core/preferences.test.ts` | Passes |
| T-05 | `core/tailoring.test.ts`, `api/spec-applying.test.ts` | Passes |
| T-06 | `api/spec-applying.test.ts`, `api/repository.contract.ts`, `ext/queue.spec.ts` | Passes |
| T-07 | `api/spec-queue.test.ts`, `ext/queue.spec.ts` | Passes on fictional forms |
| T-08 | `api/spec-queue.test.ts`, `ext/queue.spec.ts` | Passes |
| T-09 | `api/spec-queue.test.ts` | Passes |
| T-10 | `api/spec-applying.test.ts` | Passes |
| T-11 | `api/spec-queue.test.ts`, `ext/queue.spec.ts` | Passes |
| T-12 | `api/spec-applying.test.ts`, `api/spec-queue.test.ts` | Passes |
| T-13 | `api/spec-queue.test.ts`, `ext/queue.spec.ts` | Passes |
| T-14 | `api/spec-queue.test.ts`, `ext/queue.spec.ts` | Passes |
| T-15 | `api/spec-p4.test.ts` | Passes (simulated clock; no real inbox) |
| T-16 | `api/spec-p4.test.ts` | Passes |
| T-17 | `api/spec-p4.test.ts` | Passes |
| T-18 | `api/spec-p4.test.ts`, `web/account-flows.spec.ts` | Passes |
| T-19 | `api/spec-p4.test.ts` | Passes |
| T-20 | `api/spec-p4.test.ts` | Passes |
| T-21 | `api/spec-applying.test.ts` | Passes |
| T-22 | `api/spec-queue.test.ts`, `ext/queue.spec.ts` | Passes |

## What settles Gate 1, and is not here

One job source and one application adapter verified live, the LLM key and model confirmed, an
e-mail sender configured, one confirmed real employer submission with a receipt, and one 09:00
report delivered to a real inbox. None of these can be produced from this repository's tests.
