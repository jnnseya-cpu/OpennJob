import { Client } from 'pg';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createDefaultDeps, isProduction, startupProblems } from './deps';
import type { OpennJobDeps } from './deps';
import { createApp } from './http';
import { consoleJsonLogger } from './logging';
import type { Logger } from './logging';
import { defaultMigrationsDir, loadMigrations, pendingMigrations } from './migrations';

type Env = Record<string, string | undefined>;

export class StartupError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join(' '));
    this.name = 'StartupError';
  }
}

export interface RunningServer {
  app: NestExpressApplication;
  deps: OpennJobDeps;
  url: string;
  /** Stops accepting connections, lets requests in flight finish, then closes the database pool. */
  close(): Promise<void>;
}

/** With DATABASE_URL set, the schema must be migrated before the API serves anything. */
async function assertMigrated(databaseUrl: string, env: Env): Promise<void> {
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
  } catch {
    throw new StartupError(['Cannot connect to the database named by DATABASE_URL.']);
  }
  try {
    const pending = await pendingMigrations(client, loadMigrations(defaultMigrationsDir(env)));
    if (pending.length > 0) throw new StartupError([`The database is missing migrations: ${pending.join(', ')}. Run "npm run migrate" first.`]);
  } finally {
    await client.end();
  }
}

/**
 * Starts the API. Throws StartupError (without listening) when the configuration is not
 * fit to run: in production, no OPENNJOB_JWT_SECRET or no OPENNJOB_DATA_KEY.
 */
export async function startServer(env: Env = process.env, logger: Logger = consoleJsonLogger): Promise<RunningServer> {
  const problems = startupProblems(env);
  if (problems.length > 0) throw new StartupError(problems);

  const databaseUrl = (env.DATABASE_URL ?? '').trim();
  if (databaseUrl) await assertMigrated(databaseUrl, env);

  const deps = createDefaultDeps(env, undefined, logger);
  const trustProxy = (env.OPENNJOB_TRUST_PROXY ?? '').trim();
  const app = await createApp(deps, trustProxy ? { trustProxy } : {});

  const port = Number.parseInt(env.PORT ?? '3000', 10);
  const host = env.HOST ?? '127.0.0.1';
  await app.listen(port, host);
  const address = app.getHttpServer().address() as { port: number } | string | null;
  const url = `http://${host}:${typeof address === 'object' && address ? address.port : port}`;

  logger.info({ msg: 'listening', url, production: isProduction(env) });
  logger.info({ msg: 'persistence', kind: deps.persistence });
  if (deps.config.registrationAllowlist.length === 0) logger.warn({ msg: 'OPENNJOB_REGISTRATION_ALLOWLIST is empty: anyone who can reach the API can register.' });
  else logger.info({ msg: 'registration is invite-only', invited: deps.config.registrationAllowlist.length });
  if (deps.persistence === 'memory') logger.warn({ msg: 'DATABASE_URL is not set: data is held in memory and is lost when this process stops.' });
  if (!(env.OPENNJOB_DATA_KEY ?? '').trim()) logger.warn({ msg: 'OPENNJOB_DATA_KEY is not set: CV text, passports and statements are stored unencrypted.' });
  logger.info({ msg: 'llm', configured: Boolean(deps.llm) });
  logger.info({ msg: 'job sources', count: deps.sources.length, labels: deps.sources.map((s) => s.label).join(', ') });

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      await app.close(); // stops listening; in-flight requests finish first
      await deps.close?.();
    })();
    return closing;
  };
  return { app, deps, url, close };
}
