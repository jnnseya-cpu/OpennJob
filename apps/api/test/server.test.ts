import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryRepository } from '@opennjob/core';
import { ENCRYPTED_PREFIX } from '../src/crypto';
import { memoryLogger } from '../src/logging';
import { PostgresRepository } from '../src/postgres';
import { StartupError, startServer } from '../src/server';
import type { RunningServer } from '../src/server';
import { CV_TEXT, PROFILE } from './helpers';
import { DATABASE_URL, createTestDatabase, hasPostgres } from './pg-helpers';

/**
 * startServer() is what `node apps/api/dist/main.js` runs. These tests start it for
 * real on a free port and talk to it over HTTP.
 */
let server: RunningServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const SECRET = 'server-test-secret-not-a-real-secret-0123456789';
const KEY = randomBytes(32).toString('base64');
const BASE = { PORT: '0', HOST: '127.0.0.1', OPENNJOB_BCRYPT_ROUNDS: '4' };
const json = async (res: Response) => ({ status: res.status, body: (await res.json()) as Record<string, unknown> });
const post = (url: string, body: unknown, token?: string) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
/** Fictional. */
const ACCOUNT = { email: 'chidi.eze@example.org', password: 'nine quiet lanterns at dusk', acceptedTermsVersion: 'draft-1', acceptedPrivacyVersion: 'draft-1' };

