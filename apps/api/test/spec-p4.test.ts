import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryRepository, SYSTEM_USER_ID, createSampleSource } from '@opennjob/core';
import type { Application, Job, JobSourceAdapter } from '@opennjob/core';
import type { EmailSender } from '../src/notifications';
import { CV_TYPES } from '../src/cv';
import { createApp } from '../src/http';
import { memoryLogger } from '../src/logging';
import { Scheduler } from '../src/scheduler';
import { CV_TEXT, NOW, PASSPORT, PROFILE, USER_EMAIL, USER_ID, USER_PASSWORD, createTestApp, testConfig } from './helpers';
import type { TestApp } from './helpers';

/**
 * Spec phase 4: the scheduler (T-15, T-16, T-17, DIS-4), interview from the documents sent
 * (T-18), zero employer jobs (T-19), account deletion (T-20), e-mail verification (ACC-2),
 * password reset (ACC-3), CV upload (PRO-1), the shared rate limit (NFR-2), speed (NFR-3),
 * operator alerts (NFR-4) and retention (DP-5). Every person, employer and file is fictional.
 */

let t: TestApp;
afterEach(async () => {
  await t?.app.close();
});

const FIXTURES = join(__dirname, 'fixtures');
const OPERATOR = 'operator.alerts@example.org';

type Mail = { to: string; subject: string; text: string; html: string };
function capturing(): EmailSender & { sent: Mail[] } {
  const sent: Mail[] = [];
  return { name: 'capture', live: true, sent, send: async (m) => (sent.push(m), 'sent') };
}

/** A clock the test moves. */
function movable(start: string) {
  let now = new Date(start);
  return { clock: () => now, set: (iso: string) => (now = new Date(iso)) };
}

const STATEMENT = 'I completed medication rounds for 28 patients on an acute medical ward. I wrote and reviewed care plans with families.';
const TAILORED_CV = 'Completed medication rounds for 28 patients and acted as second checker for controlled drugs.\nWrote and reviewed care plans and kept accurate records.';
const PASSPORT_SECRET = PASSPORT.nmcPin;

function sentApplication(id: string, jobId: string, overrides: Partial<Application> = {}): Application {
  return {
    id,
    userId: USER_ID,
    jobId,
    jobTitle: 'Staff Nurse (fictional)',
    employer: 'Northfield General Hospital (fictional)',
    applyUrl: 'https://example.org/apply/1',
    mode: 'hybrid',
    status: 'submitted',
    statement: STATEMENT,
    statementSource: 'fallback',
    gaps: [],
    warnings: [],
    score: 86,
    confirmedFields: [],
    createdAt: NOW,
    submittedAt: NOW,
    tailoredCv: TAILORED_CV,
    sentDocuments: { statement: STATEMENT, tailoredCv: TAILORED_CV, sha256: { statement: 'a'.repeat(64), tailoredCv: 'b'.repeat(64) } },
    receipt: { at: NOW, pageUrl: 'https://example.org/apply/1/thanks', confirmationText: 'Application received. Reference EX-1 (fictional)', documentsSha256: {}, automatic: false },
    ...overrides,
  };
}

const ADVERT: Job = {
  id: 'employer:nurse-1',
  source: 'employer',
  externalId: 'nurse-1',
  title: 'Staff Nurse (fictional)',
  employer: 'Northfield General Hospital (fictional)',
  location: 'Birmingham',
  url: 'https://example.org/jobs/1',
  description: 'You will lead medication rounds on a busy ward. You will keep care plans up to date. Experience of tracheostomy care is desirable.',
  criteria: [
    { label: 'Medication rounds', essential: true, keywords: ['medication'] },
    { label: 'Care plans', essential: true, keywords: ['care plans'] },
    { label: 'Tracheostomy care', essential: false, keywords: ['tracheostomy'] },
  ],
  criteriaSource: 'provided',
  requiresRegistration: false,
  origin: 'employer',
};

