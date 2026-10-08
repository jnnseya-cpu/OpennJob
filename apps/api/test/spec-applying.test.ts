import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeLlm, createSampleSource, CV_TAILOR_SYSTEM_PROMPT } from '@opennjob/core';
import type { Application, Job, JobSourceAdapter } from '@opennjob/core';
import { signAccessToken } from '../src/auth';
import type { OpennJobDeps } from '../src/deps';
import { OpennJobService } from '../src/services';
import { JWT_SECRET, NOW, PASSPORT, PROFILE, USER_ID, createTestApp, scriptedLlm, testConfig } from './helpers';
import type { TestApp } from './helpers';

/** A fictional confirmation page, as "I have submitted it" records it (APP-7). */
const RECEIPT = { pageUrl: 'https://example.org/applied/thanks', confirmationText: 'Thank you, your application has been received. (fictional)' };

/**
 * The spec's required cases for drafting and duplicates (OpennJob Build and Test
 * Requirements, section 7.2): T-01, T-05 (API level), T-06, T-10, T-12, T-21.
 * Every person, CV and employer here is fictional.
 */

let t: TestApp;
afterEach(async () => {
  await t?.app.close();
});

const EMPLOYER_KEY = 'employer-key-not-a-secret';
const NURSE_JOB = 'sample:staff-nurse-medical';
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/** A movable clock, and a client whose token is signed at the clock's current time. */
function movableClock(start = NOW) {
  let now = new Date(start);
  return {
    clock: () => new Date(now),
    set: (iso: string) => {
      now = new Date(iso);
    },
  };
}
const clientAt = (app: TestApp, at: Date) => app.as(signAccessToken(USER_ID, JWT_SECRET, 3600, at).accessToken);

async function seeded(overrides: Partial<OpennJobDeps> = {}): Promise<TestApp> {
  t = await createTestApp({ config: testConfig({ employerKey: EMPLOYER_KEY }), ...overrides });
  await t.api.put('/profile').send(PROFILE).expect(200);
  await t.api.put('/passport').send(PASSPORT).expect(200);
  await t.api.post('/jobs/refresh').expect(200);
  return t;
}

const employerPost = (body: object) => t.raw().post('/employer/jobs').set('Authorization', `Bearer ${EMPLOYER_KEY}`).send(body);

describe('spec T-01: a job at 79% is left alone; at 80% it is prepared', () => {
  // Ten essential criteria (weight 20) and four desirable (weight 4): total 24.
  // The CV below meets nine essential and one desirable: 19/24 = 79.2, shown as 79.
  // With at most 15 criteria and weights of 1 and 2, no single job can move from 79 to
  // exactly 80 by one more criterion, so 80 is proved on its own job (4/5) further down.
  const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet'];
  const cv = `Fictional skills: ${words.slice(0, 9).join(', ')} and kilo.`;
  const job79 = {
    title: 'Alpha Lead 79 (fictional)',
    employer: 'Threshold Works (fictional)',
    description: 'A fictional vacancy used to test the 80% rule.',
    country: 'gb',
    city: 'Leeds',
    applyUrl: 'https://example.org/apply/79',
    criteria: [...words.map((w) => ({ label: `Skill ${w}`, essential: true, keywords: [w] })), ...['kilo', 'lima', 'mike', 'november'].map((w) => ({ label: `Bonus ${w}`, essential: false, keywords: [w] }))],
  };
  const job80 = {
    title: 'Alpha Lead 80 (fictional)',
    employer: 'Threshold Works (fictional)',
    description: 'A fictional vacancy used to test the 80% rule.',
    country: 'gb',
    city: 'Leeds',
    applyUrl: 'https://example.org/apply/80',
    criteria: [
      { label: 'Skill alpha', essential: true, keywords: ['alpha'] },
      { label: 'Skill bravo', essential: true, keywords: ['bravo'] },
      { label: 'Bonus oscar', essential: false, keywords: ['oscar'] },
    ],
  };

  it('prepares the 80% job and leaves the 79% job alone', async () => {
    t = await createTestApp({ sources: [], config: testConfig({ employerKey: EMPLOYER_KEY }) });
    await t.api.put('/profile').send({ ...PROFILE, cvText: cv }).expect(200);
    const at79 = (await employerPost(job79).expect(201)).body as Job;
    const at80 = (await employerPost(job80).expect(201)).body as Job;
    const scores = Object.fromEntries(((await t.api.get('/jobs/matches?min=0').expect(200)).body as { job: Job; score: number }[]).map((m) => [m.job.id, m.score]));
    expect(scores[at79.id]).toBe(79);
    expect(scores[at80.id]).toBe(80);

    const run = (await t.api.post('/agent/run').send({}).expect(200)).body;
    expect(run.prepared.map((a: Application) => a.jobId)).toEqual([at80.id]);
    expect(run.skipped.belowThreshold).toBe(1);
    expect((await t.api.get('/applications').expect(200)).body.map((a: Application) => a.jobId)).toEqual([at80.id]);
  });
});

