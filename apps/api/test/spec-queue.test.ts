import { afterEach, describe, expect, it } from 'vitest';
import { STANDING_SCOPE_TEXT, STANDING_SCOPE_VERSION } from '@opennjob/core';
import type { Application } from '@opennjob/core';
import { signAccessToken } from '../src/auth';
import type { OpennJobDeps } from '../src/deps';
import { JWT_SECRET, NOW, PASSPORT, PROFILE, USER_ID, createTestApp, testConfig } from './helpers';
import type { TestApp } from './helpers';

/**
 * Applying on the person's behalf, at the API (spec section 7.2): T-07, T-08, T-09, T-11,
 * T-12, T-13, T-14 and T-22, plus APP-2 (authorisation) and APP-9 (application systems).
 * The extension side of the same cases runs in apps/extension/test/e2e/queue.spec.ts.
 * Every person, employer and form here is fictional.
 */

let t: TestApp;
afterEach(async () => {
  await t?.app.close();
});

const EMPLOYER_KEY = 'employer-key-not-a-secret';
const OPERATOR_KEY = 'operator-key-not-a-secret';
const FORM = 'http://127.0.0.1:8123/apply';
const RECEIPT = { pageUrl: `${FORM}/thanks`, confirmationText: 'Thank you. Your application has been received. (fictional)', documentsSha256: { statement: 'a'.repeat(64) } };

const operator = () => t.as(OPERATOR_KEY);
const employerPost = (body: object) => t.raw().post('/employer/jobs').set('Authorization', `Bearer ${EMPLOYER_KEY}`).send(body);

function vacancy(n: number, applyUrl = `${FORM}/${n}`) {
  return {
    title: `Care Assistant ${n} (fictional)`,
    employer: `Moorside Care ${n} (fictional)`,
    description: 'A fictional vacancy.',
    country: 'gb',
    city: 'Leeds',
    applyUrl,
    criteria: [
      { label: 'Medication rounds', essential: true, keywords: ['medication'] },
      { label: 'Care plans', essential: true, keywords: ['care plans'] },
    ],
  };
}

/** A person with n queued auto-mode applications on the fictional forms' host. */
async function queued(n: number, overrides: Partial<OpennJobDeps> = {}, config: Partial<OpennJobDeps['config']> = {}): Promise<Application[]> {
  t = await createTestApp({ sources: [], config: testConfig({ employerKey: EMPLOYER_KEY, operatorKey: OPERATOR_KEY, ...config }), ...overrides });
  await t.api.put('/profile').send(PROFILE).expect(200);
  await t.api.put('/passport').send(PASSPORT).expect(200);
  const apps: Application[] = [];
  for (let i = 1; i <= n; i += 1) {
    const job = (await employerPost(vacancy(i)).expect(201)).body;
    apps.push((await t.api.post('/applications').send({ jobId: job.id, mode: 'auto' }).expect(201)).body);
  }
  await operator().put('/operator/systems/local-fixture').send({ enabled: true, termsCheckedAt: NOW, supervisedSubmissionAt: NOW, note: 'fictional test forms' }).expect(200);
  await t.api.put('/agent/authorisation').send({ enabled: true, scopeVersion: STANDING_SCOPE_VERSION }).expect(200);
  return apps;
}

