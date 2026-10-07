import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createGreenhouseSource, createLeverSource, createSampleSource, CV_TAILOR_SYSTEM_PROMPT } from '@opennjob/core';
import type { FetchLike } from '@opennjob/core';
import { CV_TEXT, NOW, PASSPORT, PROFILE, TOKEN, createTestApp, scriptedLlm, testConfig } from './helpers';
import type { TestApp } from './helpers';

/** A fictional confirmation page, as "I have submitted it" records it (APP-7). */
const RECEIPT = { pageUrl: 'https://example.org/applied/thanks', confirmationText: 'Thank you, your application has been received. (fictional)' };

let t: TestApp;
afterEach(async () => {
  await t?.app.close();
});

const NURSE_JOB = 'sample:staff-nurse-medical';
const HCA_JOB = 'sample:hca-elderly-care';

async function seeded(overrides: Parameters<typeof createTestApp>[0] = {}): Promise<TestApp> {
  t = await createTestApp(overrides);
  await t.api.put('/profile').send(PROFILE).expect(200);
  await t.api.put('/passport').send(PASSPORT).expect(200);
  await t.api.post('/jobs/refresh').expect(200);
  return t;
}

describe('auth guard', () => {
  it('rejects requests without a valid bearer token', async () => {
    t = await createTestApp();
    await t.raw().get('/profile').expect(401);
    await t.raw().get('/profile').set('Authorization', 'Bearer wrong').expect(401);
    await t.raw().get('/profile').set('Authorization', TOKEN).expect(401);
    await t.raw().get('/profile').set('Authorization', `Basic ${TOKEN}`).expect(401);
    await t.raw().post('/jobs/refresh').expect(401);
    await t.raw().get('/applications').expect(401);
    await t.raw().post('/interview/feedback').send({ question: 'q', answer: 'a' }).expect(401);
  });

  it('accepts the configured token and leaves /health public', async () => {
    t = await createTestApp();
    await t.raw().get('/health').expect(200, { status: 'ok', persistence: 'memory', database: 'up', version: 'unknown' });
    await t.api.get('/applications').expect(200, []);
  });

  it('fails closed when no signing secret is configured on the server', async () => {
    t = await createTestApp({ config: testConfig({ jwtSecret: '', llmCriteriaMaxJobs: 0 }) });
    const res = await t.raw().get('/profile').set('Authorization', 'Bearer ').expect(401);
    expect(res.body.message).toMatch(/not configured/);
    await t.raw().get('/profile').set('Authorization', `Bearer ${TOKEN}`).expect(401);
  });
});

describe('PUT/GET /profile', () => {
  it('returns 404 before a profile exists, then stores and returns it', async () => {
    t = await createTestApp();
    await t.api.get('/profile').expect(404);
    const put = await t.api.put('/profile').send({ ...PROFILE, firstName: '  Amara  ' }).expect(200);
    expect(put.body).toEqual(PROFILE);
    const get = await t.api.get('/profile').expect(200);
    expect(get.body).toEqual(PROFILE);
  });

  it('validates input and lists every problem', async () => {
    t = await createTestApp();
    const res = await t.api.put('/profile').send({ ...PROFILE, email: 'not-an-email', phone: 'abc', cvText: 'short', isAdmin: true, firstName: '' }).expect(400);
    expect(res.body.message).toBe('Validation failed');
    const paths = res.body.issues.map((i: { path: string }) => i.path);
    expect(paths).toEqual(expect.arrayContaining(['email', 'phone', 'cvText', 'firstName']));
    expect(JSON.stringify(res.body.issues)).toMatch(/isAdmin/);
    await t.api.put('/profile').send({}).expect(400);
    await t.api.put('/profile').send([]).expect(400);
    await t.api.get('/profile').expect(404); // nothing was stored
  });
});

