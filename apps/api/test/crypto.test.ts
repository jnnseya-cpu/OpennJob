import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Application, Passport, Profile } from '@opennjob/core';
import type { FieldCipher } from '../src/crypto';
import { AesGcmCipher, DecryptionError, ENCRYPTED_PREFIX, PlaintextCipher, cipherFromEnv, parseDataKey } from '../src/crypto';
import { PostgresRepository } from '../src/postgres';
import { userRecord } from './helpers';
import { createTestDatabase, hasPostgres } from './pg-helpers';
import type { TestDatabase } from './pg-helpers';

const KEY = randomBytes(32);
const CV = 'Registered nurse with five years of experience on acute medical wards.\nÉtudes à Kinshasa.';

describe('AES-256-GCM field cipher', () => {
  const cipher = new AesGcmCipher(KEY);

  it('round-trips text of every kind', () => {
    for (const text of ['', 'a', CV, 'é\u{1F642}"\\\n\t', 'x'.repeat(50_000)]) {
      const stored = cipher.encrypt(text, 'profile.cv:u1');
      expect(stored.startsWith(ENCRYPTED_PREFIX)).toBe(true);
      expect(cipher.decrypt(stored, 'profile.cv:u1')).toBe(text);
    }
  });

  it('never stores the plain text, and never produces the same ciphertext twice', () => {
    const one = cipher.encrypt(CV, 'c');
    const two = cipher.encrypt(CV, 'c');
    expect(one).not.toBe(two);
    for (const stored of [one, two]) {
      expect(stored).not.toContain('nurse');
      expect(Buffer.from(stored.slice(ENCRYPTED_PREFIX.length), 'base64').toString('latin1')).not.toContain('Registered nurse');
    }
    // nonce (12) + tag (16) + one byte per byte of plain text
    expect(Buffer.from(one.slice(ENCRYPTED_PREFIX.length), 'base64')).toHaveLength(12 + 16 + Buffer.byteLength(CV));
  });

  it('detects tampering: any changed byte of nonce, tag or ciphertext fails', () => {
    const stored = cipher.encrypt(CV, 'profile.cv:u1');
    const raw = Buffer.from(stored.slice(ENCRYPTED_PREFIX.length), 'base64');
    for (const index of [0, 11, 12, 27, 28, raw.length - 1]) {
      const changed = Buffer.from(raw);
      changed[index] = (changed[index] as number) ^ 0x01;
      expect(() => cipher.decrypt(ENCRYPTED_PREFIX + changed.toString('base64'), 'profile.cv:u1'), `byte ${index}`).toThrow(DecryptionError);
    }
    expect(() => cipher.decrypt(ENCRYPTED_PREFIX + raw.subarray(0, raw.length - 1).toString('base64'), 'profile.cv:u1')).toThrow(DecryptionError);
    expect(() => cipher.decrypt(`${ENCRYPTED_PREFIX}AAAA`, 'profile.cv:u1')).toThrow(/too short/);
    expect(cipher.decrypt(stored, 'profile.cv:u1')).toBe(CV); // the untouched value still reads
  });

  it('binds a value to its place: moved to another user or column, it does not decrypt', () => {
    const stored = cipher.encrypt(CV, 'profile.cv:user-a');
    expect(() => cipher.decrypt(stored, 'profile.cv:user-b')).toThrow(DecryptionError);
    expect(() => cipher.decrypt(stored, 'passport:user-a')).toThrow(DecryptionError);
  });

  it('does not decrypt under another key, and the error says nothing about the content', () => {
    const stored = cipher.encrypt(CV, 'c');
    let message = '';
    try {
      new AesGcmCipher(randomBytes(32)).decrypt(stored, 'c');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/could not be decrypted/);
    expect(message).not.toContain('nurse');
  });

  it('reads a value that was stored before a key was configured', () => {
    expect(cipher.decrypt(CV, 'c')).toBe(CV);
  });

  it('refuses a key that is not 32 bytes', () => {
    expect(() => new AesGcmCipher(randomBytes(16))).toThrow(/32-byte/);
  });
});

describe('OPENNJOB_DATA_KEY', () => {
  it('is optional; when set it must be base64 of exactly 32 bytes', () => {
    expect(parseDataKey(undefined)).toBeUndefined();
    expect(parseDataKey('   ')).toBeUndefined();
    expect(parseDataKey(KEY.toString('base64'))?.equals(KEY)).toBe(true);
    expect(parseDataKey(` ${KEY.toString('base64url')} `)?.equals(KEY)).toBe(true);
    expect(() => parseDataKey(randomBytes(16).toString('base64'))).toThrow(/exactly 32 bytes \(got 16\)/);
    expect(() => parseDataKey(randomBytes(33).toString('base64'))).toThrow(/exactly 32 bytes/);
    expect(() => parseDataKey('not base64 at all!')).toThrow(/must be base64/);
  });

  it('selects the cipher', () => {
    expect(cipherFromEnv(KEY.toString('base64')).enabled).toBe(true);
    const plain = cipherFromEnv('');
    expect(plain.enabled).toBe(false);
    expect(plain.decrypt(plain.encrypt(CV, 'c'), 'c')).toBe(CV);
  });

  it('without a key, an encrypted value is an error, not garbage handed to the user', () => {
    const stored = new AesGcmCipher(KEY).encrypt(CV, 'c');
    const plain: FieldCipher = new PlaintextCipher();
    expect(() => plain.decrypt(stored, 'c')).toThrow(/OPENNJOB_DATA_KEY is not set/);
  });
});

