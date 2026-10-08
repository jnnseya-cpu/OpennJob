import { describe, expect, it } from 'vitest';
import { createJoobleSearch, createReliefWebSearch, joobleHost, parseJoobleKeys, recruiterEmailIn } from '../src';
import type { FetchLike } from '../src';

/**
 * ReliefWeb and Jooble, driven by an injected fetch serving the remembered response shape
 * (unverified against the live APIs). No live calls. Fictional employers and adverts.
 */
function fakeFetch(body: unknown) {
  const calls: { url: string; method?: string; body?: unknown }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, ...(init?.method ? { method: init.method } : {}), ...(init?.body ? { body: JSON.parse(init.body) } : {}) });
    return { ok: true, status: 200, json: async () => body };
  };
  return { fetch, calls };
}

describe('reliefweb search', () => {
  const body = {
    data: [
      {
        id: '4100001',
        fields: {
          title: 'Electrical Engineer – Solar Mini-Grids (fictional)',
          body: '<p>Design and commission solar mini-grids in Goma.</p><ul><li>Experience of 33kV networks</li></ul>',
          how_to_apply: '<p>Send your CV to <a href="mailto:jobs@example.org">jobs@example.org</a> quoting EE-01.</p>',
          url: 'https://reliefweb.int/job/4100001/example',
          source: [{ name: 'Example Relief Agency (fictional)' }],
          country: [{ iso3: 'cod', name: 'Democratic Republic of the Congo' }],
          city: [{ name: 'Goma' }],
          date: { created: '2026-10-05T08:00:00+00:00' },
        },
      },
      { id: '4100002', fields: {} },
    ],
  };

  it('asks for the title in the country (ISO3) with the approved appname, and keeps how to apply', async () => {
    const { fetch, calls } = fakeFetch(body);
    const jobs = await createReliefWebSearch({ appName: 'opennjob-test', fetch }).search({ what: 'electrical engineer', country: 'CD' });
    expect(calls[0]).toMatchObject({ url: 'https://api.reliefweb.int/v2/jobs?appname=opennjob-test', method: 'POST' });
    expect(calls[0]?.body).toMatchObject({ query: { value: 'electrical engineer', fields: ['title'] }, filter: { field: 'country.iso3', value: 'COD' } });
    expect(jobs).toHaveLength(1); // the empty row is skipped
    expect(jobs[0]).toMatchObject({ id: 'reliefweb:4100001', source: 'reliefweb', employer: 'Example Relief Agency (fictional)', country: 'CD', city: 'Goma', url: 'https://reliefweb.int/job/4100001/example' });
    expect(jobs[0]?.description).toContain('Experience of 33kV networks');
    expect(recruiterEmailIn(jobs[0]?.description ?? '')).toBe('jobs@example.org'); // the e-mail route can use it
  });

  it('asks nothing for a country it has no code for', async () => {
    const { fetch, calls } = fakeFetch(body);
    expect(await createReliefWebSearch({ appName: 'x', fetch }).search({ what: 'electrical engineer', country: 'ZZ' })).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe('jooble search', () => {
  it('sends each country to its own Jooble site with that country\'s key', async () => {
    const { fetch, calls } = fakeFetch({
      totalCount: 1,
      jobs: [{ id: 778899, title: 'Electrical Engineer <b>HV</b> (fictional)', location: 'Abu Dhabi', snippet: 'Substation commissioning, 132kV.', type: 'Full-time', link: 'https://example.org/jooble/778899', company: 'Example Grid Contracting (fictional)', updated: '2026-10-04T00:00:00.0000000' }],
    });
    const source = createJoobleSearch({ keys: parseJoobleKeys('AE:ae-key-not-a-secret, gb:uk-key-not-a-secret'), fetch });
    expect(source.countries).toEqual(['AE', 'GB']);
    const jobs = await source.search({ what: 'electrical engineer', where: 'Abu Dhabi', country: 'AE' });
    expect(calls[0]).toMatchObject({ url: 'https://ae.jooble.org/api/ae-key-not-a-secret', method: 'POST', body: { keywords: 'electrical engineer', location: 'Abu Dhabi' } });
    expect(jobs[0]).toMatchObject({ id: 'jooble:778899', source: 'jooble', title: 'Electrical Engineer HV (fictional)', employer: 'Example Grid Contracting (fictional)', country: 'AE', url: 'https://example.org/jooble/778899' });
    await source.search({ what: 'electrical engineer', country: 'GB' });
    expect(calls[1]?.url).toBe('https://uk.jooble.org/api/uk-key-not-a-secret'); // the UK site is uk., not gb.
    // No key for a country: nothing is asked.
    expect(await source.search({ what: 'electrical engineer', country: 'SA' })).toEqual([]);
    expect(calls).toHaveLength(2);
  });

  it('the USA is jooble.org itself; malformed key entries are ignored', () => {
    expect(joobleHost('US')).toBe('jooble.org');
    expect(joobleHost('ae')).toBe('ae.jooble.org');
    expect(parseJoobleKeys('AE:k1,,bad,USA:k2, sa : k3')).toEqual({ AE: 'k1', SA: 'k3' });
    expect(parseJoobleKeys(undefined)).toEqual({});
  });
});

describe('why a link cannot be used by the queue', () => {
  it('job boards, aggregators, known systems and unknown sites', async () => {
    const { noRouteReason, isEmployerLink } = await import('../src');
    expect(noRouteReason('https://www.reed.co.uk/jobs/x/1')).toBe('job-board');
    expect(noRouteReason('https://uk.indeed.com/viewjob?jk=1')).toBe('job-board');
    expect(noRouteReason('https://www.adzuna.co.uk/jobs/land/ad/1')).toBe('aggregator');
    expect(noRouteReason('https://career4.successfactors.com/portalcareer?x=1')).toBe('system-off:successfactors');
    expect(noRouteReason('https://jobs.example.org/job/1', { successfactors: ['jobs.example.org'] })).toBe('system-off:successfactors');
    expect(noRouteReason('https://careers.example.org/apply')).toBe('unknown-site');
    expect(isEmployerLink('https://example.wd3.myworkdayjobs.com/job/1')).toBe(true);
    expect(isEmployerLink('https://www.linkedin.com/jobs/view/1')).toBe(false);
  });
});

describe('duplicates: the copy that can go out on its own is kept', () => {
  it('prefers a later copy with a recruiter address or an employer link, in the first copy\'s place', async () => {
    const { dedupeJobs, hasWayOut } = await import('../src');
    const base = { title: 'Planner (fictional)', employer: 'Example Build Ltd (fictional)', location: 'Leeds', country: 'GB', criteria: [], criteriaSource: 'fallback' as const, requiresRegistration: false };
    const adzuna = { ...base, id: 'adzuna:1', source: 'adzuna' as const, externalId: '1', url: 'https://www.adzuna.co.uk/jobs/land/ad/1', description: 'A fictional snippet.' };
    const reed = { ...base, id: 'reed:1', source: 'reed' as const, externalId: '1', url: 'https://www.reed.co.uk/jobs/planner/1', description: 'A fictional advert. Send your CV to jobs@example.org.' };
    const other = { ...base, title: 'Estimator (fictional)', id: 'adzuna:2', source: 'adzuna' as const, externalId: '2', url: 'https://www.adzuna.co.uk/jobs/land/ad/2', description: 'A fictional snippet.' };
    expect(hasWayOut(adzuna)).toBe(false);
    expect(hasWayOut(reed)).toBe(true);
    expect(hasWayOut({ ...adzuna, applyUrl: 'https://example.wd3.myworkdayjobs.com/job/1' })).toBe(true);
    expect(hasWayOut({ ...adzuna, url: 'https://reliefweb.int/job/1' })).toBe(false); // an advert page, not the employer's
    const r = dedupeJobs([adzuna, other, reed]);
    expect(r.jobs.map((j) => j.id)).toEqual(['reed:1', 'adzuna:2']);
    expect(r.duplicates.map((j) => j.id)).toEqual(['adzuna:1']);
    // Neither has a way out: the first stays.
    expect(dedupeJobs([adzuna, { ...reed, description: 'A fictional advert.' }]).jobs.map((j) => j.id)).toEqual(['adzuna:1']);
  });
});
