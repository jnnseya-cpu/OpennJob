import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSampleSource } from '@opennjob/core';
import type { Application } from '@opennjob/core';
import { BACKENDS } from './backends';
import { CV_TEXT, NOW, PASSPORT, PROFILE, USER_EMAIL, USER_ID, USER_PASSWORD, createTestApp, scriptedLlm } from './helpers';
import type { TestApp } from './helpers';

/** GET /account/export and DELETE /account, on both stores. All people here are fictional. */
for (const backend of BACKENDS) {
  describe.skipIf(backend.skip)(`account export and deletion: ${backend.name}`, () => {
    let t: TestApp;
    let made: Awaited<ReturnType<(typeof backend)['make']>>;
    let applications: Application[];

    beforeEach(async () => {
      made = await backend.make();
      t = await createTestApp({ repository: made.repository, usageMeter: made.usageMeter, persistence: backend.persistence, llm: scriptedLlm(), sources: [createSampleSource()] });
      await t.api.put('/profile').send({ ...PROFILE, preferences: { languages: ['English'], countries: ['GB'], cities: [] } }).expect(200);
      await t.api.put('/passport').send(PASSPORT).expect(200);
      await t.api.post('/jobs/refresh').expect(200);
      const first = (await t.api.post('/applications').send({ jobId: 'sample:staff-nurse-medical', mode: 'hybrid' }).expect(201)).body as Application;
      await t.api.post(`/applications/${first.id}/confirm`).send({ confirmedFields: ['nmcPin'] }).expect(200);
      await t.api.post('/applications').send({ jobId: 'sample:hca-elderly-care', mode: 'review' }).expect(201);
      applications = (await t.api.get('/applications').expect(200)).body;
    });
    afterEach(async () => {
      await t?.app.close();
      await made?.close();
    });

    it('GET /account/export returns everything held about the account, as JSON, and never the password hash', async () => {
      const res = await t.api.get('/account/export').expect(200);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      const body = res.body;
      expect(Object.keys(body).sort()).toEqual(['applications', 'events', 'exportedAt', 'notificationDeliveries', 'notificationPreferences', 'notifications', 'passport', 'profile', 'usage', 'user']);
      expect(body.exportedAt).toBe(NOW);
      expect(body.user).toEqual({ id: USER_ID, email: USER_EMAIL, createdAt: NOW, emailVerified: true, emailVerifiedAt: NOW, consent: { acceptedTermsVersion: 'terms-test-1', acceptedPrivacyVersion: 'privacy-test-1', acceptedAt: NOW } });
      expect(body.profile).toEqual({ ...PROFILE, preferences: { languages: ['English'], countries: ['GB'], cities: [] } });
      expect(body.profile.cvText).toBe(CV_TEXT);
      expect(body.passport).toEqual(PASSPORT);
      expect(body.applications).toHaveLength(2);
      expect([...body.applications].sort((x: Application, y: Application) => x.id.localeCompare(y.id))).toEqual([...applications].sort((x, y) => x.id.localeCompare(y.id)));
      expect(body.applications.find((a: Application) => a.status === 'confirmed')).toMatchObject({ confirmedFields: ['nmcPin'], statement: expect.stringContaining('registered nurse') });
      expect(body.events.map((e: { type: string }) => e.type)).toEqual(['profile.updated', 'passport.updated', 'jobs.refreshed', 'application.drafted', 'application.confirmed', 'application.drafted']);
      expect(body.usage).toHaveLength(4); // one call drafts the statement, one rewrites the CV for the advert, for each of the two applications
      expect(body.usage.every((u: { userId: string; purpose: string }) => u.userId === USER_ID && ['supporting-statement', 'cv-tailoring'].includes(u.purpose))).toBe(true);
      expect(JSON.stringify(body)).not.toMatch(/passwordHash|password_hash|\$2b\$/);
    });

    it('the export survives a round trip through JSON unchanged (it is plain data)', async () => {
      const body = (await t.api.get('/account/export').expect(200)).body;
      expect(JSON.parse(JSON.stringify(body))).toEqual(body);
    });

    it('DELETE /account needs the password, then removes every trace of the user', async () => {
      await t.api.delete('/account').expect(400);
      await t.api.delete('/account').send({}).expect(400);
      await t.api.delete('/account').send({ password: 'the wrong passphrase' }).expect(401);
      expect(await t.deps.repository.getUserById(USER_ID)).toBeDefined();
      expect((await t.api.get('/applications').expect(200)).body).toHaveLength(2);

      await t.api.delete('/account').send({ password: USER_PASSWORD }).expect(200, { deleted: true });

      const repo = t.deps.repository;
      expect(await repo.getUserById(USER_ID)).toBeUndefined();
      expect(await repo.getUserByEmail(USER_EMAIL)).toBeUndefined();
      expect(await repo.getProfile(USER_ID)).toBeUndefined();
      expect(await repo.getPassport(USER_ID)).toBeUndefined();
      expect(await repo.listApplications(USER_ID)).toEqual([]);
      for (const a of applications) expect(await repo.getApplication(USER_ID, a.id)).toBeUndefined();
      expect(await repo.listEvents(USER_ID)).toEqual([]);
      expect(await t.deps.usageMeter.list(USER_ID)).toEqual([]);
      expect(await t.deps.usageMeter.totals(USER_ID)).toEqual({ calls: 0, inputTokens: 0, outputTokens: 0, acu: 0 });
      // The shared job catalogue is not personal data and stays.
      expect((await repo.listJobs()).length).toBeGreaterThan(0);

      // The deletion itself is logged against no account, with nothing that identifies who it was.
      const system = (await repo.listEvents('system')).filter((e) => e.type === 'account.deleted');
      expect(system).toHaveLength(1);
      expect(system[0]?.payload).toEqual({});
      expect(JSON.stringify(system)).not.toContain(USER_ID);
    });

    it('after deletion the old token is refused on every route, the password no longer signs in, and the email is free again', async () => {
      await t.api.delete('/account').send({ password: USER_PASSWORD }).expect(200);
      for (const path of ['/profile', '/passport', '/applications', `/applications/${applications[0]?.id}`, '/usage', '/account', '/account/export', '/jobs/matches']) await t.api.get(path).expect(401);
      await t.api.put('/profile').send(PROFILE).expect(401);
      await t.api.delete('/account').send({ password: USER_PASSWORD }).expect(401);
      await t.raw().post('/auth/login').send({ email: USER_EMAIL, password: USER_PASSWORD }).expect(401);
      expect(await t.deps.repository.getProfile(USER_ID)).toBeUndefined(); // the refused PUT stored nothing

      const again = await t.raw().post('/auth/register').send({ email: USER_EMAIL, password: USER_PASSWORD, acceptedTermsVersion: 'terms-test-1', acceptedPrivacyVersion: 'privacy-test-1' }).expect(201);
      expect(again.body.user.id).not.toBe(USER_ID);
      const fresh = t.as(again.body.accessToken);
      await fresh.get('/profile').expect(404);
      expect((await fresh.get('/applications').expect(200)).body).toEqual([]);
      expect((await fresh.get('/account/export').expect(200)).body).toMatchObject({ profile: null, passport: null, applications: [], usage: [] });
    });

    // Defined only for the PostgreSQL store: it reads the tables directly.
    if (backend.persistence === 'postgres') it('in PostgreSQL no row that refers to the user is left in any table', async () => {
      const pool = made.db?.pool;
      if (!pool) throw new Error('no database');
      const count = async (table: string, column: string): Promise<number> => Number((await pool.query(`SELECT count(*) AS n FROM ${table} WHERE ${column} = $1`, [USER_ID])).rows[0]?.n);
      const tables: [string, string][] = [['users', 'id'], ['profiles', 'user_id'], ['passports', 'user_id'], ['applications', 'user_id'], ['events', 'user_id'], ['usage_records', 'user_id']];
      const before = Object.fromEntries(await Promise.all(tables.map(async ([table, column]) => [table, await count(table, column)])));
      expect(before).toEqual({ users: 1, profiles: 1, passports: 1, applications: 2, events: 6, usage_records: 4 }); // a statement and a CV rewrite per application
      await t.api.delete('/account').send({ password: USER_PASSWORD }).expect(200);
      for (const [table, column] of tables) expect(await count(table, column), table).toBe(0);
      // Nothing anywhere in the database still mentions the id (jobs and the system event included).
      const everything = JSON.stringify(await Promise.all(['users', 'profiles', 'passports', 'applications', 'events', 'usage_records', 'jobs', 'notifications', 'notification_deliveries', 'notification_preferences', 'auth_tokens', 'screening_answers', 'standing_authorisations'].map(async (table) => (await pool.query(`SELECT * FROM ${table}`)).rows)));
      expect(everything).not.toContain(USER_ID);
      expect(everything).not.toContain(USER_EMAIL);
    });
  });
}
