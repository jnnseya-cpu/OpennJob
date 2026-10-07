import { expect, test } from '@playwright/test';
import { freePort, startApi, startWeb } from './servers';
import type { ApiProcess, WebServer } from './servers';

/**
 * The Tracker's daily review (skip what should not go out automatically), the person's record of
 * what came of each sent application, and replies by route. Fictional account and jobs.
 */
test.describe.configure({ mode: 'serial' });

let api: ApiProcess;
let web: WebServer;
let session: { accessToken: string; expiresAt: string };
const j = { 'Content-Type': 'application/json' };
const auth = () => ({ ...j, Authorization: `Bearer ${session.accessToken}` });
let outgoingId = '';
let sentId = '';

test.beforeAll(async () => {
  const port = await freePort();
  api = await startApi(`http://127.0.0.1:${port}`);
  web = await startWeb(port, api.url);
  const v = (await (await fetch(`${api.url}/auth/versions`)).json()) as { termsVersion: string; privacyVersion: string };
  session = (await (
    await fetch(`${api.url}/auth/register`, {
      method: 'POST',
      headers: j,
      body: JSON.stringify({ email: 'tracker.check@example.org', password: 'a long fictional passphrase here', acceptedTermsVersion: v.termsVersion, acceptedPrivacyVersion: v.privacyVersion }),
    })
  ).json()) as { accessToken: string; expiresAt: string };
  const cv = 'Example Candidate (fictional). Healthcare assistant: personal care, dementia care, care plans and accurate records. Team player.';
  await fetch(`${api.url}/profile`, { method: 'PUT', headers: auth(), body: JSON.stringify({ firstName: 'Sam', lastName: 'Example', email: 'tracker.check@example.org', phone: '07700 900333', addressLine1: '3 Example Road', city: 'Leeds', postcode: 'LS3 3CC', cvText: cv }) });
  await fetch(`${api.url}/jobs/refresh`, { method: 'POST', headers: auth() });
  const matches = (await (await fetch(`${api.url}/jobs/matches?min=0`, { headers: auth() })).json()) as { job: { id: string }; eligible: boolean }[];
  const eligible = matches.filter((m) => m.eligible).map((m) => m.job.id);
  const create = async (jobId: string) => ((await (await fetch(`${api.url}/applications`, { method: 'POST', headers: auth(), body: JSON.stringify({ jobId, mode: 'auto' }) })).json()) as { id: string }).id;
  outgoingId = await create(eligible[0] as string);
  sentId = await create(eligible[1] as string);
  await fetch(`${api.url}/applications/${sentId}/submitted`, { method: 'POST', headers: auth(), body: JSON.stringify({ pageUrl: 'https://example.org/thanks', confirmationText: 'Thank you (fictional)' }) });
});
test.afterAll(async () => {
  await web?.close();
  await api?.stop();
});

async function openTracker(page: import('@playwright/test').Page) {
  await page.goto(`${web.url}/signin/`);
  await page.evaluate((s) => sessionStorage.setItem('opennjob.session', JSON.stringify(s)), session);
  await page.goto(`${web.url}/tracker/`);
  await expect(page.getByRole('heading', { name: 'Tracker' })).toBeVisible();
}

test('the daily review lists what will go out automatically, and Skip keeps it from going', async ({ page }) => {
  await openTracker(page);
  const outgoing = page.getByTestId('outgoing');
  await expect(outgoing).toContainText('Going out automatically · 1');
  await outgoing.getByRole('button', { name: 'Skip' }).click();
  await expect(page.getByTestId('outgoing')).toHaveCount(0);
  const skipped = (await (await fetch(`${api.url}/applications/${outgoingId}`, { headers: auth() })).json()) as { status: string; skippedAt?: string };
  expect(skipped).toMatchObject({ status: 'closed', skippedAt: expect.any(String) });
});

test('recording an interview on a sent application shows in replies by route', async ({ page }) => {
  await openTracker(page);
  await expect(page.getByTestId('replies-by-route')).toContainText('Sent by you');
  await page.getByRole('group', { name: 'What came of it' }).getByRole('button', { name: 'Interview' }).click();
  const row = page.getByTestId('replies-by-route').getByRole('row', { name: /Sent by you/ });
  await expect(row).toContainText('100%');
  // The same outcome counts in the interview rate by match score, and the bar explains itself.
  const rates = page.getByTestId('interview-rates');
  await expect(rates.getByTestId('automatic-bar')).toContainText('Set a target interview rate on your Profile');
  await expect(rates.getByRole('row').filter({ hasText: '100%' })).toHaveCount(1);
  const sent = (await (await fetch(`${api.url}/applications/${sentId}`, { headers: auth() })).json()) as { status: string; outcome?: string };
  expect(sent).toMatchObject({ status: 'interview', outcome: 'interview' });
});
