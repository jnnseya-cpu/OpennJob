import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium, expect, test } from '@playwright/test';
import type { BrowserContext, Page, Worker } from '@playwright/test';
import { DIST, FIXTURES } from './helpers';

/**
 * The queue (APP-3, OD-4), end to end, with nothing mocked: the real API process, the
 * built extension in Chromium, and fictional forms served over http://127.0.0.1.
 *
 * As in real-extension.spec.ts, the test loads a COPY of dist/ whose manifest grants
 * http://127.0.0.1/* up front, because a test cannot press the browser's permission
 * prompt. The shipped manifest asks per site (optional_host_permissions). The JavaScript
 * is the built extension, unchanged.
 *
 * Proves, in a real browser: T-07 (a form with no sensitive field is sent without
 * approval, with the site's confirmation as the receipt), T-08 (a declaration holds it),
 * T-11 (no confirmation: uncertain, not submitted), T-13 (CAPTCHA stops it), T-14 (stored
 * answers fill, an unknown question holds), T-22 (a pause stops it), and the per-site
 * permission check.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const API_ENTRY = path.join(REPO_ROOT, 'apps/api/dist/main.js');
const JWT_SECRET = 'e2e-signing-secret-not-a-real-secret-0123456789';
const OPERATOR_KEY = 'e2e-operator-key-not-a-secret';
const EMPLOYER_KEY = 'e2e-employer-key-not-a-secret';
/** Fictional person. */
const EMAIL = 'tomasz.wolski@example.org';
const PASSWORD = 'a long fictional passphrase for the queue';
const PROFILE = {
  firstName: 'Tomasz',
  lastName: 'Wolski',
  email: EMAIL,
  phone: '07700 900321',
  addressLine1: '3 Example Close',
  city: 'Leeds',
  postcode: 'LS2 2ZZ',
  cvText: ['Site coordinator with six years on residential and rail projects.', 'Managed subcontractors and kept the programme on track.', 'Ran daily briefings and kept accurate site records.'].join('\n'),
};

let api: ChildProcess;
let apiBase: string;
let fixtureServer: http.Server;
let fixtureBase: string;
let context: BrowserContext;
let worker: Worker;
let extensionId: string;
let workDir: string;
let token: string;
const hits: string[] = [];
const apps: Record<string, string> = {};

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });

async function call<T>(method: string, route: string, body?: unknown, bearer: string = token): Promise<T> {
  const res = await fetch(`${apiBase}${route}`, {
    method,
    headers: { ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new Error(`${method} ${route} -> ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

interface App {
  id: string;
  status: string;
  holdReasons?: string[];
  automatic?: boolean;
  statement: string;
  receipt?: { pageUrl: string; confirmationText: string; documentsSha256: Record<string, string>; automatic: boolean };
  sentDocuments?: { sha256: { statement: string } };
}
const app = (name: string) => call<App>('GET', `/applications/${apps[name]}`);

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  workDir = mkdtempSync(path.join(os.tmpdir(), 'opennjob-queue-'));
  const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript' };
  fixtureServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/hit') {
      hits.push(url.searchParams.get('form') ?? '?');
      res.writeHead(204).end();
      return;
    }
    const name = path.basename(url.pathname);
    try {
      const body = readFileSync(path.join(FIXTURES, name));
      res.writeHead(200, { 'Content-Type': types[path.extname(name)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise<void>((resolve) => fixtureServer.listen(0, '127.0.0.1', resolve));
  const port = (fixtureServer.address() as AddressInfo).port;
  fixtureBase = `http://127.0.0.1:${port}`;

  const apiPort = await freePort();
  apiBase = `http://127.0.0.1:${apiPort}`;
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(apiPort), HOST: '127.0.0.1', OPENNJOB_JWT_SECRET: JWT_SECRET, OPENNJOB_BCRYPT_ROUNDS: '4', OPENNJOB_OPERATOR_KEY: OPERATOR_KEY, OPENNJOB_EMPLOYER_KEY: EMPLOYER_KEY, OPENNJOB_DEV_MAILBOX_DIR: path.join(workDir, 'mailbox') };
  for (const key of ['DATABASE_URL', 'OPENNJOB_DATA_KEY', 'NODE_ENV', 'OPENNJOB_CORS_ORIGINS', 'OPENNJOB_CORS_ALLOW_ANY_EXTENSION', 'ANTHROPIC_API_KEY', 'OPENNJOB_DEMO_JOBS', 'ADZUNA_APP_ID', 'ADZUNA_APP_KEY', 'REED_API_KEY', 'OPENNJOB_GREENHOUSE_BOARDS', 'OPENNJOB_LEVER_COMPANIES', 'OPENNJOB_ASHBY_BOARDS', 'OPENNJOB_REGISTRATION_ALLOWLIST', 'RESEND_API_KEY', 'OPENNJOB_APP_URL']) delete env[key];
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

  const consent = await call<{ termsVersion: string; privacyVersion: string }>('GET', '/auth/versions', undefined, '');
  token = (await call<{ accessToken: string }>('POST', '/auth/register', { email: EMAIL, password: PASSWORD, acceptedTermsVersion: consent.termsVersion, acceptedPrivacyVersion: consent.privacyVersion }, '')).accessToken;
  // ACC-2: nothing is submitted for an unverified address. Verify with the code from the dev mailbox.
  const mails = readdirSync(path.join(workDir, 'mailbox')).map((f) => JSON.parse(readFileSync(path.join(workDir, 'mailbox', f), 'utf8')) as { to: string; text: string });
  const code = mails.filter((m) => m.to === EMAIL).map((m) => /code: ([A-Za-z0-9_-]{32,128})/.exec(m.text)?.[1]).find(Boolean);
  if (!code) throw new Error('No verification code in the dev mailbox');
  await call('POST', '/auth/verify-email', { token: code }, '');
  await call('PUT', '/profile', PROFILE);
  await call('PUT', '/passport', { rightToWorkConfirmed: false, training: [], referees: [] });
  await call('PUT', '/screening', { noticePeriod: 'Four weeks', custom: { 'Can you work weekends?': 'Yes, one in three' } });
  const forms: [string, string][] = [
    ['plain', `${fixtureBase}/queue-plain.html`],
    ['declaration', `${fixtureBase}/queue-declaration.html`],
    ['unknown', `${fixtureBase}/queue-unknown.html`],
    ['upload', `${fixtureBase}/queue-upload.html`],
    ['captcha', `${fixtureBase}/captcha-application.html`],
    ['noconfirm', `${fixtureBase}/queue-noconfirm.html`],
    // Not granted to the extension: the queue stops and asks the person to allow it.
    ['otherhost', `http://localhost:${port}/queue-plain.html`],
  ];
  for (const [name, applyUrl] of forms) {
    const job = await call<{ id: string }>('POST', '/employer/jobs', {
      title: `Site Coordinator ${name} (fictional)`,
      employer: `Queue Test Employer ${name} (fictional)`,
      description: 'A fictional vacancy for the queue tests.',
      country: 'gb',
      city: 'Leeds',
      applyUrl,
      criteria: [
        { label: 'Subcontractor management', essential: true, keywords: ['subcontractors'] },
        { label: 'Site records', essential: true, keywords: ['site records'] },
      ],
    }, EMPLOYER_KEY);
    apps[name] = (await call<{ id: string }>('POST', '/applications', { jobId: job.id, mode: 'auto' })).id;
    // One at a time, so the queue meets them in this order.
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const now = new Date().toISOString();
  await call('PUT', '/operator/systems/local-fixture', { enabled: true, termsCheckedAt: now, supervisedSubmissionAt: now, note: 'fictional forms' }, OPERATOR_KEY);

  const extensionDir = path.join(workDir, 'extension');
  mkdirSync(extensionDir);
  cpSync(DIST, extensionDir, { recursive: true });
  const manifestPath = path.join(extensionDir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.host_permissions = ['http://127.0.0.1/*'];
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  context = await chromium.launchPersistentContext(path.join(workDir, 'profile'), {
    channel: 'chromium',
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

async function popup(): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(page.locator('#status')).not.toHaveText('');
  if (await page.locator('#sign-in').isVisible()) {
    await page.locator('#settings summary').click();
    await page.locator('#apiBase').fill(apiBase);
    await page.locator('#save').click();
    await page.locator('#email').fill(EMAIL);
    await page.locator('#password').fill(PASSWORD);
    await page.locator('#sign-in-button').click();
  }
  await expect(page.locator('#queue')).toBeVisible();
  return page;
}

async function runQueue(page: Page): Promise<{ message: string; sent: number; held: number; uncertain: number; needsSite?: string }> {
  await worker.evaluate(() => chrome.storage.local.remove('queueState'));
  await page.locator('#queue-start').click();
  await expect.poll(async () => worker.evaluate(async () => (await chrome.storage.local.get('queueState')).queueState?.running), { timeout: 90_000 }).toBe(false);
  return worker.evaluate(async () => (await chrome.storage.local.get('queueState')).queueState);
}

test('the shipped manifest keeps its three permissions and asks for sites one at a time', async () => {
  const shipped = JSON.parse(readFileSync(path.join(DIST, 'manifest.json'), 'utf8'));
  expect(shipped.permissions).toEqual(['activeTab', 'scripting', 'storage']);
  expect(shipped.optional_host_permissions).toEqual(['https://*/*']);
  expect(shipped.host_permissions).toBeUndefined();
});

test('without standing authorisation the queue sends nothing', async () => {
  const page = await popup();
  const state = await runQueue(page);
  expect(state.message).toMatch(/Standing authorisation is off/);
  expect(hits).toEqual([]);
  await page.close();
});

test('T-22 in the browser: a paused agent sends nothing', async () => {
  await call('PUT', '/agent/authorisation', { enabled: true, scopeVersion: (await call<{ scope: { version: string } }>('GET', '/agent/authorisation')).scope.version });
  await call('PUT', '/agent/pause', { paused: true });
  const page = await popup();
  const state = await runQueue(page);
  expect(state.message).toBe('You have paused the agent.');
  expect(hits).toEqual([]);
  await call('PUT', '/agent/pause', { paused: false });
  await page.close();
});

test('the queue: sends the plain form, holds the rest for the person, and stops at a site it may not open', async () => {
  const page = await popup();
  const state = await runQueue(page);
  expect(state).toMatchObject({ sent: 1, held: 4, uncertain: 1, needsSite: 'localhost' });
  await expect(page.locator('#allow-site')).toHaveText('Allow OpennJob on localhost');

  // T-07: sent with no approval; the receipt is the site's own confirmation page.
  const plain = await app('plain');
  expect(plain).toMatchObject({ status: 'submitted', automatic: true });
  expect(plain.receipt?.pageUrl).toBe(`${fixtureBase}/queue-thanks.html?form=plain`);
  expect(plain.receipt?.confirmationText).toBe('Thank you. Your application has been received.');
  expect(plain.receipt?.automatic).toBe(true);
  // T-06 end to end: the statement hash computed in the browser matches the stored document.
  const sha = createHash('sha256').update(plain.statement, 'utf8').digest('hex');
  expect(plain.receipt?.documentsSha256.statement).toBe(sha);
  expect(plain.sentDocuments?.sha256.statement).toBe(sha);

  // T-08: a declaration is never sent by the agent.
  expect(await app('declaration')).toMatchObject({ status: 'needs_you', holdReasons: ['sensitive:convictions'] });
  // T-14: an unknown required question holds it, with the question named.
  expect(await app('unknown')).toMatchObject({ status: 'needs_you', holdReasons: ['question:Are you able to work nights?'] });
  // A required CV upload is never faked.
  expect(await app('upload')).toMatchObject({ status: 'needs_you', holdReasons: ['file-upload'] });
  // T-13: a CAPTCHA stops it with the reason.
  expect((await app('captcha')).holdReasons).toEqual(['captcha']);
  // T-11: submitted but no confirmation from the site: uncertain, never "submitted".
  const noconfirm = await app('noconfirm');
  expect(noconfirm.status).toBe('uncertain');
  expect(noconfirm.receipt).toBeUndefined();
  // The site without permission was not touched.
  expect((await app('otherhost')).status).toBe('draft');

  // Exactly two forms were really submitted: the plain one and the one with no confirmation.
  expect([...hits].sort()).toEqual(['noconfirm', 'plain']);
  await page.close();
});

test('T-14: answering the held question once releases it, and the stored answer fills it next time', async () => {
  await call('POST', `/applications/${apps.unknown}/answer`, { question: 'Are you able to work nights?', answer: 'Yes, two a week' });
  // Take the other host out of the way so the queue reaches the released application.
  await call('POST', `/agent/queue/${apps.otherhost}/result`, { outcome: 'held', reasons: ['site-not-allowed'] });
  const page = await popup();
  const state = await runQueue(page);
  expect(state).toMatchObject({ sent: 1, held: 0 });
  expect((await app('unknown')).status).toBe('submitted');
  expect(hits.filter((h) => h === 'unknown')).toHaveLength(1);
  // Nothing is ever attempted twice.
  const again = await runQueue(page);
  expect(again).toMatchObject({ sent: 0, held: 0, uncertain: 0 });
  expect(again.message).toBe('Nothing is ready to send.');
  expect(hits.filter((h) => h === 'plain')).toHaveLength(1);
  await page.close();
});
