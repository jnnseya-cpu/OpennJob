# Evidence Ledger

Statuses: PASS · FAIL · PARTIAL · NOT TESTED · N/A. Environment: checked-out repo + in-process API (supertest, fake deps), fictional data only. RC `34ad783`.

## Build & code quality
| ID | Check | Command | Result |
|----|-------|---------|--------|
| BLD-1 | Production build | `npm run build` | PASS — exit 0, static export, CSP on 24 pages |
| BLD-2 | Typecheck (all workspaces) | `npm run typecheck` | PASS — exit 0 (after fixing a real regression) |
| BLD-3 | Test suite | `npm test` | PASS — 864→881 tests pass, 128 skipped (Postgres, no DATABASE_URL), 0 suppressed |
| BLD-4 | Secret scan (tracked files) | `git ls-files` + regex | PASS — `.env` git-ignored; only `.env.example` tracked; no hard-coded secrets in src |
| BLD-5 | Suppression hunt | grep `any`/`@ts-ignore`/`eslint-disable`/console | PASS — only 3 justified+commented eslint-disables; no `any` type; no console in web; 0 TODO/FIXME in src |

## Dependency / CVE audit
| ID | Finding | Result |
|----|---------|--------|
| DEP-1 | Next.js criticals (Image Optimizer / RSC DoS) | N/A — web is a static export; no Next server runs in production |
| DEP-2 | vitest / tinypool critical | N/A — dev/test only, never shipped |
| DEP-3 | postcss high | Build-time only, operates on own trusted CSS |
| DEP-4 | Zod oversized-collection DoS (high) | PARTIAL — real but bounded by body-size limit + auth + rate-limit; full fix = Zod 4 (major), recommended as planned upgrade |

## Security — adversarial (17 cases, `launch-audit-adversarial.test.ts`)
| ID | Attack | Result |
|----|--------|--------|
| SEC-1 | 48 protected routes, no token | PASS — 401 |
| SEC-2 | Garbage/empty/tampered/`alg:none`/wrong-secret/expired/deleted-account tokens | PASS — 401, correct code, no stack leak |
| SEC-3 | IDOR: B reads/writes/deletes A's applications/queue (13 routes) | PASS — 404, no A data leaked, A untouched |
| SEC-4 | Identity injection via body/query/`X-User-Id` header | PASS — body 400 (.strict), query/header ignored |
| SEC-5 | B reads A profile/passport/screening/usage/notifications/authorisation | PASS — 404 / B's own empty state |
| SEC-6 | Account deletion with another user's password | PASS — deletes self only |
| SEC-7 | register/login fuzz: missing/null/wrong-type/extra-key/SQLi/NoSQLi/XSS/JNDI | PASS — 400/401/403, never created, no 5xx |
| SEC-8 | Oversized body / malformed JSON | PASS — 413 / 400, not 500 |
| SEC-9 | 2xx for failed business op (confirm/submit on bad id; ineligible job) | PASS — 404 / 422 |
| SEC-10 | Rate limit on auth routes | PASS — 4th login → 429 + Retry-After |
| SEC-11 | Stack trace / driver message / secret in any response | PASS — none |

## Data & privacy
| ID | Check | Result |
|----|-------|--------|
| DAT-1 | Repository contract (both Postgres + in-memory) | PASS |
| DAT-2 | Account deletion cascades + idempotent | PASS — `ON DELETE CASCADE`, `deleteUser` in both repos, account.test + contract |
| DAT-3 | Export flow | PASS — exists, event payload empty (no PII) |
| DAT-4 | Logging PII | PASS — fixed `LogFields`, no body/headers/query; errors by type+code only; logging.test holds it |
| DAT-5 | Field encryption | PASS — AES-256-GCM, per-value nonce, context as AAD (CV/passport/statements, Postgres) |

## NOT TESTED (require live infra/access)
Load/soak/stress · DR restore drill · live-browser novice walkthrough (3G, phone) · monitoring/alert firing · live Resend/Anthropic integration test · production DB state.
