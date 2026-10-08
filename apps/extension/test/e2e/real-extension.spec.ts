import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium, expect, test } from '@playwright/test';
import jwt from 'jsonwebtoken';
import type { BrowserContext, Page, Worker } from '@playwright/test';
import { DIST, FIXTURES, PASSPORT, PROFILE } from './helpers';

/**
 * The whole product, end to end, with nothing mocked:
 *
 *   real OpennJob API (apps/api/dist, in-memory store, no LLM key), with real accounts:
 *   the test registers a user over HTTP and the popup signs in with that email and password
 *     <- popup.html of the unpacked extension, loaded in Chromium
 *       -> chrome.scripting injects dist/content.js into the tab (isolated world)
 *         -> fixture application form served over http://127.0.0.1
 *
 * One thing is simulated. In real use the user clicks the toolbar icon, which grants the
 * extension `activeTab` access to that tab. A test cannot click browser chrome, so the
 * test loads a COPY of dist/ whose manifest additionally has host permission for
 * http://127.0.0.1/* (the fixture server). The JavaScript is byte-for-byte the built
 * extension. The shipped manifest is not changed.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const API_ENTRY = path.join(REPO_ROOT, 'apps/api/dist/main.js');
/** Signs the API's tokens for this run. Known to the test so it can make an expired one. */
const JWT_SECRET = 'e2e-signing-secret-not-a-real-secret-0123456789';
/** Fictional account. */
const EMAIL = 'amara.okafor@example.org';
const PASSWORD = 'a long fictional passphrase';
const OTHER_EMAIL = 'bola.adeyemi@example.org';
const OTHER_PASSWORD = 'seven green kettles on a shelf';
const CV_TEXT = [
  'Healthcare assistant with four years of experience in a care home and on elderly care wards.',
  'I hold the Care Certificate and an NVQ Level 2 in Health and Social Care.',
  'I give personal care with dignity and I am trained in moving and handling.',
  'I work well in a team and my communication with residents and families is clear and kind.',
].join('\n');

let api: ChildProcess;
let apiBase: string;
let fixtureServer: http.Server;
let fixtureBase: string;
let context: BrowserContext;
let worker: Worker;
let extensionId: string;
let workDir: string;
let hcaApplicationId: string;
let secondApplicationId: string;
let token: string;
let userId: string;

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });

