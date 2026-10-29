import { expect, test } from '@playwright/test';
import { freePort, startWeb } from './servers';
import type { WebServer } from './servers';

/** The Light / Dark / Auto switch: applied at once, remembered in this browser, and the logo is shown unchanged. */
let web: WebServer;
test.beforeAll(async () => {
  web = await startWeb(await freePort(), 'http://127.0.0.1:9'); // no API needed for signed-out pages
});
test.afterAll(async () => {
  await web?.close();
});

test('the theme switch cycles Auto, Light, Dark, and the choice survives a reload', async ({ page }) => {
  await page.goto(`${web.url}/signin/`);
  const toggle = page.getByTestId('theme-toggle');
  await expect(toggle).toHaveText('Auto');
  expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBeNull();
  await toggle.click();
  await expect(toggle).toHaveText('Light');
  expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe('light');
  await toggle.click();
  await expect(toggle).toHaveText('Dark');
  await page.reload();
  expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe('dark');
  await expect(page.getByTestId('theme-toggle')).toHaveText('Dark');
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).toBe('rgb(7, 16, 41)'); // the brand navy
  await page.getByTestId('theme-toggle').click();
  await expect(page.getByTestId('theme-toggle')).toHaveText('Auto');
  expect(await page.evaluate(() => localStorage.getItem('opennjob.theme'))).toBeNull();
});

test('the logo is served unchanged and shown in the header', async ({ page, request }) => {
  await page.goto(`${web.url}/signin/`);
  await expect(page.locator('.brand img.logo')).toHaveAttribute('src', '/brand/opennjob-logo-192.png');
  const original = await request.get(`${web.url}/brand/opennjob-logo.png`);
  expect(original.status()).toBe(200);
  expect((await original.body()).length).toBe(177259);
});
