import { afterEach, describe, expect, it } from 'vitest';
import type { Application, Job, SearchSource } from '@opennjob/core';
import { BACKENDS } from './backends';
import { PASSPORT, PROFILE, USER_ID, createTestApp } from './helpers';
import type { TestApp } from './helpers';

/** Where an application found on a job board goes: the employer link the person gives, and the whole advert read before it goes out. On both stores. Fictional. */
for (const backend of BACKENDS) {
  describe.skipIf(backend.skip)(`employer link: ${backend.name}`, () => {
    let t: TestApp;
    let made: Awaited<ReturnType<(typeof backend)['make']>>;
    afterEach(async () => {
      await t?.app.close();
      await made?.close();
    });

    it('stores the link the person gives', async () => {
      made = await backend.make();
      t = await createTestApp({ repository: made.repository, usageMeter: made.usageMeter, persistence: backend.persistence, sources: [] });
      await t.api.put('/profile').send(PROFILE).expect(200);
      await t.api.put('/passport').send(PASSPORT).expect(200);
      const job: Job = { id: 'reed:1', source: 'reed', externalId: '1', title: 'Staff Nurse (fictional)', employer: 'Example Grid (fictional)', location: 'Leeds', country: 'GB', url: 'https://www.reed.co.uk/jobs/staff-nurse/1', applyUrl: 'https://www.reed.co.uk/jobs/staff-nurse/1', description: 'A fictional vacancy.', criteria: [], criteriaSource: 'provided', requiresRegistration: false };
      await t.deps.repository.upsertJobs([job]);
      const app: Application = { id: 'reed-app', userId: USER_ID, jobId: job.id, jobTitle: job.title, employer: job.employer, applyUrl: job.url, mode: 'auto', status: 'draft', statement: 'A fictional statement.', statementSource: 'fallback', gaps: [], warnings: [], score: 100, confirmedFields: [], createdAt: '2026-10-08T06:00:00.000Z' };
      await t.deps.repository.createApplication(app);
      const res = await t.api.post('/applications/reed-app/apply-url').send({ url: 'https://career4.successfactors.com/career?company=example&career_job_req_id=1' });
      expect(res.status).toBe(200);
      expect((await t.deps.repository.getApplication(USER_ID, 'reed-app'))?.applyUrl).toContain('successfactors');
    });

    it('reads the whole advert of an application with no way out yet, a few per run', async () => {
      made = await backend.make();
      const asked: string[] = [];
      const reed: SearchSource = {
        name: 'reed',
        label: 'reed',
        countries: ['GB'],
        search: async () => [],
        details: async (j) => {
          asked.push(j.id);
          if (j.id === 'reed:mail') return { description: 'A fictional vacancy. Medication rounds on a ward. Send your CV to jobs@example.org quoting SN-1.' };
          if (j.id === 'reed:link') return { applyUrl: 'https://example.wd3.myworkdayjobs.com/en-GB/careers/job/Leeds/Nurse_R2' };
          throw new Error('unavailable');
        },
      };
      t = await createTestApp({ repository: made.repository, usageMeter: made.usageMeter, persistence: backend.persistence, sources: [], searchSources: [reed] });
      await t.api.put('/profile').send(PROFILE).expect(200);
      await t.api.put('/passport').send(PASSPORT).expect(200);
      const job = (id: string, employer: string, description = 'A fictional vacancy. Medication rounds on a ward.'): Job => ({ id: `reed:${id}`, source: 'reed', externalId: id, title: 'Staff Nurse (fictional)', employer, location: 'Leeds', country: 'GB', url: `https://www.reed.co.uk/jobs/staff-nurse/${id}`, applyUrl: `https://www.reed.co.uk/jobs/staff-nurse/${id}`, description, criteria: [{ label: 'Medication', essential: true, keywords: ['medication'] }], criteriaSource: 'provided', requiresRegistration: false });
      const jobs = [job('mail', 'Alpha Care (fictional)'), job('link', 'Beta Care (fictional)'), job('down', 'Gamma Care (fictional)'), job('known', 'Delta Care (fictional)', 'A fictional vacancy. Medication rounds. Apply to known@example.org.')];
      await t.deps.repository.upsertJobs(jobs);
      for (const j of jobs) {
        await t.deps.repository.createApplication({ id: `app-${j.externalId}`, userId: USER_ID, jobId: j.id, jobTitle: j.title, employer: j.employer, applyUrl: j.url, mode: 'auto', status: 'draft', statement: 'A fictional statement.', statementSource: 'fallback', gaps: [], warnings: [], score: 100, confirmedFields: [], createdAt: '2026-10-08T06:00:00.000Z' });
      }

      const run = (await t.api.post('/agent/run').send({ mode: 'auto' }).expect(200)).body;
      // The one whose advert already names an address is not asked again; a failed read changes nothing.
      expect(asked.sort()).toEqual(['reed:down', 'reed:link', 'reed:mail']);
      expect(run.advertsRead).toBe(3);
      expect((await t.deps.repository.getJob('reed:mail'))?.description).toContain('jobs@example.org');
      expect((await t.deps.repository.getApplication(USER_ID, 'app-link'))?.applyUrl).toBe('https://example.wd3.myworkdayjobs.com/en-GB/careers/job/Leeds/Nurse_R2');
      expect((await t.deps.repository.getApplication(USER_ID, 'app-down'))?.applyUrl).toBe('https://www.reed.co.uk/jobs/staff-nurse/down');
      expect((await t.api.get('/agent/status').expect(200)).body.routes).toMatchObject({ 'app-mail': 'email', 'app-known': 'email', 'app-link': 'none', 'app-down': 'none' });
    });
  });
}
