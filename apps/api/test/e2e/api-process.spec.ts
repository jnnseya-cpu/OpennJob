import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { Client } from 'pg';

/**
 * The BUILT API as a real operating-system process (`node apps/api/dist/main.js`), the
 * way Docker and Cloud Run start it: what it prints, when it refuses to start, and how
 * it stops. No browser is involved; these run with the end-to-end tests because they
 * need the build.
 */
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const MAIN = path.join(REPO_ROOT, 'apps/api/dist/main.js');
const MIGRATE = path.join(REPO_ROOT, 'apps/api/dist/migrate-cli.js');
const SECRET = 'process-test-secret-not-a-real-secret-0123456789';
const KEY = randomBytes(32).toString('base64');
const DATABASE_URL = (process.env.DATABASE_URL ?? '').trim();

let workDir: string;
test.beforeAll(() => {
  workDir = mkdtempSync(path.join(os.tmpdir(), 'opennjob-proc-')); // an empty directory: no .env to pick up
});
test.afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });

interface Proc {
  output: () => string;
  lines: () => Record<string, unknown>[];
  exit: Promise<number | null>;
  kill: (signal: NodeJS.Signals) => void;
  url: string;
}

async function start(entry: string, extra: Record<string, string>): Promise<Proc> {
  const port = await freePort();
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, PORT: String(port), HOST: '127.0.0.1', OPENNJOB_BCRYPT_ROUNDS: '4', ...extra };
  const child = spawn(process.execPath, [entry], { cwd: workDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const exit = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  return {
    output: () => out,
    lines: () => out.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l) as Record<string, unknown>),
    exit,
    kill: (signal) => void child.kill(signal),
    url: `http://127.0.0.1:${port}`,
  };
}

async function waitForHealth(proc: Proc): Promise<void> {
  await expect.poll(async () => fetch(`${proc.url}/health`).then((r) => r.status).catch(() => 0), { timeout: 20_000, message: proc.output() }).toBe(200);
}

test('production: refuses to start without OPENNJOB_JWT_SECRET (exit code 1, says why, listens on nothing)', async () => {
  const proc = await start(MAIN, { NODE_ENV: 'production', OPENNJOB_DATA_KEY: KEY });
  expect(await proc.exit).toBe(1);
  expect(proc.lines()).toEqual([expect.objectContaining({ level: 'error', msg: 'refusing to start', problem: 'OPENNJOB_JWT_SECRET is not set. It is required when NODE_ENV=production.' })]);
  await expect(fetch(`${proc.url}/health`)).rejects.toThrow();
});

test('production: refuses to start without OPENNJOB_DATA_KEY, and with a malformed one', async () => {
  const missing = await start(MAIN, { NODE_ENV: 'production', OPENNJOB_JWT_SECRET: SECRET });
  expect(await missing.exit).toBe(1);
  expect(missing.output()).toContain('OPENNJOB_DATA_KEY is not set. It is required when NODE_ENV=production');
  const malformed = await start(MAIN, { NODE_ENV: 'production', OPENNJOB_JWT_SECRET: SECRET, OPENNJOB_DATA_KEY: 'c2hvcnQ=' });
  expect(await malformed.exit).toBe(1);
  expect(malformed.output()).toContain('must decode to exactly 32 bytes');
  expect(malformed.output()).not.toContain(SECRET);
});

