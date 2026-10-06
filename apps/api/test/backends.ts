import { randomBytes } from 'node:crypto';
import { InMemoryRepository, InMemoryUsageMeter } from '@opennjob/core';
import type { Repository, UsageMeter } from '@opennjob/core';
import { AesGcmCipher } from '../src/crypto';
import { PostgresRepository, PostgresUsageMeter } from '../src/postgres';
import { createTestDatabase, hasPostgres } from './pg-helpers';
import type { TestDatabase } from './pg-helpers';

/**
 * The two stores the API can run on. API-level tests that must hold on both (account
 * deletion, export, isolation between users) loop over this list. The PostgreSQL entry
 * is skipped, and reported as skipped, when DATABASE_URL is not set.
 */
export interface Backend {
  name: string;
  skip: boolean;
  persistence: 'memory' | 'postgres';
  make(): Promise<{ repository: Repository; usageMeter: UsageMeter; db?: TestDatabase; close(): Promise<void> }>;
}

export const BACKENDS: Backend[] = [
  {
    name: 'in-memory repository',
    skip: false,
    persistence: 'memory',
    make: async () => ({ repository: new InMemoryRepository(), usageMeter: new InMemoryUsageMeter(), close: async () => undefined }),
  },
  {
    name: 'PostgreSQL repository (live database, encrypted columns)',
    skip: !hasPostgres,
    persistence: 'postgres',
    make: async () => {
      const db = await createTestDatabase();
      return { repository: new PostgresRepository(db.pool, new AesGcmCipher(randomBytes(32))), usageMeter: new PostgresUsageMeter(db.pool), db, close: db.drop };
    },
  },
];