describe.skipIf(!hasPostgres)('encryption at rest in a live PostgreSQL', () => {
  let db: TestDatabase;
  let repo: PostgresRepository;
  const profile: Profile = { firstName: 'Amara', lastName: 'Okafor', email: 'amara.okafor@example.org', phone: '07700 900123', addressLine1: '12 Example Street', city: 'Birmingham', postcode: 'B1 1AA', cvText: CV };
  const passport: Passport = { nmcPin: '18A1234E', credentials: { sc: 'SC, expires 2028-01' }, dbs: { certificateNumber: '001234567890' }, rightToWorkConfirmed: true, training: [{ name: 'Basic life support' }], referees: [{ name: 'Priya Shah', relationship: 'Ward Manager', organisation: 'Northfield General Hospital (example)', email: 'priya.shah@example.org', phone: '07700 900456' }] };
  const application = (id: string, userId: string): Application => ({ id, userId, jobId: 'sample:j1', jobTitle: 'Staff Nurse', employer: 'Example Care Group (fictional)', applyUrl: 'https://example.org/a', mode: 'hybrid', status: 'draft', statement: 'I completed medication rounds for 28 patients.', statementSource: 'fallback', gaps: [], warnings: [], score: 80, confirmedFields: [], createdAt: '2026-10-06T09:00:00.000Z' });

  beforeAll(async () => {
    db = await createTestDatabase();
    repo = new PostgresRepository(db.pool, new AesGcmCipher(KEY));
    for (const id of ['u1', 'u2']) await repo.createUser(userRecord(id, `${id}@example.org`));
    await repo.upsertJobs([{ id: 'sample:j1', source: 'sample', externalId: 'j1', title: 'Staff Nurse', employer: 'Example Care Group (fictional)', location: 'Leeds', url: 'https://example.org/j1', description: 'd', criteria: [], criteriaSource: 'provided', requiresRegistration: false }]);
    for (const id of ['u1', 'u2']) {
      await repo.saveProfile(id, profile);
      await repo.savePassport(id, passport);
      await repo.createApplication(application(`${id}-app`, id));
    }
  });
  afterAll(async () => {
    await db?.drop();
  });

  const raw = async (sql: string): Promise<string> => JSON.stringify((await db.pool.query(sql)).rows);

  it('the rows hold ciphertext: no CV text, passport value or statement can be read from the database', async () => {
    const stored = (await raw('SELECT cv_text FROM profiles')) + (await raw('SELECT data FROM passports')) + (await raw('SELECT statement FROM applications'));
    for (const secret of ['Registered nurse', 'Kinshasa', '18A1234E', 'SC, expires', '001234567890', 'Priya Shah', 'priya.shah@example.org', 'rightToWorkConfirmed', 'Basic life support', 'medication rounds']) {
      expect(stored, secret).not.toContain(secret);
    }
    const values = [
      ...(await db.pool.query('SELECT cv_text AS v FROM profiles')).rows,
      ...(await db.pool.query('SELECT data AS v FROM passports')).rows,
      ...(await db.pool.query('SELECT statement AS v FROM applications')).rows,
    ].map((r) => r.v as string);
    expect(values).toHaveLength(6);
    expect(values.every((v) => v.startsWith(ENCRYPTED_PREFIX))).toBe(true);
    expect(new Set(values).size).toBe(6); // same plain text, different ciphertext every time
  });

  it('the repository reads them back exactly', async () => {
    expect(await repo.getProfile('u1')).toEqual(profile);
    expect(await repo.getPassport('u1')).toEqual(passport);
    expect(await repo.getApplication('u1', 'u1-app')).toEqual(application('u1-app', 'u1'));
  });

  it('a value altered in the database is detected on read', async () => {
    await db.pool.query(`UPDATE applications SET statement = overlay(statement placing (CASE WHEN substr(statement, 40, 1) = 'A' THEN 'B' ELSE 'A' END) from 40 for 1) WHERE id = 'u2-app'`);
    await expect(repo.getApplication('u2', 'u2-app')).rejects.toThrow(DecryptionError);
    await expect(repo.listApplications('u2')).rejects.toThrow(DecryptionError);
    expect((await repo.getApplication('u1', 'u1-app'))?.statement).toBe('I completed medication rounds for 28 patients.');
  });

  it("one user's ciphertext copied into another user's row is detected on read", async () => {
    await db.pool.query("UPDATE profiles SET cv_text = (SELECT cv_text FROM profiles WHERE user_id = 'u1') WHERE user_id = 'u2'");
    await db.pool.query("UPDATE passports SET data = (SELECT data FROM passports WHERE user_id = 'u1') WHERE user_id = 'u2'");
    await expect(repo.getProfile('u2')).rejects.toThrow(DecryptionError);
    await expect(repo.getPassport('u2')).rejects.toThrow(DecryptionError);
  });

  it('the wrong key reads nothing; no key refuses rather than returning ciphertext', async () => {
    await expect(new PostgresRepository(db.pool, new AesGcmCipher(randomBytes(32))).getProfile('u1')).rejects.toThrow(DecryptionError);
    await expect(new PostgresRepository(db.pool).getPassport('u1')).rejects.toThrow(/OPENNJOB_DATA_KEY is not set/);
  });

  it('rows written before the key was set are still readable, and are encrypted on the next save', async () => {
    await repo.createUser(userRecord('u3', 'u3@example.org'));
    await new PostgresRepository(db.pool).saveProfile('u3', profile);
    expect(await raw("SELECT cv_text FROM profiles WHERE user_id = 'u3'")).toContain('Registered nurse');
    expect(await repo.getProfile('u3')).toEqual(profile);
    await repo.saveProfile('u3', profile);
    expect(await raw("SELECT cv_text FROM profiles WHERE user_id = 'u3'")).not.toContain('Registered nurse');
  });
});