describe('spec T-15: the report goes at 09:00 London time on the days either side of each clock change', () => {
  // 2026-10-25 and 2027-03-28 are the clock-change Sundays.
  const cases = [
    { day: 'Saturday before the autumn change (BST)', before: '2026-10-24T07:59:00.000Z', at: '2026-10-24T08:00:00.000Z' },
    { day: 'Monday after the autumn change (GMT)', before: '2026-10-26T08:59:00.000Z', at: '2026-10-26T09:00:00.000Z' },
    { day: 'Saturday before the spring change (GMT)', before: '2027-03-27T08:59:00.000Z', at: '2027-03-27T09:00:00.000Z' },
    { day: 'Monday after the spring change (BST)', before: '2027-03-29T07:59:00.000Z', at: '2027-03-29T08:00:00.000Z' },
  ];
  for (const c of cases) {
    it(`${c.day}: nothing at 08:59 London, one report at 09:00, not a second one later that day`, async () => {
      const time = movable(c.before);
      const sender = capturing();
      t = await createTestApp({ sources: [], clock: time.clock, emailSender: sender });
      const scheduler = t.app.get(Scheduler);
      expect((await scheduler.tick()).filter((r) => r.startsWith('report'))).toEqual([]);
      time.set(c.at);
      expect(await scheduler.tick()).toContain(`report:${USER_ID}`);
      time.set(new Date(new Date(c.at).getTime() + 3 * 3_600_000).toISOString());
      expect((await scheduler.tick()).filter((r) => r.startsWith('report'))).toEqual([]);
      expect(sender.sent.filter((m) => m.to === USER_EMAIL)).toHaveLength(1);
    });
  }
});

describe('spec T-16: a quiet day still sends a report that says nothing happened', () => {
  it('sends "Nothing happened since your last report." and records the event with zero counts', async () => {
    const sender = capturing();
    t = await createTestApp({ sources: [], emailSender: sender });
    await t.app.get(Scheduler).report(USER_ID);
    const mail = sender.sent.find((m) => m.to === USER_EMAIL);
    expect(mail?.text).toContain('Nothing happened since your last report.');
    const event = (await t.deps.repository.listEvents(USER_ID)).find((e) => e.type === 'report.daily');
    expect(event?.payload).toEqual({ submitted: 0, held: 0, uncertain: 0, matches: 0, failures: 0 });
  });

  it('REP-4: the person can pause the report e-mail; it is then not sent', async () => {
    const sender = capturing();
    t = await createTestApp({ sources: [], emailSender: sender });
    await t.api.put('/notifications/preferences').send({ email: true, sms: false, push: false, whatsapp: false, muted: ['agent.daily_report'] }).expect(200);
    await t.app.get(Scheduler).report(USER_ID);
    expect(sender.sent.filter((m) => m.to === USER_EMAIL)).toEqual([]);
  });

  it('the next report starts where the last one ended (watermark), so nothing is reported twice', async () => {
    const time = movable('2026-10-06T08:00:00.000Z');
    const sender = capturing();
    t = await createTestApp({ sources: [], clock: time.clock, emailSender: sender });
    await t.deps.repository.upsertJobs([ADVERT]);
    await t.deps.repository.createApplication(sentApplication('app-1', ADVERT.id));
    await t.deps.repository.appendEvent({ id: 'ev-1', type: 'application.submitted', userId: USER_ID, occurredAt: '2026-10-06T07:00:00.000Z', payload: { applicationId: 'app-1' } });
    const scheduler = t.app.get(Scheduler);
    await scheduler.report(USER_ID);
    expect(sender.sent.at(-1)?.text).toContain('Submitted, with the site\'s confirmation: 1');
    time.set('2026-10-07T08:00:00.000Z');
    await scheduler.report(USER_ID);
    expect(sender.sent.at(-1)?.text).toContain('Submitted, with the site\'s confirmation: 0');
  });
});

describe('spec T-17: no CV text, credential or statement in the report or the logs', () => {
  it('the report names the job, employer, status and reason only', async () => {
    const sender = capturing();
    const logger = memoryLogger();
    t = await createTestApp({ sources: [], emailSender: sender, logger });
    await t.api.put('/profile').send(PROFILE).expect(200);
    await t.api.put('/passport').send(PASSPORT).expect(200);
    await t.deps.repository.upsertJobs([ADVERT]);
    await t.deps.repository.createApplication(sentApplication('app-1', ADVERT.id));
    await t.deps.repository.createApplication(sentApplication('app-2', ADVERT.id, { status: 'needs_you', holdReasons: ['sensitive:convictions'], receipt: undefined, sentDocuments: undefined }));
    await t.deps.repository.appendEvent({ id: 'ev-1', type: 'application.submitted', userId: USER_ID, occurredAt: NOW, payload: { applicationId: 'app-1' } });
    await t.app.get(Scheduler).report(USER_ID);
    const mail = sender.sent.find((m) => m.to === USER_EMAIL);
    expect(mail?.text).toContain('Staff Nurse (fictional)');
    expect(mail?.text).toContain('Held for you: 1');
    const everything = JSON.stringify([sender.sent, logger.lines, await t.deps.repository.listEvents(USER_ID)]);
    const secrets = [PASSPORT_SECRET, PASSPORT.dbs.certificateNumber, PROFILE.phone, PROFILE.addressLine1, ...CV_TEXT.split('\n'), ...STATEMENT.split('. ')];
    for (const secret of secrets) expect(everything, secret).not.toContain(secret);
  });
});

