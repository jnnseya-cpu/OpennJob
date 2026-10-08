import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium, expect, test } from '@playwright/test';
import type { BrowserContext, Page, Worker } from '@playwright/test';
import { DIST, FIXTURES } from './helpers';

/**
 * Multi-step application systems in the queue, end to end, with nothing mocked: the real API
 * process, the built extension in Chromium, and FICTIONAL pages shaped like a Workday career site
 * (a single-page app: Apply, Apply Manually, sign-in, steps, drop-down lists, CV upload, Review,
 * Submit) and a SuccessFactors one (job page, "Apply now", one long form). They are written from
 * how those systems are remembered to look, not copied from a live site: the supervised test that
 * enables each system for real is the check against the real thing.
 *
 * Proves: the queue walks every step and submits only at the end, after the API's go, with the
 * site's confirmation as the receipt; a declaration step (equality monitoring, "I consent") holds it
 * with the earlier steps saved and the tab left open; a sign-in page stops it and leaves the tab
 * open (log in once), and after "try again" it goes all the way; drop-down lists are chosen from
 * the person's stored answers; right to work comes from the person's record (OD-5).
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const API_ENTRY = path.join(REPO_ROOT, 'apps/api/dist/main.js');
const JWT_SECRET = 'e2e-signing-secret-not-a-real-secret-0123456789';
const OPERATOR_KEY = 'e2e-operator-key-not-a-secret';
const EMPLOYER_KEY = 'e2e-employer-key-not-a-secret';
const EMAIL = 'ines.martel@example.org';
const PASSWORD = 'a long fictional passphrase for multistep';
const PROFILE = {
  firstName: 'Ines',
  lastName: 'Martel',
  email: EMAIL,
  phone: '07700 900456',
  addressLine1: '7 Example Row',
  city: 'Leeds',
  postcode: 'LS6 6ZZ',
  cvText: ['Electrical Project Manager (fictional)', 'Managed subcontractors on HV substation projects.', 'Kept accurate site records and ran commissioning.'].join('\n'),
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
  receipt?: { pageUrl: string; confirmationText: string };
}
const app = (name: string) => call<App>('GET', `/applications/${apps[name]}`);

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  workDir = mkdtempSync(path.join(os.tmpdir(), 'opennjob-multistep-'));
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
  fixtureBase = `http://127.0.0.1:${(fixtureServer.address() as AddressInfo).port}`;

  const apiPort = await freePort();
  apiBase = `http://127.0.0.1:${apiPort}`;
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(apiPort), HOST: '127.0.0.1', OPENNJOB_JWT_SECRET: JWT_SECRET, OPENNJOB_BCRYPT_ROUNDS: '4', OPENNJOB_OPERATOR_KEY: OPERATOR_KEY, OPENNJOB_EMPLOYER_KEY: EMPLOYER_KEY, OPENNJOB_DEV_MAILBOX_DIR: path.join(workDir, 'mailbox') };
  for (const key of ['DATABASE_URL', 'OPENNJOB_DATA_KEY', 'NODE_ENV', 'OPENNJOB_CORS_ORIGINS', 'OPENNJOB_CORS_ALLOW_ANY_EXTENSION', 'ANTHROPIC_API_KEY', 'OPENNJOB_DEMO_JOBS', 'ADZUNA_APP_ID', 'ADZUNA_APP_KEY', 'REED_API_KEY', 'OPENNJOB_GREENHOUSE_BOARDS', 'OPENNJOB_LEVER_COMPANIES', 'OPENNJOB_ASHBY_BOARDS', 'OPENNJOB_REGISTRATION_ALLOWLIST', 'RESEND_API_KEY', 'OPENNJOB_APP_URL', 'JOOBLE_API_KEYS', 'OPENNJOB_RELIEFWEB_APPNAME']) delete env[key];
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
  const mails = readdirSync(path.join(workDir, 'mailbox')).map((f) => JSON.parse(readFileSync(path.join(workDir, 'mailbox', f), 'utf8')) as { to: string; text: string });
  const code = mails.filter((m) => m.to === EMAIL).map((m) => /code: ([A-Za-z0-9_-]{32,128})/.exec(m.text)?.[1]).find(Boolean);
  if (!code) throw new Error('No verification code in the dev mailbox');
  await call('POST', '/auth/verify-email', { token: code }, '');
  await call('PUT', '/profile', PROFILE);
  await call('PUT', '/passport', { rightToWorkConfirmed: true, training: [], referees: [], workRights: [{ country: 'GB', rightToWork: true, requiresSponsorship: false, basis: 'British or Irish passport', confirmed: true }] });
  // Ordinary answers the person stored once; the Workday drop-downs are chosen from them.
  await call('PUT', '/screening', { noticePeriod: 'Four weeks', custom: { Country: 'United Kingdom', 'Phone Device Type': 'Mobile' } });
  const forms: [string, string][] = [
    ['workday', `${fixtureBase}/workday-apply.html?variant=plain`],
    ['disclosures', `${fixtureBase}/workday-apply.html?variant=disclosures`],
    ['signin', `${fixtureBase}/workday-apply.html?variant=signin`],
    ['sf', `${fixtureBase}/sf-job.html?variant=plain`],
    ['sfconsent', `${fixtureBase}/sf-job.html?variant=consent`],
  ];
  for (const [name, applyUrl] of forms) {
    const job = await call<{ id: string }>('POST', '/employer/jobs', {
      title: `Electrical Project Manager ${name} (fictional)`,
      employer: `${name} Grid (fictional)`,
      description: 'A fictional vacancy for the multi-step tests.',
      country: 'gb',
      city: 'Leeds',
      applyUrl,
      criteria: [
        { label: 'Subcontractor management', essential: true, keywords: ['subcontractors'] },
        { label: 'Site records', essential: true, keywords: ['site records'] },
      ],
    }, EMPLOYER_KEY);
    apps[name] = (await call<{ id: string }>('POST', '/applications', { jobId: job.id, mode: 'auto' })).id;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const now = new Date().toISOString();
  await call('PUT', '/operator/systems/local-fixture', { enabled: true, termsCheckedAt: now, supervisedSubmissionAt: now, note: 'fictional forms' }, OPERATOR_KEY);
  await call('PUT', '/agent/authorisation', { enabled: true, scopeVersion: (await call<{ scope: { version: string } }>('GET', '/agent/authorisation')).scope.version });

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

async function runQueue(page: Page): Promise<{ message: string; sent: number; held: number; uncertain: number }> {
  await worker.evaluate(() => chrome.storage.local.remove('queueState'));
  await page.locator('#queue-start').click();
  await expect.poll(async () => worker.evaluate(async () => (await chrome.storage.local.get('queueState')).queueState?.running), { timeout: 120_000 }).toBe(false);
  return worker.evaluate(async () => (await chrome.storage.local.get('queueState')).queueState);
}

const openTabs = () => context.pages().map((p) => p.url());

test('Workday-style and SuccessFactors-style applications: walked step by step, submitted only at the end, held at declarations and sign-in', async () => {
  // Five applications over many pages take about 25 seconds alone, more when the whole suite runs:
  // the test gets the same 120 seconds runQueue gives the queue, not the default 30.
  test.setTimeout(120_000);
  const page = await popup();
  const state = await runQueue(page);
  expect(state).toMatchObject({ sent: 2, held: 3, uncertain: 0 });

  // Workday: Apply, Apply Manually, My Information (drop-downs from stored answers), My Experience
  // (CV attached), Application Questions (right to work from the record), Review, Submit.
  const workday = await app('workday');
  expect(workday).toMatchObject({ status: 'submitted', automatic: true });
  expect(workday.receipt?.confirmationText).toBe('Thank you for applying. Your application has been submitted.');

  // A Voluntary Disclosures step (equality monitoring, "I consent") is the person's: held there,
  // with the three earlier steps saved, and the tab left open at that step.
  const disclosures = await app('disclosures');
  expect(disclosures.status).toBe('needs_you');
  expect(disclosures.holdReasons).toEqual(expect.arrayContaining(['steps-saved:3']));
  expect(disclosures.holdReasons?.some((r) => r.startsWith('sensitive:'))).toBe(true);
  expect(openTabs().some((u) => u.includes('variant=disclosures'))).toBe(true);

  // A sign-in page stops it, with the tab left open for the person to sign in once.
  expect((await app('signin')).holdReasons).toEqual(['login-wall']);
  expect(openTabs().some((u) => u.includes('variant=signin'))).toBe(true);

  // SuccessFactors: "Apply now" on the job page, then the one long form, CV attached, submitted.
  expect(await app('sf')).toMatchObject({ status: 'submitted', automatic: true });
  // The Data Privacy Statement tick box is a consent: never ticked by the agent.
  const consent = await app('sfconsent');
  expect(consent.status).toBe('needs_you');
  expect(consent.holdReasons?.some((r) => r.startsWith('sensitive:'))).toBe(true);

  // Exactly two applications were really submitted.
  expect([...hits].sort()).toEqual(['sf-plain', 'workday-plain']);
  await page.close();
});

test('log in once: the person signs in in the tab that was left open, presses "try again", and the queue goes all the way', async () => {
  const signinTab = context.pages().find((p) => p.url().includes('variant=signin'));
  expect(signinTab).toBeDefined();
  // The person signs in on the employer's site themselves (OpennJob never fills a password).
  await signinTab?.locator('[data-automation-id="signInSubmitButton"]').click();
  await signinTab?.close();
  expect((await call<App>('POST', `/applications/${apps.signin}/retry`)).status).toBe('draft');
  // The disclosures one keeps its declaration hold; it is not part of this run.
  const page = await popup();
  const state = await runQueue(page);
  expect(state).toMatchObject({ sent: 1 });
  expect((await app('signin')).status).toBe('submitted');
  expect(hits.filter((h) => h === 'workday-signin')).toHaveLength(1);
  expect(hits.filter((h) => h === 'workday-plain')).toHaveLength(1); // nothing sent twice
  await page.close();
});
