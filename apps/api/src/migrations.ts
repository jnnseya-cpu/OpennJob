import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * Versioned SQL migrations. Files are db/migrations/NNN_name.sql, applied in order, each
 * in its own transaction, each recorded in the `schema_migrations` table with a checksum.
 * Running it again does nothing (idempotent). An applied file that has since been edited
 * stops the run: write a new migration instead.
 */
export interface MigrationFile {
  version: string;
  name: string;
  sql: string;
  checksum: string;
}

/** One connection (not a pool): the advisory lock and the transactions must share a session. */
export interface MigrationClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/** Works from apps/api/src and from apps/api/dist. Override with OPENNJOB_MIGRATIONS_DIR. */
export const defaultMigrationsDir = (env: Record<string, string | undefined> = process.env): string =>
  (env.OPENNJOB_MIGRATIONS_DIR ?? '').trim() || path.resolve(__dirname, '../../../db/migrations');

const FILE = /^(\d{3,})_([a-z0-9_]+)\.sql$/;

export function loadMigrations(dir: string): MigrationFile[] {
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const seen = new Set<string>();
  return files.map((file) => {
    const m = FILE.exec(file);
    if (!m) throw new Error(`Migration file name must look like 001_name.sql: ${file}`);
    const version = m[1] as string;
    if (seen.has(version)) throw new Error(`Two migrations share version ${version}`);
    seen.add(version);
    const sql = readFileSync(path.join(dir, file), 'utf8');
    return { version, name: m[2] as string, sql, checksum: createHash('sha256').update(sql).digest('hex') };
  });
}

const TABLE = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version     TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  checksum    TEXT NOT NULL,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
)`;

/** Any fixed number: two migration runs at once take turns instead of colliding. */
const LOCK_KEY = 7_316_042_001;

async function applied(client: MigrationClient): Promise<Map<string, string>> {
  const { rows } = await client.query('SELECT version, checksum FROM schema_migrations');
  return new Map(rows.map((r) => [r.version as string, r.checksum as string]));
}

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
  /** Migrations the database has that this code does not know (only with allowNewer). */
  newer: string[];
}

/**
 * `allowNewer`: set only while rolling back to older code (deploy/auto-update.sh,
 * OPENNJOB_ALLOW_NEWER_SCHEMA=1). The database may then carry migrations this code does not know,
 * provided every one of them comes after the newest it does know: a newer release added them, and
 * migrations only add tables, columns and looser checks. Anything else is still refused.
 */
export async function runMigrations(client: MigrationClient, migrations: MigrationFile[], options: { allowNewer?: boolean } = {}): Promise<MigrationResult> {
  await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
  try {
    await client.query(TABLE);
    const done = await applied(client);
    const known = new Set(migrations.map((m) => m.version));
    const newestKnown = [...known].sort().at(-1) ?? '';
    const newer: string[] = [];
    for (const version of [...done.keys()].sort()) {
      if (known.has(version)) continue;
      if (options.allowNewer && version > newestKnown) newer.push(version);
      else throw new Error(`The database has migration ${version}, which this code does not know. Refusing to continue with older code.`);
    }
    const result: MigrationResult = { applied: [], alreadyApplied: [], newer };
    for (const m of migrations) {
      const label = `${m.version}_${m.name}`;
      const recorded = done.get(m.version);
      if (recorded !== undefined) {
        if (recorded !== m.checksum) throw new Error(`Migration ${label} was changed after it was applied. Add a new migration instead of editing an old one.`);
        result.alreadyApplied.push(label);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [m.version, m.name, m.checksum]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${label} failed and was rolled back: ${err instanceof Error ? err.message : String(err)}`);
      }
      result.applied.push(label);
    }
    return result;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
  }
}

/** Migrations in the files that the database does not have yet. Empty means up to date. */
export async function pendingMigrations(client: MigrationClient, migrations: MigrationFile[]): Promise<string[]> {
  const { rows } = await client.query("SELECT to_regclass('schema_migrations') AS t");
  const done = rows[0]?.t ? await applied(client) : new Map<string, string>();
  return migrations.filter((m) => !done.has(m.version)).map((m) => `${m.version}_${m.name}`);
}