describe('spec T-05 (API): what the CV does not support is never sent', () => {
  it('a sentence that invents an employer, a date and a qualification is taken out; the rest is kept, and nothing is added', async () => {
    const inventing = new FakeLlm(() => 'Wrote and reviewed care plans and kept accurate records. I worked at Barrow Infirmary from 2011 and hold an MSc in nursing.\n\nGAPS:\nnone');
    await seeded({ llm: inventing });
    const app = (await t.api.post('/applications').send({ jobId: NURSE_JOB, mode: 'hybrid' }).expect(201)).body as Application;
    expect(app).toMatchObject({ status: 'draft', statementSource: 'llm' });
    expect(app.statement).toContain('Wrote and reviewed care plans');
    expect(app.statement).not.toContain('Barrow');
    expect(app.traceFailures).toBeUndefined();
    // The tailored CV is the person's CV reordered: every line is one of theirs.
    for (const line of (app.tailoredCv ?? '').split('\n')) expect(PROFILE.cvText.split('\n')).toContain(line);
  });

  it('when nothing is left after taking out what the CV does not support, the application is held for the person', async () => {
    const inventing = new FakeLlm(() => 'I worked at Barrow Infirmary from 2011 and hold an MSc in nursing.\n\nGAPS:\nnone');
    await seeded({ llm: inventing });
    const app = (await t.api.post('/applications').send({ jobId: NURSE_JOB, mode: 'hybrid' }).expect(201)).body as Application;
    expect(app).toMatchObject({ status: 'needs_you', holdReasons: ['trace-check'], statementSource: 'llm' });
    expect(app.traceFailures).toEqual(['Statement: nothing was left after the sentences your CV does not support were taken out.']);
    // The event says how many failures, never what they were.
    const drafted = (await t.deps.repository.listEvents(USER_ID)).find((e) => e.type === 'application.drafted');
    expect(drafted?.payload).toMatchObject({ traceFailures: 1, held: true });
    expect(JSON.stringify(drafted)).not.toContain('Barrow');
  });

  it('correcting the statement so it traces releases the hold; confirming a held application is the person taking it as theirs', async () => {
    await seeded({ llm: new FakeLlm(() => 'I hold an MSc.\n\nGAPS:\nnone') });
    const app = (await t.api.post('/applications').send({ jobId: NURSE_JOB, mode: 'hybrid' }).expect(201)).body as Application;
    expect(app.status).toBe('needs_you');
    const fixed = (await t.api.put(`/applications/${app.id}/statement`).send({ statement: 'Wrote and reviewed care plans and kept accurate records.' }).expect(200)).body as Application;
    expect(fixed.status).toBe('draft');
    expect(fixed.holdReasons).toBeUndefined();
    expect(fixed.traceFailures).toBeUndefined();

    await t.api.put(`/applications/${app.id}/statement`).send({ statement: 'I hold an MSc.' }).expect(200);
    const confirmed = (await t.api.post(`/applications/${app.id}/confirm`).send({ confirmedFields: ['statement'] }).expect(200)).body as Application;
    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.holdReasons).toBeUndefined();
    expect(confirmed.traceFailures).toHaveLength(1); // still recorded
  });
});

