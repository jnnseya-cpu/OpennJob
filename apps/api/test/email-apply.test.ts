import { afterEach, describe, expect, it } from 'vitest';
import { STANDING_SCOPE_TEXT, STANDING_SCOPE_VERSION } from '@opennjob/core';
import type { Application } from '@opennjob/core';
import type { EmailMessage, EmailSender } from '../src/notifications';
import { PASSPORT, PROFILE, USER_ID, createTestApp, testConfig } from './helpers';
import type { TestApp } from './helpers';

/**
 * Applications by e-mail to the recruiter an advert names, under standing authorisation.
 * Fictional people, recruiters and employers; no real mail is sent (a capturing sender).
 */
let t: TestApp;
afterEach(async () => {
  await t?.app.close();
});

const EMPLOYER_KEY = 'employer-key-not-a-secret';
const RECRUITER = 'jane.recruiter@example.org';

function capturing(result: 'sent' | 'failed' = 'sent'): EmailSender & { sent: EmailMessage[] } {
  const sent: EmailMessage[] = [];
  return { name: 'capture', live: true, sent, send: async (m) => (sent.push(m), result) };
}

const vacancy = (n: number, description: string) => ({
  title: `Staff Nurse ${n} (fictional)`,
  employer: `Moorside Care ${n} (fictional)`,
  description,
  country: 'gb',
  city: 'Leeds',
  applyUrl: `https://example.org/apply/${n}`,
  criteria: [
    { label: 'Medication rounds', essential: true, keywords: ['medication'] },
    { label: 'Care plans', essential: true, keywords: ['care plans'] },
  ],
});

async function setUp(sender: EmailSender, authorised = true) {
  t = await createTestApp({ sources: [], emailSender: sender, config: testConfig({ employerKey: EMPLOYER_KEY }) });
  await t.api.put('/profile').send(PROFILE).expect(200);
  await t.api.put('/passport').send(PASSPORT).expect(200);
  const post = (body: object) => t.raw().post('/employer/jobs').set('Authorization', `Bearer ${EMPLOYER_KEY}`).send(body).expect(201);
  const withAddress = (await post(vacancy(1, `A fictional vacancy. Ref: MC-001. Send your CV to ${RECRUITER}.`))).body;
  const withoutAddress = (await post(vacancy(2, 'A fictional vacancy. Apply on our website.'))).body;
  if (authorised) await t.api.put('/agent/authorisation').send({ enabled: true, scopeVersion: STANDING_SCOPE_VERSION }).expect(200);
  return { withAddress, withoutAddress };
}

describe('applications by e-mail', () => {
  it('the wording the person agrees to names the e-mail route', () => {
    expect(STANDING_SCOPE_TEXT).toMatch(/e-mails my tailored CV as a PDF and my supporting statement there, in my name, with replies coming to my own e-mail address/);
  });

  it('sends the tailored CV and statement to the recruiter, in the person\'s name, replies to them, once', async () => {
    const sender = capturing();
    const { withAddress, withoutAddress } = await setUp(sender);
    const run = (await t.api.post('/agent/run').send({ mode: 'auto' }).expect(200)).body as { prepared: Application[]; emailed: { sent: number; failed: number } };
    expect(run.emailed).toEqual({ sent: 1, failed: 0 });
    const toRecruiter = sender.sent.filter((m) => m.to === RECRUITER);
    expect(toRecruiter).toHaveLength(1);
    const m = toRecruiter[0] as EmailMessage;
    expect(m.subject).toBe(`Application: Staff Nurse 1 (fictional) (ref MC-001) - ${PROFILE.firstName} ${PROFILE.lastName}`);
    expect(m.fromName).toBe(`${PROFILE.firstName} ${PROFILE.lastName}`);
    expect(m.replyTo).toBe(PROFILE.email);
    expect(m.attachments?.[0]).toMatchObject({ filename: `${PROFILE.firstName}_${PROFILE.lastName}_CV.pdf`, contentType: 'application/pdf' });
    expect(Buffer.from(m.attachments?.[0]?.content ?? []).toString('latin1').startsWith('%PDF-1.4')).toBe(true);

    const apps = (await t.api.get('/applications').expect(200)).body as Application[];
    const sentApp = apps.find((a) => a.jobId === withAddress.id);
    expect(sentApp).toMatchObject({ status: 'submitted', automatic: true, receipt: { pageUrl: `mailto:${RECRUITER}`, automatic: true } });
    expect(apps.find((a) => a.jobId === withoutAddress.id)?.status).toBe('draft'); // no address: left for the form route

    // A second run sends nothing again.
    const again = (await t.api.post('/agent/run').send({ mode: 'auto' }).expect(200)).body;
    expect(again.emailed).toEqual({ sent: 0, failed: 0 });
    expect(sender.sent.filter((m2) => m2.to === RECRUITER)).toHaveLength(1);
    // Events carry ids and counters only.
    const payloads = JSON.stringify((await t.deps.repository.listEvents(USER_ID)).map((e) => e.payload));
    expect(payloads).not.toContain(RECRUITER);
  });

  it('sends nothing without standing authorisation, or in hybrid mode', async () => {
    const sender = capturing();
    await setUp(sender, false);
    expect((await t.api.post('/agent/run').send({ mode: 'auto' }).expect(200)).body.emailed).toEqual({ sent: 0, failed: 0, wait: 'not-authorised' });
    expect((await t.api.post('/agent/run').send({ mode: 'hybrid' }).expect(200)).body.emailed).toBeUndefined();
    expect(sender.sent.filter((m) => m.to === RECRUITER)).toEqual([]);
  });

  it('a message the mail server refuses is held for the person and never retried', async () => {
    const sender = capturing('failed');
    const { withAddress } = await setUp(sender);
    expect((await t.api.post('/agent/run').send({ mode: 'auto' }).expect(200)).body.emailed).toEqual({ sent: 0, failed: 1 });
    const app = ((await t.api.get('/applications').expect(200)).body as Application[]).find((a) => a.jobId === withAddress.id);
    expect(app).toMatchObject({ status: 'needs_you', holdReasons: ['email-not-sent'] });
    await t.api.post('/agent/run').send({ mode: 'auto' }).expect(200);
    expect(sender.sent.filter((m) => m.to === RECRUITER)).toHaveLength(1);
  });

  it('stops at the daily limit', async () => {
    const sender = capturing();
    t = await createTestApp({ sources: [], emailSender: sender, config: testConfig({ employerKey: EMPLOYER_KEY, dailyApplicationLimit: 1 }) });
    await t.api.put('/profile').send(PROFILE).expect(200);
    await t.api.put('/passport').send(PASSPORT).expect(200);
    for (const n of [1, 2]) await t.raw().post('/employer/jobs').set('Authorization', `Bearer ${EMPLOYER_KEY}`).send(vacancy(n, `Send your CV to recruiter${n}@example.org`)).expect(201);
    await t.api.put('/agent/authorisation').send({ enabled: true, scopeVersion: STANDING_SCOPE_VERSION }).expect(200);
    expect((await t.api.post('/agent/run').send({ mode: 'auto' }).expect(200)).body.emailed).toEqual({ sent: 1, failed: 0, wait: 'daily-limit' });
  });
});