test('production: starts with both, logs JSON lines only, never prints a secret, and stops cleanly on SIGTERM', async () => {
  const proc = await start(MAIN, { NODE_ENV: 'production', OPENNJOB_JWT_SECRET: SECRET, OPENNJOB_DATA_KEY: KEY, OPENNJOB_DEMO_JOBS: 'true' });
  await waitForHealth(proc);
  expect(await (await fetch(`${proc.url}/health`)).json()).toEqual({ status: 'ok', persistence: 'memory', database: 'up', version: 'unknown' });

  // A whole user journey over HTTP, so the request log has something to get wrong.
  const json = { 'Content-Type': 'application/json' };
  const versions = (await (await fetch(`${proc.url}/auth/versions`)).json()) as { termsVersion: string; privacyVersion: string };
  const registered = (await (
    await fetch(`${proc.url}/auth/register`, { method: 'POST', headers: json, body: JSON.stringify({ email: 'chidi.eze@example.org', password: 'nine quiet lanterns at dusk', acceptedTermsVersion: versions.termsVersion, acceptedPrivacyVersion: versions.privacyVersion }) })
  ).json()) as { accessToken: string };
  const auth = { ...json, Authorization: `Bearer ${registered.accessToken}` };
  const cv = 'Healthcare assistant with four years of experience in a care home.\nI hold the Care Certificate and give personal care with dignity.';
  expect((await fetch(`${proc.url}/profile`, { method: 'PUT', headers: auth, body: JSON.stringify({ firstName: 'Chidi', lastName: 'Eze', email: 'chidi.eze@example.org', phone: '07700 900321', addressLine1: '9 Sample Lane', city: 'Leeds', postcode: 'LS1 1AA', cvText: cv }) })).status).toBe(200);
  expect((await fetch(`${proc.url}/passport`, { method: 'PUT', headers: auth, body: JSON.stringify({ nmcPin: '18A1234E', rightToWorkConfirmed: true }) })).status).toBe(200);
  expect((await fetch(`${proc.url}/jobs/refresh`, { method: 'POST', headers: auth })).status).toBe(200);
  const application = (await (await fetch(`${proc.url}/applications`, { method: 'POST', headers: auth, body: JSON.stringify({ jobId: 'sample:hca-elderly-care' }) })).json()) as { statement: string };
  expect(application.statement.length).toBeGreaterThan(20);
  expect((await fetch(`${proc.url}/profile`)).status).toBe(401);

  proc.kill('SIGTERM');
  expect(await proc.exit).toBe(0);

  const output = proc.output();
  const lines = proc.lines();
  expect(output.split('\n').filter((l) => l.trim() !== '' && !l.startsWith('{'))).toEqual([]); // every line is JSON
  expect(lines.map((l) => l.msg)).toEqual(expect.arrayContaining(['listening', 'persistence', 'request', 'shutting down', 'shutdown complete']));
  expect(lines.filter((l) => l.msg === 'request').map((l) => `${String(l.method)} ${String(l.path)} ${String(l.status)}`)).toEqual(expect.arrayContaining(['POST /auth/register 201', 'PUT /profile 200', 'PUT /passport 200', 'POST /applications 201', 'GET /profile 401']));
  expect(lines.at(-1)).toMatchObject({ level: 'info', msg: 'shutdown complete' });
  for (const secret of [SECRET, KEY, registered.accessToken, 'nine quiet lanterns', 'chidi.eze@example.org', 'Chidi', 'Healthcare assistant', 'Care Certificate', '18A1234E', '9 Sample Lane', ...application.statement.split('\n').filter((l) => l.length > 12)]) {
    expect(output, secret.slice(0, 30)).not.toContain(secret);
  }
  await expect(fetch(`${proc.url}/health`)).rejects.toThrow();
});

test('development: starts with no secret at all, warns, and stops on SIGINT', async () => {
  const proc = await start(MAIN, {});
  await waitForHealth(proc);
  proc.kill('SIGINT');
  expect(await proc.exit).toBe(0);
  const warnings = proc.lines().filter((l) => l.level === 'warn').map((l) => String(l.msg));
  expect(warnings.some((m) => m.includes('OPENNJOB_JWT_SECRET is not set'))).toBe(true);
  expect(warnings.some((m) => m.includes('lost when this process stops'))).toBe(true);
  expect(warnings.some((m) => m.includes('stored unencrypted'))).toBe(true);
});

test('npm run migrate without DATABASE_URL exits 1 and says so', async () => {
  const proc = await start(MIGRATE, {});
  expect(await proc.exit).toBe(1);
  expect(proc.output()).toContain('DATABASE_URL is not set');
});

test('with a live PostgreSQL: the API will not start before `migrate`; after it, data outlives the process', async () => {
  test.skip(DATABASE_URL === '', 'needs DATABASE_URL (a live PostgreSQL)');
  const schema = `test_${randomBytes(8).toString('hex')}`;
  const admin = new Client({ connectionString: DATABASE_URL });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = `${DATABASE_URL}${DATABASE_URL.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
  const env = { NODE_ENV: 'production', OPENNJOB_JWT_SECRET: SECRET, OPENNJOB_DATA_KEY: KEY, DATABASE_URL: url };
  try {
    const early = await start(MAIN, env);
    expect(await early.exit).toBe(1);
    expect(early.output()).toContain('The database is missing migrations: 001_initial_schema, 002_accounts_and_encryption, 003_notifications, 004_applying');

    const first = await start(MIGRATE, env);
    expect(await first.exit).toBe(0);
    expect(first.output()).toContain('migrations: 4 applied, 0 already in place.');
    const second = await start(MIGRATE, env);
    expect(await second.exit).toBe(0);
    expect(second.output()).toContain('migrations: 0 applied, 4 already in place.');

    const one = await start(MAIN, env);
    await waitForHealth(one);
    expect(await (await fetch(`${one.url}/health`)).json()).toEqual({ status: 'ok', persistence: 'postgres', database: 'up' });
    const account = { email: 'chidi.eze@example.org', password: 'nine quiet lanterns at dusk', acceptedTermsVersion: 'draft-1', acceptedPrivacyVersion: 'draft-1' };
    expect((await fetch(`${one.url}/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(account) })).status).toBe(201);
    one.kill('SIGTERM');
    expect(await one.exit).toBe(0);

    const two = await start(MAIN, env);
    await waitForHealth(two);
    expect((await fetch(`${two.url}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: account.email, password: account.password }) })).status).toBe(200);
    two.kill('SIGTERM');
    expect(await two.exit).toBe(0);
  } finally {
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