describe('APP-2: standing authorisation is explicit, dated, to a named wording, and revocable', () => {
  it('is off until the person agrees to the current wording; revoking is one call and is dated', async () => {
    t = await createTestApp({ config: testConfig({ operatorKey: OPERATOR_KEY }) });
    const before = (await t.api.get('/agent/authorisation').expect(200)).body;
    expect(before).toMatchObject({ enabled: false, scope: { version: STANDING_SCOPE_VERSION, text: STANDING_SCOPE_TEXT } });
    expect(STANDING_SCOPE_TEXT).toMatch(/no declaration and no other sensitive question/);

    await t.api.put('/agent/authorisation').send({ enabled: true }).expect(400);
    await t.api.put('/agent/authorisation').send({ enabled: true, scopeVersion: 'an-older-wording' }).expect(400);
    await t.api.put('/agent/authorisation').send({ enabled: true, scopeVersion: STANDING_SCOPE_VERSION, userId: 'someone' }).expect(400);
    const on = (await t.api.put('/agent/authorisation').send({ enabled: true, scopeVersion: STANDING_SCOPE_VERSION }).expect(200)).body;
    expect(on).toMatchObject({ enabled: true, scopeVersion: STANDING_SCOPE_VERSION, consentAt: NOW, paused: false });

    const off = (await t.api.put('/agent/authorisation').send({ enabled: false }).expect(200)).body;
    expect(off).toMatchObject({ enabled: false, consentAt: NOW, revokedAt: NOW });
    const types = (await t.deps.repository.listEvents(USER_ID)).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['agent.authorised', 'agent.authorisation_revoked']));
  });

  it('consent to an earlier wording does not count', async () => {
    t = await createTestApp();
    await t.deps.repository.saveAuthorisation(USER_ID, { enabled: true, scopeVersion: 'od1-2026-01-01', consentAt: NOW, paused: false });
    expect((await t.api.get('/agent/authorisation').expect(200)).body.enabled).toBe(false);
    expect((await t.api.get('/agent/queue/next').expect(200)).body.wait).toBe('not-authorised');
  });
});

describe('OD-6: the declarations the person answered once go to the queue', () => {
  it('saves them with the screening answers and hands them out with the next application; free-text declarations are still refused', async () => {
    await queued(1);
    const declarations = { everConvicted: false, conflictOfInterest: false, certifyAndConsent: true, equalityPreferNotToSay: true };
    await t.api.put('/screening').send({ declarations: { ...declarations, extra: true }, custom: {} }).expect(400); // .strict()
    await t.api.put('/screening').send({ declarations, custom: {} }).expect(200);
    expect((await t.api.get('/screening').expect(200)).body.declarations).toEqual(declarations);
    expect((await t.api.get('/agent/queue/next').expect(200)).body.declarations).toEqual(declarations);
    await t.api.put('/screening').send({ custom: { 'Do you have any criminal convictions?': 'No' } }).expect(400);
  });
});

describe('spec T-07: with standing authorisation on, a form with no sensitive field is submitted without approval', () => {
  it('hands out the next application with what may be filled, gives the go once, and records the receipt', async () => {
    const [app] = await queued(1);
    const next = (await t.api.get('/agent/queue/next').expect(200)).body;
    expect(next.application).toMatchObject({ id: app?.id, applyUrl: `${FORM}/1` });
    expect(next.values).toMatchObject({ firstName: PROFILE.firstName, supportingStatement: app?.statement });

    expect((await t.api.post(`/agent/queue/${app?.id}/go`).expect(200)).body).toEqual({ go: true });
    expect((await t.api.post(`/agent/queue/${app?.id}/go`).expect(200)).body).toMatchObject({ go: false, reason: 'not-queued' });
    const sent = (await t.api.post(`/agent/queue/${app?.id}/result`).send({ outcome: 'submitted', receipt: RECEIPT }).expect(200)).body as Application;
    expect(sent).toMatchObject({ status: 'submitted', automatic: true, confirmedFields: [], receipt: { ...RECEIPT, at: NOW, automatic: true } });
    expect(sent.sentDocuments?.statement).toBe(app?.statement);
    expect((await t.api.get('/agent/queue/next').expect(200)).body.wait).toBe('empty');
  });

  it('a draft held by the truth check, or in hybrid or review mode, is never handed out', async () => {
    const [app] = await queued(1);
    await t.api.put(`/applications/${app?.id}/statement`).send({ statement: 'I hold an MSc in nursing.' }).expect(200);
    expect((await t.api.get('/agent/queue/next').expect(200)).body.wait).toBe('empty');
    const job = (await employerPost(vacancy(9)).expect(201)).body;
    await t.api.post('/applications').send({ jobId: job.id, mode: 'hybrid' }).expect(201);
    expect((await t.api.get('/agent/queue/next').expect(200)).body.wait).toBe('empty');
  });
});

