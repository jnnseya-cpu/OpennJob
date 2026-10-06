import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EmailTakenError, SYSTEM_USER_ID, createSampleSource } from '@opennjob/core';
import type { Application, DomainEvent, Job, Notification, NotificationDelivery, Passport, Profile, Repository, UsageMeter, UsageRecord, User } from '@opennjob/core';

/**
 * THE REPOSITORY CONTRACT. One suite, run against every implementation of Repository
 * (and UsageMeter) by repository.contract.test.ts. An implementation is correct when it
 * passes this; the API is written against nothing else.
 *
 * Every person, CV and employer below is fictional.
 */
export interface ContractBackend {
  repository: Repository;
  usageMeter: UsageMeter;
  close(): Promise<void>;
}

const NOW = '2026-10-06T09:00:00.000Z';
let counter = 0;
/** Unique per call, so tests do not depend on the store being empty. */
const unique = (prefix: string): string => `${prefix}-${Date.now().toString(36)}-${(counter += 1)}`;

const user = (id: string, overrides: Partial<User> = {}): User => ({
  id,
  email: `${id}@example.org`,
  passwordHash: '$2b$04$notARealHashJustAPlaceholderValue0000000000000000000000',
  createdAt: NOW,
  acceptedTermsVersion: 'terms-1',
  acceptedPrivacyVersion: 'privacy-2',
  consentAt: '2026-10-06T09:00:01.000Z',
  ...overrides,
});

const profile = (overrides: Partial<Profile> = {}): Profile => ({
  firstName: 'Amara',
  lastName: 'Okafor',
  email: 'amara.okafor@example.org',
  phone: '07700 900123',
  addressLine1: '12 Example Street',
  city: 'Birmingham',
  postcode: 'B1 1AA',
  cvText: 'Registered nurse with five years of experience on acute medical wards.\nÉtudes à Kinshasa. "Quotes", \\backslashes\\ and a null-free emoji: \u{1F642}',
  ...overrides,
});

const passport = (overrides: Partial<Passport> = {}): Passport => ({
  nmcPin: '18A1234E',
  credentials: { prof: 'MCIOB 0000000', sc: 'SC, expires 2028-01' },
  dbs: { certificateNumber: '001234567890', issueDate: '2025-03-01', onUpdateService: true },
  rightToWorkConfirmed: true,
  training: [{ name: 'Basic life support', completedOn: '2025-10-20', expiresOn: '2026-10-20' }, { name: 'Fire safety' }],
  referees: [{ name: 'Priya Shah', relationship: 'Ward Manager', organisation: 'Northfield General Hospital (example)', email: 'priya.shah@example.org', phone: '07700 900456' }],
  ...overrides,
});

const job = (id: string, overrides: Partial<Job> = {}): Job => ({
  id: `sample:${id}`,
  source: 'sample',
  externalId: id,
  title: 'Staff Nurse',
  employer: 'Example Care Group (fictional)',
  location: 'Leeds',
  url: `https://example.org/jobs/${id}`,
  description: 'Essential\n- Registered nurse.',
  criteria: [{ label: 'Registered nurse', essential: true, keywords: ['registered nurse', 'RN'] }],
  criteriaSource: 'provided',
  requiresRegistration: false,
  ...overrides,
});

const application = (id: string, userId: string, jobId: string, overrides: Partial<Application> = {}): Application => ({
  id,
  userId,
  jobId,
  jobTitle: 'Staff Nurse',
  employer: 'Example Care Group (fictional)',
  applyUrl: 'https://example.org/apply/1',
  mode: 'hybrid',
  status: 'draft',
  statement: 'I am a registered nurse with five years of experience.\nSecond line, with an accent: é.',
  statementSource: 'fallback',
  gaps: ['Tracheostomy care'],
  warnings: ['Basic life support expires soon'],
  score: 83,
  confirmedFields: [],
  createdAt: NOW,
  ...overrides,
});

const event = (id: string, userId: string, type = 'profile.updated', payload: Record<string, unknown> = { cvCharacters: 12 }): DomainEvent => ({ id, type, userId, occurredAt: NOW, payload });