describe('PUT/GET /passport', () => {
  it('stores the passport and reports training expiry against the injected clock', async () => {
    t = await createTestApp();
    await t.api.get('/passport').expect(404);
    const put = await t.api.put('/passport').send(PASSPORT).expect(200);
    expect(put.body.passport).toEqual(PASSPORT);
    expect(put.body.training).toEqual([
      { name: 'Basic life support', expiresOn: '2026-10-20', status: 'expiring', daysRemaining: 14 },
      { name: 'Moving and handling', expiresOn: '2026-01-10', status: 'expired', daysRemaining: -269 },
      { name: 'Fire safety', expiresOn: '2027-06-01', status: 'valid', daysRemaining: 238 },
    ]);
    const get = await t.api.get('/passport').expect(200);
    expect(get.body).toEqual(put.body);
  });

  it('accepts a minimal passport', async () => {
    t = await createTestApp();
    const res = await t.api.put('/passport').send({ rightToWorkConfirmed: false }).expect(200);
    expect(res.body).toEqual({ passport: { rightToWorkConfirmed: false, training: [], referees: [] }, training: [] });
  });

  it('validates input', async () => {
    t = await createTestApp();
    const bad = [
      {},
      { rightToWorkConfirmed: 'yes' },
      { rightToWorkConfirmed: true, nmcPin: 'x' },
      { rightToWorkConfirmed: true, dbs: { certificateNumber: '123' } },
      { rightToWorkConfirmed: true, training: [{ name: 'BLS', expiresOn: '20/10/2026' }] },
      { rightToWorkConfirmed: true, training: [{ name: 'BLS', expiresOn: '2026-02-30' }] },
      { rightToWorkConfirmed: true, referees: [{ name: 'A' }] },
      { rightToWorkConfirmed: true, referees: Array(4).fill(PASSPORT.referees[0]) },
      { rightToWorkConfirmed: true, convictions: 'none' },
    ];
    for (const body of bad) await t.api.put('/passport').send(body).expect(400);
    await t.api.get('/passport').expect(404);
  });
});

describe('POST /jobs/refresh', () => {
  const fixture = (name: string) => JSON.parse(readFileSync(path.join(__dirname, '../../../packages/core/test/fixtures/sources', name), 'utf8'));
  const serving = (body: unknown, status = 200): FetchLike => async () => ({ ok: status < 300, status, json: async () => body });

  it('runs the configured sources, de-duplicates, stores jobs and survives a failing source', async () => {
    t = await createTestApp({
      sources: [
        createSampleSource(),
        createGreenhouseSource({ boardToken: 'examplecare', employer: 'Example Care', fetch: serving(fixture('greenhouse.json')) }),
        createLeverSource({ company: 'examplesupport', employer: 'Example Care', fetch: serving(fixture('lever.json')) }),
        createLeverSource({ company: 'broken', fetch: serving({}, 500) }),
      ],
    });
    const res = await t.api.post('/jobs/refresh').expect(200);
    expect(res.body).toEqual({
      sources: ['sample (fictional demo jobs)', 'greenhouse:examplecare', 'lever:examplesupport', 'lever:broken'],
      fetched: 7,
      duplicatesRemoved: 1,
      stored: 6,
      new: 6,
      criteriaFromLlm: 0,
      searches: 0,
      errors: [{ source: 'lever:broken', message: 'lever:broken: HTTP 500' }],
    });
    const again = await t.api.post('/jobs/refresh').expect(200);
    expect(again.body).toMatchObject({ stored: 6, new: 0 });
    expect(await t.deps.repository.listJobs()).toHaveLength(6);
  });

  it('works with no sources configured', async () => {
    t = await createTestApp({ sources: [] });
    const res = await t.api.post('/jobs/refresh').expect(200);
    expect(res.body).toMatchObject({ sources: [], fetched: 0, stored: 0, errors: [] });
  });

  it('does not call the LLM for criteria unless enabled', async () => {
    const llm = scriptedLlm();
    t = await createTestApp({ llm });
    await t.api.post('/jobs/refresh').expect(200);
    expect(llm.calls).toHaveLength(0);
    expect((await t.deps.repository.getJob(NURSE_JOB))?.criteriaSource).toBe('fallback');
  });

  it('extracts criteria with the LLM when enabled, up to the cap, metering each call, and does not repeat for unchanged jobs', async () => {
    const llm = scriptedLlm();
    t = await createTestApp({ llm, config: testConfig({ llmCriteria: true, llmCriteriaMaxJobs: 2 }) });
    const res = await t.api.post('/jobs/refresh').expect(200);
    expect(res.body.criteriaFromLlm).toBe(2);
    expect(llm.calls).toHaveLength(2);
    const nurse = await t.deps.repository.getJob(NURSE_JOB);
    expect(nurse?.criteriaSource).toBe('llm');
    expect(nurse?.criteria.map((c) => c.label)).toEqual(['LLM criterion: medication', 'LLM criterion: tracheostomy']);
    expect(nurse?.requiresRegistration).toBe(true); // the advert explicitly asks for NMC registration
    expect((await t.deps.repository.getJob('sample:support-worker-ld'))?.criteriaSource).toBe('fallback'); // over the cap
    const usage = await t.api.get('/usage').expect(200);
    expect(usage.body.totals.calls).toBe(2);
    expect(usage.body.records.every((r: { purpose: string }) => r.purpose === 'criteria-extraction')).toBe(true);

    const second = await t.api.post('/jobs/refresh').expect(200);
    expect(second.body.criteriaFromLlm).toBe(1); // only the job that was over the cap last time
    expect(llm.calls).toHaveLength(3);
  });
});

