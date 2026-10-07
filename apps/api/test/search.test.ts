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
    expect(adzuna.asked).toEqual([{ what: 'site manager', where: 'London', country: 'GB' }, { what: 'site manager', country: 'FR' }]);
    expect(reed.asked).toEqual([{ what: 'site manager', where: 'London', country: 'GB' }]);
    expect(res).toMatchObject({ searches: 3, errors: [] });
    const matches = (await t.api.get('/jobs/matches?min=0').expect(200)).body as { job: { title: string } }[];
    expect(matches.map((m) => m.job.title)).toContain('site manager (fictional)');
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