describe('spec T-18: interview preparation quotes the advert and the documents this application sent', () => {
  it('every quote is exact, a criterion the documents missed is a gap, and an unsent application has none', async () => {
    t = await createTestApp({ sources: [] });
    await t.deps.repository.upsertJobs([ADVERT]);
    await t.deps.repository.createApplication(sentApplication('app-1', ADVERT.id));
    await t.deps.repository.createApplication(sentApplication('app-2', ADVERT.id, { status: 'draft', sentDocuments: undefined, receipt: undefined }));
    const body = (await t.api.get('/applications/app-1/interview').expect(200)).body;
    expect(body.documentsSha256).toEqual({ statement: 'a'.repeat(64), tailoredCv: 'b'.repeat(64) });
    expect(body.questions.length).toBe(3);
    for (const q of body.questions) {
      if (q.advertQuote) expect(ADVERT.description).toContain(q.advertQuote);
      if (q.documentQuote) expect(q.documentQuote.document === 'statement' ? STATEMENT : TAILORED_CV).toContain(q.documentQuote.text);
    }
    expect(body.questions[0]).toMatchObject({ criterion: 'Medication rounds', essential: true, documentQuote: { document: 'statement' } });
    expect(body.gaps).toEqual(['Tracheostomy care']);
    expect(body.questions.find((q: { criterion: string }) => q.criterion === 'Tracheostomy care').question).toMatch(/did not cover it/);

    await t.api.get('/applications/app-2/interview').expect(409);
    const fb = (await t.api.post('/applications/app-1/interview/feedback').send({ questionId: 'doc-1', answer: 'On a night shift I led the medication round, checked each chart and the result was no missed doses.' }).expect(200)).body;
    expect(fb.feedback.total).toEqual(expect.any(Number));
    await t.api.post('/applications/app-1/interview/feedback').send({ questionId: 'doc-99', answer: 'x' }).expect(404);
    await t.api.post('/applications/app-1/interview/feedback').send({ questionId: 'doc-1', answer: 'x', userId: 'someone' }).expect(400);
  });
});

describe('spec T-19: the product works with zero employer jobs', () => {
  it('matches and drafts come from discovered jobs alone', async () => {
    t = await createTestApp({ sources: [createSampleSource()] });
    await t.api.put('/profile').send(PROFILE).expect(200);
    await t.api.put('/passport').send(PASSPORT).expect(200);
    await t.api.post('/jobs/refresh').expect(200);
    const jobs = await t.deps.repository.listJobs();
    expect(jobs.filter((j) => j.origin === 'employer')).toEqual([]);
    const matches = (await t.api.get('/jobs/matches').expect(200)).body;
    expect(matches.length).toBeGreaterThan(0);
    const run = (await t.api.post('/agent/run').send({ mode: 'hybrid' }).expect(200)).body;
    expect(run.considered).toBeGreaterThan(0);
  });
});

describe('spec T-20: deleting the account removes receipts, documents and screening answers', () => {
  it('leaves nothing of the person in the repository', async () => {
    t = await createTestApp({ sources: [] });
    await t.api.put('/profile').send(PROFILE).expect(200);
    await t.api.put('/screening').send({ noticePeriod: 'Four weeks', relocation: false }).expect(200);
    await t.deps.repository.upsertJobs([ADVERT]);
    await t.deps.repository.createApplication(sentApplication('app-1', ADVERT.id));
    expect(await t.deps.repository.getScreeningAnswers(USER_ID)).toBeDefined();
    await t.api.delete('/account').send({ password: USER_PASSWORD }).expect(200);
    expect(await t.deps.repository.getApplication(USER_ID, 'app-1')).toBeUndefined();
    expect(await t.deps.repository.listApplications(USER_ID)).toEqual([]);
    expect(await t.deps.repository.getScreeningAnswers(USER_ID)).toBeUndefined();
    expect(await t.deps.repository.getProfile(USER_ID)).toBeUndefined();
    expect(await t.deps.repository.getUserById(USER_ID)).toBeUndefined();
  });
});

