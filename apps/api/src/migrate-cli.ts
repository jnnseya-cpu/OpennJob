import { existsSync } from 'node:fs';
import { Client } from 'pg';
import { defaultMigrationsDir, loadMigrations, runMigrations } from './migrations';

/** `npm run migrate`. Applies every migration the database does not have yet, then exits. */
async function main(): Promise<void> {
  const loadEnvFile = (process as unknown as { loadEnvFile?: (path?: string) => void }).loadEnvFile;
  if (existsSync('.env') && typeof loadEnvFile === 'function') loadEnvFile('.env');

  const databaseUrl = (process.env.DATABASE_URL ?? '').trim();
  if (!databaseUrl) {
    console.error('[opennjob] DATABASE_URL is not set. Nothing to migrate (the in-memory store has no schema).');
    process.exit(1);
  }
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await runMigrations(client, loadMigrations(defaultMigrationsDir()));
    for (const m of result.alreadyApplied) console.log(`[opennjob] already applied: ${m}`);
    for (const m of result.applied) console.log(`[opennjob] applied: ${m}`);
    console.log(`[opennjob] migrations: ${result.applied.length} applied, ${result.alreadyApplied.length} already in place.`);
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error(`[opennjob] migration failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