describe('spec T-06: the stored documents are byte-identical to what was sent', () => {
  it('records the statement and tailored CV at submission with their SHA-256, and nothing changes them afterwards', async () => {
    await seeded();
    const app = (await t.api.post('/applications').send({ jobId: NURSE_JOB, mode: 'review' }).expect(201)).body as Application;
    const statement = 'Wrote and reviewed care plans and kept accurate records.\r\nCompleted medication rounds for 28 patients and acted as second checker for controlled drugs.  ';
    await t.api.put(`/applications/${app.id}/statement`).send({ statement }).expect(200);
    const before = (await t.api.get(`/applications/${app.id}`).expect(200)).body as Application;
    const sent = (await t.api.post(`/applications/${app.id}/submitted`).send(RECEIPT).expect(200)).body as Application;

    expect(sent.sentDocuments).toEqual({
      statement: before.statement,
      tailoredCv: before.tailoredCv,
      sha256: { statement: sha(before.statement), tailoredCv: sha(before.tailoredCv ?? '') },
    });
    const stored = (await t.api.get(`/applications/${app.id}`).expect(200)).body as Application;
    expect(Buffer.from(stored.sentDocuments?.statement ?? '', 'utf8').equals(Buffer.from(before.statement, 'utf8'))).toBe(true);
    expect(sha(stored.sentDocuments?.tailoredCv ?? '')).toBe(stored.sentDocuments?.sha256.tailoredCv);
    // Once sent, the documents cannot be edited.
    await t.api.put(`/applications/${app.id}/statement`).send({ statement: 'Changed afterwards.' }).expect(409);
    expect((await t.api.get(`/applications/${app.id}`).expect(200)).body.sentDocuments).toEqual(sent.sentDocuments);
  });
});

describe('spec T-10: one vacancy, one application', () => {
  const vacancy = {
    title: 'Staff Nurse - Acute Medicine (fictional)',
    employer: 'Calder Vale Hospital (fictional)',
    description: 'Registered nurse for acute medical wards. Medication rounds, care plans, NEWS2.',
    country: 'gb',
    city: 'Leeds',
    criteria: [
      { label: 'Medication rounds', essential: true, keywords: ['medication'] },
      { label: 'Care plans', essential: true, keywords: ['care plans'] },
    ],
  };

  it('the same vacancy from two sources gives one application, from the agent and from a direct request', async () => {
    const clock = movableClock();
    await seeded({ clock: clock.clock, sources: [] });
    const first = (await employerPost({ ...vacancy, applyUrl: 'https://example.org/board-a/1' }).expect(201)).body as Job;
    const second = (await employerPost({ ...vacancy, applyUrl: 'https://example.org/board-b/77' }).expect(201)).body as Job;
    expect(first.id).not.toBe(second.id);

    const run = (await t.api.post('/agent/run').send({}).expect(200)).body;
    expect(run.prepared).toHaveLength(1);
    expect(run.skipped.alreadyPrepared).toBe(1);
    const only = run.prepared[0] as Application;
    // Asking for the other copy returns the application that exists.
    const again = (await t.api.post('/applications').send({ jobId: only.jobId === first.id ? second.id : first.id, mode: 'hybrid' }).expect(201)).body as Application;
    expect(again.id).toBe(only.id);
    expect((await t.api.get('/applications').expect(200)).body).toHaveLength(1);
  });

  it('the same vacancy again the next day gives no second application; after the duplicate period it may', async () => {
    const clock = movableClock();
    await seeded({ clock: clock.clock, sources: [], config: testConfig({ employerKey: EMPLOYER_KEY, duplicateDays: 30 }) });
    await employerPost({ ...vacancy, applyUrl: 'https://example.org/board-a/1' }).expect(201);
    expect((await t.api.post('/agent/run').send({}).expect(200)).body.prepared).toHaveLength(1);

    clock.set('2026-10-07T09:00:00.000Z');
    await employerPost({ ...vacancy, applyUrl: 'https://example.org/board-a/1-reposted' }).expect(201);
    const nextDay = (await clientAt(t, clock.clock()).post('/agent/run').send({}).expect(200)).body;
    expect(nextDay.prepared).toHaveLength(0);
    expect(nextDay.skipped.alreadyPrepared).toBe(2);

    // The original job id never gets a second application, however long ago; a repost
    // under a new id after the period is a new vacancy.
    clock.set('2026-11-06T09:00:01.000Z');
    const later = (await clientAt(t, clock.clock()).post('/agent/run').send({}).expect(200)).body;
    expect(later.prepared).toHaveLength(1);
    expect(later.skipped.alreadyPrepared).toBe(1);
  });

  it('the same job arriving from two adapters in one refresh is stored once', async () => {
    const copy = (id: string): JobSourceAdapter => ({
      id: `copy-${id}`,
      label: `Copy ${id}`,
      fetchJobs: async () => (await createSampleSource().fetchJobs()).filter((j) => j.id === NURSE_JOB).map((j) => ({ ...j, id: `${id}:${j.id}`, source: id })),
    } as unknown as JobSourceAdapter);
    t = await createTestApp({ sources: [copy('a'), copy('b')] });
    await t.api.put('/profile').send(PROFILE).expect(200);
    await t.api.put('/passport').send(PASSPORT).expect(200);
    const refresh = (await t.api.post('/jobs/refresh').expect(200)).body;
    expect(refresh).toMatchObject({ fetched: 2, duplicatesRemoved: 1 });
    expect((await t.api.post('/agent/run').send({}).expect(200)).body.prepared).toHaveLength(1);
  });
});

