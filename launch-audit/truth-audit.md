# Truth Audit — claims vs. code

Method: each public claim traced to its code path and classified REAL / PARTIAL / STUBBED / ABSENT / BROKEN. **No dishonest stubs found** — no fake dashboards, no handler-less buttons, no success toasts without a write, no AI feature faking a model call. Gaps are those `GO-LIVE.md` already discloses.

| Claim | Status | Evidence / note |
|-------|--------|-----------------|
| Truth-checked CV tailoring — "cannot invent" | REAL | `tailoring.ts` fails closed to reorder on any untraceable fact; `traceCheck` on figures + capitalised names. Fact/keyword-level (not semantic). |
| See-through match scoring | REAL | `matching.ts` — each hit carries the CV sentence as evidence; score = matched/total, essential weighted. Keyword heuristic (PARTIAL quality, disclosed). |
| Statements lead with strengths, evidence-only | PARTIAL | `statement.ts` prompt + `findUnsupportedClaims` guard (a warning, not a proof). No-LLM fallback is a plain CV-sentence list. LLM path **runs in production** (see correction). |
| Applications send themselves by e-mail, revocable authorisation | REAL (live) | `applying.service.ts sendByEmail` gated on authorisation + verified e-mail + pauses + daily limit + claim-once (no double-send); revocable in one step. **Proven live: 60 sent, real replies.** |
| 3 modes; sensitive fields always confirmed; Auto never submits a declaration form | REAL (wording tightened) | `policy.ts decide()` + ~93k combination sweeps; `fields.ts` fail-sensitive-when-unsure. Caveat: under OD-6, declarations answered from the person's own saved answers don't block Auto — sales-page wording corrected to match. |
| Right-to-work & own-answers from own record, never guessed | REAL | `fields.ts workRightsAnswer` (confirmed, unexpired, document-named only); OD-6 own-answers plumbed. Non-UK rules legally unverified (disclosed). |
| Tracker learns / tunes the bar; interview prep from sent docs | REAL | `outcomes.ts automaticBar` + `interview-docs.ts`. Needs ≥20 hand-recorded outcomes before the bar moves; nothing for a brand-new user. |
| Plays by the rules — no CAPTCHA/bot-evasion/ToS scraping | REAL (enforcement) | `blockers.ts` visible-CAPTCHA + login-wall stop; invisible reCAPTCHA untouched; API sources only; career-sites gated on operator terms-check. `docs/sources.md` still marks sources "not checked" for formal ToS review (owner recorded live endpoint checks). |
| Data encrypted; scoped to you; nothing personal logged; export & delete | REAL (as scoped) | AES-256-GCM context-bound (CV/passport/statements, Postgres); every route in `isolation.test`; logging strips bodies; export + password-gated delete. Names/e-mail/phone/preferences are plaintext (e-mail must be queryable); in-memory store encrypts nothing. |

## Correction against live reality
`GO-LIVE.md` lists e-mail sending and LLM calls as never exercised against real providers. That is **out of date**: the live deployment has sent 60 applications (36 LLM-drafted) and received genuine recruiter replies. Reclassified from "never happened" (HIGH) to **"works in production, lacks an automated integration test" (MEDIUM)**. Recommend updating `GO-LIVE.md` (H8).

## Cold-start reachability
- **Deployed public user:** blocked before the first application — e-mail verification is required (queue refuses unverified) and `draft-1` terms mean consent isn't real. Public-launch blocker, not a pilot blocker.
- **Pilot / configured deployment (real key + sender, as now):** register → verify → Profile/CV → Matches → agent drafts → review/approve → auto-send by e-mail where a recruiter address exists. This path is live and proven.
