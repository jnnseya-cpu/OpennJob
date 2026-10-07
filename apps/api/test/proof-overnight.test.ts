import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { STANDING_SCOPE_VERSION } from '@opennjob/core';
import type { Application } from '@opennjob/core';
import type { EmailMessage, EmailSender } from '../src/notifications';
import { signAccessToken } from '../src/auth';
import { Scheduler } from '../src/scheduler';
import { PASSPORT, PROFILE, USER_EMAIL, USER_ID, createTestApp, testConfig } from './helpers';
import type { TestApp } from './helpers';

/**
 * The whole overnight chain, with nobody at the keyboard: the person sets up once in the evening;
 * the 06:00 run finds the job, writes the documents and e-mails the application to the recruiter;
 * the 09:00 report tells the person what went out. Real API code, scheduler and PDF writer; a
 * capturing mailbox instead of a mail server; fictional person, employer and recruiter.
 *
 * With OPENNJOB_PROOF_DIR set, the e-mails and PDFs it produced are written there to be read.
 */
let t: TestApp;
afterEach(async () => {
  await t?.app.close();
});

const EMPLOYER_KEY = 'employer-key-not-a-secret';
const RECRUITER = 'jane.recruiter@example.org';

function movable(start: string) {
  let now = new Date(start);
  return { clock: () => now, set: (iso: string) => (now = new Date(iso)) };
}

describe('overnight: applied at 06:00 without the person, reported at 09:00', () => {
  it('sends one application with CV and cover letter PDFs, then a report that lists it', async () => {
    const time = movable('2026-10-06T19:00:00.000Z'); // 20:00 London, the evening before
    const sent: EmailMessage[] = [];
    const sender: EmailSender = { name: 'capture', live: true, send: async (m) => (sent.push(m), 'sent') };
    t = await createTestApp({ sources: [], clock: time.clock, emailSender: sender, config: testConfig({ employerKey: EMPLOYER_KEY }) });

    // The evening before: the person's one-time set-up.
    await t.api.put('/profile').send(PROFILE).expect(200);
    await t.api.put('/passport').send(PASSPORT).expect(200);
    await t.api.put('/agent/authorisation').send({ enabled: true, scopeVersion: STANDING_SCOPE_VERSION }).expect(200);
    // An advert that names a recruiter's address arrives.
    await t.raw().post('/employer/jobs').set('Authorization', `Bearer ${EMPLOYER_KEY}`).send({
      title: 'Staff Nurse (fictional)',
      employer: 'Moorside Care (fictional)',
      description: 'A fictional vacancy on a busy ward: medication rounds and care plans. Ref: MC-001. Send your CV to ' + RECRUITER + '.',
      country: 'gb',
      city: 'Leeds',
      applyUrl: 'https://example.org/apply/1',
      criteria: [
        { label: 'Medication rounds', essential: true, keywords: ['medication'] },
        { label: 'Care plans', essential: true, keywords: ['care plans'] },
      ],
    }).expect(201);
    expect(sent.filter((m) => m.to === RECRUITER)).toEqual([]);

    // Nobody touches anything from here on. 06:00 London: discovery, drafting, sending.
    const scheduler = t.app.get(Scheduler);
    time.set('2026-10-07T05:00:00.000Z');
    expect(await scheduler.tick()).toEqual(['discovery']);
    const application = sent.filter((m) => m.to === RECRUITER);
    expect(application).toHaveLength(1);
    const mail = application[0] as EmailMessage;
    expect(mail.fromName).toBe(`${PROFILE.firstName} ${PROFILE.lastName}`);
    expect(mail.replyTo).toBe(PROFILE.email);
    expect(mail.subject).toContain('Staff Nurse (fictional) (ref MC-001)');
    expect(mail.attachments?.map((a) => a.filename)).toEqual([`${PROFILE.firstName}_${PROFILE.lastName}_CV.pdf`, `${PROFILE.firstName}_${PROFILE.lastName}_Cover_Letter.pdf`]);
    for (const a of mail.attachments ?? []) expect(Buffer.from(a.content).toString('latin1').startsWith('%PDF-1.4')).toBe(true);
    // The evening's session has long expired; the person signs in again to look.
    const signedIn = () => t.as(signAccessToken(USER_ID, t.deps.config.jwtSecret as string, 3600, time.clock()).accessToken);
    const apps = (await signedIn().get('/applications').expect(200)).body as Application[];
    expect(apps).toHaveLength(1);
    expect(apps[0]).toMatchObject({ status: 'submitted', automatic: true, receipt: { pageUrl: `mailto:${RECRUITER}` } });

    // 08:59: no report yet. 09:00: the report.
    time.set('2026-10-07T07:59:00.000Z');
    expect(await scheduler.tick()).toEqual([]);
    time.set('2026-10-07T08:00:00.000Z');
    expect((await scheduler.tick()).filter((r) => r.startsWith('report'))).toHaveLength(1);
    const report = sent.find((m) => m.to === USER_EMAIL && m.text.includes('Submitted'));
    expect(report?.text).toContain("Submitted, with the site's confirmation: 1");
    expect(report?.text).toContain('Staff Nurse (fictional) — Moorside Care (fictional)');
    expect(report?.text).toContain(`E-mailed to ${RECRUITER}`);
    // Nothing goes twice: a later run that day sends no second application or report.
    time.set('2026-10-07T12:00:00.000Z');
    await signedIn().post('/agent/run').send({ mode: 'auto' }).expect(200);
    await scheduler.tick();
    expect(sent.filter((m) => m.to === RECRUITER)).toHaveLength(1);
    expect(sent.filter((m) => m.to === USER_EMAIL && m.text.includes('Submitted'))).toHaveLength(1);

    const dir = process.env.OPENNJOB_PROOF_DIR;
    if (dir && report) {
      mkdirSync(dir, { recursive: true });
      const head = (m: EmailMessage) => `To: ${m.to}\nFrom name: ${m.fromName ?? ''}\nReply-To: ${m.replyTo ?? ''}\nSubject: ${m.subject}\nAttachments: ${(m.attachments ?? []).map((a) => a.filename).join(', ') || 'none'}\n\n`;
      writeFileSync(join(dir, '1-application-email-sent-at-0600.txt'), head(mail) + mail.text);
      for (const a of mail.attachments ?? []) writeFileSync(join(dir, `2-${a.filename}`), Buffer.from(a.content));
      writeFileSync(join(dir, '3-report-email-sent-at-0900.txt'), head(report) + report.text);
    }
  });
});
