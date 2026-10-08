import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { STANDING_SCOPE_VERSION, createSampleSource } from '@opennjob/core';
import type { Application } from '@opennjob/core';
import { BACKENDS } from './backends';
import { PASSPORT, PROFILE, USER_ID, USER_PASSWORD, createTestApp, scriptedLlm, testConfig } from './helpers';
import type { TestApp } from './helpers';

/** A fictional confirmation page, as "I have submitted it" records it (APP-7). */
const RECEIPT = { pageUrl: 'https://example.org/applied/thanks', confirmationText: 'Thank you, your application has been received. (fictional)' };

/**
 * USER A CANNOT READ OR CHANGE USER B'S DATA, ON ANY ROUTE.
 *
 * Two fictional accounts on one API. A (USER_ID) has a profile, a passport, applications,
 * usage and events. B is a different person. Every route the API has is exercised as B
 * against A's data, and the last test fails if a route exists that this file does not name.
 */

/** Every route of the API. A new route must be added here AND given an isolation check below. */
const ROUTES = [
  'DELETE /account',
  'GET /account',
  'GET /account/export',
  'GET /agent/authorisation',
  'GET /agent/interview-rates',
  'GET /agent/queue/next',
  'GET /agent/status',
  'GET /applications',
  'GET /applications/:id',
  'GET /applications/:id/interview',
  'GET /auth/versions',
  'GET /health',
  'GET /interview/questions',
  'GET /jobs/matches',
  'GET /jobs/search-plan',
  'GET /notifications',
  'GET /notifications/catalogue',
  'GET /notifications/deliveries',
  'GET /notifications/preferences',
  'GET /notifications/preview',
  'GET /operator/status',
  'GET /passport',
  'GET /profile',
  'GET /screening',
  'GET /usage',
  'POST /account/verification',
  'POST /agent/queue/:id/go',
  'POST /agent/queue/:id/result',
  'POST /agent/run',
  'POST /applications',
  'POST /applications/:id/answer',
  'POST /applications/:id/confirm',
  'POST /applications/:id/interview/feedback',
  'POST /applications/:id/outcome',
  'POST /applications/:id/apply-url',
  'POST /applications/from-link',
  'POST /applications/:id/retry',
  'POST /applications/:id/skip',
  'POST /applications/:id/submitted',
  'POST /auth/login',
  'POST /auth/logout',
  'POST /auth/refresh',
  'POST /auth/password/forgot',
  'POST /auth/password/reset',
  'POST /auth/register',
  'POST /auth/verify-email',
  'POST /employer/jobs',
  'POST /interview/feedback',
  'POST /jobs/refresh',
  'POST /notifications/read',
  'POST /notifications/test',
  'POST /profile/cv',
  'PUT /agent/authorisation',
  'PUT /agent/pause',
  'PUT /applications/:id/statement',
  'PUT /notifications/preferences',
  'PUT /operator/pause',
  'PUT /operator/systems/:id',
  'PUT /passport',
  'PUT /profile',
  'PUT /screening',
];
/** Routes that carry no user data and take no user token. */
const NOT_USER_SCOPED = ['GET /auth/versions', 'GET /health', 'GET /interview/questions', 'POST /auth/login', 'POST /auth/refresh', 'POST /auth/logout', 'POST /auth/register', 'POST /employer/jobs',
  'POST /auth/verify-email', 'POST /auth/password/forgot', 'POST /auth/password/reset', 'GET /operator/status', 'PUT /operator/pause', 'PUT /operator/systems/:id'];

const B_ID = 'user-b';
/** Fictional. A site manager, so B's matches differ from A's (a nurse). */
const B_PROFILE = {
  firstName: 'Bola',
  lastName: 'Adeyemi',
  email: 'bola.adeyemi@example.org',
  phone: '07700 900777',
  addressLine1: '4 Sample Road',
  city: 'Leeds',
  postcode: 'LS1 1AA',
  cvText: 'Healthcare assistant with four years of experience in a care home.\nI hold the Care Certificate and give personal care with dignity.\nTrained in moving and handling.',
};
const B_PASSPORT = { rightToWorkConfirmed: false, training: [], referees: [] };
const A_SECRETS = ['Registered nurse with five years', 'Okafor', '18A1234E', '001234567890', 'Priya Shah', '12 Example Street'];

