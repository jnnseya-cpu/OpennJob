import { afterEach, describe, expect, it } from 'vitest';
import { SYSTEM_USER_ID } from '@opennjob/core';
import type { Job, SearchQuery, SearchSource } from '@opennjob/core';
import { OpennJobService } from '../src/services';
import { PROFILE, USER_ID, createTestApp } from './helpers';
import type { TestApp } from './helpers';

/**
 * Adzuna and Reed are asked what each person's CV and preferences say: no server keyword or
 * location. A fake search API records every search it is asked. Every person here is fictional.
 */
let t: TestApp;
afterEach(async () => {
  await t?.app.close();
});

function recordingSource(label: string, countries?: string[]): SearchSource & { asked: SearchQuery[] } {
  const asked: SearchQuery[] = [];
  return {
    name: 'adzuna',
    label,
    ...(countries ? { countries } : {}),
    asked,
    async search(q) {
      asked.push(q);
      const job: Job = {
        id: `adzuna:${q.what}-${q.country}`.replace(/\s+/g, '-'),
        source: 'adzuna',
        externalId: `${q.what}-${q.country}`,
        title: `${q.what} (fictional)`,
        employer: 'Example Build Ltd (fictional)',
        location: q.where ?? q.country,
        url: 'https://example.org/job',
        description: `A fictional ${q.what} vacancy.`,
        criteria: [{ label: q.what, essential: true, keywords: [q.what] }],
        criteriaSource: 'provided',
        requiresRegistration: false,
        country: q.country,
      };
      return [job];
    },
  };
}

const SITE_MANAGER = { ...PROFILE, city: 'Leeds', cvText: 'Site Manager (fictional)\nSite manager for Example Homes on a 120-home scheme.\nSMSTS and CSCS Black Card.' };

describe('companies the person asked to search for', () => {
  it('each company is searched by name once per country, and its jobs are marked on Matches', async () => {
    const adzuna = recordingSource('adzuna', ['GB']);
    t = await createTestApp({ sources: [], searchSources: [adzuna] });
    const preferences = { languages: [], countries: ['GB'], cities: ['London'], targetEmployers: ['Northgrid Power (fictional)', ' northgrid power (fictional) ', 'Example Build'] };
    await t.api.put('/profile').send({ ...SITE_MANAGER, preferences }).expect(200);
    const saved = (await t.api.get('/profile').expect(200)).body;
    expect(saved.preferences.targetEmployers).toEqual(['Northgrid Power (fictional)', 'northgrid power (fictional)', 'Example Build']); // trimmed; the plan folds case
    const plan = (await t.api.get('/jobs/search-plan').expect(200)).body;
    expect(plan.employers).toEqual(['Northgrid Power (fictional)', 'Example Build']);
    await t.api.post('/jobs/refresh').expect(200);
    expect(adzuna.asked).toEqual([
      { what: 'site manager', where: 'London', country: 'GB' },
      { what: 'Northgrid Power (fictional)', country: 'GB' },
      { what: 'Example Build', country: 'GB' },
    ]);
    const matches = (await t.api.get('/jobs/matches?min=0').expect(200)).body as { job: { title: string }; targetEmployer?: { name: string; how: string } }[];
    // The fake source's adverts all come from "Example Build Ltd (fictional)".
    expect(matches.every((m) => m.targetEmployer?.name === 'Example Build' && m.targetEmployer.how === 'employer')).toBe(true);
  });

  it('rejects too many companies or an over-long name', async () => {
    t = await createTestApp({ sources: [] });
    const send = (targetEmployers: string[]) => t.api.put('/profile').send({ ...SITE_MANAGER, preferences: { languages: [], countries: [], cities: [], targetEmployers } });
    await send(Array.from({ length: 61 }, (_, i) => `Company ${i}`)).expect(400);
    await send(['x'.repeat(81)]).expect(400);
    await send(Array.from({ length: 60 }, (_, i) => `Company ${i}`)).expect(200);
  });
});