describe('ACC-2: an e-mail address is verified before the agent submits anything', () => {
  const REGISTER = { email: 'kwame.mensah@example.org', password: 'another fictional passphrase', acceptedTermsVersion: 'terms-test-1', acceptedPrivacyVersion: 'privacy-test-1' };
  const tokenIn = (mails: Mail[]) => mails.map((m) => /(?:token=|code: )([A-Za-z0-9_-]{32,128})/.exec(m.text)?.[1]).find(Boolean);

  it('register sends a one-time link; the link verifies once; only its hash is stored; the link is never in-app', async () => {
    const sender = capturing();
    t = await createTestApp({ sources: [], emailSender: sender, config: testConfig({ brand: { name: 'OpennJob', colour: '#0F766E', footer: 'Fictional footer', appUrl: 'https://app.example.org' } }) });
    const reg = (await t.raw().post('/auth/register').send(REGISTER).expect(201)).body;
    expect(reg.user.emailVerified).toBe(false);
    expect(sender.sent.filter((m) => m.to === REGISTER.email).map((m) => m.text).join('\n')).toMatch(/https:\/\/app\.example\.org\/verify-email\/\?token=/);
    const token = tokenIn(sender.sent.filter((m) => m.to === REGISTER.email));
    expect(token).toBeDefined();
    const me = t.as(reg.accessToken);
    // Nothing is queued for an unverified address, even with authorisation on.
    const scopeVersion = (await me.get('/agent/authorisation').expect(200)).body.scope.version;
    await me.put('/agent/authorisation').send({ enabled: true, scopeVersion }).expect(200);
    expect((await me.get('/agent/queue/next').expect(200)).body.wait).toBe('email-unverified');
    const inbox = JSON.stringify((await me.get('/notifications').expect(200)).body);
    expect(inbox).not.toContain(token as string);

    await t.raw().post('/auth/verify-email').send({ token }).expect(200);
    await t.raw().post('/auth/verify-email').send({ token }).expect(400); // used
    expect((await me.get('/account').expect(200)).body.emailVerified).toBe(true);
    expect((await me.get('/agent/queue/next').expect(200)).body.wait).not.toBe('email-unverified');
    // Only the SHA-256 of the token is stored.
    expect(JSON.stringify((t.deps.repository as unknown as { tokens: unknown[] }).tokens)).not.toContain(token as string);
    expect(JSON.stringify((t.deps.repository as unknown as { tokens: unknown[] }).tokens)).toMatch(/"tokenHash":"[0-9a-f]{64}"/);
  });

  it('a wrong or malformed token is refused; resending is rate-limited and needs a token', async () => {
    const sender = capturing();
    t = await createTestApp({ sources: [], emailSender: sender });
    const reg = (await t.raw().post('/auth/register').send(REGISTER).expect(201)).body;
    await t.raw().post('/auth/verify-email').send({ token: 'x'.repeat(43) }).expect(400);
    await t.raw().post('/auth/verify-email').send({ token: 'short' }).expect(400);
    await t.raw().post('/account/verification').send({}).expect(401);
    expect((await t.as(reg.accessToken).post('/account/verification').send({}).expect(200)).body).toEqual({ verified: false, sent: true });
    await t.as(reg.accessToken).post('/account/verification').send({}).expect(409); // a second link within the minute
  });
});

describe('ACC-3: password reset by a one-time link; the reset ends every earlier session', () => {
  it('always answers the same, resets once, and refuses tokens signed before the reset', async () => {
    const sender = capturing();
    t = await createTestApp({ sources: [], emailSender: sender });
    const login = (await t.raw().post('/auth/login').send({ email: USER_EMAIL, password: USER_PASSWORD }).expect(200)).body;
    const old = t.as(login.accessToken);
    await old.get('/account').expect(200);

    const unknown = (await t.raw().post('/auth/password/forgot').send({ email: 'nobody@example.org' }).expect(200)).body;
    const known = (await t.raw().post('/auth/password/forgot').send({ email: USER_EMAIL }).expect(200)).body;
    expect(unknown).toEqual(known); // no account enumeration
    expect(sender.sent.filter((m) => m.to === 'nobody@example.org')).toEqual([]);
    // No app address configured: the e-mail carries the code itself.
    const token = sender.sent.filter((m) => m.to === USER_EMAIL).map((m) => /code: ([A-Za-z0-9_-]{32,128})/.exec(m.text)?.[1]).find(Boolean);
    expect(token).toBeDefined();

    await t.raw().post('/auth/password/reset').send({ token, password: 'short' }).expect(400);
    const reset = await t.raw().post('/auth/password/reset').send({ token, password: 'a brand new fictional passphrase' });
    expect(reset.status, JSON.stringify(reset.body)).toBe(200);
    await t.raw().post('/auth/password/reset').send({ token, password: 'yet another fictional passphrase' }).expect(400);
    await old.get('/account').expect(401);
    await t.raw().post('/auth/login').send({ email: USER_EMAIL, password: USER_PASSWORD }).expect(401);
    const fresh = (await t.raw().post('/auth/login').send({ email: USER_EMAIL, password: 'a brand new fictional passphrase' }).expect(200)).body;
    await t.as(fresh.accessToken).get('/account').expect(200);
    expect((await t.deps.repository.listEvents(USER_ID)).map((e) => e.type)).toContain('account.password_changed');
  });
});

