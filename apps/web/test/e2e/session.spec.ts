import { expect, test } from '@playwright/test';
import { freePort, startApi, startWeb } from './servers';
import type { ApiProcess, WebServer } from './servers';

/**
 * "Keep me signed in on this device": closing and reopening the app keeps the person signed in;
 * signing out ends it everywhere; unticked, closing the app signs out. Fictional account.
 */
test.describe.configure({ mode: 'serial' });

let api: ApiProcess;
let web: WebServer;
const EMAIL = 'keep.signed.in@example.org';
const PASSWORD = 'a long fictional passphrase here';

test.beforeAll(async () => {
  const port = await freePort();
  api = await startApi(`http://127.0.0.1:${port}`);
  web = await startWeb(port, api.url);
  const v = (await (await fetch(`${api.url}/auth/versions`)).json()) as { termsVersion: string; privacyVersion: string };
  await fetch(`${api.url}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, acceptedTermsVersion: v.termsVersion, acceptedPrivacyVersion: v.privacyVersion }),
  });
});
test.afterAll(async () => {
  await web?.close();
  await api?.stop();
});

async function signIn(page: import('@playwright/test').Page, keep: boolean) {
  await page.goto(`${web.url}/signin/`);
  await page.getByLabel('Email address').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  const box = page.getByTestId('keep-signed-in');
  await expect(box).toBeChecked(); // on by default
  if (!keep) await box.uncheck();
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard\/$/);
}

test('kept: closing the app and opening it again stays signed in, and the token is renewed', async ({ browser }) => {
  const context = await browser.newContext();
  const first = await context.newPage();
  await signIn(first, true);
  const kept = await first.evaluate(() => localStorage.getItem('opennjob.keep'));
  expect(kept).toMatch(/^[A-Za-z0-9_-]{43}$/);
  await first.close(); // the app is closed: its sessionStorage is gone

  const reopened = await context.newPage();
  await reopened.goto(`${web.url}/dashboard/`);
  await expect(reopened.getByRole('heading', { name: 'Your dashboard' })).toBeVisible();
  const renewed = await reopened.evaluate(() => localStorage.getItem('opennjob.keep'));
  expect(renewed).not.toBe(kept); // used once, replaced

  // Signing out forgets it here and revokes it on the server.
  await reopened.goto(`${web.url}/account/`);
  await reopened.getByRole('button', { name: /Sign out/ }).click();
  await expect(reopened).toHaveURL(/\/signin\/\?notice=signedout$/);
  expect(await reopened.evaluate(() => localStorage.getItem('opennjob.keep'))).toBeNull();
  const res = await fetch(`${api.url}/auth/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: renewed }) });
  expect(res.status).toBe(401);
  await context.close();
});

test('not kept: closing the app signs out', async ({ browser }) => {
  const context = await browser.newContext();
  const first = await context.newPage();
  await signIn(first, false);
  expect(await first.evaluate(() => localStorage.getItem('opennjob.keep'))).toBeNull();
  await first.close();
  const reopened = await context.newPage();
  await reopened.goto(`${web.url}/dashboard/`);
  await expect(reopened).toHaveURL(/\/signin\//);
  await context.close();
});