describe('start-up', () => {
  it('refuses to start in production without OPENNJOB_JWT_SECRET, and listens on nothing', async () => {
    const attempt = startServer({ ...BASE, NODE_ENV: 'production', OPENNJOB_DATA_KEY: KEY }, memoryLogger());
    await expect(attempt).rejects.toBeInstanceOf(StartupError);
    await expect(attempt).rejects.toThrow(/OPENNJOB_JWT_SECRET is not set/);
  });

  it('refuses to start in production without OPENNJOB_DATA_KEY', async () => {
    await expect(startServer({ ...BASE, NODE_ENV: 'production', OPENNJOB_JWT_SECRET: SECRET }, memoryLogger())).rejects.toThrow(/OPENNJOB_DATA_KEY is not set/);
  });

  it('refuses a malformed data key even outside production', async () => {
    await expect(startServer({ ...BASE, OPENNJOB_DATA_KEY: 'c2hvcnQ=' }, memoryLogger())).rejects.toThrow(/exactly 32 bytes/);
  });

  it('starts in production with both, on the in-memory store, and says so loudly', async () => {
    const logger = memoryLogger();
    server = await startServer({ ...BASE, NODE_ENV: 'production', OPENNJOB_JWT_SECRET: SECRET, OPENNJOB_DATA_KEY: KEY }, logger);
    expect(server.deps.repository).toBeInstanceOf(InMemoryRepository);
    expect(await json(await fetch(`${server.url}/health`))).toEqual({ status: 200, body: { status: 'ok', persistence: 'memory', database: 'up' } });
    expect(logger.lines.some((l) => l.level === 'warn' && /held in memory/.test(String(l.msg)))).toBe(true);
    expect(JSON.stringify(logger.lines)).not.toContain(SECRET);
    expect(JSON.stringify(logger.lines)).not.toContain(KEY);
  });

  it('serves register, login and a protected route over real HTTP, then shuts down cleanly', async () => {
    server = await startServer({ ...BASE, OPENNJOB_JWT_SECRET: SECRET }, memoryLogger());
    const registered = await json(await post(`${server.url}/auth/register`, ACCOUNT));
    expect(registered.status).toBe(201);
    const login = await json(await post(`${server.url}/auth/login`, { email: ACCOUNT.email, password: ACCOUNT.password }));
    expect(login.status).toBe(200);
    const token = login.body.accessToken as string;
    expect((await fetch(`${server.url}/applications`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
    expect((await fetch(`${server.url}/applications`)).status).toBe(401);

    const url = server.url;
    await server.close();
    await server.close(); // a second call is harmless
    server = undefined;
    await expect(fetch(`${url}/health`)).rejects.toThrow(); // nothing is listening any more
  });

  it('graceful shutdown lets a request that is already in flight finish', async () => {
    server = await startServer({ ...BASE, OPENNJOB_JWT_SECRET: SECRET }, memoryLogger());
    const realPing = server.deps.repository.ping.bind(server.deps.repository);
    let release: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      server!.deps.repository.ping = async () => {
        resolve();
        await new Promise<void>((r) => (release = r));
        return realPing();
      };
    });
    const inFlight = fetch(`${server.url}/health`);
    await started;
    const closing = server.close();
    release();
    expect((await inFlight).status).toBe(200);
    await closing;
    server = undefined;
  });
});

describe.skipIf(!hasPostgres)('start-up with DATABASE_URL (live PostgreSQL)', () => {
  /** startServer takes a connection string, so the test schema goes into it as a libpq option. */
  const urlFor = (schema: string): string => `${DATABASE_URL}${DATABASE_URL.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${schema}`)}`;

  it('refuses to start on a database that has not been migrated', async () => {
    const db = await createTestDatabase({ migrate: false });
    try {
      await expect(startServer({ ...BASE, OPENNJOB_JWT_SECRET: SECRET, DATABASE_URL: urlFor(db.schema) }, memoryLogger())).rejects.toThrow(/missing migrations: 001_initial_schema, 002_accounts_and_encryption, 003_notifications.*npm run migrate/);
    } finally {
      await db.drop();
    }
  });

  it('refuses to start when the database cannot be reached', async () => {
    await expect(startServer({ ...BASE, OPENNJOB_JWT_SECRET: SECRET, DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none' }, memoryLogger())).rejects.toThrow(/Cannot connect to the database/);
  });

  it('selects PostgreSQL, keeps data across a restart, encrypts it at rest, and /health follows the database', async () => {
    const db = await createTestDatabase();
    const env = { ...BASE, NODE_ENV: 'production', OPENNJOB_JWT_SECRET: SECRET, OPENNJOB_DATA_KEY: KEY, DATABASE_URL: urlFor(db.schema) };
    try {
      server = await startServer(env, memoryLogger());
      expect(server.deps.repository).toBeInstanceOf(PostgresRepository);
      expect(await json(await fetch(`${server.url}/health`))).toEqual({ status: 200, body: { status: 'ok', persistence: 'postgres', database: 'up' } });
      const token = (await json(await post(`${server.url}/auth/register`, ACCOUNT))).body.accessToken as string;
      const put = await fetch(`${server.url}/profile`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(PROFILE) });
      expect(put.status).toBe(200);

      // Stop the process's server and start another on the same database: the data is still there.
      await server.close();
      server = await startServer(env, memoryLogger());
      const login = await json(await post(`${server.url}/auth/login`, { email: ACCOUNT.email, password: ACCOUNT.password }));
      expect(login.status).toBe(200);
      const profile = await json(await fetch(`${server.url}/profile`, { headers: { Authorization: `Bearer ${login.body.accessToken as string}` } }));
      expect(profile.body).toEqual(PROFILE);

      // What is in the table is ciphertext.
      const client = new Client({ connectionString: urlFor(db.schema) });
      await client.connect();
      const stored = (await client.query('SELECT cv_text FROM profiles')).rows[0]?.cv_text as string;
      await client.end();
      expect(stored.startsWith(ENCRYPTED_PREFIX)).toBe(true);
      expect(stored).not.toContain(CV_TEXT.slice(0, 20));

      // The database goes away underneath the running API: /health says so with 503.
      await server.deps.close?.();
      expect(await json(await fetch(`${server.url}/health`))).toEqual({ status: 503, body: { status: 'degraded', persistence: 'postgres', database: 'down' } });
      await server.app.close();
      server = undefined;
    } finally {
      await db.drop();
    }
  });
});
