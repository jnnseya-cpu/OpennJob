import { expect, test } from '@playwright/test';
import { freePort, startApi, startWeb } from './servers';
import type { ApiProcess, WebServer } from './servers';

/**
 * The page fits the screen: on a laptop it uses the width, the tabs sit in the top bar and groups of
 * cards sit side by side; on a phone it is one column with the tabs at the bottom. Fictional account.
 */
let api: ApiProcess;
let web: WebServer;
let session: { accessToken: string; expiresAt: string };
test.beforeAll(async () => {
  const port = await freePort();
  api = await startApi(`http://127.0.0.1:${port}`);
  web = await startWeb(port, api.url);
  const v = (await (await fetch(`${api.url}/auth/versions`)).json()) as { termsVersion: string; privacyVersion: string };
  const reg = (await (
    await fetch(`${api.url}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'layout.check@example.org', password: 'a long fictional passphrase here', acceptedTermsVersion: v.termsVersion, acceptedPrivacyVersion: v.privacyVersion }),
    })
  ).json()) as { accessToken: string; expiresAt: string };
  session = { accessToken: reg.accessToken, expiresAt: reg.expiresAt };
});
test.afterAll(async () => {
  await web?.close();
  await api?.stop();
});

async function signedIn(page: import('@playwright/test').Page, path: string) {
  await page.goto(`${web.url}/signin/`);
  await page.evaluate((s) => sessionStorage.setItem('opennjob.session', JSON.stringify(s)), session);
  await page.goto(`${web.url}${path}`);
  await expect(page.getByRole('heading', { level: 2 }).first()).toBeVisible();
}

test('on a laptop the page uses the width, the tabs are in the top bar, and cards sit side by side', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await signedIn(page, '/account/');
  const main = await page.locator('main').boundingBox();
  expect(main?.width ?? 0).toBeGreaterThan(1100);
  const tabs = page.getByRole('navigation', { name: 'Sections' });
  expect(await tabs.evaluate((el) => el.closest('header') !== null && getComputedStyle(el).position)).toBe('static');
  expect((await tabs.boundingBox())?.y ?? 999).toBeLessThan(200);
  const cards = page.locator('main .cols > .card');
  const [a, b] = [await cards.nth(0).boundingBox(), await cards.nth(2).boundingBox()];
  expect(Math.abs((a?.x ?? 0) - (b?.x ?? 0))).toBeGreaterThan(300); // a second column exists
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1366);
});

test('on a phone it is one column with the tabs fixed at the bottom', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signedIn(page, '/account/');
  const tabs = page.getByRole('navigation', { name: 'Sections' });
  expect(await tabs.evaluate((el) => getComputedStyle(el).position)).toBe('fixed');
  const box = await tabs.boundingBox();
  expect((box?.y ?? 0) + (box?.height ?? 0)).toBeGreaterThan(800);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('sign-in keeps a comfortable form width on a laptop', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto(`${web.url}/signin/`);
  expect((await page.locator('main').boundingBox())?.width ?? 0).toBeLessThanOrEqual(520);
});
