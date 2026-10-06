import { afterEach, describe, expect, it, vi } from 'vitest';
import { NOTIFICATION_CATALOGUE, NOTIFICATION_CATEGORIES, eventsForTrigger, renderEmailHtml, routeChannels } from '@opennjob/core';
import { memoryLogger } from '../src/logging';
import { resendEmail } from '../src/notifications';
import type { EmailSender } from '../src/notifications';
import { PASSPORT, PROFILE, USER_EMAIL, USER_ID, USER_PASSWORD, createTestApp, testConfig } from './helpers';
import type { TestApp } from './helpers';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.app.close();
  t = undefined;
});

/** Records what would have been sent. */
function capturing(): EmailSender & { sent: { to: string; subject: string; html: string }[] } {
  const sent: { to: string; subject: string; html: string }[] = [];
  return { name: 'capture', live: true, sent, send: async (m) => (sent.push(m), 'sent') };
}

describe('the catalogue', () => {
  it('has unique keys, known categories, in-app on every event, and honest live/planned flags', () => {
    const keys = NOTIFICATION_CATALOGUE.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const e of NOTIFICATION_CATALOGUE) {
      expect(NOTIFICATION_CATEGORIES as readonly string[]).toContain(e.category);
      expect(e.channels).toContain('inapp');
    }
    // Every live trigger is an event the API really publishes.
    const published = ['account.registered', 'account.signed_in', 'account.exported', 'account.deleted', 'notification.test', 'profile.updated', 'passport.updated', 'jobs.refreshed', 'agent.run', 'application.drafted', 'application.confirmed', 'application.submitted', 'application.statement.edited', 'interview.feedback',
      'auth.verification_sent', 'account.email_verified', 'auth.password_reset_requested', 'account.password_changed', 'application.uncertain', 'application.needs_you', 'report.daily'];
    for (const e of NOTIFICATION_CATALOGUE.filter((x) => x.trigger)) expect(published).toContain(e.trigger);
    expect(eventsForTrigger('application.drafted').map((e) => e.key)).toEqual(['agent.review_needed']);
    // Messages that carry a one-time link or a report are sent directly, never by the dispatcher.
    expect(eventsForTrigger('auth.verification_sent')).toEqual([]); expect(eventsForTrigger('report.daily')).toEqual([]);
    expect(NOTIFICATION_CATALOGUE.filter((e) => e.direct).map((e) => e.key).sort()).toEqual(['account.email_verification_required', 'agent.daily_report', 'security.password_reset_link']);
  });

  it('routes by preference; mandatory notices ignore opt-outs; muted events keep in-app only', () => {
    const run = NOTIFICATION_CATALOGUE.find((e) => e.key === 'agent.run_completed')!;
    const deleted = NOTIFICATION_CATALOGUE.find((e) => e.key === 'privacy.account_deleted')!;
    const off = { email: false, sms: false, push: false, whatsapp: false, muted: [] };
    expect(routeChannels(run, { ...off, email: true })).toEqual({ send: ['email', 'inapp'], skipped: ['push'] });
    expect(routeChannels(run, { ...off, email: true, muted: ['agent.run_completed'] })).toEqual({ send: ['inapp'], skipped: ['email', 'push'] });
    expect(routeChannels(deleted, { ...off, muted: ['privacy.account_deleted'] }).send).toContain('email');
  });

  it('renders branded, escaped e-mail with only whitelisted placeholders', () => {
    const def = NOTIFICATION_CATALOGUE.find((e) => e.key === 'agent.review_needed')!;
    const m = renderEmailHtml(def, { jobTitle: '<script>x</script>Site Manager', employer: 'Example Ltd' }, { name: 'Brandly', colour: '#123456', footer: 'Brandly Ltd, 1 Example Street (fictional)' });
    expect(m.subject).toBe('Action needed: review <script>x</script>Site Manager');
    expect(m.html).not.toContain('<script>x');
    expect(m.html).toContain('&lt;script&gt;');
    expect(m.html).toContain('Brandly'); expect(m.html).toContain('#123456'); expect(m.html).toContain('1 Example Street (fictional)');
  });
});