describe('spec T-08: with standing authorisation on, a form with any sensitive field is not submitted and shows as "needs you"', () => {
  it('the held report moves the application to needs_you with the reasons, and it leaves the queue', async () => {
    const [app] = await queued(1);
    const held = (await t.api.post(`/agent/queue/${app?.id}/result`).send({ outcome: 'held', reasons: ['sensitive:convictions', 'sensitive:right-to-work'] }).expect(200)).body;
    expect(held).toMatchObject({ status: 'needs_you', holdReasons: ['sensitive:convictions', 'sensitive:right-to-work'] });
    expect((await t.api.get('/agent/queue/next').expect(200)).body.wait).toBe('empty');
    // Without the go, nothing can be recorded as sent by the agent.
    await t.api.post(`/agent/queue/${app?.id}/result`).send({ outcome: 'submitted', receipt: RECEIPT }).expect(409);
    expect((await t.api.get('/agent/status').expect(200)).body.queue).toMatchObject({ ready: 0, needsYou: 1 });
  });
});

describe('spec T-09: revoking standing authorisation stops the next submission, including one already queued', () => {
  it('an application handed out before the revocation gets no go', async () => {
    const [app] = await queued(1);
    expect((await t.api.get('/agent/queue/next').expect(200)).body.application.id).toBe(app?.id);
    await t.api.put('/agent/authorisation').send({ enabled: false }).expect(200);
    expect((await t.api.post(`/agent/queue/${app?.id}/go`).expect(200)).body).toMatchObject({ go: false, reason: 'not-authorised' });
    expect((await t.api.get('/agent/queue/next').expect(200)).body.wait).toBe('not-authorised');
    expect((await t.api.get(`/applications/${app?.id}`).expect(200)).body).toMatchObject({ status: 'draft' });
  });
});

describe('spec T-11: a submission with no confirmation from the site is not marked submitted', () => {
  it('a result with no confirmation text is refused; "uncertain" is recorded and never retried', async () => {
    const [app] = await queued(1);
    await t.api.post(`/agent/queue/${app?.id}/go`).expect(200);
    await t.api.post(`/agent/queue/${app?.id}/result`).send({ outcome: 'submitted', receipt: { pageUrl: RECEIPT.pageUrl } }).expect(400);
    await t.api.post(`/agent/queue/${app?.id}/result`).send({ outcome: 'submitted', receipt: { ...RECEIPT, confirmationText: '' } }).expect(400);
    const uncertain = (await t.api.post(`/agent/queue/${app?.id}/result`).send({ outcome: 'uncertain', pageUrl: `${FORM}/1` }).expect(200)).body;
    expect(uncertain.status).toBe('uncertain');
    expect(uncertain.submittedAt).toBeUndefined();
    expect(uncertain.receipt).toBeUndefined();
    expect((await t.api.get('/agent/queue/next').expect(200)).body.wait).toBe('empty');
    expect((await t.api.post(`/agent/queue/${app?.id}/go`).expect(200)).body.go).toBe(false);
  });
});

