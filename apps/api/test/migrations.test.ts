import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Client } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { defaultMigrationsDir, loadMigrations, pendingMigrations, runMigrations } from '../src/migrations';
import type { MigrationFile } from '../src/migrations';
import { createTestDatabase, hasPostgres } from './pg-helpers';
import type { TestDatabase } from './pg-helpers';

const REAL = loadMigrations(defaultMigrationsDir({}));

describe('migration files', () => {
  it('are versioned, ordered and checksummed, and wrap nothing in their own transaction', () => {
    expect(REAL.map((m) => `${m.version}_${m.name}`)).toEqual(['001_initial_schema', '002_accounts_and_encryption', '003_notifications', '004_applying', '005_refresh_tokens', '006_more_job_sources', '007_link_and_career_sites']);
    for (const m of REAL) {
      expect(m.checksum).toMatch(/^[0-9a-f]{64}$/);
      // The runner supplies the transaction; a COMMIT inside a file would end it early.
      expect(m.sql).not.toMatch(/^\s*(BEGIN|COMMIT)\s*;/im);
    }
  });

  it('rejects badly named files and duplicate versions', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'opennjob-mig-'));
    try {
      writeFileSync(path.join(dir, '001_one.sql'), 'SELECT 1;');
      writeFileSync(path.join(dir, 'notes.txt'), 'ignored');
      expect(loadMigrations(dir).map((m) => m.version)).toEqual(['001']);
      writeFileSync(path.join(dir, '001_two.sql'), 'SELECT 2;');
      expect(() => loadMigrations(dir)).toThrow(/share version 001/);
      rmSync(path.join(dir, '001_two.sql'));
      writeFileSync(path.join(dir, 'second.sql'), 'SELECT 2;');
      expect(() => loadMigrations(dir)).toThrow(/must look like 001_name\.sql/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('finds the migrations directory from the environment or from the source tree', () => {
    expect(defaultMigrationsDir({ OPENNJOB_MIGRATIONS_DIR: ' /somewhere/else ' })).toBe('/somewhere/else');
    expect(defaultMigrationsDir({})).toMatch(/db[\\/]migrations$/);
  });
});

describe.skipIf(!hasPostgres)('running migrations against a live PostgreSQL', () => {
  let db: TestDatabase;
  let client: Client;
  beforeAll(async () => {
    db = await createTestDatabase({ migrate: false });
  });
  afterAll(async () => {
    await db?.drop();
  });
  beforeEach(async () => {
    client = await db.connect();
  });
  afterEach(async () => {
    await client.end();
  });

  const tables = async (): Promise<string[]> =>
    (await client.query('SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY 1', [db.schema])).rows.map((r) => r.table_name as string);

  it('reports everything as pending on an empty database', async () => {
    expect(await pendingMigrations(client, REAL)).toEqual(['001_initial_schema', '002_accounts_and_encryption', '003_notifications', '004_applying', '005_refresh_tokens', '006_more_job_sources', '007_link_and_career_sites']);
    expect(await tables()).toEqual([]);
  });

  it('applies every migration once, in order, and records each in schema_migrations', async () => {
    const first = await runMigrations(client, REAL);
    expect(first).toEqual({ applied: ['001_initial_schema', '002_accounts_and_encryption', '003_notifications', '004_applying', '005_refresh_tokens', '006_more_job_sources', '007_link_and_career_sites'], alreadyApplied: [], newer: [] });
    expect(await tables()).toEqual(['applications', 'auth_tokens', 'events', 'jobs', 'notification_deliveries', 'notification_preferences', 'notifications', 'passports', 'platform_claims', 'platform_settings', 'profiles', 'rate_limit_windows', 'schema_migrations', 'screening_answers', 'standing_authorisations', 'usage_records', 'users']);
    const recorded = (await client.query('SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version')).rows;
    expect(recorded.map((r) => [r.version, r.name, r.checksum])).toEqual(REAL.map((m) => [m.version, m.name, m.checksum]));
    expect(recorded.every((r) => r.applied_at instanceof Date)).toBe(true);
    expect(await pendingMigrations(client, REAL)).toEqual([]);
  });

  it('is idempotent: a second and third run change nothing', async () => {
    await client.query("INSERT INTO users (id, email, password_hash, accepted_terms_version, accepted_privacy_version, consent_at) VALUES ('keep', 'keep@example.org', 'x', 't', 'p', now())");
    const before = (await client.query('SELECT version, applied_at FROM schema_migrations ORDER BY version')).rows;
    for (let i = 0; i < 2; i += 1) {
      expect(await runMigrations(client, REAL)).toEqual({ applied: [], alreadyApplied: ['001_initial_schema', '002_accounts_and_encryption', '003_notifications', '004_applying', '005_refresh_tokens', '006_more_job_sources', '007_link_and_career_sites'], newer: [] });
    }
    expect((await client.query('SELECT version, applied_at FROM schema_migrations ORDER BY version')).rows).toEqual(before);
    expect((await client.query('SELECT id FROM users')).rows).toEqual([{ id: 'keep' }]);
  });

  it('the migrated schema has the account, consent and encrypted-value columns', async () => {
    const columns = async (table: string) =>
      (await client.query('SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY 1', [db.schema, table])).rows.map((r) => r.column_name as string);
    expect(await columns('users')).toEqual(['accepted_privacy_version', 'accepted_terms_version', 'consent_at', 'created_at', 'email', 'email_verified_at', 'id', 'password_hash']);
    expect(await columns('passports')).toEqual(['data', 'updated_at', 'user_id']);
    // Deleting a user removes every row that belongs to them.
    const cascades = (
      await client.query(
        `SELECT cl.relname AS t FROM pg_constraint c JOIN pg_class cl ON cl.oid = c.conrelid JOIN pg_namespace n ON n.oid = cl.relnamespace
         WHERE c.contype = 'f' AND c.confdeltype = 'c' AND n.nspname = $1 AND c.confrelid = (quote_ident($1) || '.users')::regclass ORDER BY 1`,
        [db.schema],
      )
    ).rows.map((r) => r.t as string);
    expect(cascades).toEqual(['applications', 'auth_tokens', 'events', 'notification_deliveries', 'notification_preferences', 'notifications', 'passports', 'profiles', 'screening_answers', 'standing_authorisations', 'usage_records']);
  });

  it('applies a new migration on top, rolls a failing one back completely, and names it', async () => {
    const good: MigrationFile = { version: '008', name: 'extra', sql: 'CREATE TABLE extra_one (id INT); CREATE TABLE extra_two (id INT);', checksum: 'c3' };
    const bad: MigrationFile = { version: '009', name: 'broken', sql: 'CREATE TABLE half_made (id INT); SELECT * FROM table_that_does_not_exist;', checksum: 'c4' };
    await expect(runMigrations(client, [...REAL, good, bad])).rejects.toThrow(/Migration 009_broken failed and was rolled back/);
    expect(await tables()).toContain('extra_two');
    expect(await tables()).not.toContain('half_made');
    expect(await pendingMigrations(client, [...REAL, good, bad])).toEqual(['009_broken']);
    // The lock was released: the next run is not left waiting.
    expect(await runMigrations(client, [...REAL, good])).toEqual({ applied: [], alreadyApplied: ['001_initial_schema', '002_accounts_and_encryption', '003_notifications', '004_applying', '005_refresh_tokens', '006_more_job_sources', '007_link_and_career_sites', '008_extra'], newer: [] });
  });

  it('refuses to run when an applied migration was edited, or when the database is ahead of the code', async () => {
    const extra: MigrationFile = { version: '008', name: 'extra', sql: '', checksum: 'c3' }; // applied by the test above
    const edited = [...REAL.map((m, i) => (i === 0 ? { ...m, checksum: 'different' } : m)), extra];
    await expect(runMigrations(client, edited)).rejects.toThrow(/001_initial_schema was changed after it was applied/);
    await expect(runMigrations(client, REAL)).rejects.toThrow(/has migration 008, which this code does not know/);
  });

  it('while rolling back, older code accepts migrations newer than all of its own, and nothing else', async () => {
    // 008 (from the tests above) is newer than everything in REAL: a rollback may go on.
    expect((await runMigrations(client, REAL, { allowNewer: true })).newer).toEqual(['008']);
    // Code that knows 009 but not 008 has a gap, not a newer schema: still refused.
    const later: MigrationFile = { version: '009', name: 'later', sql: '', checksum: 'c9' };
    await expect(runMigrations(client, [...REAL, later], { allowNewer: true })).rejects.toThrow(/has migration 008, which this code does not know/);
  });

  it('two runs at the same time do not collide', async () => {
    const fresh = await createTestDatabase({ migrate: false });
    const [one, two] = [await fresh.connect(), await fresh.connect()];
    try {
      const results = await Promise.all([runMigrations(one, REAL), runMigrations(two, REAL)]);
      expect(results.map((r) => r.applied.length).sort()).toEqual([0, REAL.length]);
    } finally {
      await one.end();
      await two.end();
      await fresh.drop();
    }
  });
});
