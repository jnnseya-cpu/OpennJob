import { afterEach, describe, expect, it } from 'vitest';
import type { Application, Job } from '@opennjob/core';
import { PASSPORT, PROFILE, USER_ID, createTestApp, scriptedLlm } from './helpers';
import type { TestApp } from './helpers';

/**
 * The agent run tidies unsent drafts: one prepared under an older, looser score is closed when it no
 * longer reaches the bar, and one written without AI (budget used up) is written again with AI.
 * Fictional person and employers.
 */
let t: TestApp;
afterEach(async () => {
  await t?.app.close();
});

const job = (id: string, criteriaSource: Job['criteriaSource'], criteria: Job['criteria']): Job => ({
  id: `employer:${id}`, source: 'employer', externalId: id, title: 'Staff Nurse (fictional)', employer: `${id} Care (fictional)`, location: 'Leeds', country: 'GB',
  url: `https://example.org/jobs/${id}`, description: 'A fictional vacancy.', criteria, criteriaSource, requiresRegistration: false, origin: 'employer',
});
const draft = (id: string, j: Job, extra: Partial<Application> = {}): Application => ({
  id, userId: USER_ID, jobId: j.id, jobTitle: j.title, employer: j.employer, applyUrl: j.url, mode: 'auto', status: 'draft',
  statement: 'A fictional statement.', statementSource: 'fallback', gaps: [], warnings: [], score: 100, confirmedFields: [], createdAt: '2026-10-06T06:00:00.000Z', ...extra,
});

describe('the agent run tidies unsent drafts', () => {
  it('closes a draft whose advert gave only two keyword-read requirements (now capped at 75%); keeps an approved one', async () => {
    t = await createTestApp({ sources: [] });
    await t.api.put('/profile').send(PROFILE).expect(200);
    await t.api.put('/passport').send(PASSPORT).expect(200);
    const thin = job('thin', 'fallback', [
      { label: 'Medication rounds', essential: true, keywords: ['medication'] },
      { label: 'Care plans', essential: true, keywords: ['care plans'] },
    ]);
    const approvedJob = job('approved', 'fallback', thin.criteria);
    await t.deps.repository.upsertJobs([thin, approvedJob]);
    await t.deps.repository.createApplication(draft('old-thin', thin));
    await t.deps.repository.createApplication(draft('old-approved', approvedJob, { status: 'confirmed' }));
    const run = (await t.api.post('/agent/run').send({ mode: 'auto' }).expect(200)).body;
    expect(run.closedBelowBar).toBe(1);
    expect(await t.deps.repository.getApplication(USER_ID, 'old-thin')).toMatchObject({ status: 'closed', score: 75 });
    // The approved one stays open, but shows today's score (the one its review page shows), not the old 100.
    expect(await t.deps.repository.getApplication(USER_ID, 'old-approved')).toMatchObject({ status: 'confirmed', score: 75 });
  });

  it('writes a draft made without AI again once AI is available', async () => {
    t = await createTestApp({ sources: [], llm: scriptedLlm() });
    await t.api.put('/profile').send(PROFILE).expect(200);
    await t.api.put('/passport').send(PASSPORT).expect(200);
    const j = job('full', 'provided', [
      { label: 'Medication rounds', essential: true, keywords: ['medication'] },
      { label: 'Care plans', essential: true, keywords: ['care plans'] },
    ]);
    await t.deps.repository.upsertJobs([j]);
    await t.deps.repository.createApplication(draft('no-ai', j, { status: 'needs_you', holdReasons: ['llm-ceiling'] }));
    const run = (await t.api.post('/agent/run').send({ mode: 'auto' }).expect(200)).body;
    expect(run.redrafted).toBe(1);
    expect((await t.deps.repository.getApplication(USER_ID, 'no-ai'))?.status).toBe('closed');
    const fresh = (await t.deps.repository.listApplications(USER_ID)).filter((a) => a.jobId === j.id && a.status !== 'closed');
    expect(fresh).toHaveLength(1);
    expect(fresh[0]?.holdReasons ?? []).not.toContain('llm-ceiling');
    expect(fresh[0]?.statementSource).toBe('llm');
  });
});

describe('try again after signing in once', () => {
  it('clears only the holds the person resolves on the employer site', async () => {
    t = await createTestApp({ sources: [] });
    await t.api.put('/profile').send(PROFILE).expect(200);
    const j = job('signin', 'provided', [{ label: 'Medication rounds', essential: true, keywords: ['medication'] }]);
    await t.deps.repository.upsertJobs([j]);
    await t.deps.repository.createApplication(draft('wall', j, { status: 'needs_you', holdReasons: ['login-wall'] }));
    await t.deps.repository.createApplication(draft('part', { ...j, id: 'employer:x' }, { status: 'needs_you', holdReasons: ['sensitive:convictions', 'steps-saved:3'] }));
    expect((await t.api.post('/applications/wall/retry').expect(200)).body).toMatchObject({ status: 'draft' });
    const part = (await t.api.post('/applications/part/retry').expect(200)).body;
    expect(part).toMatchObject({ status: 'needs_you', holdReasons: ['sensitive:convictions'] }); // a declaration stays the person's
    await t.deps.repository.updateApplication({ ...(await t.deps.repository.getApplication(USER_ID, 'wall')) as Application, attemptedAt: '2026-10-07T06:00:00.000Z' });
    await t.api.post('/applications/wall/retry').expect(409); // never after the go
  });
});
