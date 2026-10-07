import { afterEach, describe, expect, it } from 'vitest';
import { STANDING_SCOPE_VERSION, applicationSystemFor } from '@opennjob/core';
import type { Application, Job } from '@opennjob/core';
import { PASSPORT, PROFILE, USER_ID, createTestApp, testConfig } from './helpers';
import type { TestApp } from './helpers';

/** Workday and SuccessFactors as application systems, and an employer's own domain added by the operator. Fictional. */
let t: TestApp;
afterEach(async () => {
  await t?.app.close();
});
const OPERATOR_KEY = 'operator-key-not-a-secret';

describe('application systems: Workday and SuccessFactors', () => {
  it('recognises their hosts, and an employer domain only when the operator added it', () => {
    expect(applicationSystemFor('https://example.wd3.myworkdayjobs.com/careers/job/1')?.id).toBe('workday');
    expect(applicationSystemFor('https://career5.successfactors.eu/career?company=example')?.id).toBe('successfactors');
    expect(applicationSystemFor('https://jobs.example.org/job/Warwick-PM/1')).toBeUndefined();
    expect(applicationSystemFor('https://jobs.example.org/job/Warwick-PM/1', { successfactors: ['jobs.example.org'] })?.id).toBe('successfactors');
    expect(applicationSystemFor('https://evil.myworkdayjobs.com.example.net/')).toBeUndefined();
  });

  it('enabling needs the evidence; extra hosts route the employer domain to the form queue', async () => {
    t = await createTestApp({ sources: [], config: testConfig({ operatorKey: OPERATOR_KEY }) });
    await t.api.put('/profile').send(PROFILE).expect(200);
    await t.api.put('/passport').send(PASSPORT).expect(200);
    await t.api.put('/agent/authorisation').send({ enabled: true, scopeVersion: STANDING_SCOPE_VERSION }).expect(200);
    const job: Job = { id: 'employer:sf1', source: 'employer', externalId: 'sf1', title: 'Staff Nurse (fictional)', employer: 'Example Networks (fictional)', location: 'Warwick', country: 'GB', url: 'https://jobs.example.org/job/1', applyUrl: 'https://jobs.example.org/job/1', description: 'A fictional vacancy.', criteria: [{ label: 'Medication', essential: true, keywords: ['medication'] }], criteriaSource: 'provided', requiresRegistration: false, origin: 'employer' };
    await t.deps.repository.upsertJobs([job]);
    const app: Application = { id: 'sf-app', userId: USER_ID, jobId: job.id, jobTitle: job.title, employer: job.employer, applyUrl: job.url, mode: 'auto', status: 'draft', statement: 'A fictional statement.', statementSource: 'fallback', gaps: [], warnings: [], score: 100, confirmedFields: [], createdAt: '2026-10-07T06:00:00.000Z' };
    await t.deps.repository.createApplication(app);
    const op = (body: object) => t.raw().put('/operator/systems/successfactors').set('Authorization', `Bearer ${OPERATOR_KEY}`).send(body);

    expect((await t.api.get('/agent/status').expect(200)).body.routes).toEqual({ 'sf-app': 'none' });
    await op({ enabled: true, extraHosts: ['jobs.example.org'] }).expect(400); // no evidence
    await op({ enabled: true, termsCheckedAt: '2026-10-07T10:00:00Z', supervisedSubmissionAt: '2026-10-07T11:00:00Z', extraHosts: ['not a host'] }).expect(400);
    const on = (await op({ enabled: true, termsCheckedAt: '2026-10-07T10:00:00Z', supervisedSubmissionAt: '2026-10-07T11:00:00Z', extraHosts: ['JOBS.example.org'] }).expect(200)).body;
    expect(on).toMatchObject({ id: 'successfactors', enabled: true, extraHosts: ['jobs.example.org'] });
    expect((await t.api.get('/agent/status').expect(200)).body.routes).toEqual({ 'sf-app': 'form' });
    expect((await t.api.get('/agent/queue/next').expect(200)).body.application?.id).toBe('sf-app');
  });
});
