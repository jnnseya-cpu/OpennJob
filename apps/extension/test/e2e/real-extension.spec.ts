import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium, expect, test } from '@playwright/test';
import type { BrowserContext, Page, Worker } from '@playwright/test';
import { DIST, FIXTURES, PASSPORT, PROFILE } from './helpers';

/**
 * The whole product, end to end, with nothing mocked:
 *
 *   real OpennJob API (apps/api/dist, in-memory store, no LLM key)
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
const TOKEN = 'e2e-token-not-a-secret';
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
    headers: { Authorization: `Bearer ${TOKEN}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
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
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(port), HOST: '127.0.0.1', OPENNJOB_API_TOKEN: TOKEN, OPENNJOB_DEMO_JOBS: 'true' };
  for (const key of ['ANTHROPIC_API_KEY', 'OPENNJOB_MODEL', 'ADZUNA_APP_ID', 'ADZUNA_APP_KEY', 'REED_API_KEY', 'OPENNJOB_GREENHOUSE_BOARDS', 'OPENNJOB_LEVER_COMPANIES', 'OPENNJOB_ASHBY_BOARDS']) delete env[key];
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

  // 3. Seed it through its own REST endpoints.
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
  worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 20_000 }));
  extensionId = new URL(worker.url()).host;
});

test.afterAll(async () => {
  await context?.close();
  api?.kill();
  await new Promise<void>((resolve) => (fixtureServer ? fixtureServer.close(() => resolve()) : resolve()));
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

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
  // First use: the Connection panel is open and the user enters the address and token.
  // Later uses: the saved settings are read from chrome.storage and the data loads by itself.
  await popup.waitForFunction(() => (document.querySelector('#settings') as HTMLDetailsElement).open || document.querySelector('#status')?.textContent !== '');
  if (await popup.locator('#settings').evaluate((el) => (el as HTMLDetailsElement).open)) {
    await popup.locator('#apiBase').fill(apiBase);
    await popup.locator('#token').fill(TOKEN);
    await popup.locator('#save').click();
  }
  await expect(popup.locator('#status')).toHaveText('Loaded details for Amara Okafor.');
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
