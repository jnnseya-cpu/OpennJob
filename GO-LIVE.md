# GO-LIVE checklist

Two lists. The first is what exists in this repository and is covered by a test that was
run. The second is what does not exist, or exists and was never verified. **The second
list is the one that decides whether real people can use this.** As it stands, they
cannot: several items on it are legal requirements and several are safety checks that
nobody has done.

Nothing here is legal advice.

## Done and tested in this repo

Each line names where the test is. "Tested" means the automated tests in this repository
pass; it does not mean it was tried in a real deployment.

**Accounts**

- [x] `POST /auth/register`, `POST /auth/login`, `GET /account`: real multi-user
      accounts. Passwords hashed with bcrypt (cost 12 by default). `auth.test.ts`
- [x] Password rules: 12 characters or more, at most 72 bytes, not a common password,
      not the email address, at least 5 different characters. `auth.test.ts`
- [x] Signed JWT access tokens (HS256, `OPENNJOB_JWT_SECRET`, one hour by default).
      Expired, altered, wrongly signed and `alg: none` tokens are refused. A token for a
      deleted account stops working at once. `auth.test.ts`, `account.test.ts`
- [x] The API refuses to start with `NODE_ENV=production` and no `OPENNJOB_JWT_SECRET`,
      or no `OPENNJOB_DATA_KEY`. Tested on the function, on `startServer()`, and on the
      built process. `auth.test.ts`, `server.test.ts`, `api-process.spec.ts`
- [x] Rate limiting on `/auth/*`, per client address and per email address.
      `auth.test.ts`
- [x] Invite-only registration for the private pilot: `OPENNJOB_REGISTRATION_ALLOWLIST`
      (empty means open, with a start-up warning); others get 403 and no account; the web app
      says the pilot is invite-only. `auth.test.ts`, `invite-only.spec.ts`
- [x] Consent recorded at registration: `acceptedTermsVersion` and
      `acceptedPrivacyVersion` are required, must equal the configured current versions,
      and are stored with a timestamp. `auth.test.ts`, `repository.contract.ts`
- [x] Every profile, passport, preference, application, agent run, match, usage record
      and event is scoped to the authenticated user. User A cannot read or change user
      B's data on any route; the test fails if a route exists that it does not cover.
      Run against both stores. `isolation.test.ts`
- [x] `DELETE /account` (needs the password) removes all of the user's data;
      `GET /account/export` returns all of it as JSON. Both against both stores, and for
      PostgreSQL by reading every table afterwards. `account.test.ts`

**PostgreSQL**

- [x] `PostgresRepository` and `PostgresUsageMeter` (`pg`), selected when
      `DATABASE_URL` is set; in-memory otherwise. `config.test.ts`, `server.test.ts`
- [x] One contract test suite run against both implementations.
      `repository.contract.ts`, `repository.contract.test.ts`
- [x] Versioned SQL migrations, `npm run migrate`, idempotent, tracked in
      `schema_migrations`, checksummed, safe to run twice at once; a failing migration
      rolls back. The API refuses to start on a database that is missing migrations.
      `migrations.test.ts`, `server.test.ts`, `api-process.spec.ts`
- [x] These were run against a live PostgreSQL 16 (a throwaway local instance). See the
      test results in `README.md` for the exact counts and for what is skipped when no
      database is available.

**Data protection in code**

- [x] CV text, the whole credential passport and supporting statements are encrypted at
      rest in PostgreSQL with AES-256-GCM when `OPENNJOB_DATA_KEY` is set. Round trip,
      tamper detection, wrong key, and a ciphertext moved to another user's row are all
      tested, including by reading the raw rows. `crypto.test.ts`
- [x] Structured JSON request logging that never contains CV, passport or statement
      content, passwords, tokens or email addresses, across every route and on the built
      process's real output. `http.test.ts`, `api-process.spec.ts`
- [x] Security headers (helmet), a CORS allow-list from the environment, a request body
      size limit. `http.test.ts`

**Deployment**