describe('spec T-12: the application after the daily limit is reached is held until the next day', () => {
  it('stops at the limit and starts again at London midnight', async () => {
    let now = new Date('2026-10-06T21:00:00.000Z'); // 22:00 in London
    const clock = () => new Date(now);
    const apps = await queued(3, { clock }, { dailyApplicationLimit: 2 });
    const sent: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const next = (await t.api.get('/agent/queue/next').expect(200)).body;
      expect((await t.api.post(`/agent/queue/${next.application.id}/go`).expect(200)).body.go).toBe(true);
      await t.api.post(`/agent/queue/${next.application.id}/result`).send({ outcome: 'submitted', receipt: RECEIPT }).expect(200);
      sent.push(next.application.id);
    }
    const left = apps.find((a) => !sent.includes(a.id));
    const third = (await t.api.get('/agent/queue/next').expect(200)).body;
    expect(third).toMatchObject({ wait: 'daily-limit', resetsAt: '2026-10-06T23:00:00.000Z' });
    expect((await t.api.post(`/agent/queue/${left?.id}/go`).expect(200)).body).toMatchObject({ go: false, reason: 'daily-limit' });

    now = new Date('2026-10-06T23:00:00.000Z');
    const tomorrow = t.as(signAccessToken(USER_ID, JWT_SECRET, 3600, now).accessToken);
    expect((await tomorrow.get('/agent/queue/next').expect(200)).body.application.id).toBe(left?.id);
  });
});

describe('spec T-13: a CAPTCHA or login wall stops the agent with a stated reason', () => {
  it('records the reason as a hold the person can read', async () => {
    const [captcha, login] = await queued(2);
    await t.api.post(`/agent/queue/${captcha?.id}/result`).send({ outcome: 'held', reasons: ['captcha'] }).expect(200);
    await t.api.post(`/agent/queue/${login?.id}/result`).send({ outcome: 'held', reasons: ['login-wall'] }).expect(200);
    const list = (await t.api.get('/applications').expect(200)).body as Application[];
    expect(list.map((a) => [a.status, a.holdReasons])).toEqual(expect.arrayContaining([['needs_you', ['captcha']], ['needs_you', ['login-wall']]]));
  });
});

describe('spec T-14: stored screening answers', () => {
  it('ordinary answers are stored and handed to the extension; declarations are refused', async () => {
    await queued(1);
    const saved = (await t.api.put('/screening').send({ noticePeriod: '4 weeks', relocation: false, drivingLicence: true, custom: { 'Can you work weekends?': 'Yes' } }).expect(200)).body;
    expect(saved).toEqual({ noticePeriod: '4 weeks', relocation: false, drivingLicence: true, custom: { 'Can you work weekends?': 'Yes' } });
    const next = (await t.api.get('/agent/queue/next').expect(200)).body;
    expect(next.values).toMatchObject({ noticePeriod: '4 weeks', relocation: false, drivingLicence: true });
    expect(next.custom).toEqual({ 'can you work weekends': 'Yes' });

    for (const question of ['Do you have any unspent criminal convictions?', 'Will you need visa sponsorship?', 'I declare that the information is true', 'What is your ethnic group?', 'Do you have a disability?']) {
      const res = await t.api.put('/screening').send({ custom: { [question]: 'No' } }).expect(400);
      expect(JSON.stringify(res.body)).toMatch(/not stored/);
    }
    expect((await t.api.get('/screening').expect(200)).body.custom).toEqual({ 'Can you work weekends?': 'Yes' });
    await t.api.put('/screening').send({ noticePeriod: '' }).expect(400);
    await t.api.put('/screening').send({ custom: {}, userId: 'x' }).expect(400);
  });

  it('an unknown question holds the application; the answer is saved for next time and the hold is lifted', async () => {
    const [app] = await queued(1);
    await t.api.post(`/agent/queue/${app?.id}/result`).send({ outcome: 'held', reasons: ['question:Are you able to work nights?'] }).expect(200);
    await t.api.post(`/applications/${app?.id}/answer`).send({ question: 'Have you ever been convicted of an offence?', answer: 'No' }).expect(400);
    const released = (await t.api.post(`/applications/${app?.id}/answer`).send({ question: 'Are you able to work nights?', answer: 'Yes, two a week' }).expect(200)).body;
    expect(released.status).toBe('draft');
    expect(released.holdReasons).toBeUndefined();
    expect((await t.api.get('/screening').expect(200)).body.custom).toEqual({ 'Are you able to work nights?': 'Yes, two a week' });
    const next = (await t.api.get('/agent/queue/next').expect(200)).body;
    expect(next.application.id).toBe(app?.id);
    expect(next.custom).toEqual({ 'are you able to work nights': 'Yes, two a week' });
  });
});