describe('PRO-1: a CV uploaded as PDF or Word becomes text the person checks; the file is not stored', () => {
  for (const [file, type, format] of [['cv-fictional.pdf', CV_TYPES.pdf, 'pdf'], ['cv-fictional.docx', CV_TYPES.docx, 'docx']] as const) {
    it(`${format}: text, suggestions and a warning to check every line`, async () => {
      t = await createTestApp({ sources: [] });
      const bytes = readFileSync(join(FIXTURES, file));
      const body = (await t.api.post('/profile/cv').set('Content-Type', type).send(bytes).expect(200)).body;
      expect(body.format).toBe(format);
      expect(body.text).toContain('Completed medication rounds for 28 patients');
      expect(body.suggestions).toMatchObject({ firstName: 'Amara', lastName: 'Okafor', email: 'amara.okafor@example.org', phone: '07700 900123', postcode: 'B1 1AA' });
      expect(body.warnings.join(' ')).toMatch(/Check every line/);
      if (format === 'pdf') expect(body.pages).toBe(2);
      expect(await t.deps.repository.getProfile(USER_ID)).toBeUndefined(); // nothing saved until the person saves
      const events = await t.deps.repository.listEvents(USER_ID);
      expect(JSON.stringify(events)).not.toContain('medication');
      expect(events.find((e) => e.type === 'profile.cv_extracted')?.payload).toMatchObject({ format });
    });
  }

  it('refuses another type, an empty body, a file that is not a CV format, and a token-less request', async () => {
    t = await createTestApp({ sources: [] });
    await t.api.post('/profile/cv').set('Content-Type', 'text/plain').send('Amara Okafor').expect(400);
    await t.api.post('/profile/cv').set('Content-Type', CV_TYPES.pdf).send(Buffer.from('not a pdf at all')).expect(400);
    await t.api.post('/profile/cv').set('Content-Type', CV_TYPES.pdf).send(Buffer.from('%PDF-1.4 broken')).expect(400);
    await t.raw().post('/profile/cv').set('Content-Type', CV_TYPES.pdf).send(readFileSync(join(FIXTURES, 'cv-fictional.pdf'))).expect(401);
  });
});

describe('NFR-2: the sign-in rate limit is shared by every API instance', () => {
  it('two app instances over one store count the same attempts', async () => {
    const repository = new InMemoryRepository();
    t = await createTestApp({ sources: [], repository, config: testConfig({ authRateLimitMax: 3 }) });
    const second = await createApp({ ...t.deps, notifier: undefined });
    await second.init();
    try {
      const { default: request } = await import('supertest');
      const wrong = { email: USER_EMAIL, password: 'not the password at all' };
      await t.raw().post('/auth/login').send(wrong).expect(401);
      await request(second.getHttpServer()).post('/auth/login').send(wrong).expect(401);
      await t.raw().post('/auth/login').send(wrong).expect(401);
      await request(second.getHttpServer()).post('/auth/login').send(wrong).expect(429);
    } finally {
      await second.close();
    }
  });
});

describe('NFR-3: matches for 5,000 jobs come back in under a second', () => {
  it('times GET /jobs/matches over 5,000 stored jobs', async () => {
    t = await createTestApp({ sources: [] });
    await t.api.put('/profile').send(PROFILE).expect(200);
    await t.api.put('/passport').send(PASSPORT).expect(200);
    const jobs: Job[] = Array.from({ length: 5000 }, (_, i) => ({ ...ADVERT, id: `employer:perf-${i}`, externalId: `perf-${i}`, title: `Staff Nurse ${i} (fictional)`, origin: 'discovered' }));
    await t.deps.repository.upsertJobs(jobs);
    await t.api.get('/jobs/matches').expect(200); // warm-up
    const start = performance.now();
    const res = await t.api.get('/jobs/matches').expect(200);
    const ms = performance.now() - start;
    expect(res.body.length).toBeGreaterThan(0);
    expect(ms).toBeLessThan(1000);
  });
});