- [x] `/health` reports the store and database connectivity (503 when the database is
      unreachable). `http.test.ts`, `server.test.ts`
- [x] Graceful shutdown on SIGTERM and SIGINT: requests in flight finish, the pool
      closes, exit code 0. `server.test.ts`, `api-process.spec.ts`
- [x] `.env.example` lists every variable. No secret is committed.

**Candidate web app** (`apps/web`; tested in headless Chromium at phone size against the
built API process, in memory and on PostgreSQL with encryption on; never deployed)

- [x] Register with both consent boxes unticked until the person ticks them; sign in;
      sign out; an expired or rejected token sends the person back to sign in.
      `web-app.spec.ts`
- [x] Profile, CV text, preferences and the credential passport saved and read back
      through the API. `web-app.spec.ts`
- [x] Matches with pack and region filters, scores equal to the API's, missing
      credentials shown. `web-app.spec.ts`
- [x] Review: every declaration starts unticked and is ticked one at a time; Approve
      stays disabled until all are ticked (and, in review-all mode, "I have checked
      every field"); no "tick all". Nothing is submitted from the website; an auto-mode
      agent run leaves every application as a draft. `web-app.spec.ts`
- [x] `PUT /applications/:id/statement` saves the user's edited statement; refused once
      submitted; isolated per user; not in the logs. `api.test.ts`, `isolation.test.ts`,
      `http.test.ts`, `repository.contract.ts`
- [x] Export downloads everything; delete needs the password and removes the account
      (all rows checked on PostgreSQL). `web-app.spec.ts`
- [x] No CV, passport, statement or contact value reached the browser console or the
      API log during the whole run. `web-app.spec.ts`

**Notifications**

- [x] Catalogue of 36 events (14 live, 22 planned), routed by user settings; service notices
      ignore opt-outs; in-app inbox; delivery log with no content or address; per-user routes
      covered in `isolation.test.ts`; removed with the account; in the export.
      `notifications.test.ts`, `repository.contract.ts`, `isolation.test.ts`, `web-app.spec.ts`

**Extension**

- [x] The popup has a sign-in form and a configurable API address, stores the user's
      JWT (never the password), and handles expiry by signing out and asking again.
      Driven through the real loaded extension against the real built API.
      `real-extension.spec.ts`
- [x] Unchanged safety behaviour: sensitive fields wait for the user's confirmation and
      are never auto-filled; auto mode never submits a form that has sensitive fields; it
      stops on CAPTCHA and login walls. `policy.test.ts`, `form-filling.spec.ts`,
      `pack-forms.spec.ts`, `real-extension.spec.ts` (none of these were weakened)

**Applying on the person's behalf, reports and accounts (spec phases 2 to 5)**

Every requirement and test case of the owner's "OpennJob Build and Test Requirements" is
mapped to its tests, or marked not done with the reason, in `docs/traceability.md`.

- [x] Tailored CV that only reorders the person's own lines; a trace check holds any
      sentence it cannot trace; the exact documents sent are kept, encrypted, with their
      SHA-256. `tailoring.test.ts`, `spec-applying.test.ts`, `repository.contract.ts`
- [x] One application per job (same id, or employer, title and location within
      `OPENNJOB_DUPLICATE_DAYS`); a daily limit per London day; an LLM spending ceiling
      per person and in total that holds new drafts. `spec-applying.test.ts`
- [x] Standing authorisation: off until the person agrees to the current wording, dated,
      revocable in one step, pausable; the operator's pause for everyone. A form with any
      declaration or sensitive question is never submitted. The queue re-checks
      everything before each submission and claims each application once.
      `spec-queue.test.ts`, `queue.spec.ts` (fictional forms only)
- [x] Submitted only with a receipt: the page address and the site's own confirmation
      text. No confirmation seen means "uncertain", never retried automatically.
      `spec-queue.test.ts`, `queue.spec.ts`
- [x] Application systems are off until the operator records a terms check and one
      supervised real submission. None is on. `spec-queue.test.ts`
- [x] Ordinary screening answers stored once and reused; an unknown question holds the
      application and the person's answer is saved; declarations are refused on save and
      never filled from storage. `screening.test.ts`, `spec-queue.test.ts`,
      `account-flows.spec.ts`
- [x] E-mail verification and password reset by one-time links (only their SHA-256 is
      stored; one use; 24 hours and 1 hour). Nothing is queued for an unverified address.
      A reset ends every earlier session. The reset request answers the same for unknown
      addresses. `spec-p4.test.ts`, `account-flows.spec.ts`
- [x] CV upload: PDF and Word (.docx) become text the person reads and edits before
      saving. The file is not kept. `spec-p4.test.ts` (real fixture files),
      `account-flows.spec.ts`
- [x] Scheduler on London time, once per day across instances (`OPENNJOB_SCHEDULER=true`):
      06:00 discovery and drafts, 09:00 report (quiet days included, watermarked, no CV
      text or answers, pausable by the person), 03:00 retention when
      `OPENNJOB_RETENTION_DAYS` is set. Tested on both sides of both 2026/27 clock
      changes with a simulated clock. `spec-p4.test.ts`
- [x] Operator alerts by e-mail (`OPENNJOB_OPERATOR_EMAIL`) on a failed source, agent run
      or report e-mail, one per problem per hour. `spec-p4.test.ts`
- [x] The sign-in rate limit is shared by every API instance through the database.
      `spec-p4.test.ts`
- [x] Matches for 5,000 stored jobs answer in under a second (in memory, build machine).
      `spec-p4.test.ts`
- [x] Interview preparation from the advert and the documents that application sent,
      quoted word for word, with uncovered criteria named. `spec-p4.test.ts`,
      `account-flows.spec.ts`
- [x] Web screens for all of the above: verification banner and pages, forgot and reset
      password, automatic applications with the exact wording, revoke and pause, queue
      status, daily report switch, CV upload, standard answers, receipts and hold reasons
      in the tracker, interview from an application. `account-flows.spec.ts`
- [x] A terms register for every job source, with a test that fails when a source has no
      row (`docs/sources.md`, `sources-register.test.ts`). It says no source has been
      checked.

## Not done

Every item here is open. None has a workaround in the code.

### The product is not complete

- [ ] **The web app is not deployed** and has never been used by a real person or on a
      real phone (only headless Chromium at a phone-sized viewport). No accessibility
      audit. No content-security policy is set for it. The production API must list the
      site's origin in `OPENNJOB_CORS_ORIGINS`; nothing has been configured.
- [ ] **E-mail has never been sent.** The Resend adapter is untested against the real service;
      no sending domain, SPF, DKIM or DMARC is set up (REP-4). Verification links, reset links,
      operator alerts and the 09:00 report have only reached the test capture and the
      development mailbox, never a real inbox. SMS, push and WhatsApp have no provider
      at all. Notification subjects (job title, employer) are not encrypted at rest.
- [ ] **Next.js 14 has open advisories** (`npm audit --omit=dev`), on 14.2.35, the newest
      14.2 release. They are in server features (server actions, image optimisation,
      rewrites, middleware) that the static export does not run, as listed in
      `docs/dependency-audit.md`; moving to a supported major version is still to do.
      `mammoth` pulls in `sprintf-js` through its command-line parser, which the API
      never loads.
- [ ] The web app's "I have submitted it" is the person's own record. Nothing checks it
      against the employer, and employer replies are not tracked.
- [ ] No change-password route while signed in (the reset link is the only way) and no
      change-email route.
- [ ] **Billing (BitriPay) is not implemented.** Usage is metered in "ACU" with a
      placeholder formula. `BitriPayBillingPort` is an interface with no implementation,
      and it does not describe BitriPay's real API. There are no plans, prices, invoices
      or payment flows.
- [ ] No sign-out on the server, no refresh tokens, no way to revoke one token, no
      multi-factor authentication, no account lock-out beyond the rate limit. A stolen
      access token works until it expires (one hour by default).
- [ ] No admin or support tooling: no way to look up, suspend or help a user.
- [ ] `POST /jobs/refresh` can be called by any signed-in user and refreshes the shared
      job catalogue for everyone. No role restricts it (the scheduler now refreshes daily).
- [ ] Employer posting is still one shared key with no employer accounts and no
      moderation.
- [ ] Scanned PDFs (images with no text layer) give no text; the person is told to paste
      the CV instead. No OCR.
- [ ] Retention is off until `OPENNJOB_RETENTION_DAYS` is set; the period is the owner's
      decision and is not set anywhere.
- [ ] The automatic queue has run only against fictional forms on 127.0.0.1. No real
      employer form has been submitted by it, and no application system is enabled.

### Never verified against the real world

- [ ] **Job-source response shapes are unverified against the live APIs.** The
      Greenhouse, Lever, Ashby, Adzuna and Reed adapters were written from memory of the
      public documentation and tested only against hand-written fixtures. No live call
      has been made. Expect field names to be wrong.
- [ ] **The extension has never been run on a real employer site.** Only on the
      fictional forms in `apps/extension/test/fixtures/`, in automated headless Chromium.
      Nobody has loaded it into desktop Chrome by hand. Real forms (multi-page, file
      upload, iframes, custom widgets) will break it.
- [ ] **The Gemini key and model name are not confirmed.** Claude was removed (owner, 8 October
      2026); Google Gemini is the only AI. No call to Gemini has been made by this code here;
      `deploy/check-ai.sh` makes one on the server. Statement quality from Gemini is unknown.
- [ ] **Production files for one server exist and were never run**: `docker-compose.prod.yml`,
      `deploy/web.Dockerfile`, `deploy/Caddyfile`, `deploy/hostinger-vps.md`. `docker compose config`
      validates the file; the same-origin `/api` layout is tested with a proxy in `same-origin.spec.ts`;
      no image was built (the Docker daemon could not be started where this was written).
- [ ] **The Docker image has never been built**, and `docker compose up` has never been
      run (no Docker daemon was available). The Dockerfile's steps were run by hand
      outside Docker once; that is not the same thing.
- [ ] **The GitHub Actions workflow has never run.** It was written and not executed.
- [ ] **The Cloud Run steps in `deploy/gcp-cloud-run.md` were written from memory and
      never executed.**
- [ ] Node 20 is declared as supported and was never run; everything ran on Node 22.

### Operations

- [ ] **Hosting.** Nothing is deployed anywhere.
- [ ] **Domain.** None.
- [ ] **TLS.** The API speaks plain HTTP and expects a TLS-terminating proxy in front.
      None is configured. Without TLS, passwords and tokens cross the network in the clear.
- [ ] **Backups.** None configured, and no restore has ever been tested.
- [ ] **Monitoring and alerting.** Only the operator e-mail alerts above, never received
      by a real inbox. Logs go to stdout as JSON and nothing reads
      them. Nobody is told when the API is down, erroring, or under attack.
- [ ] **Encryption key management.** `OPENNJOB_DATA_KEY` is one key from an environment
      variable. There is no rotation, no key versioning, no escrow and no recovery. If
      the key is lost, every CV, passport and statement is unreadable. If it leaks, it
      cannot be changed without writing a re-encryption tool that does not exist.
- [ ] The same for `OPENNJOB_JWT_SECRET`: changing it signs everyone out; there is no
      overlap period.
- [ ] No WAF and no bot protection in front of `/auth/*`; the shared rate limit is the
      only defence against password guessing.
- [ ] Names, email addresses, phone numbers, addresses and preferences in `profiles`
      are **not** encrypted at the application level. Only CV text, the passport and
      statements are. Account email addresses are stored in the clear (they are looked
      up at sign-in). The in-memory store encrypts nothing.
- [ ] `POST /auth/register` replies 409 for an email address that already has an
      account, which tells a caller that the address is registered.
- [ ] The extension keeps the access token in `chrome.storage.local`, unencrypted.
- [ ] No staging environment, no deployment pipeline, no rollback procedure, no runbook,
      no incident process, no on-call.
- [ ] No load or soak test. Database pool size, bcrypt cost and instance size are guesses.
- [ ] `npm audit` reports advisories in vitest's own dependencies (development only) and,
      with `--omit=dev`, in Next.js and mammoth (see `docs/dependency-audit.md`). Not
      resolved.

### Chrome Web Store

- [ ] **Chrome Web Store listing and review.** Not started. No developer account, no
      listing, no store privacy disclosures, no justification for each permission, no
      icons or screenshots. The store's policies have not been read against what this
      extension does (filling forms on third-party sites). The manifest still says
      "development build". Until it is published, the extension id is not fixed, and
      the production CORS allow-list needs that id.

### Legal and compliance

- [ ] **Legal documents: privacy policy and terms.** They do not exist. Registration
      records acceptance of versions called `draft-1`, which refer to no document. No
      real person can give valid consent to a document that was never written.
- [ ] **UK GDPR DPIA.** Not done. This is automated processing of sensitive data
      (credentials, DBS details, right-to-work status, referees' details) to make formal
      applications in a person's name; a DPIA is very likely required before any real
      user's data is processed.
- [ ] **ICO registration.** Not checked or done for this processing.
- [ ] **A separate legal check for each non-UK country served.** Not done for any
      country. The code offers jobs in 16 countries in its demo data and accepts any ISO
      country. Data-protection law, right-to-work rules and what an employer may ask
      differ in every one (EU member states, DRC, Senegal, Côte d'Ivoire, the Gulf
      states, the US, Canada and the rest). Do not serve a country before its check.
- [ ] **Per-site terms-of-use review for each job source.** Not done for any of them:
      Greenhouse, Lever, Ashby, Adzuna, Reed (API terms: attribution, caching, permitted
      use), nor for any site the extension would be used on (NHS Jobs, Trac, employer
      and agency sites, applicant tracking systems). Some sites forbid automated form
      filling as well as scraping.
- [ ] Data processing agreement and international-transfer check with the LLM provider
      (CV text and job adverts are sent to Google when a Gemini key is set), and with
      the hosting provider.
- [ ] Lawful basis, retention periods, and a process for data-subject requests beyond
      the two routes that exist (export and delete). No named data protection lead.
- [ ] Referees' details are third parties' personal data, supplied by someone else. How
      they are told has not been decided.
- [ ] No age check. No check that the person registering is the person the CV describes.
- [ ] **Employment agency status, before charging anyone.** If OpennJob is paid for and
      finds work for people or applies for them, it may count as an employment agency
      under the Employment Agencies Act 1973 and the Conduct of Employment Agencies and
      Employment Businesses Regulations 2003, which restrict charging work-seekers fees.
      Take legal advice before setting prices. Not done.
- [ ] **E-mail applications and UK GDPR/PECR.** The view that e-mailing an application to
      the address an advert gives for applications is not direct marketing is an
      interpretation, not legal advice. Confirm it, and that sending in the person's name
      from OpennJob's mailbox is covered by the privacy notice. Not done.

### Security

- [ ] **Independent security test.** None. Nobody outside the authoring process has
      reviewed or attacked this code: no penetration test, no code audit, no dependency
      review beyond `npm audit`, no threat model. The authentication, the isolation
      between users and the encryption were written and tested by the same author, in
      one sitting.
- [ ] No review of the extension's attack surface (a hostile page it is asked to fill,
      a hostile API address).
- [ ] No secrets scanning or dependency update automation on the repository.

### Before the first real user, at minimum

Privacy policy and terms; DPIA; ICO check; the web app deployed behind TLS with a
content-security policy, and tried on real phones; a real sending domain with SPF and DKIM; hosting with TLS, backups that
have been restored once, and alerting; key management for `OPENNJOB_DATA_KEY`; an
independent security test; one real Gemini call and a confirmed model name; the job
sources checked against the live APIs and their terms; the extension tried by hand on
real forms, in hybrid mode, with the site's permission where its terms require it; and
auto mode left switched off until hybrid has a track record.