describe('the engine, through the API', () => {
  it('a draft notifies the owner in-app with the job title; e-mail goes through the sender; nothing personal is logged', async () => {
    const sender = capturing();
    const logger = memoryLogger();
    t = await createTestApp({ emailSender: sender, logger });
    await t.api.put('/profile').send(PROFILE).expect(200);
    await t.api.put('/passport').send(PASSPORT).expect(200);
    await t.api.post('/jobs/refresh').expect(200);
    await t.api.post('/applications').send({ jobId: 'sample:staff-nurse-medical', mode: 'hybrid' }).expect(201);
    await t.api.post('/agent/run').send({ mode: 'hybrid' }).expect(200);

    const inbox = (await t.api.get('/notifications').expect(200)).body;
    const subjects = inbox.items.map((n: { subject: string }) => n.subject);
    expect(subjects).toContain('Action needed: review Staff Nurse - Acute Medical Ward');
    expect(subjects).toContain('Profile saved');
    expect(subjects.some((s: string) => /^Agent run finished: \d+ applications prepared$/.test(s))).toBe(true);
    expect(inbox.unread).toBe(inbox.items.length);
    // Agent run summary went by e-mail (default on), to the account address.
    expect(sender.sent.map((m) => m.subject)).toEqual(expect.arrayContaining([expect.stringMatching(/^Agent run finished/)]));
    expect(sender.sent.every((m) => m.to === USER_EMAIL)).toBe(true);
    // Push is off by default: recorded as skipped, never sent.
    const deliveries = (await t.api.get('/deliveries'.replace('/deliveries', '/notifications/deliveries')).expect(200)).body;
    expect(deliveries.items.some((d: { channel: string; status: string }) => d.channel === 'push' && d.status === 'skipped')).toBe(true);
    expect(JSON.stringify(deliveries)).not.toContain(USER_EMAIL);
    // The log names events and channels only.
    const log = JSON.stringify(logger.lines);
    expect(log).toContain('agent.run_completed');
    for (const secret of [USER_EMAIL, 'Staff Nurse', PROFILE.cvText.slice(0, 30)]) expect(log).not.toContain(secret);

    await t.api.post('/notifications/read').send({}).expect(200);
    expect((await t.api.get('/notifications').expect(200)).body.unread).toBe(0);
  });

  it('preferences: e-mail off skips e-mail; a muted event stays in-app; validation refuses unknown keys', async () => {
    const sender = capturing();
    t = await createTestApp({ emailSender: sender });
    await t.api.put('/notifications/preferences').send({ email: false, sms: false, push: false, whatsapp: false, muted: [] }).expect(200);
    await t.api.put('/notifications/preferences').send({ email: true, sms: false, push: false, whatsapp: false, muted: ['nope.unknown'] }).expect(400);
    await t.api.put('/notifications/preferences').send({ email: true, sms: false, push: false, whatsapp: false, muted: [], extra: 1 }).expect(400);
    await t.api.put('/profile').send(PROFILE).expect(200);
    await t.api.post('/notifications/test').send({ event: 'agent.run_completed' }).expect(200);
    expect(sender.sent).toEqual([]);
    const test = (await t.api.post('/notifications/test').send({}).expect(200)).body.deliveries;
    expect(test.map((d: { channel: string; status: string }) => `${d.channel}:${d.status}`).sort()).toEqual(['email:skipped', 'inapp:delivered', 'push:skipped', 'sms:skipped', 'whatsapp:skipped']);
    await t.api.put('/notifications/preferences').send({ email: true, sms: true, push: true, whatsapp: true, muted: [] }).expect(200);
    const all = (await t.api.post('/notifications/test').send({}).expect(200)).body.deliveries;
    expect(all.map((d: { channel: string; status: string; provider: string }) => `${d.channel}:${d.status}:${d.provider}`).sort()).toEqual(['email:sent:capture', 'inapp:delivered:inbox', 'push:logged:not wired', 'sms:logged:not wired', 'whatsapp:logged:not wired']);
    expect(sender.sent[0]?.subject).toBe('[Test] Test message from OpennJob');
  });

  it('without a provider, e-mail is sandboxed; the catalogue says which channels are wired; preview is branded', async () => {
    t = await createTestApp({ config: testConfig({ brand: { name: 'Pilotly', colour: '#224466', footer: 'Pilotly, Example House (fictional)' } }) });
    const cat = (await t.api.get('/notifications/catalogue').expect(200)).body;
    expect(cat.stats.events).toBe(NOTIFICATION_CATALOGUE.length);
    expect(cat.stats.live + cat.stats.planned).toBe(cat.stats.events);
    expect(cat.channels.find((c: { channel: string }) => c.channel === 'email')).toMatchObject({ wired: false, provider: 'sandbox' });
    expect(cat.channels.find((c: { channel: string }) => c.channel === 'inapp')).toMatchObject({ wired: true, events: NOTIFICATION_CATALOGUE.length });
    const preview = (await t.api.get('/notifications/preview?event=account.registered').expect(200)).body;
    expect(preview.subject).toBe('Welcome to Pilotly'); expect(preview.html).toContain('#224466');
    await t.api.get('/notifications/preview?event=does.not.exist').expect(400);
    const test = (await t.api.post('/notifications/test').send({}).expect(200)).body.deliveries;
    expect(test.find((d: { channel: string }) => d.channel === 'email')).toMatchObject({ status: 'logged', provider: 'sandbox' });
  });

  it('deleting the account sends the mandatory notice to the old address and keeps nothing of it', async () => {
    const sender = capturing();
    const logger = memoryLogger();
    t = await createTestApp({ emailSender: sender, logger });
    await t.api.delete('/account').send({ password: USER_PASSWORD }).expect(200);
    expect(sender.sent.map((m) => [m.to, m.subject])).toEqual([[USER_EMAIL, 'Your OpennJob account has been deleted']]);
    expect(await t.deps.repository.listDeliveries(USER_ID)).toEqual([]);
    expect(JSON.stringify(logger.lines)).not.toContain(USER_EMAIL);
  });
});

describe('Resend sender', () => {
  it('posts to the Resend API and reports failure on a non-2xx reply (no network: fake fetch)', async () => {
    const calls: { url: string; init: { headers: Record<string, string>; body: string } }[] = [];
    const ok = resendEmail('re_test_not_a_key', 'OpennJob <noreply@example.org>', async (url, init) => (calls.push({ url, init }), { ok: true }));
    expect(await ok.send({ to: 'x@example.org', subject: 's', text: 't', html: '<p>h</p>' })).toBe('sent');
    expect(calls[0]?.url).toBe('https://api.resend.com/emails');
    expect(calls[0]?.init.headers.Authorization).toBe('Bearer re_test_not_a_key');
    expect(JSON.parse(calls[0]?.init.body ?? '{}')).toEqual({ from: 'OpennJob <noreply@example.org>', to: ['x@example.org'], subject: 's', text: 't', html: '<p>h</p>' });
    const bad = resendEmail('k', 'f', async () => ({ ok: false }));
    expect(await bad.send({ to: 'x@example.org', subject: 's', text: 't', html: 'h' })).toBe('failed');
    vi.restoreAllMocks();
  });
});
