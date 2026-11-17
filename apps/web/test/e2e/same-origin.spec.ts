import { expect, test } from '@playwright/test';
import { freePort, startApi, startWeb } from './servers';
import type { ApiProcess, WebServer } from './servers';

/**
 * The production layout (deploy/Caddyfile): one origin serves the site and proxies /api/* to the
 * API, and the site uses the relative base "/api". No CORS origin is configured on the API here,
 * so this passes only if every call really is same-origin. Fictional account.
 */
let api: ApiProcess;
let web: WebServer;

test.beforeAll(async () => {
  api = await startApi('http://not-this-origin.example.org', { OPENNJOB_CORS_ORIGINS: '', OPENNJOB_TRUST_PROXY: '1' });
  web = await startWeb(await freePort(), '', { proxyApi: api.url });
});
test.afterAll(async () => {
  await web?.close();
  await api?.stop();
});

test('same origin behind a proxy: register, see the dashboard, read the notifications', async ({ page }) => {
  const calls: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/')) calls.push(new URL(r.url()).origin);
  });
  await page.goto(`${web.url}/register/`);
  await page.getByLabel('Email address', { exact: true }).fill('same.origin@example.org');
  await page.getByLabel('Password', { exact: true }).fill('a long fictional passphrase, same origin');
  await page.getByRole('checkbox', { name: /terms of use/ }).check();
  await page.getByRole('checkbox', { name: /privacy notice/ }).check();
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/profile\/$/);
  await page.goto(`${web.url}/dashboard/`);
  await expect(page.getByTestId('stat-unread').locator('strong')).toHaveText('2'); // "Welcome to OpennJob" and "Verify your email address"
  await page.goto(`${web.url}/notifications/`);
  await expect(page.getByTestId('notification').filter({ hasText: 'Welcome to OpennJob' })).toBeVisible();
  // The in-app notice asks for verification; the one-time link or code is only ever in the e-mail.
  await expect(page.getByTestId('notification').filter({ hasText: 'Verify your email address' })).toBeVisible();
  expect(calls.length).toBeGreaterThan(3);
  expect(new Set(calls)).toEqual(new Set([web.url]));
});