for (const backend of BACKENDS) {
  describe.skipIf(backend.skip)(`isolation between users: ${backend.name}`, () => {
    let t: TestApp;
    let close: () => Promise<void>;
    let b: Awaited<ReturnType<TestApp['addUser']>>;
    let aApp: Application;
    let aProfile: unknown;
    let aPassport: unknown;

    /** A's data as A sees it. Compared before and after everything B does. */
    const snapshotOfA = async () => ({
      profile: (await t.api.get('/profile').expect(200)).body,
      passport: (await t.api.get('/passport').expect(200)).body,
      applications: (await t.api.get('/applications').expect(200)).body,
      usage: (await t.api.get('/usage').expect(200)).body,
      events: await t.deps.repository.listEvents(USER_ID),
      notifications: (await t.api.get('/notifications').expect(200)).body,
      preferences: (await t.api.get('/notifications/preferences').expect(200)).body,
      deliveries: (await t.api.get('/notifications/deliveries').expect(200)).body,
      screening: (await t.api.get('/screening').expect(200)).body,
      authorisation: (await t.api.get('/agent/authorisation').expect(200)).body,
    });

    beforeEach(async () => {
      const made = await backend.make();
      close = made.close;
      t = await createTestApp({ repository: made.repository, usageMeter: made.usageMeter, persistence: backend.persistence, llm: scriptedLlm(), sources: [createSampleSource()], config: testConfig({ employerKey: 'employer-key-for-tests', operatorKey: 'operator-key-for-tests' }) });
      await t.api.put('/profile').send(PROFILE).expect(200);
      await t.api.put('/passport').send(PASSPORT).expect(200);
      await t.api.post('/jobs/refresh').expect(200);
      aApp = (await t.api.post('/applications').send({ jobId: 'sample:staff-nurse-medical', mode: 'hybrid' }).expect(201)).body;
      aProfile = (await t.api.get('/profile').expect(200)).body;
      aPassport = (await t.api.get('/passport').expect(200)).body;
      b = await t.addUser(B_ID, 'bola.adeyemi@example.org');
    });
    afterEach(async () => {
      await t?.app.close();
      await close?.();
    });

    it('GET /profile, PUT /profile: B has no profile until B saves one, and saving it does not touch A', async () => {
      await b.get('/profile').expect(404);
      const saved = await b.put('/profile').send(B_PROFILE).expect(200);
      expect(saved.body).toEqual(B_PROFILE);
      expect((await b.get('/profile').expect(200)).body).toEqual(B_PROFILE);
      expect((await t.api.get('/profile').expect(200)).body).toEqual(aProfile);
    });

    it('GET /passport, PUT /passport: the same for the passport', async () => {
      await b.get('/passport').expect(404);
      const saved = await b.put('/passport').send(B_PASSPORT).expect(200);
      expect(saved.body.passport).toEqual(B_PASSPORT);
      expect(JSON.stringify((await b.get('/passport').expect(200)).body)).not.toContain('18A1234E');
      expect((await t.api.get('/passport').expect(200)).body).toEqual(aPassport);
    });

    it('a user id in the body, query or header is not a way in', async () => {
      await b.put('/profile').send({ ...B_PROFILE, userId: USER_ID }).expect(400);
      await b.put('/passport').send({ ...B_PASSPORT, userId: USER_ID }).expect(400);
      await b.put('/profile').send(B_PROFILE).expect(200);
      await b.post('/applications').send({ jobId: 'sample:hca-elderly-care', mode: 'hybrid', userId: USER_ID }).expect(400);
      await b.post('/agent/run').send({ mode: 'hybrid', userId: USER_ID }).expect(400);
      const viaQuery = await b.get(`/applications?userId=${USER_ID}`).set('X-User-Id', USER_ID).expect(200);
      expect(viaQuery.body).toEqual([]);
      expect((await b.get(`/profile?userId=${USER_ID}`).set('X-User-Id', USER_ID).expect(200)).body).toEqual(B_PROFILE);
      expect((await b.get(`/account/export?userId=${USER_ID}`).expect(200)).body.user.id).toBe(B_ID);
    });

    it("GET /applications, GET /applications/:id: B sees none of A's applications", async () => {
      expect((await b.get('/applications').expect(200)).body).toEqual([]);
      const res = await b.get(`/applications/${aApp.id}`).expect(404);
      expect(JSON.stringify(res.body)).not.toContain(aApp.statement);
    });

    it("POST /applications/:id/confirm and /submitted, PUT /applications/:id/statement: B cannot change A's application", async () => {
      await b.post(`/applications/${aApp.id}/confirm`).send({ confirmedFields: ['nmcPin'] }).expect(404);
      await b.post(`/applications/${aApp.id}/submitted`).send(RECEIPT).expect(404);
      await b.put(`/applications/${aApp.id}/statement`).send({ statement: 'Overwritten by B.' }).expect(404);
      await b.get(`/applications/${aApp.id}/interview`).expect(404);
      await b.post(`/applications/${aApp.id}/interview/feedback`).send({ questionId: 'doc-1', answer: 'An answer by B.' }).expect(404);
      await b.post(`/applications/${aApp.id}/skip`).expect(404);
      await b.post(`/applications/${aApp.id}/retry`).expect(404);
      await b.post(`/applications/${aApp.id}/apply-url`).send({ url: 'https://example.wd3.myworkdayjobs.com/job/1' }).expect(404);
      await b.post(`/applications/${aApp.id}/outcome`).send({ outcome: 'rejected' }).expect(404);
      expect((await t.api.get(`/applications/${aApp.id}`).expect(200)).body).toEqual(aApp);
      expect((await t.deps.repository.listEvents(B_ID)).map((e) => e.type)).toEqual([]);
    });

    it("POST /applications/from-link: B's job from a link is B's, and A does not see it among A's applications", async () => {
      const link = { url: 'https://example.wd3.myworkdayjobs.com/en-GB/careers/job/Leeds/Care_R9', title: 'Healthcare Assistant (fictional)', employer: 'Example Care Homes (fictional)', location: 'Leeds', description: 'A fictional vacancy for a healthcare assistant. Personal care, moving and handling, and supporting residents with daily living.' };
      await b.post('/applications/from-link').send(link).expect(404); // B has no profile yet
      await b.put('/profile').send(B_PROFILE).expect(200);
      const made = (await b.post('/applications/from-link').send(link).expect(201)).body as { application: Application };
      expect(made.application.userId).toBe(B_ID);
      expect((await t.api.get('/applications').expect(200)).body.map((x: Application) => x.id)).not.toContain(made.application.id);
    });

    it("POST /applications: B's draft is made from B's CV and belongs to B", async () => {
      await b.post('/applications').send({ jobId: 'sample:hca-elderly-care', mode: 'hybrid' }).expect(404); // B has no profile yet
      await b.put('/profile').send(B_PROFILE).expect(200);
      // B holds no NMC PIN: A's stored PIN does not make B eligible for the registered-nurse job.
      await b.post('/applications').send({ jobId: 'sample:staff-nurse-medical', mode: 'hybrid' }).expect(422);
      const mine = (await b.post('/applications').send({ jobId: 'sample:hca-elderly-care', mode: 'review' }).expect(201)).body as Application;
      expect(mine.userId).toBe(B_ID);
      expect((await b.get('/applications').expect(200)).body.map((x: Application) => x.id)).toEqual([mine.id]);
      expect((await t.api.get('/applications').expect(200)).body.map((x: Application) => x.id)).toEqual([aApp.id]);
      await t.api.get(`/applications/${mine.id}`).expect(404);
      await t.api.post(`/applications/${mine.id}/submitted`).send(RECEIPT).expect(404);
      // The scripted AI reply claims a nurse's 28 patients, which B's CV does not contain: held, not sent (TAI-3).
      expect((await b.get(`/applications/${mine.id}`).expect(200)).body).toMatchObject({ status: 'needs_you', holdReasons: ['trace-check'] });
    });

    it("GET /jobs/matches: scored against the caller's own CV and passport", async () => {
      await b.get('/jobs/matches').expect(404);
      await b.put('/profile').send(B_PROFILE).expect(200);
      const forA = (await t.api.get('/jobs/matches').expect(200)).body as { job: { id: string }; score: number; eligible: boolean; hits: { evidence?: string }[] }[];
      const forB = (await b.get('/jobs/matches').expect(200)).body as typeof forA;
      const nurse = (rows: typeof forA) => rows.find((m) => m.job.id === 'sample:staff-nurse-medical');
      expect(nurse(forA)?.eligible).toBe(true);
      expect(nurse(forB)?.eligible).toBe(false);
      expect(nurse(forB)?.score).not.toBe(nurse(forA)?.score);
      const evidence = JSON.stringify(forB);
      for (const secret of A_SECRETS) expect(evidence, secret).not.toContain(secret);
    });

    it("GET /jobs/search-plan: built from the caller's own CV and places", async () => {
      expect((await b.get('/jobs/search-plan').expect(200)).body).toMatchObject({ hasProfile: false, titles: [], queries: [] });
      await b.put('/profile').send(B_PROFILE).expect(200);
      const forA = (await t.api.get('/jobs/search-plan').expect(200)).body;
      const forB = (await b.get('/jobs/search-plan').expect(200)).body;
      expect(forA.titles).toContain('registered nurse');
      expect(forB.titles).toEqual(['healthcare assistant']);
      expect(forB.places).toEqual([{ country: 'GB' }]);
      for (const secret of A_SECRETS) expect(JSON.stringify(forB), secret).not.toContain(secret);
    });

    it("POST /agent/run: prepares drafts for the caller only, and one user's drafts do not count as another's", async () => {
      await b.post('/agent/run').send({}).expect(404);
      await b.put('/profile').send(PROFILE).expect(200); // the same CV as A, so the same jobs qualify
      await b.put('/passport').send(PASSPORT).expect(200);
      const runA = (await t.api.post('/agent/run').send({}).expect(200)).body;
      const runB = (await b.post('/agent/run').send({}).expect(200)).body;
      // A already had the nurse job drafted; B had not, so B gets one more draft than A's run made.
      expect(runA.skipped.alreadyPrepared).toBe(1);
      expect(runB.skipped.alreadyPrepared).toBe(0);
      expect(runB.prepared.length).toBe(runA.prepared.length + 1);
      expect(runB.prepared.every((x: Application) => x.userId === B_ID)).toBe(true);
      expect(runA.prepared.every((x: Application) => x.userId === USER_ID)).toBe(true);
      const idsA = (await t.api.get('/applications').expect(200)).body.map((x: Application) => x.id);
      const idsB = (await b.get('/applications').expect(200)).body.map((x: Application) => x.id);
      expect(idsA.filter((id: string) => idsB.includes(id))).toEqual([]);
      expect((await t.deps.repository.listEvents(B_ID)).filter((e) => e.type === 'agent.run')).toHaveLength(1);
      expect((await t.deps.repository.listEvents(USER_ID)).filter((e) => e.type === 'agent.run')).toHaveLength(1);
    });

    it('GET /usage, POST /interview/feedback: usage is metered and shown per user', async () => {
      expect((await t.api.get('/usage').expect(200)).body.totals.calls).toBe(2); // A's statement draft and CV rewrite
      expect((await b.get('/usage').expect(200)).body).toEqual({ totals: { calls: 0, inputTokens: 0, outputTokens: 0, acu: 0 }, records: [] });
      await b.post('/interview/feedback').send({ question: 'Tell me about a time you worked in a team.', answer: 'On my ward we were short staffed, so I organised the handover.' }).expect(200);
      const usageB = (await b.get('/usage').expect(200)).body;
      expect(usageB.totals.calls).toBe(1);
      expect(usageB.records.every((r: { userId: string }) => r.userId === B_ID)).toBe(true);
      const usageA = (await t.api.get('/usage').expect(200)).body;
      expect(usageA.totals.calls).toBe(2); // unchanged by B's call
      expect(usageA.records.every((r: { userId: string }) => r.userId === USER_ID)).toBe(true);
    });

    it('POST /jobs/refresh: the catalogue is shared, the event is the caller\'s', async () => {
      await b.post('/jobs/refresh').expect(200);
      expect((await t.deps.repository.listEvents(B_ID)).map((e) => e.type)).toEqual(['jobs.refreshed']);
      expect((await t.deps.repository.listEvents(USER_ID)).filter((e) => e.type === 'jobs.refreshed')).toHaveLength(1);
    });

    it("GET /account, GET /account/export: only the caller's own account and data", async () => {
      expect((await b.get('/account').expect(200)).body).toMatchObject({ id: B_ID, email: 'bola.adeyemi@example.org' });
      const empty = (await b.get('/account/export').expect(200)).body;
      expect(empty).toMatchObject({ user: { id: B_ID }, profile: null, passport: null, applications: [], events: [], usage: [] });
      await b.put('/profile').send(B_PROFILE).expect(200);
      const exported = JSON.stringify((await b.get('/account/export').expect(200)).body);
      for (const secret of [...A_SECRETS, aApp.id, USER_ID, 'amara.okafor@example.org']) expect(exported, secret).not.toContain(secret);
      expect(exported).toContain('Adeyemi');
    });

    it("DELETE /account: B can delete only B's account; A's password is useless to B and A is untouched", async () => {
      await b.put('/profile').send(B_PROFILE).expect(200);
      const before = await snapshotOfA();
      await b.delete('/account').send({ password: 'not the password at all' }).expect(401);
      await b.delete('/account').send({ password: USER_PASSWORD, userId: USER_ID }).expect(400);
      await b.delete('/account').send({ password: USER_PASSWORD }).expect(200, { deleted: true });
      expect(await t.deps.repository.getUserById(B_ID)).toBeUndefined();
      expect(await t.deps.repository.getUserById(USER_ID)).toBeDefined();
      expect(await snapshotOfA()).toEqual(before);
      await b.get('/profile').expect(401); // B's token died with the account
    });

    it("notifications: B sees only B's inbox, deliveries and preferences, and cannot mark or change A's", async () => {
      const aInbox = (await t.api.get('/notifications').expect(200)).body;
      expect(aInbox.items.length).toBeGreaterThan(0); // A's profile, passport and draft notified A
      expect((await b.get('/notifications').expect(200)).body).toEqual({ unread: 0, items: [] });
      expect((await b.get('/notifications/deliveries').expect(200)).body.items).toEqual([]);
      await b.post('/notifications/read').send({ ids: aInbox.items.map((n: { id: string }) => n.id) }).expect(200, { changed: 0 });
      await b.post('/notifications/read').send({}).expect(200, { changed: 0 });
      await b.put('/notifications/preferences').send({ email: false, sms: true, push: true, whatsapp: true, muted: ['profile.saved'] }).expect(200);
      expect((await t.api.get('/notifications/preferences').expect(200)).body).toMatchObject({ email: true, sms: false, muted: [] });
      await b.post('/notifications/test').send({}).expect(200);
      expect((await t.api.get('/notifications').expect(200)).body).toEqual(aInbox);
      const catalogue = (await b.get('/notifications/catalogue').expect(200)).body;
      expect(JSON.stringify(catalogue)).not.toContain(aApp.jobTitle);
      const preview = (await b.get('/notifications/preview?event=agent.review_needed').expect(200)).body;
      expect(preview.html).not.toContain(aApp.jobTitle);
    });

    it("applying on A's behalf: B cannot read or change A's authorisation, screening answers or queue, and A's go is not B's", async () => {
      await t.api.put('/screening').send({ noticePeriod: '4 weeks', custom: { 'Can you work weekends?': 'Yes (fictional)' } }).expect(200);
      await t.api.put('/agent/authorisation').send({ enabled: true, scopeVersion: STANDING_SCOPE_VERSION }).expect(200);
      expect((await b.get('/screening').expect(200)).body).toEqual({ custom: {} });
      expect((await b.get('/agent/authorisation').expect(200)).body.enabled).toBe(false);
      expect((await b.get('/agent/status').expect(200)).body).toMatchObject({ authorisation: { enabled: false }, queue: { ready: 0, needsYou: 0 } });
      expect((await b.get('/agent/queue/next').expect(200)).body).toMatchObject({ wait: 'not-authorised' });
      // B's interview rates are B's own: none of A's applications are counted.
      const rates = (await b.get('/agent/interview-rates').expect(200)).body as { bands: { sent: number; outcomes: number }[]; bar: { outcomes: number } };
      expect(rates.bands.every((band) => band.sent === 0 && band.outcomes === 0)).toBe(true);
      expect(rates.bar.outcomes).toBe(0);
      await b.put('/agent/authorisation').send({ enabled: false }).expect(200);
      await b.put('/agent/pause').send({ paused: true }).expect(200);
      expect((await t.api.get('/agent/authorisation').expect(200)).body).toMatchObject({ enabled: true, paused: false });
      await b.post(`/agent/queue/${aApp.id}/go`).expect(404);
      await b.post(`/agent/queue/${aApp.id}/result`).send({ outcome: 'held', reasons: ['captcha'] }).expect(404);
      await b.post(`/applications/${aApp.id}/answer`).send({ question: 'Can you work nights?', answer: 'No' }).expect(404);
      expect((await t.api.get(`/applications/${aApp.id}`).expect(200)).body).toEqual(aApp);
      // A's stored answers are not B's.
      expect(JSON.stringify((await b.get('/screening').expect(200)).body)).not.toContain('weekends');
    });

    it('the operator routes: only the operator key opens them, and it opens no user route', async () => {
      await b.get('/operator/status').expect(401);
      await t.api.put('/operator/pause').send({ paused: true }).expect(401);
      const operator = t.as('operator-key-for-tests');
      const status = (await operator.get('/operator/status').expect(200)).body;
      expect(JSON.stringify(status)).not.toContain(USER_ID);
      for (const path of ['/profile', '/screening', '/agent/status', '/applications', '/account']) await operator.get(path).expect(401);
      await t.as('employer-key-for-tests').get('/operator/status').expect(401);
    });

    it("after everything B can do on every route, A's data is exactly as it was", async () => {
      const before = await snapshotOfA();
      await b.put('/profile').send(B_PROFILE).expect(200);
      await b.put('/passport').send(B_PASSPORT).expect(200);
      await b.get('/jobs/matches?min=0').expect(200);
      await b.post('/agent/run').send({ mode: 'auto' }).expect(200);
      await b.post('/applications').send({ jobId: 'sample:support-worker-ld', mode: 'auto' });
      for (const id of [aApp.id, `${aApp.id}%00`, '../' + aApp.id, 'id-1', '*']) {
        await b.get(`/applications/${encodeURIComponent(id)}`).expect((r) => expect([400, 404]).toContain(r.status));
        await b.post(`/applications/${encodeURIComponent(id)}/confirm`).send({ confirmedFields: ['x'] }).expect((r) => expect([400, 404]).toContain(r.status));
        await b.post(`/applications/${encodeURIComponent(id)}/submitted`).send(RECEIPT).expect((r) => expect([400, 404]).toContain(r.status));
        await b.put(`/applications/${encodeURIComponent(id)}/statement`).send({ statement: 'Overwritten by B.' }).expect((r) => expect([400, 404]).toContain(r.status));
        await b.post(`/applications/${encodeURIComponent(id)}/answer`).send({ question: 'Can you work nights?', answer: 'No' }).expect((r) => expect([400, 404]).toContain(r.status));
        await b.post(`/agent/queue/${encodeURIComponent(id)}/go`).expect((r) => expect([400, 404]).toContain(r.status));
        await b.post(`/agent/queue/${encodeURIComponent(id)}/result`).send({ outcome: 'uncertain' }).expect((r) => expect([400, 404]).toContain(r.status));
      }
      await b.put('/screening').send({ custom: { 'Can you work nights?': 'No' } }).expect(200);
      await b.post('/account/verification').expect(200);
      await b.post('/profile/cv').set('Content-Type', 'application/pdf').send(Buffer.from('%PDF-1.4 not a real pdf')).expect(400);
      await b.put('/agent/authorisation').send({ enabled: true, scopeVersion: STANDING_SCOPE_VERSION }).expect(200);
      await b.put('/agent/pause').send({ paused: true }).expect(200);
      await b.get('/agent/status').expect(200);
      await b.get('/agent/queue/next').expect(200);
      await b.get('/usage').expect(200);
      await b.get('/notifications').expect(200);
      await b.post('/notifications/read').send({}).expect(200);
      await b.put('/notifications/preferences').send({ email: false, sms: false, push: false, whatsapp: false, muted: [] }).expect(200);
      await b.post('/notifications/test').send({ event: 'agent.run_completed' }).expect(200);
      await b.get('/account/export').expect(200);
      await b.post('/interview/feedback').send({ questionId: 'val-compassion', answer: 'I sat with a resident who was upset and listened.' }).expect(200);
      expect(await snapshotOfA()).toEqual(before);
    });

    it('routes without a user: need no token and return nothing of any user; the employer key opens no user route', async () => {
      const text = JSON.stringify([
        (await t.raw().get('/health').expect(200)).body,
        (await t.raw().get('/auth/versions').expect(200)).body,
        (await t.raw().post('/employer/jobs').set('Authorization', 'Bearer employer-key-for-tests').send({ title: 'Site Manager', employer: 'Example Build Ltd (fictional)', country: 'GB', city: 'Leeds', applyUrl: 'https://example.org/apply/1', description: 'Essential\n- CDM 2015 duties.\n- SMSTS certificate.' }).expect(201)).body,
      ]);
      for (const secret of [...A_SECRETS, USER_ID]) expect(text, secret).not.toContain(secret);
      const employer = t.as('employer-key-for-tests');
      for (const path of ['/profile', '/passport', '/applications', `/applications/${aApp.id}`, '/usage', '/account', '/account/export', '/jobs/matches']) await employer.get(path).expect(401);
      // interview questions need a token but hold no user data
      expect(JSON.stringify((await b.get('/interview/questions').expect(200)).body)).not.toContain('Okafor');
    });

    it('every user-scoped route refuses a request with no token', async () => {
      for (const route of ROUTES.filter((r) => !NOT_USER_SCOPED.includes(r))) {
        const [method, path] = route.split(' ') as [string, string];
        const url = path.replace(':id', aApp.id);
        const req = method === 'GET' ? t.raw().get(url) : method === 'PUT' ? t.raw().put(url) : method === 'DELETE' ? t.raw().delete(url) : t.raw().post(url);
        await req.send(method === 'GET' ? undefined : {}).expect(401);
      }
      await t.raw().get('/interview/questions').expect(401);
    });

    it('this file names every route the API has', () => {
      type Layer = { route?: { path: string; methods: Record<string, boolean> } };
      const express = t.app.getHttpAdapter().getInstance() as { router?: { stack: Layer[] }; _router?: { stack: Layer[] } };
      const stack = (express.router ?? express._router)?.stack ?? [];
      const actual = stack
        .filter((l): l is Required<Layer> => Boolean(l.route))
        .flatMap((l) => Object.keys(l.route.methods).filter((m) => l.route.methods[m]).map((m) => `${m.toUpperCase()} ${l.route.path}`))
        .sort();
      expect(actual).toEqual([...ROUTES].sort());
    });
  });
}
