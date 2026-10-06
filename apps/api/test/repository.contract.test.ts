import { describe } from 'vitest';
import { InMemoryRepository, InMemoryUsageMeter } from '@opennjob/core';
import { randomBytes } from 'node:crypto';
import { AesGcmCipher } from '../src/crypto';
import { PostgresRepository, PostgresUsageMeter } from '../src/postgres';
import { createTestDatabase, hasPostgres } from './pg-helpers';
import { repositoryContract } from './repository.contract';

// The same suite against every implementation.
repositoryContract('InMemoryRepository', async () => ({ repository: new InMemoryRepository(), usageMeter: new InMemoryUsageMeter(), close: async () => undefined }));

// Needs a live PostgreSQL (DATABASE_URL). Skipped, and reported as skipped, without one.
describe.skipIf(!hasPostgres)('against a live PostgreSQL', () => {
  repositoryContract('PostgresRepository, no data key (plain text columns)', async () => {
    const db = await createTestDatabase();
    return { repository: new PostgresRepository(db.pool), usageMeter: new PostgresUsageMeter(db.pool), close: db.drop };
  });

  repositoryContract('PostgresRepository, AES-256-GCM data key', async () => {
    const db = await createTestDatabase();
    return { repository: new PostgresRepository(db.pool, new AesGcmCipher(randomBytes(32))), usageMeter: new PostgresUsageMeter(db.pool), close: db.drop };
  });
});
