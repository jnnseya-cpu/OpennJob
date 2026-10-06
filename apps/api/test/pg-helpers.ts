import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import type { Pool } from 'pg';
import { defaultMigrationsDir, loadMigrations, runMigrations } from '../src/migrations';
import { createPool } from '../src/postgres';

/**
 * PostgreSQL-backed tests run only when DATABASE_URL is set (CI gives them a postgres
 * service container; locally `npm run test:pg` starts a throwaway instance). Without it
 * they are reported as skipped, never as passed.
 */
export const DATABASE_URL = (process.env.DATABASE_URL ?? '').trim();
export const hasPostgres = DATABASE_URL !== '';

export interface TestDatabase {
  pool: Pool;
  schema: string;
  /** A fresh single connection whose search_path is the test schema. The caller ends it. */
  connect(): Promise<Client>;
  drop(): Promise<void>;
}

/**
 * Each test file works in a schema of its own, made here and dropped afterwards, so the
 * files can run side by side and nothing is ever written to the `public` schema of the
 * database DATABASE_URL names.
 */
export async function createTestDatabase(options: { migrate?: boolean } = {}): Promise<TestDatabase> {
  const schema = `test_${randomBytes(8).toString('hex')}`;
  const admin = new Client({ connectionString: DATABASE_URL });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();

  const searchPath = `-c search_path=${schema}`;
  const connect = async (): Promise<Client> => {
    const client = new Client({ connectionString: DATABASE_URL, options: searchPath });
    await client.connect();
    return client;
  };
  if (options.migrate !== false) {
    const client = await connect();
    try {
      await runMigrations(client, loadMigrations(defaultMigrationsDir({})));
    } finally {
      await client.end();
    }
  }
  const pool = createPool(DATABASE_URL, { options: searchPath, max: 4 });
  return {
    pool,
    schema,
    connect,
    drop: async () => {
      await pool.end().catch(() => undefined);
      const cleaner = new Client({ connectionString: DATABASE_URL });
      await cleaner.connect();
      await cleaner.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await cleaner.end();
    },
  };
}