describe('job search from the CV (no server keywords)', () => {
  it("a person's refresh asks for the titles in their CV, in their places; Reed only for the UK", async () => {
    const adzuna = recordingSource('adzuna', ['GB', 'FR']);
    const reed = recordingSource('reed', ['GB']);
    t = await createTestApp({ sources: [], searchSources: [adzuna, reed] });
    await t.api.put('/profile').send({ ...SITE_MANAGER, preferences: { languages: [], countries: ['GB', 'FR'], cities: ['London'] } }).expect(200);
    const plan = (await t.api.get('/jobs/search-plan').expect(200)).body;
    expect(plan).toMatchObject({ hasProfile: true, titles: ['site manager'], places: [{ where: 'London', country: 'GB' }, { country: 'FR' }] });
    expect(plan.searchSources.map((s: { label: string }) => s.label)).toEqual(['adzuna', 'reed']);

    const res = (await t.api.post('/jobs/refresh').expect(200)).body;
    // In France the French title is asked too.
    expect(adzuna.asked).toEqual([{ what: 'site manager', where: 'London', country: 'GB' }, { what: 'site manager', country: 'FR' }, { what: 'conducteur de travaux', country: 'FR' }]);
    expect(reed.asked).toEqual([{ what: 'site manager', where: 'London', country: 'GB' }]);
    expect(res).toMatchObject({ searches: 4, errors: [] });
    expect(plan.coverage).toEqual([
      { country: 'GB', searches: 1, sources: ['adzuna', 'reed'] },
      { country: 'FR', searches: 2, sources: ['adzuna'] },
    ]);
    expect(plan.warnings).toEqual([]);
    const matches = (await t.api.get('/jobs/matches?min=0').expect(200)).body as { job: { title: string } }[];
    expect(matches.map((m) => m.job.title)).toContain('site manager (fictional)');
  });

  it('the plan names countries no source covers, and settings that hide jobs abroad', async () => {
    t = await createTestApp({ sources: [], searchSources: [recordingSource('adzuna', ['GB', 'FR']), recordingSource('reed', ['GB'])] });
    await t.api.put('/profile').send({ ...SITE_MANAGER, preferences: { languages: ['English'], countries: ['GB', 'FR', 'IE'], cities: [], searchTypes: ['uk-permanent'] } }).expect(200);
    const plan = (await t.api.get('/jobs/search-plan').expect(200)).body;
    expect(plan.coverage.find((c: { country: string }) => c.country === 'IE')).toEqual({ country: 'IE', searches: 1, sources: [] });
    expect(plan.warnings).toEqual(['search-types-uk-only', 'french-not-selected']);
  });

  it('a CV with no recognisable job title makes no search and says so in the plan', async () => {
    const adzuna = recordingSource('adzuna');
    t = await createTestApp({ sources: [], searchSources: [adzuna] });
    await t.api.put('/profile').send({ ...PROFILE, cvText: 'I enjoy hiking and chess, and I am reliable.' }).expect(200);
    expect((await t.api.get('/jobs/search-plan').expect(200)).body).toMatchObject({ titles: [], queries: [] });
    expect((await t.api.post('/jobs/refresh').expect(200)).body).toMatchObject({ searches: 0 });
    expect(adzuna.asked).toEqual([]);
  });

  it('the daily run searches for everyone, asking a search shared by two people once, within the cap', async () => {
    const adzuna = recordingSource('adzuna');
    t = await createTestApp({ sources: [], searchSources: [adzuna] });
    await t.api.put('/profile').send(SITE_MANAGER).expect(200);
    const other = await t.addUser('user-two');
    await other.put('/profile').send({ ...SITE_MANAGER, firstName: 'Ama', email: 'ama@example.org' }).expect(200);
    const third = await t.addUser('user-three');
    await third.put('/profile').send({ ...PROFILE, cvText: 'Registered nurse on an acute ward.' }).expect(200);
    await t.app.get(OpennJobService).refreshJobs(SYSTEM_USER_ID);
    expect(adzuna.asked).toEqual([{ what: 'site manager', country: 'GB' }, { what: 'registered nurse', country: 'GB' }]);

    t.deps.config.searchMaxQueriesPerRefresh = 1;
    adzuna.asked.length = 0;
    await t.app.get(OpennJobService).refreshJobs(SYSTEM_USER_ID);
    expect(adzuna.asked).toHaveLength(1);
    const events = await t.deps.repository.listEvents(SYSTEM_USER_ID);
    expect(JSON.stringify(events)).not.toContain('site manager'); // events carry counts, not search terms
    expect(USER_ID).toBe('dev-user');
  });
});

describe('"Look for jobs now" never hangs', () => {
  it('answers that the search carries on when it takes longer than the wait, and a second press joins it', async () => {
    let open: () => void = () => undefined;
    const gate = new Promise<void>((r) => (open = r));
    let calls = 0;
    const slow: SearchSource = {
      name: 'reed',
      label: 'reed',
      countries: ['GB'],
      search: async () => {
        calls += 1;
        await gate;
        return [];
      },
    };
    const t = await createTestApp({ sources: [], searchSources: [slow] });
    try {
      await t.api.put('/profile').send({ ...PROFILE, preferences: { languages: [], countries: ['GB'], cities: [] } }).expect(200);
      const service = t.app.get(OpennJobService);
      expect(await service.refreshJobsNow(USER_ID, 20)).toEqual({ running: true });
      const asked = calls;
      expect(asked).toBeGreaterThan(0);
      expect(await service.refreshJobsNow(USER_ID, 20)).toEqual({ running: true });
      open();
      expect(await service.refreshJobsNow(USER_ID, 5_000)).toMatchObject({ running: false, new: 0 });
      // The later presses joined the first search: no search was asked twice while it ran.
      expect(calls).toBe(asked);
    } finally {
      await t.app.close();
    }
  });
});

describe('sources are asked a few at a time', () => {
  it('keeps their order whatever answers first, and one failure does not stop the rest', async () => {
    const { collectJobs } = await import('@opennjob/core');
    const job = (id: string): Job => ({ id: `employer:${id}`, source: 'employer', externalId: id, title: `Planner ${id} (fictional)`, employer: `Example ${id} Ltd (fictional)`, location: 'Leeds', url: `https://example.org/${id}`, description: 'A fictional vacancy.', criteria: [], criteriaSource: 'provided', requiresRegistration: false, origin: 'employer' });
    let inFlight = 0;
    let most = 0;
    const source = (id: string, ms: number, fail = false) => ({
      label: id,
      fetchJobs: async () => {
        inFlight += 1;
        most = Math.max(most, inFlight);
        await new Promise((r) => setTimeout(r, ms));
        inFlight -= 1;
        if (fail) throw new Error('did not answer');
        return [job(id)];
      },
    });
    const r = await collectJobs([source('a', 30), source('b', 5), source('c', 1, true), source('d', 10), source('e', 1), source('f', 1)], 3);
    expect(r.jobs.map((j) => j.externalId)).toEqual(['a', 'b', 'd', 'e', 'f']);
    expect(r.errors).toEqual([{ source: 'c', message: 'did not answer' }]);
    expect(most).toBe(3);
  });
});
