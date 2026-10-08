import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { freePort, startApi, startWeb } from './servers';
import type { ApiProcess, WebServer } from './servers';

/**
 * The web screens added in spec phase 5, against the BUILT API as a real process with the
 * development mailbox switched on, so the e-mailed links are followed for real: e-mail
 * verification (ACC-2), password reset (ACC-3), standing authorisation with revoke and
 * pause (WEB-3), the daily report switch (REP-4), CV upload (PRO-1), standard answers
 * (SCR-1, SCR-3), receipts in the tracker (APP-7) and interview from the documents sent
 * (INT-1). The person, CV and employer are fictional.
 */

const EMAIL = 'adaeze.obi@example.org';
const PASSWORD = 'a long fictional passphrase for flows';
const NEW_PASSWORD = 'another long fictional passphrase';
const FIXTURE_PDF = path.resolve(__dirname, '../../../api/test/fixtures/cv-fictional.pdf');

let api: ApiProcess;
let web: WebServer;
let context: BrowserContext;
let page: Page;
let mailbox: string;
const consoleLines: string[] = [];
const tokens: string[] = [];

type Mail = { to: string; subject: string; text: string };
function mails(to: string): Mail[] {
  return readdirSync(mailbox)
    .sort()
    .map((f) => JSON.parse(readFileSync(path.join(mailbox, f), 'utf8')) as Mail)
    .filter((m) => m.to === to);
}
function lastLink(to: string, kind: 'verify-email' | 'reset-password'): string {
  const link = mails(to)
    .map((m) => new RegExp(`https?://\\S+/${kind}/\\?token=([A-Za-z0-9_-]+)`).exec(m.text))
    .filter((m): m is RegExpExecArray => m !== null)
    .at(-1);
  if (!link) throw new Error(`no ${kind} link e-mailed to ${to}`);
  tokens.push(link[1] as string);
  return link[0];
}

async function call<T>(method: string, route: string, body?: unknown): Promise<T> {
  const token = await page.evaluate(() => JSON.parse(sessionStorage.getItem('opennjob.session') ?? '{}').accessToken as string | undefined);
  const res = await fetch(`${api.url}${route}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new Error(`${method} ${route} -> ${res.status}`);
  return (await res.json()) as T;
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  mailbox = mkdtempSync(path.join(os.tmpdir(), 'opennjob-mailbox-'));
  const webPort = await freePort();
  api = await startApi(`http://127.0.0.1:${webPort}`, { OPENNJOB_DEV_MAILBOX_DIR: mailbox, OPENNJOB_APP_URL: `http://127.0.0.1:${webPort}` });
  web = await startWeb(webPort, api.url);
  context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  page = await context.newPage();
  page.on('console', (m) => consoleLines.push(m.text()));
});

test.afterAll(async () => {
  await context?.close();
  await web?.close();
  await api?.stop();
  rmSync(mailbox, { recursive: true, force: true });
});

test('ACC-2: a new account sees the banner until the e-mailed link confirms the address', async () => {
  await page.goto(`${web.url}/register/`);
  await page.getByLabel('Email address', { exact: true }).fill(EMAIL);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('checkbox', { name: /terms of use/ }).check();
  await page.getByRole('checkbox', { name: /privacy notice/ }).check();
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/profile\/$/);
  await expect(page.getByTestId('verify-banner')).toBeVisible();

  // A new link can be asked for; a second one within the minute is refused, and says so.
  await page.getByTestId('verify-banner').getByRole('button', { name: 'Send a new link' }).click();
  await expect(page.getByTestId('verify-banner')).toContainText('A new link was sent.');
  await page.getByTestId('verify-banner').getByRole('button', { name: 'Send a new link' }).click();
  await expect(page.getByTestId('verify-banner')).toContainText('less than a minute ago');

  await page.goto(lastLink(EMAIL, 'verify-email'));
  await expect(page.getByText('Your e-mail address is confirmed.')).toBeVisible();
  await page.getByRole('link', { name: 'Back to your dashboard' }).click();
  await expect(page).toHaveURL(/\/dashboard\/$/);
  await expect(page.getByTestId('verify-banner')).toHaveCount(0);
  expect((await call<{ emailVerified: boolean }>('GET', '/account')).emailVerified).toBe(true);
});

