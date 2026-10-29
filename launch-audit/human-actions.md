# Human Action List

Items only a person / infrastructure can complete. The moment each is supplied, the audit loop resumes on it.

| # | Action | Owner | Why it blocks | What I'll do when it's done |
|---|--------|-------|---------------|------------------------------|
| H1 | Real Terms / Privacy / Cookie policies + consent capture; DPIA | Owner + legal | `draft-1` placeholders → no valid consent for public users (blocks public launch, not invite pilot) | Wire consent versions, verify capture/withdrawal, re-test |
| H2 | Set SPF/DKIM/DMARC DNS for the sending domain | Owner (DNS) | Auto-sent e-mails risk spam-foldering — directly hurts pilot reply rate | Verify headers on a test send; confirm alignment |
| H3 | Run load/soak test on staging | Owner/infra | Performance gate NOT TESTED | I provide a k6/Playwright script; you run it; I analyse p95/errors |
| H4 | DR restore drill — restore a real backup into isolation | Owner/infra | Reliability gate NOT TESTED; "unrestored backup is not a backup" | Validate restored data; record RPO/RTO |
| H5 | Live novice walkthrough on a throttled phone | Owner | Usability gate needs a real device/browser I can't drive | I provide the step script; you run; I fix friction found |
| H6 | Trigger a controlled failure to confirm alerts fire to a named person | Owner/infra | Observability gate NOT TESTED | Verify alert path + content |
| H7 | Decide the Zod 4 upgrade window | Owner | Full fix for the one real (bounded) CVE is a major upgrade | Upgrade on a branch, run full suite, report |
| H8 | Refresh `GO-LIVE.md` to reflect live e-mail/LLM reality | Owner (or approve me) | Doc says they're untested; they run in production now | Update the doc on approval |

Not required for the private pilot, which is already running appropriately. Required before any unrestricted public launch: H1–H6 at minimum.