describe('spec T-22: pausing the agent, per person and for everyone, stops submissions within one queue step', () => {
  it("the person's pause stops the next go and the next hand-out", async () => {
    const [app] = await queued(1);
    expect((await t.api.get('/agent/queue/next').expect(200)).body.application).toBeDefined();
    await t.api.put('/agent/pause').send({ paused: true }).expect(200);
    expect((await t.api.post(`/agent/queue/${app?.id}/go`).expect(200)).body).toMatchObject({ go: false, reason: 'paused' });
    expect((await t.api.get('/agent/queue/next').expect(200)).body.wait).toBe('paused');
    await t.api.put('/agent/pause').send({ paused: false }).expect(200);
    expect((await t.api.post(`/agent/queue/${app?.id}/go`).expect(200)).body.go).toBe(true);
  });

  it("the operator's pause stops everyone", async () => {
    const [app] = await queued(1);
    const other = await t.addUser('user-c', 'chidi.eze@example.org');
    await operator().put('/operator/pause').send({ paused: true }).expect(200);
    expect((await t.api.post(`/agent/queue/${app?.id}/go`).expect(200)).body).toMatchObject({ go: false, reason: 'operator-paused' });
    await other.put('/agent/authorisation').send({ enabled: true, scopeVersion: STANDING_SCOPE_VERSION }).expect(200);
    expect((await other.get('/agent/queue/next').expect(200)).body.wait).toBe('operator-paused');
    expect((await operator().get('/operator/status').expect(200)).body.paused).toBe(true);
    await operator().put('/operator/pause').send({ paused: false }).expect(200);
    expect((await t.api.post(`/agent/queue/${app?.id}/go`).expect(200)).body.go).toBe(true);
  });
});

describe('APP-9: an application system is used only after the operator enables it with evidence', () => {
  it('no system is enabled by default, so nothing is handed out; enabling needs the terms check and a supervised submission', async () => {
    t = await createTestApp({ sources: [], config: testConfig({ employerKey: EMPLOYER_KEY, operatorKey: OPERATOR_KEY }) });
    await t.api.put('/profile').send(PROFILE).expect(200);
    await t.api.put('/passport').send(PASSPORT).expect(200);
    const job = (await employerPost(vacancy(1, 'https://boards.greenhouse.io/example/jobs/1')).expect(201)).body;
    await t.api.post('/applications').send({ jobId: job.id, mode: 'auto' }).expect(201);
    const other = (await employerPost(vacancy(2, 'https://careers.example.org/apply/2')).expect(201)).body;
    await t.api.post('/applications').send({ jobId: other.id, mode: 'auto' }).expect(201);
    await t.api.put('/agent/authorisation').send({ enabled: true, scopeVersion: STANDING_SCOPE_VERSION }).expect(200);

    expect((await operator().get('/operator/status').expect(200)).body.systems.every((s: { enabled: boolean }) => !s.enabled)).toBe(true);
    expect((await t.api.get('/agent/queue/next').expect(200)).body.wait).toBe('empty');
    expect((await t.api.get('/agent/status').expect(200)).body.queue).toMatchObject({ ready: 0, waitingForSystem: 2 });

    await operator().put('/operator/systems/greenhouse').send({ enabled: true }).expect(400);
    await operator().put('/operator/systems/greenhouse').send({ enabled: true, termsCheckedAt: NOW }).expect(400);
    await operator().put('/operator/systems/nowhere').send({ enabled: false }).expect(404);
    await operator().put('/operator/systems/greenhouse').send({ enabled: true, termsCheckedAt: NOW, supervisedSubmissionAt: NOW }).expect(200);
    const next = (await t.api.get('/agent/queue/next').expect(200)).body;
    expect(next.application.applyUrl).toBe('https://boards.greenhouse.io/example/jobs/1');
    // A site with no known application system is never submitted to by the agent.
    expect((await t.api.get('/agent/status').expect(200)).body.queue).toMatchObject({ ready: 1, waitingForSystem: 1 });
  });

  it('the fictional-forms system cannot be enabled in production', async () => {
    t = await createTestApp({ config: testConfig({ operatorKey: OPERATOR_KEY, production: true }) });
    await operator().put('/operator/systems/local-fixture').send({ enabled: true, termsCheckedAt: NOW, supervisedSubmissionAt: NOW }).expect(403);
    expect((await operator().get('/operator/status').expect(200)).body.systems.map((s: { id: string }) => s.id)).not.toContain('local-fixture');
  });

  it('without an operator key the operator routes are closed', async () => {
    t = await createTestApp();
    await t.raw().get('/operator/status').expect(401);
    await t.as('anything').put('/operator/pause').send({ paused: true }).expect(401);
  });
});