describe('spec T-12: the daily limit', () => {
  it('counts automatic submissions in the London day and resets at London midnight', async () => {
    const clock = movableClock('2026-07-15T21:00:00.000Z'); // 22:00 in London (BST)
    await seeded({ clock: clock.clock, config: testConfig({ employerKey: EMPLOYER_KEY, dailyApplicationLimit: 2 }) });
    const service = t.app.get(OpennJobService);
    const base = (await t.api.post('/applications').send({ jobId: NURSE_JOB, mode: 'auto' }).expect(201)).body as Application;
    const sentAt = async (id: string, at: string, automatic: boolean) => t.deps.repository.createApplication({ ...base, id, jobId: `${base.jobId}-${id}`, status: 'submitted', submittedAt: at, attemptedAt: automatic ? at : undefined, automatic });

    await sentAt('x1', '2026-07-15T08:00:00.000Z', true);
    await sentAt('x2', '2026-07-14T22:30:00.000Z', true); // 23:30 on the 14th in London: yesterday
    await sentAt('x3', '2026-07-15T10:00:00.000Z', false); // sent by the person: not counted
    expect(await service.dailyLimit(USER_ID)).toEqual({ limit: 2, used: 1, remaining: 1, resetsAt: '2026-07-15T23:00:00.000Z' });

    await sentAt('x4', '2026-07-15T20:00:00.000Z', true);
    expect(await service.dailyLimit(USER_ID)).toMatchObject({ used: 2, remaining: 0 });

    clock.set('2026-07-15T23:00:00.000Z'); // midnight in London
    expect(await service.dailyLimit(USER_ID)).toEqual({ limit: 2, used: 0, remaining: 2, resetsAt: '2026-07-16T23:00:00.000Z' });
  });
});

describe('spec T-21: reaching the LLM spending ceiling holds new drafts and records why', () => {
  it('per person: the draft is made without the LLM, held, and the reason is recorded', async () => {
    const llm = scriptedLlm();
    await seeded({ llm, config: testConfig({ llmDailyAcuPerUser: 1 }) });
    await t.deps.usageMeter.record({ userId: USER_ID, purpose: 'supporting-statement', inputTokens: 900, outputTokens: 100, acu: 1, at: NOW });
    const app = (await t.api.post('/applications').send({ jobId: NURSE_JOB, mode: 'hybrid' }).expect(201)).body as Application;
    expect(app).toMatchObject({ status: 'needs_you', holdReasons: ['llm-ceiling'], statementSource: 'fallback' });
    expect(llm.calls).toHaveLength(0);
    expect((await t.deps.repository.listEvents(USER_ID)).map((e) => e.type)).toContain('agent.llm_ceiling');
  });

  it('in total: spending by other people counts against the platform ceiling', async () => {
    const llm = scriptedLlm();
    await seeded({ llm, config: testConfig({ llmDailyAcuPerUser: 100, llmDailyAcuTotal: 5 }) });
    await t.deps.usageMeter.record({ userId: 'someone-else', purpose: 'supporting-statement', inputTokens: 4000, outputTokens: 1000, acu: 5, at: NOW });
    const app = (await t.api.post('/applications').send({ jobId: NURSE_JOB, mode: 'hybrid' }).expect(201)).body as Application;
    expect(app.holdReasons).toEqual(['llm-ceiling']);
    expect(llm.calls).toHaveLength(0);
  });

  it("yesterday's spending does not count, and below the ceiling the LLM is used as normal", async () => {
    const llm = scriptedLlm();
    await seeded({ llm, config: testConfig({ llmDailyAcuPerUser: 1 }) });
    await t.deps.usageMeter.record({ userId: USER_ID, purpose: 'supporting-statement', inputTokens: 9000, outputTokens: 1000, acu: 10, at: '2026-10-05T22:59:59.000Z' }); // 23:59 on the 5th in London
    const app = (await t.api.post('/applications').send({ jobId: NURSE_JOB, mode: 'hybrid' }).expect(201)).body as Application;
    expect(app).toMatchObject({ status: 'draft', statementSource: 'llm' });
    expect(app.holdReasons).toBeUndefined();
    expect(llm.calls.filter((c) => c.system !== CV_TAILOR_SYSTEM_PROMPT)).toHaveLength(1); // one call drafts the statement, one rewrites the CV for the advert
  });
});