describe('GET /jobs/matches', () => {
  it('needs a profile', async () => {
    t = await createTestApp();
    await t.api.post('/jobs/refresh').expect(200);
    await t.api.get('/jobs/matches').expect(404);
  });

  it('scores every job, with evidence, sorted by eligibility then score', async () => {
    await seeded();
    const res = await t.api.get('/jobs/matches').expect(200);
    expect(res.body.map((m: { job: { id: string } }) => m.job.id).sort()).toEqual([HCA_JOB, NURSE_JOB, 'sample:support-worker-ld'].sort());
    // Sort rule: eligible first, then highest score.
    const rank = res.body.map((m: { eligible: boolean; score: number }) => [m.eligible ? 1 : 0, m.score]);
    for (let i = 1; i < rank.length; i++) {
      expect(rank[i - 1][0] > rank[i][0] || (rank[i - 1][0] === rank[i][0] && rank[i - 1][1] >= rank[i][1])).toBe(true);
    }
    expect(res.body[0].job.id).toBe(NURSE_JOB);
    // The nurse's CV names neither "healthcare assistant" nor "support worker": those two posts are
    // capped as another field (OTHER_FIELD_MAX_SCORE), below the nurse post, so the order is meaningful.
    const others = res.body.filter((m: { job: { id: string } }) => m.job.id !== NURSE_JOB).map((m: { score: number }) => m.score);
    expect(others.every((s: number) => s <= 30 && s < res.body[0].score)).toBe(true);
    const nurse = res.body[0];
    expect(nurse.eligible).toBe(true);
    expect(nurse.job).toMatchObject({ title: 'Staff Nurse - Acute Medical Ward', requiresRegistration: true, applyUrl: 'https://example.org/jobs/staff-nurse-medical' });
    // Recompute the score from the returned hits: essential = 2, desirable = 1.
    for (const m of res.body) {
      const weight = (h: { essential: boolean }) => (h.essential ? 2 : 1);
      const total = m.hits.reduce((a: number, h: { essential: boolean }) => a + weight(h), 0);
      const matched = m.hits.filter((h: { matched: boolean }) => h.matched).reduce((a: number, h: { essential: boolean }) => a + weight(h), 0);
      const raw = Math.round((100 * matched) / total);
      // A post the CV does not show (otherField) is capped at 30.
      expect(m.score).toBe(m.otherField ? Math.min(raw, 30) : raw);
      for (const h of m.hits) {
        if (h.matched) expect(CV_TEXT).toContain(h.evidence);
        else expect(h.evidence).toBeUndefined();
      }
    }
    const med = nurse.hits.find((h: { label: string }) => h.label === 'Medication administration');
    expect(med).toEqual({ label: 'Medication administration', essential: true, matched: true, evidence: 'Completed medication rounds for 28 patients and acted as second checker for controlled drugs.' });
    expect(nurse.hits.find((h: { label: string }) => h.label === 'Venepuncture and cannulation')).toMatchObject({ essential: false, matched: false });
  });

  it('filters with ?min= and validates it', async () => {
    await seeded();
    const all = (await t.api.get('/jobs/matches?min=0').expect(200)).body as { score: number }[];
    const scores = all.map((m) => m.score);
    const threshold = Math.max(...scores);
    const top = (await t.api.get(`/jobs/matches?min=${threshold}`).expect(200)).body as { score: number }[];
    expect(top.length).toBeGreaterThan(0);
    expect(top.length).toBeLessThan(all.length);
    expect(top.every((m) => m.score >= threshold)).toBe(true);
    expect((await t.api.get('/jobs/matches?min=100').expect(200)).body.every((m: { score: number }) => m.score === 100)).toBe(true);
    for (const bad of ['abc', '-1', '101', '5.5', '']) await t.api.get(`/jobs/matches?min=${bad}`).expect(400);
  });

  it('marks registration-only roles ineligible when no NMC PIN is stored, and sorts them last', async () => {
    t = await createTestApp();
    await t.api.put('/profile').send(PROFILE).expect(200);
    await t.api.post('/jobs/refresh').expect(200);
    const res = await t.api.get('/jobs/matches').expect(200);
    const byId = Object.fromEntries(res.body.map((m: { job: { id: string }; eligible: boolean }) => [m.job.id, m.eligible]));
    expect(byId).toEqual({ [NURSE_JOB]: false, [HCA_JOB]: true, 'sample:support-worker-ld': true });
    expect(res.body.at(-1).job.id).toBe(NURSE_JOB);
  });
});