describe('OD-5: right to work and sponsorship from the person\'s own record', () => {
  const RECORD = { country: 'gb', rightToWork: true, requiresSponsorship: false, basis: 'British or Irish passport', confirmed: true };

  it('is saved only with the person\'s confirmation and a known document, and the time is stamped by the API', async () => {
    t = await createTestApp();
    await t.api.put('/passport').send({ ...PASSPORT, workRights: [{ ...RECORD, confirmed: false }] }).expect(400);
    await t.api.put('/passport').send({ ...PASSPORT, workRights: [{ ...RECORD, basis: 'A note from a friend' }] }).expect(400);
    await t.api.put('/passport').send({ ...PASSPORT, workRights: [{ ...RECORD, confirmedAt: '2020-01-01T00:00:00.000Z' }] }).expect(400);
    await t.api.put('/passport').send({ ...PASSPORT, workRights: [RECORD, RECORD] }).expect(400);
    const saved = (await t.api.put('/passport').send({ ...PASSPORT, workRights: [RECORD] }).expect(200)).body;
    expect(saved.passport.workRights).toEqual([{ country: 'GB', rightToWork: true, requiresSponsorship: false, basis: 'British or Irish passport', confirmedAt: NOW }]);
    const event = (await t.deps.repository.listEvents(USER_ID)).find((e) => e.type === 'passport.updated');
    expect(event?.payload).toMatchObject({ workRights: 1 });
    expect(JSON.stringify(event?.payload)).not.toContain('passport');
  });

  it('the queue hands the extension the job\'s country and the answers from the record', async () => {
    await queued(1);
    await t.api.put('/passport').send({ ...PASSPORT, workRights: [RECORD] }).expect(200);
    const next = (await t.api.get('/agent/queue/next').expect(200)).body;
    expect(next.workRights).toEqual({ country: 'GB', fromRecord: true });
    expect(next.values).toMatchObject({ rightToWork: true, visaSponsorship: false });
    // The tailored CV goes with it, to be attached to a field that asks for a CV.
    expect(next.cv.fileName).toBe(`${PROFILE.firstName}_${PROFILE.lastName}_CV.pdf`);
    expect(next.cv.text.length).toBeGreaterThan(0);
    // And the cover letter: the statement as a letter, for a field that asks for one.
    expect(next.coverLetter.fileName).toBe(`${PROFILE.firstName}_${PROFILE.lastName}_Cover_Letter.pdf`);
    expect(next.coverLetter.text).toContain('Dear Hiring Manager,');
  });

  it('without a record the queue says so, and sponsorship has no value', async () => {
    await queued(1);
    const next = (await t.api.get('/agent/queue/next').expect(200)).body;
    expect(next.workRights).toEqual({ country: 'GB', fromRecord: false });
    expect(next.values.visaSponsorship).toBeUndefined();
  });
});
