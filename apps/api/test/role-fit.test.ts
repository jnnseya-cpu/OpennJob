import { afterEach, describe, expect, it } from 'vitest';
import type { Application, Job } from '@opennjob/core';
import { PROFILE, createTestApp, testConfig } from './helpers';
import type { TestApp } from './helpers';

/**
 * A job in another field is never a match: the job title is checked against the CV, and an advert
 * that only shares a word like "team" with the CV is capped well under the 80% threshold.
 * Fictional people and employers only.
 */
let t: TestApp;
afterEach(async () => {
  await t?.app.close();
});

const EMPLOYER_KEY = 'employer-key-not-a-secret';
const CV = [
  'Example Candidate (fictional). Senior Project Manager and Chartered Construction Manager.',
  'Led multidisciplinary teams through design, construction and commissioning.',
].join('\n');
const job = (title: string, n: number) => ({
  title,
  employer: 'Example Employer (fictional)',
  description: 'Join our team. (fictional)',
  country: 'gb',
  city: 'Leeds',
  applyUrl: `https://example.org/apply/${n}`,
  criteria: [{ label: 'Teamwork', essential: true, keywords: ['team'] }],
});

describe('role fit through the API', () => {
  it('caps a post the CV does not show, says why, and the agent does not prepare it', async () => {
    t = await createTestApp({ sources: [], config: testConfig({ employerKey: EMPLOYER_KEY }) });
    await t.api.put('/profile').send({ ...PROFILE, cvText: CV }).expect(200);
    const post = (body: object) => t.raw().post('/employer/jobs').set('Authorization', `Bearer ${EMPLOYER_KEY}`).send(body).expect(201);
    const tax = (await post(job('Tax Director - Private Clients', 1))).body as Job;
    const pm = (await post(job('Senior Project Manager', 2))).body as Job;

    const matches = (await t.api.get('/jobs/matches?min=0').expect(200)).body as { job: Job; score: number; otherField?: { role: string; missing: string[] } }[];
    const byId = Object.fromEntries(matches.map((m) => [m.job.id, m]));
    expect(byId[tax.id]).toMatchObject({ score: 30, otherField: { role: 'Tax Director', missing: ['tax'] } });
    expect(byId[pm.id]?.score).toBe(100);
    expect(byId[pm.id]?.otherField).toBeUndefined();

    // A draft made earlier for the tax post (here: a direct request) is closed by the next run.
    const early = (await t.api.post('/applications').send({ jobId: tax.id, mode: 'auto' }).expect(201)).body as Application;
    const run = (await t.api.post('/agent/run').send({}).expect(200)).body as { prepared: Application[]; closedOtherField: number };
    expect(run.prepared.map((a) => a.jobId)).toEqual([pm.id]);
    expect(run.closedOtherField).toBe(1);
    expect(((await t.api.get(`/applications/${early.id}`).expect(200)).body as Application).status).toBe('closed');
  });

  it('the same vacancy from two sources is listed once, and has one application', async () => {
    t = await createTestApp({ sources: [], config: testConfig({ employerKey: EMPLOYER_KEY }) });
    await t.api.put('/profile').send({ ...PROFILE, cvText: CV }).expect(200);
    const post = (body: object) => t.raw().post('/employer/jobs').set('Authorization', `Bearer ${EMPLOYER_KEY}`).send(body).expect(201);
    const a = (await post({ ...job('Senior Project Manager', 3), employer: 'Clarion (fictional)' })).body as Job;
    const b = (await post({ ...job('Senior Project Manager', 4), employer: 'Clarion Housing (fictional)' })).body as Job;
    const listed = ((await t.api.get('/jobs/matches?min=0').expect(200)).body as { job: Job }[]).map((m) => m.job.id);
    expect(listed.filter((id) => id === a.id || id === b.id)).toHaveLength(1);

    const first = (await t.api.post('/applications').send({ jobId: a.id, mode: 'auto' }).expect(201)).body as Application;
    // A direct request for the other copy returns the existing application: one vacancy, one application.
    expect(((await t.api.post('/applications').send({ jobId: b.id, mode: 'auto' }).expect(201)).body as Application).id).toBe(first.id);
    const run = (await t.api.post('/agent/run').send({}).expect(200)).body as { prepared: Application[]; closedDuplicates: number };
    expect(run.prepared).toEqual([]);
    expect(run.closedDuplicates).toBe(0);
    expect(((await t.api.get(`/applications/${first.id}`).expect(200)).body as Application).status).not.toBe('closed');
  });
});