describe('NFR-4: a failed discovery source raises one operator alert per hour', () => {
  it('e-mails the operator with the source label only, then stays quiet for the hour', async () => {
    const sender = capturing();
    const broken: JobSourceAdapter = { name: 'greenhouse', label: 'greenhouse:example-broken', fetchJobs: async () => { throw new Error('connect ECONNREFUSED 10.0.0.1 secret-in-driver-message'); } };
    const time = movable('2026-10-06T06:30:00.000Z');
    t = await createTestApp({ sources: [broken], clock: time.clock, emailSender: sender, config: testConfig({ operatorEmail: OPERATOR }) });
    const scheduler = t.app.get(Scheduler);
    await scheduler.discovery();
    await scheduler.discovery();
    const alerts = sender.sent.filter((m) => m.to === OPERATOR);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.subject).toMatch(/Job sources failed/);
    expect(alerts[0]?.text).toContain('greenhouse:example-broken');
    expect(alerts[0]?.text).not.toContain('secret-in-driver-message');
    time.set('2026-10-06T07:30:00.000Z');
    await scheduler.discovery();
    expect(sender.sent.filter((m) => m.to === OPERATOR)).toHaveLength(2);
    // the report counts the failure for the person
    await scheduler.report(USER_ID);
    expect(sender.sent.find((m) => m.to === USER_EMAIL)?.text).toMatch(/Problems: \d+ discovery run/);
  });

  it('DIS-4: the daily discovery prepares drafts for an active account and runs once per London day', async () => {
    const time = movable('2026-10-06T05:59:00.000Z'); // 06:59 London (BST)
    t = await createTestApp({ sources: [createSampleSource()], clock: time.clock });
    await t.api.put('/profile').send(PROFILE).expect(200);
    await t.api.put('/passport').send(PASSPORT).expect(200);
    const scheduler = t.app.get(Scheduler);
    time.set('2026-10-06T04:59:00.000Z'); // 05:59 London
    expect(await scheduler.tick()).not.toContain('discovery');
    time.set('2026-10-06T05:00:00.000Z'); // 06:00 London
    expect(await scheduler.tick()).toContain('discovery');
    expect(await scheduler.tick()).not.toContain('discovery');
    expect((await t.deps.repository.listApplications(USER_ID)).length).toBeGreaterThan(0);
    expect((await t.deps.repository.listEvents(SYSTEM_USER_ID)).map((e) => e.type)).toContain('jobs.refreshed');
  });
});

describe('DP-5: records older than the retention period are deleted', () => {
  it('runs once a day after 03:00 London when OPENNJOB_RETENTION_DAYS is set, and not at all when it is not', async () => {
    const time = movable('2026-10-06T02:30:00.000Z'); // 03:30 London
    t = await createTestApp({ sources: [], clock: time.clock, config: testConfig({ retentionDays: 30 }) });
    await t.deps.repository.upsertJobs([ADVERT]);
    await t.deps.repository.createApplication(sentApplication('old', ADVERT.id, { createdAt: '2026-08-01T00:00:00.000Z' }));
    await t.deps.repository.createApplication(sentApplication('new', ADVERT.id, { createdAt: '2026-10-01T00:00:00.000Z' }));
    const scheduler = t.app.get(Scheduler);
    expect(await scheduler.tick()).toContain('retention');
    expect(await scheduler.tick()).not.toContain('retention');
    expect((await t.deps.repository.listApplications(USER_ID)).map((a) => a.id)).toEqual(['new']);
    const purged = (await t.deps.repository.listEvents(SYSTEM_USER_ID)).find((e) => e.type === 'retention.purged');
    expect(purged?.payload).toMatchObject({ days: 30, applications: 1 });
    await t.app.close();

    t = await createTestApp({ sources: [], clock: time.clock });
    await t.deps.repository.upsertJobs([ADVERT]);
    await t.deps.repository.createApplication(sentApplication('old', ADVERT.id, { createdAt: '2026-08-01T00:00:00.000Z' }));
    expect(await t.app.get(Scheduler).tick()).not.toContain('retention');
    expect(await t.deps.repository.listApplications(USER_ID)).toHaveLength(1);
  });
});
