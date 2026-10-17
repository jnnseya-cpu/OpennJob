import { afterEach, describe, expect, it } from 'vitest';
import { STANDING_SCOPE_VERSION } from '@opennjob/core';
import type { Application, ApplicationOutcome, Job } from '@opennjob/core';
import { ApplyingService } from '../src/applying.service';
import type { EmailMessage, EmailSender } from '../src/notifications';
import { PASSPORT, PROFILE, USER_ID, createTestApp } from './helpers';
import type { TestApp } from './helpers';

/**
 * Aiming automatic applications at an interview rate: outcomes the person records raise the bar
 * for what goes out on its own, and employers that interviewed them go first. Fictional data.
 */
let t: TestApp;
afterEach(async () => {
  await t?.app.close();
});

const job = (id: string, employer: string, email?: string): Job => ({
  id: `employer:${id}`,
  source: 'employer',
  externalId: id,
  title: 'Staff Nurse (fictional)',
  employer,
  location: 'Leeds',
  url: `https://example.org/jobs/${id}`,
  description: `A fictional vacancy.${email ? ` Send your CV to ${email}.` : ''}`,
  criteria: [],
  criteriaSource: 'provided',
  requiresRegistration: false,
  origin: 'employer',
});

const app = (id: string, j: Job, score: number, extra: Partial<Application> = {}): Application => ({
  id,
  userId: USER_ID,
  jobId: j.id,
  jobTitle: j.title,
  employer: j.employer,
  applyUrl: j.url,
  mode: 'auto',
  status: 'draft',
  statement: 'I completed medication rounds on a ward. (fictional)',
  statementSource: 'fallback',
  gaps: [],
  warnings: [],
  score,
  confirmedFields: [],
  createdAt: '2026-10-06T06:00:00.000Z',
  ...extra,
});

async function history(rows: { score: number; outcome: ApplicationOutcome; employer?: string }[]) {
  let i = 0;
  for (const r of rows) {
    i += 1;
    const j = job(`past-${i}`, r.employer ?? `Past Employer ${i} (fictional)`);
    await t.deps.repository.upsertJobs([j]);
    await t.deps.repository.createApplication(app(`past-${i}`, j, r.score, { status: 'submitted', submittedAt: '2026-09-01T06:00:00.000Z', outcome: r.outcome, outcomeAt: '2026-09-10T09:00:00.000Z' }));
  }
}

const rows = (count: number, score: number, outcome: ApplicationOutcome) => Array.from({ length: count }, () => ({ score, outcome }));

describe('interview rate', () => {
  it('reports interviews by match score and the bar, which rises toward the target once outcomes show it', async () => {
    t = await createTestApp({ sources: [] });
    await t.api.put('/profile').send({ ...PROFILE, preferences: { languages: [], countries: [], cities: [], targetInterviewRate: 80 } }).expect(200);
    let rates = (await t.api.get('/agent/interview-rates').expect(200)).body;
    expect(rates.bar).toMatchObject({ bar: 80, base: 80, target: 80, reason: 'learning', outcomes: 0, needed: 20 });

    await history([...rows(12, 82, 'no-reply'), ...rows(8, 92, 'interview'), ...rows(2, 93, 'rejected')]);
    rates = (await t.api.get('/agent/interview-rates').expect(200)).body;
    expect(rates.bands.find((b: { label: string }) => b.label === '90–94%')).toMatchObject({ sent: 10, outcomes: 10, interviews: 8, rate: 80 });
    expect(rates.bar).toMatchObject({ bar: 90, reason: 'meets-target', rateAtBar: 80 });
    // The agent prepares nothing below the raised bar.
    expect((await t.api.post('/agent/run').send({ mode: 'hybrid' }).expect(200)).body.threshold).toBe(90);
  });

  it('automatic e-mails go only at or above the raised bar, employers that interviewed the person first', async () => {
    const sent: EmailMessage[] = [];
    const sender: EmailSender = { name: 'capture', live: true, send: async (m) => (sent.push(m), 'sent') };
    t = await createTestApp({ sources: [], emailSender: sender });
    await t.api.put('/profile').send({ ...PROFILE, preferences: { languages: [], countries: [], cities: [], targetInterviewRate: 80 } }).expect(200);
    await t.api.put('/passport').send(PASSPORT).expect(200);
    await t.api.put('/agent/authorisation').send({ enabled: true, scopeVersion: STANDING_SCOPE_VERSION }).expect(200);
    await history([...rows(12, 82, 'no-reply'), ...rows(7, 92, 'interview'), { score: 91, outcome: 'interview', employer: 'Moorside Care Ltd (fictional)' }, ...rows(2, 93, 'rejected')]);

    const low = job('low', 'Low Match Co (fictional)', 'low@example.org');
    const high = job('high', 'High Match Co (fictional)', 'high@example.org');
    const known = job('known', 'Moorside Care Group (fictional)', 'known@example.org');
    await t.deps.repository.upsertJobs([low, high, known]);
    await t.deps.repository.createApplication(app('low', low, 84));
    await t.deps.repository.createApplication(app('high', high, 97));
    await t.deps.repository.createApplication(app('known', known, 91));

    // The sending step on its own (the agent run would first score these hand-made drafts again).
    expect(await t.app.get(ApplyingService).sendByEmail(USER_ID)).toMatchObject({ sent: 2, failed: 0 });
    expect(sent.filter((m) => m.to.endsWith('@example.org') && m.attachments?.length).map((m) => m.to)).toEqual(['known@example.org', 'high@example.org']);
    // The one below the bar stays a draft the person can still send.
    expect((await t.deps.repository.getApplication(USER_ID, 'low'))?.status).toBe('draft');
  });

  it('rejects a target outside 5-100', async () => {
    t = await createTestApp({ sources: [] });
    const send = (targetInterviewRate: number) => t.api.put('/profile').send({ ...PROFILE, preferences: { languages: [], countries: [], cities: [], targetInterviewRate } });
    await send(4).expect(400);
    await send(101).expect(400);
    await send(80).expect(200);
  });
});