async function call<T>(method: string, route: string, body?: unknown): Promise<T> {
  const res = await fetch(`${apiBase}${route}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new Error(`${method} ${route} -> ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  workDir = mkdtempSync(path.join(os.tmpdir(), 'opennjob-e2e-'));

  // 1. Fixture pages over HTTP.
  const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript' };
  fixtureServer = http.createServer((req, res) => {
    const name = path.basename((req.url ?? '/').split('?')[0] as string);
    try {
      const body = readFileSync(path.join(FIXTURES, name));
      res.writeHead(200, { 'Content-Type': types[path.extname(name)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise<void>((resolve) => fixtureServer.listen(0, '127.0.0.1', resolve));
  fixtureBase = `http://127.0.0.1:${(fixtureServer.address() as AddressInfo).port}`;

  // 2. The real API, as a developer would start it. No LLM key, so the deterministic fallbacks are used.
  const port = await freePort();
  apiBase = `http://127.0.0.1:${port}`;
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(port), HOST: '127.0.0.1', OPENNJOB_JWT_SECRET: JWT_SECRET, OPENNJOB_BCRYPT_ROUNDS: '4', OPENNJOB_DEMO_JOBS: 'true' };
  for (const key of ['DATABASE_URL', 'OPENNJOB_DATA_KEY', 'NODE_ENV', 'OPENNJOB_CORS_ORIGINS', 'OPENNJOB_CORS_ALLOW_ANY_EXTENSION', 'GEMINI_API_KEY', 'OPENNJOB_LLM_MODEL', 'ADZUNA_APP_ID', 'ADZUNA_APP_KEY', 'REED_API_KEY', 'OPENNJOB_GREENHOUSE_BOARDS', 'OPENNJOB_LEVER_COMPANIES', 'OPENNJOB_ASHBY_BOARDS']) delete env[key];
  api = spawn(process.execPath, [API_ENTRY], { cwd: workDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let apiLog = '';
  api.stdout?.on('data', (d) => (apiLog += d));
  api.stderr?.on('data', (d) => (apiLog += d));
  const deadline = Date.now() + 20_000;
  for (;;) {
    const status = await fetch(`${apiBase}/health`).then((r) => r.status).catch(() => 0);
    if (status === 200) break;
    if (Date.now() > deadline || api.exitCode !== null) throw new Error(`The API did not start.\n${apiLog}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  // 3. Register two accounts and seed the first through the API's own REST endpoints.
  const consent = await call<{ termsVersion: string; privacyVersion: string }>('GET', '/auth/versions');
  const accept = { acceptedTermsVersion: consent.termsVersion, acceptedPrivacyVersion: consent.privacyVersion };
  await call('POST', '/auth/register', { email: OTHER_EMAIL, password: OTHER_PASSWORD, ...accept }); // an account with nothing in it
  const registered = await call<{ accessToken: string; user: { id: string } }>('POST', '/auth/register', { email: EMAIL, password: PASSWORD, ...accept });
  token = registered.accessToken;
  userId = registered.user.id;
  await call('PUT', '/profile', { ...PROFILE, cvText: CV_TEXT });
  await call('PUT', '/passport', PASSPORT);
  await call('POST', '/jobs/refresh');
  hcaApplicationId = (await call<{ id: string }>('POST', '/applications', { jobId: 'sample:hca-elderly-care', mode: 'hybrid' })).id;
  secondApplicationId = (await call<{ id: string }>('POST', '/applications', { jobId: 'sample:support-worker-ld', mode: 'auto' })).id;

  // 4. A copy of the built extension with the test-only host permission (see the note at the top).
  const extensionDir = path.join(workDir, 'extension');
  mkdirSync(extensionDir);
  cpSync(DIST, extensionDir, { recursive: true });
  const manifestPath = path.join(extensionDir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.host_permissions = ['http://127.0.0.1/*'];
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  context = await chromium.launchPersistentContext(path.join(workDir, 'profile'), {
    channel: 'chromium', // full Chromium in new headless mode; the headless shell cannot load extensions
    headless: true,
    ...(process.env.OPENNJOB_CHROMIUM_PATH ? { executablePath: process.env.OPENNJOB_CHROMIUM_PATH } : {}),
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
  });
  // Listen before looking, so a worker that registers in between is not missed.
  const workerEvent = context.waitForEvent('serviceworker', { timeout: 20_000 });
  const existing = context.serviceWorkers()[0];
  if (existing) workerEvent.catch(() => undefined);
  worker = existing ?? (await workerEvent);
  extensionId = new URL(worker.url()).host;
});

test.afterAll(async () => {
  await context?.close();
  api?.kill();
  await new Promise<void>((resolve) => (fixtureServer ? fixtureServer.close(() => resolve()) : resolve()));
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

/** What the user does on first use: sets the API address under Connection, then signs in. */
async function signIn(popup: Page, email = EMAIL, password = PASSWORD): Promise<void> {
  await popup.locator('#settings summary').click();
  await popup.locator('#apiBase').fill(apiBase);
  await popup.locator('#save').click();
  await expect(popup.locator('#status')).toHaveText('Address saved.');
  await popup.locator('#email').fill(email);
  await popup.locator('#password').fill(password);
  await popup.locator('#sign-in-button').click();
}

const stored = (): Promise<Record<string, unknown>> => worker.evaluate(() => chrome.storage.local.get(null));

/** Opens a fixture in one tab and the extension popup, pointed at that tab, in another. */
async function openPopupFor(fixture: string): Promise<{ form: Page; popup: Page }> {
  const form = await context.newPage();
  const url = `${fixtureBase}/${fixture}`;
  await form.goto(url);
  const tabId = await worker.evaluate(async (target) => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((t) => t.url === target)?.id;
  }, url);
  expect(tabId, 'tab id of the fixture page').toBeGreaterThan(0);

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html?tabId=${tabId}`);
  // First use: the sign-in form is shown; the user sets the API address and signs in.
  // Later uses: the saved address and access token are read from chrome.storage and the data loads by itself.
  await expect(popup.locator('#status')).not.toHaveText('');
  if (await popup.locator('#sign-in').isVisible()) await signIn(popup);
  await expect(popup.locator('#status')).toHaveText('Loaded details for Amara Okafor.');
  await expect(popup.locator('#account-email')).toHaveText(`Signed in as ${EMAIL}`);
  return { form, popup };
}

test('the unpacked extension loads: service worker, default settings and popup', async () => {
  expect(worker.url()).toBe(`chrome-extension://${extensionId}/background.js`);
  const manifest = await worker.evaluate(() => chrome.runtime.getManifest());
  expect(manifest.manifest_version).toBe(3);
  expect(manifest.permissions).toEqual(['activeTab', 'scripting', 'storage']);
  await expect.poll(() => worker.evaluate(async () => (await chrome.storage.local.get('mode')).mode)).toBe('hybrid');

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(popup.locator('h1')).toHaveText('OpennJob');
  await expect(popup.locator('#mode')).toHaveValue('hybrid');
  await expect(popup.locator('#mode-help')).toContainText('You press submit yourself');
  await expect(popup.locator('#fill')).toBeDisabled();
  // Nobody is signed in yet: the sign-in form is shown and nothing is loaded.
  await expect(popup.locator('#sign-in')).toBeVisible();
  await expect(popup.locator('#account')).toBeHidden();
  await expect(popup.locator('#status')).toHaveText('Sign in to load your details.');
  await popup.close();
});

test('sign-in through the popup: wrong password is refused, an unsafe address is refused, the right one loads the data and stores a token, not the password', async () => {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(popup.locator('#sign-in')).toBeVisible();

  // The API address is configurable. A password is never sent over plain http to another machine.
  await popup.locator('#settings summary').click();
  await popup.locator('#apiBase').fill('http://opennjob.example.org');
  await popup.locator('#save').click();
  await expect(popup.locator('#status')).toContainText('must start with https://');
  await popup.locator('#email').fill(EMAIL);
  await popup.locator('#password').fill(PASSWORD);
  await popup.locator('#sign-in-button').click();
  await expect(popup.locator('#status')).toContainText('must start with https://');
  expect((await stored()).accessToken).toBeUndefined();
  expect((await stored()).apiBase).toBe('http://127.0.0.1:3000'); // the default, unchanged

  // The real API, wrong password.
  await popup.locator('#apiBase').fill(`${apiBase}/`);
  await popup.locator('#save').click();
  await expect(popup.locator('#status')).toHaveText('Address saved.');
  expect((await stored()).apiBase).toBe(apiBase);
  await popup.locator('#email').fill(EMAIL);
  await popup.locator('#password').fill('not the right passphrase');
  await popup.locator('#sign-in-button').click();
  await expect(popup.locator('#status')).toHaveText('Email address or password is incorrect.');
  await expect(popup.locator('#sign-in')).toBeVisible();
  await expect(popup.locator('#password')).toHaveValue('');
  expect((await stored()).accessToken).toBeUndefined();

  // The right password.
  await popup.locator('#password').fill(PASSWORD);
  await popup.locator('#sign-in-button').click();
  await expect(popup.locator('#status')).toHaveText('Loaded details for Amara Okafor.');
  await expect(popup.locator('#sign-in')).toBeHidden();
  await expect(popup.locator('#account-email')).toHaveText(`Signed in as ${EMAIL}`);
  await expect(popup.locator('#application option')).toHaveCount(3);

  const kept = await stored();
  expect(Object.keys(kept).sort()).toEqual(['accessToken', 'accountEmail', 'apiBase', 'mode', 'tokenExpiresAt']);
  expect(String(kept.accessToken).split('.')).toHaveLength(3); // a JWT issued by the API
  expect(Date.parse(String(kept.tokenExpiresAt))).toBeGreaterThan(Date.now());
  expect(JSON.stringify(kept)).not.toContain(PASSWORD);
  // The stored token is the user's own: the API accepts it and answers with that account.
  const me = await fetch(`${apiBase}/account`, { headers: { Authorization: `Bearer ${String(kept.accessToken)}` } });
  expect(((await me.json()) as { id: string }).id).toBe(userId);
  await popup.close();
});

test('each account sees only its own data: signing in as someone else shows none of the first user\'s details', async () => {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(popup.locator('#status')).toHaveText('Loaded details for Amara Okafor.');
  await popup.locator('#sign-out').click();
  await expect(popup.locator('#status')).toHaveText('Signed out.');
  await expect(popup.locator('#sign-in')).toBeVisible();
  await expect(popup.locator('#application option')).toHaveCount(1);
  expect((await stored()).accessToken).toBeUndefined();

  await popup.locator('#email').fill(OTHER_EMAIL);
  await popup.locator('#password').fill(OTHER_PASSWORD);
  await popup.locator('#sign-in-button').click();
  await expect(popup.locator('#status')).toHaveText('No profile is saved in OpennJob yet.');
  await expect(popup.locator('#account-email')).toHaveText(`Signed in as ${OTHER_EMAIL}`);
  await expect(popup.locator('#application option')).toHaveCount(1); // only "No statement"
  await expect(popup.locator('body')).not.toContainText('Okafor');

  // Changing the API address signs out: a token is never sent to an address that did not issue it.
  await popup.locator('#settings summary').click();
  await popup.locator('#apiBase').fill('https://another-api.example.org');
  await popup.locator('#save').click();
  await expect(popup.locator('#status')).toHaveText('The API address changed. Sign in again.');
  await expect(popup.locator('#sign-in')).toBeVisible();
  expect((await stored()).accessToken).toBeUndefined();
  await popup.close();
});

test('hybrid, through the popup: fills ordinary fields, holds sensitive ones until ticked, never submits, records the confirmation', async () => {
  const { form, popup } = await openPopupFor('nhs-style-application.html');
  await popup.locator('#mode').selectOption('hybrid');
  await popup.locator('#application').selectOption(hcaApplicationId);
  const statement = (await call<{ statement: string; statementSource: string }>('GET', `/applications/${hcaApplicationId}`)).statement;
  expect(statement.length).toBeGreaterThan(20);

  // Scan: a preview. Nothing is written, sensitive fields are listed with a tick box.
  await popup.locator('#scan').click();
  await expect(popup.locator('#fields li')).toHaveCount(22);
  await expect(popup.locator('#fields li.sensitive')).toHaveCount(12);
  await expect(popup.locator('#fields li.sensitive input[type="checkbox"]')).toHaveCount(12);
  await expect(popup.locator('#fields li:not(.sensitive) input[type="checkbox"]')).toHaveCount(0);
  await expect(popup.locator('#status')).toHaveText('Preview only. Nothing has been filled.');
  await expect(form.locator('#forename')).toHaveValue('');
  await expect(form.locator('#nmc-pin')).toHaveCSS('outline-style', 'solid');
  // The content script runs in the extension's isolated world: the page cannot see it.
  expect(await form.evaluate(() => '__opennjob' in window)).toBe(false);

  // Fill.
  await popup.locator('#fill').click();
  await expect(popup.locator('#status')).toContainText('Sensitive fields are outlined and have not been filled');
  await expect(form.locator('#forename')).toHaveValue('Amara');
  await expect(form.locator('#surname')).toHaveValue('Okafor');
  await expect(form.locator('#contact-email')).toHaveValue('amara.okafor@example.org');
  await expect(form.locator('#pcode')).toHaveValue('B1 1AA');
  await expect(form.locator('#supporting-info')).toHaveValue(statement);
  for (const line of statement.split('\n')) expect(CV_TEXT).toContain(line); // no-LLM draft: CV sentences only
  await expect(form.locator('#nmc-pin')).toHaveValue('');
  await expect(form.locator('#ref1-email')).toHaveValue('');
  await expect(form.locator('#rtw-yes')).not.toBeChecked();
  await expect(form.locator('#save-password')).toHaveValue('');
  expect((await call<{ status: string }>('GET', `/applications/${hcaApplicationId}`)).status).toBe('draft');

  // Tick the NMC PIN only, fill again.
  await popup.getByLabel('Confirm: NMC PIN').check();
  await popup.locator('#fill').click();
  await expect(form.locator('#nmc-pin')).toHaveValue('18A1234E');
  await expect(form.locator('#ref1-email')).toHaveValue('');
  await expect(form.locator('#rtw-yes')).not.toBeChecked();
  await expect(form.locator('#conv-no')).not.toBeChecked();

  // The form was never submitted, and the API has the audit record of what was confirmed.
  expect(await form.evaluate(() => (window as unknown as { __fixture: { submitCount: number; submitClicks: number } }).__fixture)).toMatchObject({ submitCount: 0, submitClicks: 0 });
  await expect(form.locator('#result')).toBeHidden();
  await expect
    .poll(async () => call<{ status: string; confirmedFields: string[] }>('GET', `/applications/${hcaApplicationId}`))
    .toMatchObject({ status: 'confirmed', confirmedFields: ['nmcPin'] });
  await form.close();
  await popup.close();
});

test('auto, through the popup: submits the quick-apply form with no declarations and records it', async () => {
  const { form, popup } = await openPopupFor('agency-quick-apply.html');
  await popup.locator('#mode').selectOption('auto');
  await popup.locator('#application').selectOption(secondApplicationId);
  await popup.locator('#scan').click();
  await expect(popup.locator('#fields li')).toHaveCount(5);
  await expect(popup.locator('#fields li.sensitive')).toHaveCount(0);
  await expect(form.locator('#result')).toBeHidden();

  await popup.locator('#fill').click();
  await expect(popup.locator('#status')).toContainText('OpennJob pressed submit');
  await expect(form.locator('#qa-name')).toHaveValue('Amara Okafor');
  await expect(form.locator('#qa-email2')).toHaveValue('');
  await expect(form.locator('#result')).toBeVisible();
  expect(await form.evaluate(() => (window as unknown as { __fixture: { submitCount: number; submitClicks: number } }).__fixture)).toMatchObject({ submitCount: 1, submitClicks: 1 });
  await expect.poll(async () => (await call<{ status: string }>('GET', `/applications/${secondApplicationId}`)).status).toBe('submitted');
  await form.close();
  await popup.close();
});

test('auto, through the popup: does not submit the form that has declarations', async () => {
  const { form, popup } = await openPopupFor('nhs-style-application.html');
  await popup.locator('#mode').selectOption('auto');
  await popup.locator('#scan').click();
  await popup.locator('#fill').click();
  await expect(popup.locator('#status')).toContainText('OpennJob will not submit this form');
  await expect(form.locator('#forename')).toHaveValue('Amara');
  await expect(form.locator('#nmc-pin')).toHaveValue('');
  await expect(form.locator('#result')).toBeHidden();
  expect(await form.evaluate(() => (window as unknown as { __fixture: { submitClicks: number } }).__fixture.submitClicks)).toBe(0);
  await form.close();
  await popup.close();
});

test('the popup never scans or fills OpennJob itself, and lists only applications still to send', async () => {
  const own = await context.newPage();
  await own.goto(`${apiBase}/health`);
  const tabId = await worker.evaluate(async (target) => (await chrome.tabs.query({})).find((t) => t.url?.startsWith(target))?.id, `${apiBase}/health`);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html?tabId=${tabId}`);
  await expect(popup.locator('#status')).toHaveText('Loaded details for Amara Okafor.');
  await popup.locator('#scan').click();
  await expect(popup.locator('#status')).toContainText('this is OpennJob itself');
  const listed = await popup.locator('#application option').allTextContents();
  const open = (await call<{ status: string }[]>('GET', '/applications')).filter((a) => ['draft', 'needs_you', 'confirmed'].includes(a.status));
  expect(listed).toHaveLength(open.length + 1); // plus "No statement"
  await popup.close();
  await own.close();
});

test('through the popup: stops on the CAPTCHA page and says why', async () => {
  const { form, popup } = await openPopupFor('captcha-application.html');
  for (const mode of ['review', 'hybrid', 'auto']) {
    await popup.locator('#mode').selectOption(mode);
    await popup.locator('#scan').click();
    await expect(popup.locator('#status')).toContainText('This page has a CAPTCHA. OpennJob does not solve or bypass CAPTCHAs.');
    await expect(popup.locator('#status')).toHaveClass('blocked');
    await expect(popup.locator('#fill')).toBeDisabled();
    await expect(popup.locator('#results')).toBeHidden();
  }
  await expect(form.locator('#c-name')).toHaveValue('');
  await expect(form.locator('#c-email')).toHaveValue('');
  expect(await form.evaluate(() => (window as unknown as { __fixture: { submitClicks: number; inputEvents: object } }).__fixture)).toMatchObject({ submitClicks: 0, inputEvents: {} });
  await form.close();
  await popup.close();
});

test('hybrid, through the popup: fills the French form from French labels and holds its sensitive questions', async () => {
  const { form, popup } = await openPopupFor('candidature-fr.html');
  await popup.locator('#mode').selectOption('hybrid');
  await popup.locator('#application').selectOption(hcaApplicationId);
  await popup.locator('#scan').click();
  await expect(popup.locator('#fields li')).toHaveCount(15);
  await expect(popup.locator('#fields li.sensitive')).toHaveCount(7);
  await expect(form.locator('#prenom')).toHaveValue('');

  await popup.locator('#fill').click();
  await expect(popup.locator('#status')).toContainText('Sensitive fields are outlined and have not been filled');
  await expect(form.locator('#prenom')).toHaveValue('Amara');
  await expect(form.locator('#nom')).toHaveValue('Okafor');
  await expect(form.locator('#courriel')).toHaveValue('amara.okafor@example.org');
  await expect(form.locator('#telephone')).toHaveValue('07700 900123');
  await expect(form.locator('#adresse')).toHaveValue('12 Example Street');
  await expect(form.locator('#code-postal')).toHaveValue('B1 1AA');
  await expect(form.locator('#motivation')).not.toHaveValue('');
  // Sensitive: referee details wait for a tick; the questions are never answered.
  await expect(form.locator('#ref-courriel')).toHaveValue('');
  for (const id of ['#casier-oui', '#casier-non', '#permis-oui', '#permis-non', '#droit-oui', '#droit-non', '#honneur']) await expect(form.locator(id)).not.toBeChecked();
  await expect(form.locator('#casier-groupe')).toHaveCSS('outline-style', 'solid');
  expect(await form.evaluate(() => (window as unknown as { __fixture: { submitCount: number; submitClicks: number } }).__fixture)).toMatchObject({ submitCount: 0, submitClicks: 0 });
  await expect(form.locator('#result')).toBeHidden();
  await form.close();
  await popup.close();
});

test('an expired token: the API refuses it, the popup signs out, clears what it had and asks the user to sign in again', async () => {
  const { form, popup } = await openPopupFor('agency-quick-apply.html');
  await popup.locator('#scan').click();
  await expect(popup.locator('#fields li')).toHaveCount(5);

  // Replace the stored token with one the API really issued a signature for, but which ran out an hour ago.
  // The popup is told it is still good (tokenExpiresAt in the future), so it is the API that refuses it.
  const past = Math.floor(Date.now() / 1000) - 3600;
  const expired = jwt.sign({ sub: userId, iat: past - 3600, exp: past }, JWT_SECRET, { algorithm: 'HS256', issuer: 'opennjob', audience: 'opennjob-api' });
  const refused = await fetch(`${apiBase}/profile`, { headers: { Authorization: `Bearer ${expired}` } });
  expect(refused.status).toBe(401);
  expect(((await refused.json()) as { code: string }).code).toBe('token_expired');
  await worker.evaluate((t) => chrome.storage.local.set({ accessToken: t, tokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString() }), expired);

  await popup.reload();
  await expect(popup.locator('#status')).toHaveText('Your session has expired. Sign in again.');
  await expect(popup.locator('#status')).toHaveClass('warn');
  await expect(popup.locator('#sign-in')).toBeVisible();
  await expect(popup.locator('#account')).toBeHidden();
  await expect(popup.locator('#application option')).toHaveCount(1);
  await expect(popup.locator('#fill')).toBeDisabled();
  expect(Object.keys(await stored()).sort()).toEqual(['apiBase', 'mode']); // the dead token is gone

  // Signed out, Fill does nothing to the page.
  await popup.locator('#scan').click();
  await expect(popup.locator('#fill')).toBeDisabled();
  await expect(form.locator('#qa-name')).toHaveValue('');

  // Signing in again restores everything.
  await popup.locator('#email').fill(EMAIL);
  await popup.locator('#password').fill(PASSWORD);
  await popup.locator('#sign-in-button').click();
  await expect(popup.locator('#status')).toHaveText('Loaded details for Amara Okafor.');
  await form.close();
  await popup.close();
});

test('a token past its expiry time is not sent at all, and one that runs out mid-session ends the session at the next API call', async () => {
  const { form, popup } = await openPopupFor('nhs-style-application.html');

  // 1. The popup knows the token is out of date: it asks for sign-in without calling the API.
  await worker.evaluate(() => chrome.storage.local.set({ tokenExpiresAt: new Date(Date.now() - 1000).toISOString() }));
  const calls: string[] = [];
  popup.on('request', (r) => {
    if (r.url().startsWith(apiBase)) calls.push(r.url());
  });
  await popup.reload();
  await expect(popup.locator('#status')).toHaveText('Your session has expired. Sign in again.');
  await expect(popup.locator('#sign-in')).toBeVisible();
  expect(calls).toEqual([]);
  expect((await stored()).accessToken).toBeUndefined();

  // 2. Signed in again, with a form scanned and one sensitive field ticked. Then the token runs out on
  //    the server while the popup is still open (the stored token is swapped for an expired one; the
  //    popup follows chrome.storage, as it does when the user signs out in another window).
  await popup.locator('#email').fill(EMAIL);
  await popup.locator('#password').fill(PASSWORD);
  await popup.locator('#sign-in-button').click();
  await expect(popup.locator('#status')).toHaveText('Loaded details for Amara Okafor.');
  await popup.locator('#mode').selectOption('hybrid');
  await popup.locator('#application').selectOption(hcaApplicationId);
  await popup.locator('#scan').click();
  await expect(popup.locator('#fields li')).toHaveCount(22);
  await popup.getByLabel('Confirm: NMC PIN').check();

  const past = Math.floor(Date.now() / 1000) - 60;
  const expired = jwt.sign({ sub: userId, iat: past - 3600, exp: past }, JWT_SECRET, { algorithm: 'HS256', issuer: 'opennjob', audience: 'opennjob-api' });
  await worker.evaluate((t) => chrome.storage.local.set({ accessToken: t }), expired);
  await expect.poll(() => popup.evaluate(() => document.body.dataset.sessionToken)).toBe(expired.slice(-8));

  // Fill works from what was already loaded. Telling the API about it is refused: the session ends.
  await popup.locator('#fill').click();
  await expect(popup.locator('#status')).toHaveText('Your session has expired. Sign in again.');
  await expect(popup.locator('#sign-in')).toBeVisible();
  await expect(popup.locator('#fill')).toBeDisabled();
  await expect(popup.locator('#fields li')).toHaveCount(0);
  expect((await stored()).accessToken).toBeUndefined();
  // The safety rules did not move: only the field the user ticked was written, and nothing was submitted.
  await expect(form.locator('#forename')).toHaveValue('Amara');
  await expect(form.locator('#nmc-pin')).toHaveValue('18A1234E');
  await expect(form.locator('#ref1-email')).toHaveValue('');
  await expect(form.locator('#rtw-yes')).not.toBeChecked();
  await expect(form.locator('#conv-no')).not.toBeChecked();
  expect(await form.evaluate(() => (window as unknown as { __fixture: { submitCount: number; submitClicks: number } }).__fixture)).toMatchObject({ submitCount: 0, submitClicks: 0 });
  await form.close();
  await popup.close();
});