const usage = (userId: string, overrides: Partial<UsageRecord> = {}): UsageRecord => ({ userId, purpose: 'supporting-statement', inputTokens: 1200, outputTokens: 345, acu: 1.545, at: NOW, ...overrides });

export function repositoryContract(name: string, make: () => Promise<ContractBackend>): void {
  describe(`repository contract: ${name}`, () => {
    let backend: ContractBackend;
    let repo: Repository;
    let a: string;
    let b: string;

    beforeAll(async () => {
      backend = await make();
      repo = backend.repository;
    });
    afterAll(async () => {
      await backend?.close();
    });
    beforeEach(async () => {
      a = unique('user-a');
      b = unique('user-b');
      await repo.createUser(user(a));
      await repo.createUser(user(b));
    });

    it('answers ping', async () => {
      await expect(repo.ping()).resolves.toBeUndefined();
    });

    describe('users', () => {
      it('stores a user with its consent record and finds it by id and by email', async () => {
        const stored = user(a);
        expect(await repo.getUserById(a)).toEqual(stored);
        expect(await repo.getUserByEmail(stored.email)).toEqual(stored);
        expect(stored).toMatchObject({ acceptedTermsVersion: 'terms-1', acceptedPrivacyVersion: 'privacy-2', consentAt: '2026-10-06T09:00:01.000Z' });
      });

      it('keeps the e-mail verification time given at creation, and absent when absent', async () => {
        const id = unique('user-v');
        await repo.createUser({ ...user(id), emailVerifiedAt: '2026-10-06T09:05:00.000Z' });
        expect((await repo.getUserById(id))?.emailVerifiedAt).toBe('2026-10-06T09:05:00.000Z');
        expect((await repo.getUserById(a))?.emailVerifiedAt).toBeUndefined();
      });

      it('returns undefined for an unknown id or email', async () => {
        expect(await repo.getUserById(unique('nobody'))).toBeUndefined();
        expect(await repo.getUserByEmail('nobody@example.org')).toBeUndefined();
      });

      it('refuses a second account with the same email (EmailTakenError) and a duplicate id', async () => {
        await expect(repo.createUser(user(unique('other'), { email: `${a}@example.org` }))).rejects.toBeInstanceOf(EmailTakenError);
        await expect(repo.createUser(user(a, { email: 'different@example.org' }))).rejects.toThrow(/already exists/);
        expect(await repo.getUserByEmail('different@example.org')).toBeUndefined();
      });

      it('returns copies: changing what was read does not change what is stored', async () => {
        const read = (await repo.getUserById(a)) as User;
        read.email = 'changed@example.org';
        expect((await repo.getUserById(a))?.email).toBe(`${a}@example.org`);
      });
    });

    describe('profile', () => {
      it('is undefined until saved, then round-trips exactly, including unusual characters', async () => {
        expect(await repo.getProfile(a)).toBeUndefined();
        const p = profile();
        await repo.saveProfile(a, p);
        expect(await repo.getProfile(a)).toEqual(p);
      });

      it('keeps optional fields absent when absent and present when present', async () => {
        await repo.saveProfile(a, profile());
        const bare = (await repo.getProfile(a)) as Profile;
        expect('addressLine2' in bare).toBe(false);
        expect('preferences' in bare).toBe(false);
        const full = profile({ addressLine2: 'Flat 3', preferences: { languages: ['French'], countries: ['GB', 'CD'], cities: ['Kinshasa'] } });
        await repo.saveProfile(a, full);
        expect(await repo.getProfile(a)).toEqual(full);
        const empty = profile({ preferences: { languages: [], countries: [], cities: [] } });
        await repo.saveProfile(a, empty);
        expect(await repo.getProfile(a)).toEqual(empty);
      });

      it('replaces on save and is scoped to its user', async () => {
        await repo.saveProfile(a, profile({ firstName: 'First' }));
        await repo.saveProfile(a, profile({ firstName: 'Second' }));
        await repo.saveProfile(b, profile({ firstName: 'Bola', cvText: 'Site manager with ten years on data centre builds.' }));
        expect((await repo.getProfile(a))?.firstName).toBe('Second');
        expect((await repo.getProfile(b))?.firstName).toBe('Bola');
        expect((await repo.getProfile(b))?.cvText).toBe('Site manager with ten years on data centre builds.');
      });

      it('holds a CV of the largest size the API accepts', async () => {
        const cvText = 'Evidence line with an é. '.repeat(2000).slice(0, 50_000);
        await repo.saveProfile(a, profile({ cvText }));
        expect((await repo.getProfile(a))?.cvText).toBe(cvText);
      });
    });

    describe('passport', () => {
      it('is undefined until saved, then round-trips exactly', async () => {
        expect(await repo.getPassport(a)).toBeUndefined();
        const p = passport();
        await repo.savePassport(a, p);
        expect(await repo.getPassport(a)).toEqual(p);
      });

      it('round-trips the smallest passport and a stored "no"', async () => {
        const minimal: Passport = { rightToWorkConfirmed: false, training: [], referees: [] };
        await repo.savePassport(a, minimal);
        const read = (await repo.getPassport(a)) as Passport;
        expect(read).toEqual(minimal);
        expect('nmcPin' in read || 'credentials' in read || 'dbs' in read).toBe(false);
      });

      it('replaces on save and is scoped to its user', async () => {
        await repo.savePassport(a, passport());
        await repo.savePassport(a, passport({ nmcPin: '99Z9999Z', credentials: { cscs: '00000000' } }));
        expect(await repo.getPassport(a)).toEqual(passport({ nmcPin: '99Z9999Z', credentials: { cscs: '00000000' } }));
        expect(await repo.getPassport(b)).toBeUndefined();
      });
    });

    describe('jobs', () => {
      it('inserts, counts only the new ones, and replaces by id', async () => {
        const one = job(unique('j'));
        const two = job(unique('j'), { title: 'Healthcare Assistant' });
        expect(await repo.upsertJobs([one, two])).toBe(2);
        expect(await repo.upsertJobs([{ ...one, title: 'Senior Staff Nurse' }, job(unique('j'))])).toBe(1);
        expect((await repo.getJob(one.id))?.title).toBe('Senior Staff Nurse');
        expect(await repo.getJob(two.id)).toEqual(two);
        expect(await repo.getJob('sample:does-not-exist')).toBeUndefined();
        expect(await repo.upsertJobs([])).toBe(0);
      });

      it('round-trips every optional field, and leaves absent ones absent', async () => {
        const bare = job(unique('j'));
        const full = job(unique('j'), {
          applyUrl: 'https://example.org/apply/2',
          salaryMin: 31_000,
          salaryMax: 37_500.5,
          employmentType: 'Permanent',
          postedAt: '2026-09-30',
          requiresRegistration: true,
          requiredCredential: 'pin',
          pack: 'hc',
          country: 'GB',
          city: 'Leeds',
          region: 'uk',
          language: 'fr',
          origin: 'discovered',
          criteriaSource: 'llm',
          criteria: [
            { label: 'Registered nurse', essential: true, keywords: ['registered nurse', 'RN'] },
            { label: 'Français courant', essential: false, keywords: ['français'] },
          ],
        });
        const employer = job(unique('j'), { id: `employer:${unique('e')}`, source: 'employer', origin: 'employer', requiredCredential: 'sc', requiresRegistration: true });
        employer.externalId = employer.id.slice('employer:'.length);
        await repo.upsertJobs([bare, full, employer]);
        const readBare = (await repo.getJob(bare.id)) as Job;
        expect(readBare).toEqual(bare);
        for (const key of ['applyUrl', 'salaryMin', 'postedAt', 'pack', 'country', 'region', 'language', 'origin', 'requiredCredential'] as const) expect(key in readBare, key).toBe(false);
        expect(await repo.getJob(full.id)).toEqual(full);
        expect(await repo.getJob(employer.id)).toEqual(employer);
      });

      it('lists every job that was stored', async () => {
        const mine = [job(unique('j')), job(unique('j'))];
        await repo.upsertJobs(mine);
        const listed = await repo.listJobs();
        for (const j of mine) expect(listed).toContainEqual(j);
      });

      it('stores all the fictional demo jobs and gives them back unchanged', async () => {
        const demo = await createSampleSource({ allPacks: true }).fetchJobs();
        expect(demo.length).toBeGreaterThan(20);
        await repo.upsertJobs(demo);
        for (const j of demo) expect(await repo.getJob(j.id), j.id).toEqual(j);
        expect(await repo.upsertJobs(demo)).toBe(0);
      });
    });

    describe('applications', () => {
      let jobId: string;
      beforeEach(async () => {
        const j = job(unique('j'));
        jobId = j.id;
        await repo.upsertJobs([j]);
      });

      it('creates, reads back exactly, and refuses a duplicate id', async () => {
        const app = application(unique('app'), a, jobId);
        await repo.createApplication(app);
        const read = (await repo.getApplication(a, app.id)) as Application;
        expect(read).toEqual(app);
        expect('confirmedAt' in read || 'submittedAt' in read).toBe(false);
        await expect(repo.createApplication(app)).rejects.toThrow(/already exists/);
        await expect(repo.createApplication({ ...app, userId: b })).rejects.toThrow(/already exists/);
      });

      it('updates status, confirmed fields and timestamps', async () => {
        const app = application(unique('app'), a, jobId);
        await repo.createApplication(app);
        const confirmed: Application = { ...app, status: 'confirmed', confirmedFields: ['nmcPin', 'rightToWork'], confirmedAt: '2026-10-06T09:05:00.000Z' };
        await repo.updateApplication(confirmed);
        expect(await repo.getApplication(a, app.id)).toEqual(confirmed);
        const submitted: Application = { ...confirmed, status: 'submitted', submittedAt: '2026-10-06T09:06:00.123Z' };
        await repo.updateApplication(submitted);
        expect(await repo.getApplication(a, app.id)).toEqual(submitted);
        const edited: Application = { ...confirmed, statement: 'My own wording, edited after the draft. (fictional)' };
        await repo.updateApplication(edited);
        expect(await repo.getApplication(a, app.id)).toEqual(edited);
        await expect(repo.updateApplication({ ...app, id: unique('missing') })).rejects.toThrow(/not found/);
      });

      it("never returns one user's application to another, by id or in a list", async () => {
        const mine = application(unique('app'), a, jobId);
        const theirs = application(unique('app'), b, jobId, { statement: 'Statement of the other user.' });
        await repo.createApplication(mine);
        await repo.createApplication(theirs);
        expect(await repo.getApplication(b, mine.id)).toBeUndefined();
        expect(await repo.getApplication(a, theirs.id)).toBeUndefined();
        expect(await repo.listApplications(a)).toEqual([mine]);
        expect(await repo.listApplications(b)).toEqual([theirs]);
        expect(await repo.listApplications(unique('nobody'))).toEqual([]);
      });

      it("refuses an update that names another user's application, and leaves it untouched", async () => {
        const theirs = application(unique('app'), b, jobId);
        await repo.createApplication(theirs);
        await expect(repo.updateApplication({ ...theirs, userId: a, status: 'submitted', submittedAt: NOW, statement: 'overwritten' })).rejects.toThrow(/not found/);
        expect(await repo.getApplication(b, theirs.id)).toEqual(theirs);
        expect(await repo.listApplications(a)).toEqual([]);
      });

      it('lists applications in the order they were created', async () => {
        const ids = [unique('app-z'), unique('app-a'), unique('app-m')];
        for (const id of ids) await repo.createApplication(application(id, a, jobId));
        expect((await repo.listApplications(a)).map((x) => x.id)).toEqual(ids);
      });
    });

    describe('events', () => {
      it('appends and lists per user, in order, with the payload intact', async () => {
        const mine = [event(unique('ev-z'), a, 'profile.updated', { cvCharacters: 12 }), event(unique('ev-a'), a, 'agent.run', { prepared: 2, nested: { ok: true }, list: [1, 2] })];
        const theirs = event(unique('ev'), b, 'passport.updated', { referees: 1 });
        for (const e of [mine[0] as DomainEvent, theirs, mine[1] as DomainEvent]) await repo.appendEvent(e);
        expect(await repo.listEvents(a)).toEqual(mine);
        expect(await repo.listEvents(b)).toEqual([theirs]);
      });

      it('keeps events that belong to no account apart from every account', async () => {
        const system = event(unique('ev'), SYSTEM_USER_ID, 'employer.job.posted', { jobId: 'employer:x' });
        await repo.appendEvent(system);
        expect(await repo.listEvents(SYSTEM_USER_ID)).toContainEqual(system);
        expect(await repo.listEvents(a)).toEqual([]);
      });
    });

    describe('notifications', () => {
      const note = (id: string, userId: string, extra: Partial<Notification> = {}): Notification => ({ id, userId, eventKey: 'agent.review_needed', category: 'AI agent', severity: 'warning', subject: 'Action needed: review Site Manager (fictional)', body: 'A draft waits for you.', createdAt: '2026-10-06T09:00:00.000Z', ...extra });

      it('stores an inbox per user, newest first, and marks read only the owner\'s', async () => {
        const [n1, n2, other] = [note(unique('n'), a), note(unique('n'), a, { severity: 'success', createdAt: '2026-10-06T09:01:00.000Z' }), note(unique('n'), b)];
        for (const n of [n1, other, n2]) await repo.saveNotification(n);
        expect(await repo.listNotifications(a)).toEqual([n2, n1]);
        expect(await repo.listNotifications(a, 1)).toEqual([n2]);
        expect(await repo.markNotificationsRead(b, [n1.id], NOW)).toBe(0); // not B's
        expect(await repo.markNotificationsRead(a, [n1.id], NOW)).toBe(1);
        expect(await repo.markNotificationsRead(a, [n1.id], NOW)).toBe(0); // already read
        expect(await repo.markNotificationsRead(a, undefined, NOW)).toBe(1);
        expect((await repo.listNotifications(a)).every((n) => n.readAt === NOW)).toBe(true);
        expect((await repo.listNotifications(b))[0]?.readAt).toBeUndefined();
      });

      it('keeps a delivery log and preferences per user; deleting the account removes them', async () => {
        const d = (id: string, userId: string, channel: NotificationDelivery['channel'], status: NotificationDelivery['status']): NotificationDelivery => ({ id, userId, eventKey: 'account.test', channel, status, provider: 'sandbox', at: NOW });
        const mine = [d(unique('d'), a, 'email', 'logged'), d(unique('d'), a, 'sms', 'skipped')];
        await repo.appendDelivery(mine[0] as NotificationDelivery); await repo.appendDelivery(d(unique('d'), b, 'inapp', 'delivered')); await repo.appendDelivery(mine[1] as NotificationDelivery);
        expect(await repo.listDeliveries(a)).toEqual([mine[1], mine[0]]);
        expect(await repo.getNotificationPreferences(a)).toBeUndefined();
        const prefs = { email: false, sms: true, push: false, whatsapp: false, muted: ['profile.saved'] };
        await repo.saveNotificationPreferences(a, prefs);
        await repo.saveNotificationPreferences(a, { ...prefs, push: true });
        expect(await repo.getNotificationPreferences(a)).toEqual({ ...prefs, push: true });
        expect(await repo.getNotificationPreferences(b)).toBeUndefined();
        await repo.saveNotification(note(unique('n'), a));
        expect(await repo.deleteUser(a)).toBe(true);
        expect(await repo.listNotifications(a)).toEqual([]);
        expect(await repo.listDeliveries(a)).toEqual([]);
        expect(await repo.getNotificationPreferences(a)).toBeUndefined();
        expect((await repo.listDeliveries(b)).length).toBe(1);
      });
    });

    describe('applying data', () => {
      let jobId: string;
      beforeEach(async () => {
        const j = job(unique('j'));
        jobId = j.id;
        await repo.upsertJobs([j]);
      });

      it('round-trips the new application fields, including the private block, and every status', async () => {
        const app = application(unique('app'), a, jobId);
        const full: Application = {
          ...app,
          status: 'needs_you',
          holdReasons: ['A declaration needs your answer: Criminal convictions'],
          dedupeKey: 'example ltd|site manager|leeds',
          tailoredCv: 'Site manager (fictional).\nLed a 40-home scheme.',
          traceFailures: ['Holds a PhD in physics.'],
          sentDocuments: { statement: 'I led a scheme. (fictional)', tailoredCv: 'Site manager (fictional).', sha256: { statement: 'a'.repeat(64), tailoredCv: 'b'.repeat(64) } },
        };
        await repo.createApplication(full);
        expect(await repo.getApplication(a, full.id)).toEqual(full);
        for (const status of ['draft', 'confirmed', 'uncertain', 'interview', 'closed'] as const) {
          await repo.updateApplication({ ...full, status });
          expect((await repo.getApplication(a, full.id))?.status).toBe(status);
        }
        const sent: Application = { ...full, status: 'submitted', submittedAt: NOW, automatic: true, holdReasons: undefined, receipt: { at: NOW, pageUrl: 'https://jobs.example.org/thanks', confirmationText: 'Application received (fictional)', documentsSha256: { statement: 'a'.repeat(64) }, automatic: true } };
        await repo.updateApplication(sent);
        expect(await repo.getApplication(a, full.id)).toEqual(sent);
        // The person's record of what came of it, and a skip, survive a round trip.
        const answered: Application = { ...sent, status: 'interview', outcome: 'interview', outcomeAt: NOW, skippedAt: NOW };
        await repo.updateApplication(answered);
        expect(await repo.getApplication(a, full.id)).toEqual(answered);
        expect(await repo.deleteApplication(b, full.id)).toBe(false); // not B's
        expect(await repo.deleteApplication(a, full.id)).toBe(true);
        expect(await repo.getApplication(a, full.id)).toBeUndefined();
      });

      it('spec T-06: the documents sent come back byte for byte (line endings, spaces, accents and symbols kept)', async () => {
        const statement = 'Première ligne (fictional).\r\n  Indented, with a trailing space \nTabs\tand NBSP\u00a0here — £1,250 · ✓ 🙂';
        const tailoredCv = 'Ligne une (fictional)\n\nLigne trois\r\n';
        const sentDocuments = { statement, tailoredCv, sha256: { statement: 'd'.repeat(64), tailoredCv: 'e'.repeat(64) } };
        const app: Application = { ...application(unique('app'), a, jobId), status: 'submitted', submittedAt: NOW, statement, tailoredCv, sentDocuments };
        await repo.createApplication(app);
        const back = await repo.getApplication(a, app.id);
        expect(Buffer.from(back?.sentDocuments?.statement ?? '', 'utf8').equals(Buffer.from(statement, 'utf8'))).toBe(true);
        expect(Buffer.from(back?.sentDocuments?.tailoredCv ?? '', 'utf8').equals(Buffer.from(tailoredCv, 'utf8'))).toBe(true);
        expect(back?.sentDocuments).toEqual(sentDocuments);
      });

      it('stores screening answers and standing authorisation per user, and removes them with the account', async () => {
        const answers = { noticePeriod: '4 weeks', relocation: true, custom: { 'years managing teams': '6 (fictional)' } };
        await repo.saveScreeningAnswers(a, answers);
        expect(await repo.getScreeningAnswers(a)).toEqual(answers);
        expect(await repo.getScreeningAnswers(b)).toBeUndefined();
        const auth = { enabled: true, scopeVersion: 'od1-2026-10-06', consentAt: NOW, paused: false };
        await repo.saveAuthorisation(a, auth);
        expect(await repo.getAuthorisation(a)).toEqual(auth);
        await repo.saveAuthorisation(a, { ...auth, enabled: false, revokedAt: NOW });
        expect((await repo.getAuthorisation(a))?.revokedAt).toBe(NOW);
        await repo.deleteUser(a);
        expect(await repo.getScreeningAnswers(a)).toBeUndefined();
        expect(await repo.getAuthorisation(a)).toBeUndefined();
      });

      it('verifies e-mail, changes the password hash, and consumes a token once, only before it expires', async () => {
        await repo.markEmailVerified(a, NOW);
        await repo.markEmailVerified(a, '2030-01-01T00:00:00.000Z'); // the first date stays
        expect((await repo.getUserById(a))?.emailVerifiedAt).toBe(NOW);
        expect((await repo.getUserById(b))?.emailVerifiedAt).toBeUndefined();
        await repo.updatePasswordHash(a, '$2b$04$fictionalhashfictionalhashfictionalhashfictiona');
        expect((await repo.getUserById(a))?.passwordHash).toBe('$2b$04$fictionalhashfictionalhashfictionalhashfictiona');
        const hash = 'c'.repeat(64);
        await repo.saveAuthToken({ id: unique('tok'), userId: a, kind: 'reset-password', tokenHash: hash, expiresAt: '2026-10-06T10:00:00.000Z', createdAt: NOW });
        expect(await repo.consumeAuthToken('verify-email', hash, NOW)).toBeUndefined(); // wrong kind
        expect(await repo.consumeAuthToken('reset-password', hash, '2026-10-06T11:00:00.000Z')).toBeUndefined(); // expired
        expect(await repo.consumeAuthToken('reset-password', hash, NOW)).toBe(a);
        expect(await repo.consumeAuthToken('reset-password', hash, NOW)).toBeUndefined(); // used
        expect(await repo.listUserIds()).toEqual(expect.arrayContaining([a, b]));
      });

      it('platform settings, one-off claims and shared rate-limit windows', async () => {
        const key = unique('setting');
        expect(await repo.getPlatformSetting(key)).toBeUndefined();
        await repo.setPlatformSetting(key, { paused: true });
        expect(await repo.getPlatformSetting(key)).toEqual({ paused: true });
        const claim = unique('claim');
        expect(await repo.claimOnce(claim, NOW)).toBe(true);
        expect(await repo.claimOnce(claim, NOW)).toBe(false);
        const rl = unique('rl');
        expect(await repo.hitRateLimit(rl, NOW)).toBe(1);
        expect(await repo.hitRateLimit(rl, NOW)).toBe(2);
        expect(await repo.hitRateLimit(rl, '2026-10-06T09:15:00.000Z')).toBe(1);
      });

      it('purgeBefore deletes records older than the cutoff and keeps newer ones (DP-5)', async () => {
        const OLD = '2026-01-01T00:00:00.000Z';
        const CUTOFF = '2026-06-01T00:00:00.000Z';
        const oldApp = { ...application(unique('app'), a, jobId), createdAt: OLD };
        const newApp = application(unique('app'), a, jobId);
        await repo.createApplication(oldApp);
        await repo.createApplication(newApp);
        const oldEv = { ...event(unique('ev'), a, 'profile.updated', {}), occurredAt: OLD };
        const newEv = event(unique('ev'), a, 'profile.updated', {});
        await repo.appendEvent(oldEv);
        await repo.appendEvent(newEv);
        await repo.saveAuthToken({ id: unique('tok'), userId: a, kind: 'verify-email', tokenHash: unique('h').padEnd(64, '0'), expiresAt: OLD, createdAt: OLD });
        const counts = await repo.purgeBefore(CUTOFF);
        expect(counts.applications).toBeGreaterThanOrEqual(1);
        expect(counts.events).toBeGreaterThanOrEqual(1);
        expect(counts.tokens).toBeGreaterThanOrEqual(1);
        expect(await repo.getApplication(a, oldApp.id)).toBeUndefined();
        expect(await repo.getApplication(a, newApp.id)).toEqual(newApp);
        const ids = (await repo.listEvents(a)).map((e) => e.id);
        expect(ids).not.toContain(oldEv.id);
        expect(ids).toContain(newEv.id);
        expect(await repo.getUserById(a)).toBeDefined(); // the account itself is never purged by age
      });

      it('stores the job contract type', async () => {
        const job = { ...(await repo.getJob(jobId))!, id: unique('sample:ct'), externalId: unique('ct'), contractType: 'contract' as const };
        await repo.upsertJobs([job]);
        expect((await repo.getJob(job.id))?.contractType).toBe('contract');
      });
    });

    describe('usage meter', () => {
      it('records per user and totals to three decimal places', async () => {
        const meter = backend.usageMeter;
        await meter.record(usage(a));
        await meter.record(usage(a, { purpose: 'interview-feedback', inputTokens: 800, outputTokens: 200, acu: 1 }));
        await meter.record(usage(b, { inputTokens: 10, outputTokens: 5, acu: 0.015 }));
        expect(await meter.list(a)).toEqual([usage(a), usage(a, { purpose: 'interview-feedback', inputTokens: 800, outputTokens: 200, acu: 1 })]);
        expect(await meter.totals(a)).toEqual({ calls: 2, inputTokens: 2000, outputTokens: 545, acu: 2.545 });
        expect(await meter.totals(b)).toEqual({ calls: 1, inputTokens: 10, outputTokens: 5, acu: 0.015 });
        expect(await meter.totals(unique('nobody'))).toEqual({ calls: 0, inputTokens: 0, outputTokens: 0, acu: 0 });
      });

      it("deletes one user's records and nobody else's", async () => {
        const meter = backend.usageMeter;
        await meter.record(usage(a));
        await meter.record(usage(b));
        await meter.deleteForUser(a);
        expect(await meter.list(a)).toEqual([]);
        expect(await meter.list(b)).toEqual([usage(b)]);
      });
    });

    describe('deleteUser', () => {
      it('removes the account and everything stored for it, and nothing of anyone else', async () => {
        const shared = job(unique('j'));
        await repo.upsertJobs([shared]);
        for (const id of [a, b]) {
          await repo.saveProfile(id, profile({ firstName: id }));
          await repo.savePassport(id, passport());
          await repo.createApplication(application(`${id}-app-1`, id, shared.id));
          await repo.createApplication(application(`${id}-app-2`, id, shared.id, { status: 'submitted', submittedAt: NOW }));
          await repo.appendEvent(event(`${id}-ev-1`, id));
          await repo.appendEvent(event(`${id}-ev-2`, id, 'agent.run'));
          await backend.usageMeter.record(usage(id));
        }

        await backend.usageMeter.deleteForUser(a);
        expect(await repo.deleteUser(a)).toBe(true);

        expect(await repo.getUserById(a)).toBeUndefined();
        expect(await repo.getUserByEmail(`${a}@example.org`)).toBeUndefined();
        expect(await repo.getProfile(a)).toBeUndefined();
        expect(await repo.getPassport(a)).toBeUndefined();
        expect(await repo.listApplications(a)).toEqual([]);
        expect(await repo.getApplication(a, `${a}-app-1`)).toBeUndefined();
        expect(await repo.listEvents(a)).toEqual([]);
        expect(await backend.usageMeter.list(a)).toEqual([]);

        expect(await repo.getUserById(b)).toEqual(user(b));
        expect((await repo.getProfile(b))?.firstName).toBe(b);
        expect(await repo.getPassport(b)).toEqual(passport());
        expect((await repo.listApplications(b)).map((x) => x.id)).toEqual([`${b}-app-1`, `${b}-app-2`]);
        expect((await repo.listEvents(b)).map((e) => e.id)).toEqual([`${b}-ev-1`, `${b}-ev-2`]);
        expect(await backend.usageMeter.list(b)).toEqual([usage(b)]);
        // Jobs are a shared catalogue, not personal data.
        expect(await repo.getJob(shared.id)).toEqual(shared);
      });

      it('returns false for an account that does not exist, and the email can be registered again afterwards', async () => {
        expect(await repo.deleteUser(unique('nobody'))).toBe(false);
        expect(await repo.deleteUser(a)).toBe(true);
        expect(await repo.deleteUser(a)).toBe(false);
        const again = user(unique('user-a2'), { email: `${a}@example.org` });
        await repo.createUser(again);
        expect(await repo.getUserByEmail(`${a}@example.org`)).toEqual(again);
        expect(await repo.getProfile(again.id)).toBeUndefined();
      });
    });
  });
}
