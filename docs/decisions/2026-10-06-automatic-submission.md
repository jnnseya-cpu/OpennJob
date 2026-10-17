# Decision: automatic submission under standing authorisation

- **Date:** 6 October 2026
- **Decided by:** the owner (repository owner jnnseya-cpu), in the Claude Code session that built it.
- **Status: decided, NOT implemented.** The code change was refused by the build session's safety check; `CLAUDE.md` rules 1 and 3 and `policy.ts` are unchanged.
- **Would change:** `CLAUDE.md` non-negotiable rules 1 (declarations) and 3 (auto mode and sensitive fields),
  and `decide()` in `packages/core/src/policy.ts`.

## What was decided

The platform may submit an application by itself when, and only when, the applicant has switched on
**standing authorisation** and every one of these holds:

1. The match score is 80% or more and every essential requirement is met.
2. The form passes the route checks: no CAPTCHA or login wall, exactly one form and one submit control,
   every required field filled.
3. **Every** field on the form, sensitive or not, is answered from data or answers the applicant has
   confirmed. Anything without a confirmed answer stops the submission and asks the applicant.
4. Fewer than 20 automatic submissions have been made that day (Europe/London).
5. A receipt is captured after submitting; without one the application is recorded as uncertain and is
   never retried automatically.
6. The applicant can switch it off at any time; every automatic submission is notified.

## Declarations the platform may answer, from the applicant's own confirmed answers

- **Right to work and sponsorship**, per country, from a record the applicant attests with a supporting
  document (the document's fingerprint is stored; the file stays on the applicant's device).
- **Accuracy and consent boxes** ("I confirm the information is accurate", consent to be contacted),
  once the applicant has approved that kind of statement.
- **Criminal convictions and security clearance**, from answers the applicant confirms and re-confirms
  every 90 days. Convictions are answered only when the applicant has confirmed "none, of any kind,
  spent or unspent, including cautions"; anything else is answered by the applicant.
- **Equality monitoring**, with "prefer not to say" only.

Never answered automatically: health and disability, fitness to practise, safeguarding, conflicts of
interest, and any declaration that does not match the categories above. Unchanged: no CAPTCHA or
login workarounds, no automation where a site's terms forbid it, no guessed answers.

## Not decided here

Server-side or background browser automation on employer sites. Submission happens in the
applicant's own browser through the extension.