describe('applications', () => {
  it('POST /applications drafts a statement with the LLM and meters the call', async () => {
    const llm = scriptedLlm();
    await seeded({ llm });
    const res = await t.api.post('/applications').send({ jobId: NURSE_JOB }).expect(201);
    expect(res.body).toMatchObject({
      userId: 'dev-user',
      jobId: NURSE_JOB,
      jobTitle: 'Staff Nurse - Acute Medical Ward',
      employer: 'Midshire University Hospitals (example)',
      applyUrl: 'https://example.org/jobs/staff-nurse-medical',
      mode: 'hybrid',
      status: 'draft',
      statement: 'I am a registered nurse and have completed medication rounds for 28 patients.',
      statementSource: 'llm',
      confirmedFields: [],
      createdAt: NOW,
    });
    expect(res.body.statement).not.toMatch(/GAPS/);
    expect(res.body.warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/AI-drafted/),
        'Basic life support expires on 2026-10-20 (14 day(s) left)',
        'Moving and handling expired on 2026-01-10',
      ]),
    );
    // The statement prompt went to the LLM with the essential criteria and the CV.
    expect(llm.calls.filter((c) => c.system !== CV_TAILOR_SYSTEM_PROMPT)).toHaveLength(1); // one call drafts the statement, one rewrites the CV for the advert
    expect(llm.calls.filter((c) => c.system === CV_TAILOR_SYSTEM_PROMPT)).toHaveLength(1);
    expect(llm.calls[0]?.prompt).toContain('Medication administration');
    expect(llm.calls[0]?.prompt).toContain(CV_TEXT);
    const usage = (await t.api.get('/usage').expect(200)).body;
    expect(usage.totals.calls).toBe(2);
    expect(usage.totals.acu).toBeGreaterThan(0);
    expect(usage.records.map((r: { purpose: string }) => r.purpose).sort()).toEqual(['cv-tailoring', 'supporting-statement']);
  });

  it('drafts from CV sentences only when no LLM is configured, and lists gaps separately', async () => {
    const cvText = 'I have five years of experience in a care home.\nI gave personal care with dignity every day.\nI completed my Care Certificate in 2021.';
    t = await createTestApp();
    await t.api.put('/profile').send({ ...PROFILE, cvText }).expect(200);
    await t.api.post('/jobs/refresh').expect(200);
    const res = await t.api.post('/applications').send({ jobId: HCA_JOB, mode: 'review' }).expect(201);
    expect(res.body.statementSource).toBe('fallback');
    expect(res.body.mode).toBe('review');
    const lines = (res.body.statement as string).split('\n');
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(cvText.split('\n')).toContain(line);
    expect(res.body.gaps).toEqual(expect.arrayContaining(['Moving and handling', 'Communication skills']));
    for (const gap of res.body.gaps) expect(res.body.statement).not.toContain(gap);
    expect((await t.api.get('/usage').expect(200)).body.totals.calls).toBe(0);
  });

  it('rejects bad input, unknown jobs, a missing profile and ineligible roles', async () => {
    t = await createTestApp();
    await t.api.post('/jobs/refresh').expect(200);
    await t.api.post('/applications').send({ jobId: HCA_JOB }).expect(404); // no profile yet
    await t.api.put('/profile').send(PROFILE).expect(200);
    await t.api.post('/applications').send({}).expect(400);
    await t.api.post('/applications').send({ jobId: HCA_JOB, mode: 'turbo' }).expect(400);
    await t.api.post('/applications').send({ jobId: HCA_JOB, extra: 1 }).expect(400);
    await t.api.post('/applications').send({ jobId: 'sample:nope' }).expect(404);
    const res = await t.api.post('/applications').send({ jobId: NURSE_JOB }).expect(422); // needs NMC PIN, none stored
    expect(res.body.message).toMatch(/NMC PIN/);
    await t.api.get('/applications').expect(200, []);
  });

  it('confirm records the confirmed fields; submitted closes the application; both are guarded', async () => {
    await seeded();
    const id = (await t.api.post('/applications').send({ jobId: NURSE_JOB, mode: 'hybrid' }).expect(201)).body.id as string;

    await t.api.post(`/applications/${id}/confirm`).send({}).expect(400);
    await t.api.post(`/applications/${id}/confirm`).send({ confirmedFields: [] }).expect(400);
    await t.api.post('/applications/unknown/confirm').send({ confirmedFields: ['nmcPin'] }).expect(404);
    await t.api.post('/applications/unknown/submitted').send(RECEIPT).expect(404);
    // APP-7: "submitted" needs the confirmation page's address and the site's own confirmation text.
    await t.api.post(`/applications/${id}/submitted`).send({}).expect(400);
    await t.api.post(`/applications/${id}/submitted`).send({ pageUrl: RECEIPT.pageUrl }).expect(400);
    await t.api.post(`/applications/${id}/submitted`).send({ ...RECEIPT, confirmationText: '  ' }).expect(400);
    await t.api.post(`/applications/${id}/submitted`).send({ ...RECEIPT, pageUrl: 'javascript:alert(1)' }).expect(400);

    const first = await t.api.post(`/applications/${id}/confirm`).send({ confirmedFields: ['nmcPin', 'rightToWork'] }).expect(200);
    expect(first.body).toMatchObject({ status: 'confirmed', confirmedFields: ['nmcPin', 'rightToWork'], confirmedAt: NOW });
    const second = await t.api.post(`/applications/${id}/confirm`).send({ confirmedFields: ['rightToWork', 'referee1.email'] }).expect(200);
    expect(second.body.confirmedFields).toEqual(['nmcPin', 'rightToWork', 'referee1.email']);

    const done = await t.api.post(`/applications/${id}/submitted`).send(RECEIPT).expect(200);
    expect(done.body).toMatchObject({ status: 'submitted', submittedAt: NOW, receipt: { at: NOW, ...RECEIPT, automatic: false } });
    expect(done.body.receipt.documentsSha256).toEqual(done.body.sentDocuments.sha256);
    await t.api.post(`/applications/${id}/submitted`).send(RECEIPT).expect(409);
    await t.api.post(`/applications/${id}/confirm`).send({ confirmedFields: ['x'] }).expect(409);

    const one = await t.api.get(`/applications/${id}`).expect(200);
    expect(one.body.status).toBe('submitted');
    await t.api.get('/applications/unknown').expect(404);
  });

  it("PUT /applications/:id/statement saves the user's own edit; validated, and refused once submitted", async () => {
    await seeded();
    const id = (await t.api.post('/applications').send({ jobId: NURSE_JOB, mode: 'hybrid' }).expect(201)).body.id as string;
    const edited = 'I give medication rounds for eight patients a shift and escalate with SBAR. (fictional edit)';

    await t.api.put(`/applications/${id}/statement`).send({}).expect(400);
    await t.api.put(`/applications/${id}/statement`).send({ statement: '   ' }).expect(400);
    await t.api.put(`/applications/${id}/statement`).send({ statement: edited, status: 'submitted' }).expect(400);
    await t.api.put(`/applications/${id}/statement`).send({ statement: 'x'.repeat(20_001) }).expect(400);
    await t.api.put('/applications/unknown/statement').send({ statement: edited }).expect(404);

    const saved = await t.api.put(`/applications/${id}/statement`).send({ statement: `  ${edited}  ` }).expect(200);
    // TAI-3: the edit is traced like a draft. The CV says 28 patients, the edit says eight, so it is held for the person.
    expect(saved.body).toMatchObject({ id, statement: edited, status: 'needs_you', holdReasons: ['trace-check'] });
    expect(saved.body.traceFailures).toEqual(['Statement: "I give medication rounds for eight patients a shift and escalate with SBAR." mentions eight, which your CV does not contain.']);
    expect((await t.api.get(`/applications/${id}`).expect(200)).body.statement).toBe(edited);

    const events = await t.deps.repository.listEvents('dev-user');
    const event = events.find((e) => e.type === 'application.statement.edited');
    expect(event?.payload).toEqual({ applicationId: id, statementCharacters: edited.length });
    expect(JSON.stringify(events)).not.toContain('SBAR');

    await t.api.post(`/applications/${id}/submitted`).send(RECEIPT).expect(200);
    await t.api.put(`/applications/${id}/statement`).send({ statement: 'changed after sending' }).expect(409);
    expect((await t.api.get(`/applications/${id}`).expect(200)).body.statement).toBe(edited);
  });

  it('GET /applications lists every application', async () => {
    await seeded();
    const a = (await t.api.post('/applications').send({ jobId: NURSE_JOB }).expect(201)).body;
    const b = (await t.api.post('/applications').send({ jobId: HCA_JOB, mode: 'auto' }).expect(201)).body;
    const list = (await t.api.get('/applications').expect(200)).body as { id: string; mode: string }[];
    expect(list.map((x) => x.id).sort()).toEqual([a.id, b.id].sort());
    expect(list.find((x) => x.id === b.id)?.mode).toBe('auto');
  });

  it('emits domain events to the event log without personal data in the payloads', async () => {
    await seeded({ llm: scriptedLlm() });
    const id = (await t.api.post('/applications').send({ jobId: NURSE_JOB }).expect(201)).body.id as string;
    await t.api.post(`/applications/${id}/confirm`).send({ confirmedFields: ['nmcPin'] }).expect(200);
    await t.api.post(`/applications/${id}/submitted`).send(RECEIPT).expect(200);
    const events = await t.deps.repository.listEvents('dev-user');
    expect(events.map((e) => e.type)).toEqual(['profile.updated', 'passport.updated', 'jobs.refreshed', 'application.drafted', 'application.confirmed', 'application.submitted']);
    expect(events[3]?.payload).toMatchObject({ applicationId: id, jobId: NURSE_JOB, mode: 'hybrid', statementSource: 'llm' });
    const log = JSON.stringify(events);
    for (const secret of [PROFILE.email, PROFILE.lastName, PROFILE.phone, PASSPORT.nmcPin, PASSPORT.dbs.certificateNumber, 'medication rounds', 'Priya']) {
      expect(log).not.toContain(secret);
    }
  });
});

