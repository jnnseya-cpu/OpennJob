# OpennJob — Launch-Readiness Audit (Master Prompt v2)

RC commit: `34ad783` (+ `launch-audit` commit) · branch `claude/busy-fermat-9hhn11`
Environment tested: the checked-out repository and the **in-process API** (NestJS via supertest, fake deps). The deployed VPS, live third-party providers, load and monitoring were **not** reachable from the audit session.
Cycles run: 1 recon/baseline + 1 fix (typecheck regression) + 2 parallel deep phases (truth audit, adversarial API).

## 1. Executive verdict

**NO-GO for unrestricted public launch. CONDITIONAL GO for the current private pilot.**

The code is in genuinely good shape: deterministic build, 881 automated tests passing (incl. a new 17-case adversarial suite), zero secrets in source, no `any`/`@ts-ignore`, the safety core enforced and swept over ~93k decision combinations, and **no auth/authz/IDOR bypass found under active attack**. The reasons this is not an unrestricted GO are honest and specific: whole operational gates (load/soak, DR restore drill, live-browser novice walkthrough, monitoring/alert firing) **could not be executed** from the audit environment and remain NOT TESTED; and per the project's own record the product has not been legally cleared (terms/privacy are `draft-1`) for public use. As a **private, invite-only pilot it is already running and appropriate**.

## 2. Immediate launch blockers (for *public* launch; none block the pilot)

| ID | Sev | Area | Issue | Required correction | Status |
|----|-----|------|-------|---------------------|--------|
| B1 | P1 | Legal | Terms/Privacy/Cookies are `draft-1` placeholders → no valid consent for public users | Real legal docs + consent capture; DPIA | HUMAN |
| B2 | P1 | Ops | Load, DR-restore drill, monitoring/alerts NOT TESTED | Run on VPS/staging (scripts can be provided) | HUMAN/INFRA |
| B3 | P2 | Integrations | No automated integration test against live Resend/Anthropic; job-source shapes unverified vs live APIs | Add integration tests; verify source adapters | CODE (planned) |
| B4 | P2 | Deliverability | SPF/DKIM (REP-4) not set for the sending domain | DNS records | HUMAN/INFRA |

## 3. Gate results

| Gate | Status | Evidence |
|------|--------|----------|
| 1 Build integrity | **PASS** | `npm run build` exit 0 (static export, CSP 24 pages); `npm run typecheck` exit 0 (fixed a real regression, commit `34ad783`); `npm test` 881 pass / 0 suppressed |
| 2 Truth & fitness | **PASS (pilot) / PARTIAL (public)** | No dishonest stubs (truth-audit.md). Core value reachable in dev/pilot; blocked for a cold public user by legal docs + verification setup |
| 3 Critical functionality | **PASS (tested paths)** | API + e2e suites; live proof: 60 real applications sent, real replies received |
| 4 Security | **PASS** | 17 adversarial cases: no authN/authZ/IDOR bypass, no info disclosure, no 5xx, rate-limit fires; no secrets in source; CVEs triaged (see §8) |
| 5 Data integrity | **PASS** | repository.contract.ts runs against Postgres **and** in-memory; migrations checksum-guarded; deletion cascades + idempotent |
| 6 Financial integrity | **N/A** | No payments/ledger in product |
| 7 Performance / load | **NOT TESTED** | No load infra in audit env |
| 8 Reliability (DR/rollback) | **NOT TESTED** | Needs restore drill on real backup |
| 9 Observability | **PARTIAL** | Logging proven PII-free (fixed fields; no body/headers/query); alert *firing* not triggered live |
| 10 Privacy & compliance | **PARTIAL** | Erasure + export real and tested; encryption real (CV/passport/statements, Postgres); legal docs `draft-1` (blocker for public) |
| 11 Operational readiness | **PARTIAL** | Deployed, auto-deploy + reboot-safe; runbooks/monitoring/legal incomplete |

## 4. Truth-audit summary
See `truth-audit.md`. Every public claim traces to real code; none faked. Corrected against live reality: e-mail sending and LLM drafting, which `GO-LIVE.md` still lists as untested, **are live in production** (60 sent, 36 LLM-drafted, real recruiter replies) — reclassified to "works in production, no automated integration test." Public-surface wording tightened: the sales page's "Auto never submits a form that carries a declaration" was broader than OD-6 in code; corrected.

## 5–14. Detailed findings
Security (§8): see evidence-ledger.md — all adversarial cases PASS. Data (§10): deletion/export tested, encryption AES-256-GCM context-bound. AI (§12): runs on a real key in production; **no automated eval set** (recommended). Performance (§13), Observability (§14 live): NOT TESTED here.

## 15. Fixes implemented this audit
- **Typecheck regression** (`apps/api/test/packs.test.ts`): `MatchRow.job` missing `contractType` → CI type gate was red though production build (excludes tests) was fine. Fixed, committed `34ad783`, pushed.
- **New adversarial security suite** (`apps/api/test/launch-audit-adversarial.test.ts`, 17 cases) added and passing.
- **Sales-page wording** corrected to match OD-6.

## 16. Unresolved risks
Live-provider integration tests; legal clearance; operational gates (load/DR/monitoring). All tracked in `human-actions.md`.

## 17. Human Action List
See `human-actions.md`.

## 20. Final decision
**This release is approved only for a restricted (private, invite-only) pilot under the conditions above. It is not approved for unrestricted public launch** until B1–B4 are cleared and the NOT-TESTED operational gates are executed.
