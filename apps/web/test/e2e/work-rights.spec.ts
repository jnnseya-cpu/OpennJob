import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { freePort, startApi, startWeb } from './servers';
import type { ApiProcess, WebServer } from './servers';

test.describe.configure({ mode: 'serial' });

/**
 * OD-5 in the web app: the person records right to work and sponsorship for a country in Profile,
 * and the review screen then shows them as filled from that record. Fictional account and jobs.
 */
let api: ApiProcess;
let web: WebServer;
let session: { accessToken: string; expiresAt: string };
const j = { 'Content-Type': 'application/json' };
const auth = () => ({ ...j, Authorization: `Bearer ${session.accessToken}` });

test.beforeAll(async () => {
  const port = await freePort();
  api = await startApi(`http://127.0.0.1:${port}`);
  web = await startWeb(port, api.url);
  const v = (await (await fetch(`${api.url}/auth/versions`)).json()) as { termsVersion: string; privacyVersion: string };
  session = (await (
    await fetch(`${api.url}/auth/register`, {
      method: 'POST',
      headers: j,
      body: JSON.stringify({ email: 'rtw.check@example.org', password: 'a long fictional passphrase here', acceptedTermsVersion: v.termsVersion, acceptedPrivacyVersion: v.privacyVersion }),
    })
  ).json()) as { accessToken: string; expiresAt: string };
  const cv = 'Example Candidate (fictional). Healthcare assistant: personal care, dementia care, care plans and accurate records. Team player.';
  await fetch(`${api.url}/profile`, { method: 'PUT', headers: auth(), body: JSON.stringify({ firstName: 'Sam', lastName: 'Example', email: 'rtw.check@example.org', phone: '07700 900222', addressLine1: '2 Example Road', city: 'Leeds', postcode: 'LS2 2BB', cvText: cv }) });
  await fetch(`${api.url}/jobs/refresh`, { method: 'POST', headers: auth() });
  await fetch(`${api.url}/applications`, { method: 'POST', headers: auth(), body: JSON.stringify({ jobId: 'sample:hca-elderly-care', mode: 'auto' }) });
});
test.afterAll(async () => {
  await web?.close();
  await api?.stop();
});

async function signIn(page: Page, path: string) {
  await page.goto(`${web.url}/signin/`);
  await page.evaluate((s) => sessionStorage.setItem('opennjob.session', JSON.stringify(s)), session);
  await page.goto(`${web.url}${path}`);
}

test('Profile: a country record needs both answers, a document and the tick; then it is saved and dated', async ({ page }) => {
  await signIn(page, '/profile/');
  const section = page.getByTestId('work-rights');
  await section.getByRole('button', { name: 'Add a country' }).click();
  const row = section.getByTestId('work-rights-row').first();
  await row.locator('select').first().selectOption('GB'); // the country list
  await row.getByLabel('The document you hold').selectOption('British or Irish passport');
  await row.getByLabel('Do you have the right to work there?').selectOption('yes');
  await row.getByLabel('Will you need visa sponsorship there?').selectOption('no');
  const tick = row.getByRole('checkbox');
  await expect(tick).not.toBeChecked(); // never pre-ticked

  await page.getByRole('form', { name: 'Credential passport' }).getByRole('button', { name: /Save/ }).click();
  await expect(page.getByRole('form', { name: 'Credential passport' })).toContainText('tick to confirm');

  await tick.check();
  await page.getByRole('form', { name: 'Credential passport' }).getByRole('button', { name: /Save/ }).click();
  await expect(page.getByRole('form', { name: 'Credential passport' })).toContainText('Credential passport saved.');
  await expect(row).toContainText('Confirmed');
  const saved = (await (await fetch(`${api.url}/passport`, { headers: auth() })).json()) as { passport: { workRights: unknown[] } };
  expect(saved.passport.workRights).toEqual([expect.objectContaining({ country: 'GB', rightToWork: true, requiresSponsorship: false, basis: 'British or Irish passport' })]);

  // Changing an answer clears the tick: it has to be confirmed again.
  await row.getByLabel('Will you need visa sponsorship there?').selectOption('yes');
  await expect(tick).not.toBeChecked();
});

test('Review: right to work is shown as filled from the record, and is no longer in "Only you confirm these"', async ({ page }) => {
  await fetch(`${api.url}/passport`, {
    method: 'PUT',
    headers: auth(),
    body: JSON.stringify({ rightToWorkConfirmed: false, training: [], referees: [], workRights: [{ country: 'GB', rightToWork: true, requiresSponsorship: false, basis: 'British or Irish passport', confirmed: true }] }),
  });
  await signIn(page, `/review/?job=${encodeURIComponent('sample:hca-elderly-care')}`);
  await expect(page.getByText('filled from your record: United Kingdom (British or Irish passport)')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Only you confirm these' })).not.toContainText('Right to work');
  await expect(page.getByTestId('auto-checklist')).toContainText('Right to work and sponsorship are answered from your record');
  // Other declarations are still the person's.
  await expect(page.getByRole('region', { name: 'Only you confirm these' })).toContainText('Criminal convictions');
});
