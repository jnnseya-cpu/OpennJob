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

**Extension**

- [x] The popup has a sign-in form and a configurable API address, stores the user's
      JWT (never the password), and handles expiry by signing out and asking again.
      Driven through the real loaded extension against the real built API.
      `real-extension.spec.ts`
- [x] Unchanged safety behaviour: sensitive fields wait for the user's confirmation and
      are never auto-filled; auto mode never submits a form that has sensitive fields; it
      stops on CAPTCHA and login walls. `policy.test.ts`, `form-filling.spec.ts`,
      `pack-forms.spec.ts`, `real-extension.spec.ts` (none of these were weakened)

## Not done

Every item here is open. None has a workaround in the code.

### The product is not complete

- [ ] **No web app for candidates.** There is an API and a Chrome extension only. A
      person cannot register, accept the terms, enter a CV or a passport, see matches,
      read a drafted statement, export their data or delete their account without
      calling the API by hand (curl). The extension popup can sign in; it cannot register.
- [ ] **Email verification and password reset do not exist.** Anyone can register with
      an email address they do not own. A person who forgets their password is locked
      out for good; with encryption on, nobody can recover their account for them.
      There is no change-password or change-email route either.
- [ ] **Billing (BitriPay) is not implemented.** Usage is metered in "ACU" with a
      placeholder formula. `BitriPayBillingPort` is an interface with no implementation,
      and it does not describe BitriPay's real API. There are no plans, prices, invoices
      or payment flows.
- [ ] No sign-out on the server, no refresh tokens, no way to revoke one token, no
      multi-factor authentication, no account lock-out beyond the rate limit. A stolen
      access token works until it expires (one hour by default).
- [ ] No admin or support tooling: no way to look up, suspend or help a user.
- [ ] `POST /jobs/refresh` can be called by any signed-in user and refreshes the shared
      job catalogue for everyone. There is no scheduler and no role that restricts it.
- [ ] Employer posting is still one shared key with no employer accounts and no
      moderation.
- [ ] CV input is plain text only. No PDF or Word import.
- [ ] No data-retention rule is implemented: nothing is ever deleted except by
      `DELETE /account`.

### Never verified against the real world

- [ ] **Job-source response shapes are unverified against the live APIs.** The
      Greenhouse, Lever, Ashby, Adzuna and Reed adapters were written from memory of the
      public documentation and tested only against hand-written fixtures. No live call
      has been made. Expect field names to be wrong.
- [ ] **The extension has never been run on a real employer site.** Only on the
      fictional forms in `apps/extension/test/fixtures/`, in automated headless Chromium.
      Nobody has loaded it into desktop Chrome by hand. Real forms (multi-page, file
      upload, iframes, custom widgets) will break it.
- [ ] **LLM API key and model name are not confirmed.** No call to Anthropic has ever
      been made by this code. `OPENNJOB_MODEL` has no verified value; the fallback
      constant is a placeholder. Statement quality from a real model is unknown.
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
- [ ] **Monitoring and alerting.** None. Logs go to stdout as JSON and nothing reads
      them. Nobody is told when the API is down, erroring, or under attack.
- [ ] **Encryption key management.** `OPENNJOB_DATA_KEY` is one key from an environment
      variable. There is no rotation, no key versioning, no escrow and no recovery. If
      the key is lost, every CV, passport and statement is unreadable. If it leaks, it
      cannot be changed without writing a re-encryption tool that does not exist.
- [ ] The same for `OPENNJOB_JWT_SECRET`: changing it signs everyone out; there is no
      overlap period.
- [ ] **The rate limit is per process.** With more than one API instance each counts on
      its own, and a restart clears the count. No shared limiter, no WAF, no bot
      protection in front of `/auth/*`.
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
- [ ] `npm audit` reports advisories in vitest's own dependencies (development only;
      `npm audit --omit=dev` reports none). Not resolved.

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
      (CV text and job adverts are sent to Anthropic when an LLM key is set), and with
      the hosting provider.
- [ ] Lawful basis, retention periods, and a process for data-subject requests beyond
      the two routes that exist (export and delete). No named data protection lead.
- [ ] Referees' details are third parties' personal data, supplied by someone else. How
      they are told has not been decided.
- [ ] No age check. No check that the person registering is the person the CV describes.

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

Privacy policy and terms; DPIA; ICO check; a web app, or at least a registration and
consent screen; email verification and password reset; hosting with TLS, backups that
have been restored once, and alerting; key management for `OPENNJOB_DATA_KEY`; an
independent security test; one real Anthropic call and a confirmed model name; the job
sources checked against the live APIs and their terms; the extension tried by hand on
real forms, in hybrid mode, with the site's permission where its terms require it; and
auto mode left switched off until hybrid has a track record.
