import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { Client } from 'pg';

/**
 * Test servers for the web app's end-to-end tests:
 *  - the BUILT API (`node apps/api/dist/main.js`) as a real process, in memory, or on
 *    PostgreSQL in a throwaway schema when DATABASE_URL is set;
 *  - a plain static file server for the BUILT web app (apps/web/out), the way any static
 *    host would serve it, with `/opennjob-config.json` pointing the app at that API.
 */
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const API_ENTRY = path.join(REPO_ROOT, 'apps/api/dist/main.js');
const MIGRATE_ENTRY = path.join(REPO_ROOT, 'apps/api/dist/migrate-cli.js');
export const WEB_OUT = path.join(REPO_ROOT, 'apps/web/out');
const DATABASE_URL = (process.env.DATABASE_URL ?? '').trim();

export const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

export interface WebServer {
  url: string;
  close(): Promise<void>;
}

/** Serves apps/web/out. `/x/` is `/x/index.html`. Nothing outside out/ is reachable. */
export async function startWeb(port: number, apiBase: string): Promise<WebServer> {
  if (!existsSync(path.join(WEB_OUT, 'index.html'))) throw new Error('apps/web/out is missing: run `npm run build` first (npm run test:e2e does).');
  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    if (pathname === '/opennjob-config.json') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ apiBase }));
      return;
    }
    let file = path.normalize(path.join(WEB_OUT, pathname));
    if (!file.startsWith(WEB_OUT)) {
      res.writeHead(400).end();
      return;
    }
    if (existsSync(file) && statSync(file).isDirectory()) file = path.join(file, 'index.html');
    const found = existsSync(file);
    const body = readFileSync(found ? file : path.join(WEB_OUT, '404.html'));
    res.writeHead(found ? 200 : 404, { 'Content-Type': TYPES[path.extname(found ? file : '.html')] ?? 'application/octet-stream', 'Referrer-Policy': 'no-referrer' });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

export interface ApiProcess {
  url: string;
  persistence: 'memory' | 'postgres';
  output(): string;
  /** Runs SQL in this API's own schema (PostgreSQL only). */
  query(sql: string): Promise<Record<string, unknown>[]>;
  stop(): Promise<void>;
}

async function run(entry: string, env: NodeJS.ProcessEnv): Promise<{ code: number | null; out: string }> {
  const child = spawn(process.execPath, [entry], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
  return { code, out };
}

export async function startApi(webOrigin: string): Promise<ApiProcess> {
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    PORT: String(port),
    HOST: '127.0.0.1',
    OPENNJOB_JWT_SECRET: 'web-e2e-signing-secret-not-a-real-secret-0123',
    OPENNJOB_BCRYPT_ROUNDS: '4',
    OPENNJOB_DEMO_JOBS: 'true',
    OPENNJOB_CORS_ORIGINS: webOrigin,
  };
  let schema = '';
  let admin: Client | undefined;
  if (DATABASE_URL) {
    schema = `test_${randomBytes(8).toString('hex')}`;
    admin = new Client({ connectionString: DATABASE_URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    env.DATABASE_URL = `${DATABASE_URL}${DATABASE_URL.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
    env.OPENNJOB_DATA_KEY = randomBytes(32).toString('base64');
    const migrated = await run(MIGRATE_ENTRY, env);
    if (migrated.code !== 0) throw new Error(`migrate failed:\n${migrated.out}`);
  }
  const child: ChildProcess = spawn(process.execPath, [API_ENTRY], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout?.on('data', (d) => (out += d));
  child.stderr?.on('data', (d) => (out += d));
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  for (;;) {
    const status = await fetch(`${url}/health`).then((r) => r.status).catch(() => 0);
    if (status === 200) break;
    if (Date.now() > deadline || child.exitCode !== null) throw new Error(`The API did not start.\n${out}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return {
    url,
    persistence: DATABASE_URL ? 'postgres' : 'memory',
    output: () => out,
    async query(sql) {
      if (!admin) throw new Error('query() needs DATABASE_URL');
      return (await admin.query(sql.replaceAll('{schema}', schema))).rows as Record<string, unknown>[];
    },
    async stop() {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await new Promise((resolve) => child.once('exit', resolve));
      }
      if (admin) {
        await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await admin.end();
      }
    },
  };
}