test('PRO-1 and SCR-1: a PDF CV becomes text to check before saving; standard answers save; a declaration is refused', async () => {
  await page.goto(`${web.url}/profile/`);
  await page.locator('#cv-file').setInputFiles(FIXTURE_PDF);
  const preview = page.getByTestId('cv-preview');
  await expect(preview).toContainText('PDF (2 pages)');
  await expect(preview).toContainText('Check every line before saving');
  await expect(preview).toContainText('Completed medication rounds for 28 patients');
  await preview.getByRole('button', { name: 'Use this text' }).click();
  await expect(page.locator('#cv')).toHaveValue(/Completed medication rounds for 28 patients/);
  await expect(page.getByLabel('First name')).toHaveValue('Amara');
  await expect(page.getByLabel('Postcode')).toHaveValue('B1 1AA');
  // Details a CV does not reliably hold are the person's to type.
  await page.getByLabel('Address line 1').fill('12 Example Street');
  await page.getByLabel('Town or city').fill('Birmingham');
  await page.getByRole('button', { name: 'Save profile' }).click();
  await expect(page.getByText('Profile saved')).toBeVisible();
  expect((await call<{ cvText: string }>('GET', '/profile')).cvText).toContain('Completed medication rounds');

  const answers = page.getByRole('form', { name: 'Standard answers' });
  await answers.getByLabel('Notice period').fill('Four weeks');
  await answers.getByLabel('Full driving licence').selectOption('yes');
  await answers.getByRole('button', { name: 'Add a question' }).click();
  await answers.getByLabel('Question 1').fill('Do you have any unspent criminal convictions?');
  await answers.getByLabel('Your answer').fill('No');
  await answers.getByRole('button', { name: 'Save answers' }).click();
  await expect(answers.getByRole('alert')).toContainText('custom.Do you have any unspent criminal convictions?');
  await answers.getByRole('button', { name: 'Remove' }).click();
  await answers.getByRole('button', { name: 'Save answers' }).click();
  await expect(answers.getByText('Answers saved.')).toBeVisible();
  expect(await call('GET', '/screening')).toEqual({ noticePeriod: 'Four weeks', drivingLicence: true, custom: {} });

  // OD-6: declarations answered once, in the person's own words of yes or no.
  await answers.getByLabel(/ever had a criminal conviction or caution/).selectOption('no');
  await answers.getByLabel(/I certify the information I have given is true/).check();
  await answers.getByRole('button', { name: 'Save answers' }).click();
  await expect(answers.getByText('Answers saved.')).toBeVisible();
  expect(await call('GET', '/screening')).toEqual({ noticePeriod: 'Four weeks', drivingLicence: true, declarations: { everConvicted: false, certifyAndConsent: true }, custom: {} });
});

test('WEB-3: standing authorisation shows its wording, needs agreement, can be paused and turned off', async () => {
  await page.goto(`${web.url}/account/`);
  await expect(page.getByTestId('email-state')).toContainText('E-mail address confirmed');
  const box = page.getByTestId('authorisation');
  await expect(box).toContainText('Off. Nothing is sent without you.');
  await expect(page.getByTestId('scope-text')).toContainText('the form has no declaration and no other sensitive question');
  const on = box.getByRole('button', { name: 'Turn on automatic applications' });
  await expect(on).toBeDisabled();
  await box.getByRole('checkbox', { name: 'I have read this wording and I agree to it.' }).check();
  await on.click();
  await expect(box).toContainText('Standing authorisation is on, to the wording above.');
  await expect(page.getByTestId('queue-status')).toContainText('Sent today: 0 of 20');
  await box.getByRole('button', { name: 'Pause' }).click();
  await expect(box).toContainText('The agent is paused.');
  expect((await call<{ wait: string }>('GET', '/agent/status')).wait).toBe('paused');
  await box.getByRole('button', { name: 'Resume' }).click();
  await box.getByRole('button', { name: 'Turn off automatic applications' }).click();
  await expect(box).toContainText('Nothing is sent without you from now on.');
  const after = await call<{ enabled: boolean; revokedAt?: string }>('GET', '/agent/authorisation');
  expect(after.enabled).toBe(false);
  expect(after.revokedAt).toBeTruthy();
});

