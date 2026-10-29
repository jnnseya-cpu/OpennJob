import { expect, test } from '@playwright/test';
import { freePort, startApi, startWeb } from './servers';
import type { ApiProcess, WebServer } from './servers';

/**
 * The private pilot: the built API with OPENNJOB_REGISTRATION_ALLOWLIST set, and the built web
 * app. Only the invited address can create an account. Fictional addresses.
 */
const INVITED = 'pilot.applicant@example.org';
const PASSWORD = 'a long fictional passphrase for the pilot';

let api: ApiProcess;
let web: WebServer;

test.beforeAll(async () => {
  const port = await freePort();
  api = await startApi(`http://127.0.0.1:${port}`, { OPENNJOB_REGISTRATION_ALLOWLIST: INVITED });
  web = await startWeb(port, api.url);
});
test.afterAll(async () => {
  await web?.close();
  await api?.stop();
});

test('only the invited address can register; the page says the pilot is invite-only', async ({ page }) => {
  await page.goto(`${web.url}/register/`);
  await expect(page.getByText('OpennJob is in a private pilot. Only invited email addresses can create an account.')).toBeVisible();

  const fill = async (email: string) => {
    await page.getByLabel('Email address', { exact: true }).fill(email);
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByRole('checkbox', { name: /terms of use/ }).check();
    await page.getByRole('checkbox', { name: /privacy notice/ }).check();
    await page.getByRole('button', { name: 'Create account' }).click();
  };

  await fill('someone.else@example.org');
  await expect(page.locator('form .note.bad')).toHaveText('Registration is by invitation only during the pilot');
  await expect(page).toHaveURL(/\/register\/$/);

  await fill(INVITED.toUpperCase());
  await expect(page).toHaveURL(/\/profile\/$/);
  const versions = (await (await fetch(`${api.url}/auth/versions`)).json()) as { registration: string };
  expect(versions.registration).toBe('invite');
  expect(api.output()).not.toContain(INVITED);
});