describe('interview', () => {
  const answer = 'Last year on a night shift a patient was very distressed. My role was to keep him safe. I checked his observations, I escalated to the nurse in charge and I documented everything. As a result he was reviewed within 15 minutes and recovered.';

  it('GET /interview/questions returns the bank and filters by role and category', async () => {
    t = await createTestApp();
    const all = (await t.api.get('/interview/questions').expect(200)).body as { id: string; category: string; roles: string[] }[];
    expect(all.length).toBeGreaterThanOrEqual(12);
    const clinicalNurse = (await t.api.get('/interview/questions?role=nurse&category=clinical').expect(200)).body as typeof all;
    expect(clinicalNurse.length).toBeGreaterThan(0);
    expect(clinicalNurse.every((q) => q.category === 'clinical' && q.roles.includes('nurse'))).toBe(true);
    await t.api.get('/interview/questions?role=surgeon').expect(400);
  });

  it('POST /interview/feedback scores with the LLM when configured and meters it', async () => {
    const llm = scriptedLlm();
    t = await createTestApp({ llm });
    const res = await t.api.post('/interview/feedback').send({ questionId: 'clin-deteriorating', answer }).expect(200);
    expect(res.body.question).toMatch(/observations suddenly worsen/);
    expect(res.body.lookFor).toContain('escalation');
    expect(res.body.feedback).toEqual({
      scores: { situation: 4, task: 3, action: 5, result: 2 },
      total: 14,
      strengths: ['Clear actions.'],
      improvements: ['Say what happened in the end.'],
      source: 'llm',
    });
    expect(llm.calls[0]?.prompt).toContain(answer);
    expect((await t.api.get('/usage').expect(200)).body.records[0].purpose).toBe('interview-feedback');
  });

  it('falls back to the heuristic scorer without an LLM, for bank and custom questions', async () => {
    t = await createTestApp();
    const res = await t.api.post('/interview/feedback').send({ question: 'Tell me about a time you escalated a concern.', answer }).expect(200);
    expect(res.body.feedback.source).toBe('heuristic');
    expect(res.body.lookFor).toEqual([]);
    const s = res.body.feedback.scores;
    expect(res.body.feedback.total).toBe(s.situation + s.task + s.action + s.result);
    expect(s.action).toBeGreaterThanOrEqual(3);
  });

  it('validates input', async () => {
    t = await createTestApp();
    await t.api.post('/interview/feedback').send({ answer }).expect(400);
    await t.api.post('/interview/feedback').send({ questionId: 'val-compassion', question: 'both', answer }).expect(400);
    await t.api.post('/interview/feedback').send({ questionId: 'val-compassion', answer: '   ' }).expect(400);
    await t.api.post('/interview/feedback').send({ questionId: 'val-compassion' }).expect(400);
    await t.api.post('/interview/feedback').send({ questionId: 'no-such-question', answer }).expect(404);
  });
});