test('REP-4: the daily report e-mail can be paused and turned back on', async () => {
  await page.goto(`${web.url}/account/`);
  const report = page.getByRole('checkbox', { name: 'Send me the daily report by e-mail' });
  await expect(report).toBeChecked();
  await report.uncheck();
  await expect(page.getByText('The 09:00 report e-mail is paused.')).toBeVisible();
  expect((await call<{ muted: string[] }>('GET', '/notifications/preferences')).muted).toContain('agent.daily_report');
  await report.check();
  await expect(page.getByText('The 09:00 report e-mail is on.')).toBeVisible();
  expect((await call<{ muted: string[] }>('GET', '/notifications/preferences')).muted).not.toContain('agent.daily_report');
});

test('APP-7 and INT-1: the tracker shows the receipt, and interview preparation quotes what was sent', async () => {
  await call('POST', '/jobs/refresh'); // the fictional demo jobs
  await call('PUT', '/passport', { nmcPin: '18A1234E', rightToWorkConfirmed: false, training: [], referees: [] }); // a fictional registration number
  const app = await call<{ id: string }>('POST', '/applications', { jobId: 'sample:staff-nurse-medical', mode: 'hybrid' });
  await call('POST', `/applications/${app.id}/submitted`, { pageUrl: 'https://example.org/apply/thanks', confirmationText: 'Thank you, your application reference is EX-42 (fictional).' });
  await page.goto(`${web.url}/tracker/`);
  const card = page.getByTestId('application').filter({ hasText: 'Submitted' });
  await expect(card.getByTestId('receipt')).toContainText('Thank you, your application reference is EX-42 (fictional).');
  await card.getByRole('link', { name: 'Prepare for interview' }).click();
  await expect(page).toHaveURL(new RegExp(`/interview/\\?application=${app.id}$`));
  const first = page.getByTestId('doc-question').first();
  await expect(first).toContainText('The advert:');
  await first.getByRole('button', { name: 'Practise this one' }).click();
  await first.getByLabel('Your answer').fill('On a busy ward I led the medication round, checked every chart twice and no doses were missed that month.');
  await first.getByRole('button', { name: 'Get feedback' }).click();
  await expect(first.getByRole('heading', { name: /STAR score: \d+\/20/ })).toBeVisible();
});

test('ACC-3: forgot password sends a link; the reset ends the old session; the new password signs in', async () => {
  const oldToken = await page.evaluate(() => JSON.parse(sessionStorage.getItem('opennjob.session') ?? '{}').accessToken as string);
  await page.getByRole('link', { name: 'Account' }).click();
  await page.getByRole('button', { name: 'Sign out on this device' }).click();
  await page.getByRole('link', { name: 'Forgot your password?' }).click();
  await expect(page).toHaveURL(/\/forgot-password\/$/);
  await page.getByLabel('Email address').fill('nobody.here@example.org');
  await page.getByRole('button', { name: 'Send a reset link' }).click();
  const unknownReply = await page.getByRole('status').textContent();
  await page.goto(`${web.url}/forgot-password/`);
  await page.getByLabel('Email address').fill(EMAIL);
  await page.getByRole('button', { name: 'Send a reset link' }).click();
  expect(await page.getByRole('status').textContent()).toBe(unknownReply); // the same words either way

  await page.goto(lastLink(EMAIL, 'reset-password'));
  await page.getByLabel('New password', { exact: true }).fill(NEW_PASSWORD);
  await page.getByLabel('New password again').fill('not the same');
  await page.getByRole('button', { name: 'Save the new password' }).click();
  await expect(page.getByText('The two passwords are not the same.')).toBeVisible();
  await page.getByLabel('New password again').fill(NEW_PASSWORD);
  await page.getByRole('button', { name: 'Save the new password' }).click();
  await expect(page).toHaveURL(/\/signin\/\?notice=reset$/);
  await expect(page.getByText('Your password was changed')).toBeVisible();
  expect((await fetch(`${api.url}/account`, { headers: { Authorization: `Bearer ${oldToken}` } })).status).toBe(401);

  await page.getByLabel('Email address', { exact: true }).fill(EMAIL);
  await page.getByLabel('Password', { exact: true }).fill(NEW_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard\/$/);
});

test('no one-time token, password or CV line reached the browser console or the API log', async () => {
  const consoleText = consoleLines.join('\n');
  const apiLog = api.output();
  for (const value of [...tokens, PASSWORD, NEW_PASSWORD, 'Completed medication rounds for 28 patients', 'Four weeks']) {
    expect(consoleText, `console: ${value.slice(0, 12)}`).not.toContain(value);
    expect(apiLog, `API log: ${value.slice(0, 12)}`).not.toContain(value);
  }
});
