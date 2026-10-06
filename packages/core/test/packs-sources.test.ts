import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ADZUNA_COUNTRIES_UNVERIFIED, PACK_IDS, createAdzunaSource, createReedSource, createSampleSource, inScope, normaliseJob, regionOf } from '../src';
import type { FetchLike, RawJob } from '../src';

const fixture = (name: string): unknown => JSON.parse(readFileSync(path.join(__dirname, 'fixtures/sources', name), 'utf8'));
const fakeFetch = (body: unknown) => {
  const calls: string[] = [];
  const fetch: FetchLike = async (url) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => body };
  };
  return { fetch, calls };
};

describe('adzuna adapter: country', () => {
  it.each(['gb', 'us', 'fr', 'de', 'za'])('puts %s in the URL path and on every job', async (country) => {
    const { fetch, calls } = fakeFetch(fixture('adzuna.json'));
    const source = createAdzunaSource({ appId: 'a', appKey: 'b', country, what: 'construction manager', fetch });
    const jobs = await source.fetchJobs();
    expect(new URL(calls[0] as string).pathname).toBe(`/v1/api/jobs/${country}/search/1`);
    expect(jobs).toHaveLength(2);
    for (const job of jobs) {
      expect(job.country).toBe(country.toUpperCase());
      expect(job.region).toBe(regionOf(country));
      expect(job.origin).toBe('discovered');
    }
    expect(source.label).toBe(country === 'gb' ? 'adzuna' : `adzuna:${country}`);
  });

  it('defaults to gb and accepts any case', async () => {
    const { fetch, calls } = fakeFetch({ results: [] });
    await createAdzunaSource({ appId: 'a', appKey: 'b', what: 'nurse', fetch }).fetchJobs();
    await createAdzunaSource({ appId: 'a', appKey: 'b', country: ' FR ', what: 'nurse', fetch }).fetchJobs();
    expect(calls.map((u) => new URL(u).pathname)).toEqual(['/v1/api/jobs/gb/search/1', '/v1/api/jobs/fr/search/1']);
  });

  it('refuses something that is not a two-letter code, before any request is made', () => {
    const { fetch, calls } = fakeFetch({ results: [] });
    for (const country of ['gbr', 'g', '', 'g/b', '../x', 'g b']) {
      expect(() => createAdzunaSource({ appId: 'a', appKey: 'b', country, what: 'nurse', fetch }), country).toThrow(/not a two-letter country code/);
    }
    expect(calls).toEqual([]);
  });

  it('carries a remembered, unverified country list and does not enforce it', () => {
    expect(ADZUNA_COUNTRIES_UNVERIFIED).toEqual(expect.arrayContaining(['gb', 'us', 'fr', 'de', 'za']));
    for (const c of ADZUNA_COUNTRIES_UNVERIFIED) expect(c).toMatch(/^[a-z]{2}$/);
    // A two-letter code missing from the remembered list is still accepted: the list is not trusted enough to refuse on.
    expect(ADZUNA_COUNTRIES_UNVERIFIED).not.toContain('ie');
    expect(() => createAdzunaSource({ appId: 'a', appKey: 'b', country: 'ie', what: 'nurse', fetch: fakeFetch({}).fetch })).not.toThrow();
  });
});

describe('normaliseJob: pack, place, language and origin', () => {
  const raw = (over: Partial<RawJob> = {}): RawJob => ({
    source: 'greenhouse', externalId: '1', title: 'Senior Construction Manager - Hyperscale Data Centre', employer: 'Northgate Digital Infrastructure (example)',
    location: 'Slough', url: 'https://example.org/jobs/1', description: 'Essential\n- Data centre delivery.\n- MEP coordination.', ...over,
  });

  it('fills in country, city, region, language, pack and origin for a discovered job', () => {
    expect(normaliseJob(raw())).toMatchObject({ country: 'GB', city: 'Slough', region: 'uk', language: 'en', pack: 'dc', origin: 'discovered', requiresRegistration: false });
  });

  it('derives the region from the country, and leaves both out when the country is unknown', () => {
    expect(normaliseJob(raw({ location: 'Kinshasa' }))).toMatchObject({ country: 'CD', region: 'africa', pack: 'fr' });
    expect(normaliseJob(raw({ location: 'Somewhere', country: 'qa' }))).toMatchObject({ country: 'QA', region: 'mena' });
    const unknown = normaliseJob(raw({ location: 'Remote' }));
    expect(unknown?.country).toBeUndefined();
    expect(unknown?.region).toBeUndefined();
    expect(unknown?.city).toBeUndefined();
    // An invalid code from a source is ignored, not stored.
    expect(normaliseJob(raw({ location: 'Remote', country: 'XX' }))?.country).toBeUndefined();
  });

  it('detects a French advert, and what the source states wins over what is guessed', () => {
    const french = raw({ title: 'Responsable BIM - Ligne à grande vitesse', location: 'Lyon', description: 'Nous recrutons pour le poste de responsable BIM au sein de notre équipe.\nProfil recherché\n- Maîtrise du BIM.' });
    expect(normaliseJob(french)).toMatchObject({ language: 'fr', country: 'FR', city: 'Lyon', region: 'eu', pack: 'rail' });
    expect(normaliseJob({ ...french, language: 'en', pack: 'con' })).toMatchObject({ language: 'en', pack: 'con' });
  });

  it('leaves the pack out for a job that fits none', () => {
    const job = normaliseJob(raw({ title: 'Accountant', description: 'Month-end close.' }));
    expect(job).toBeDefined();
    expect(job?.pack).toBeUndefined();
  });

  it('requiredCredential: detected from the wording or supplied; "pin" keeps requiresRegistration true', () => {
    expect(normaliseJob(raw({ description: 'Essential\n- You must be SC cleared.' }))).toMatchObject({ requiredCredential: 'sc', requiresRegistration: false });
    expect(normaliseJob(raw({ requiredCredential: 'pin' }))).toMatchObject({ requiredCredential: 'pin', requiresRegistration: true });
    expect(normaliseJob(raw({ title: 'Staff Nurse', description: 'Current NMC registration required.' }))).toMatchObject({ requiredCredential: 'pin', requiresRegistration: true, pack: 'hc' });
    expect(normaliseJob(raw())?.requiredCredential).toBeUndefined();
  });

  it('an employer posting has the same shape as a discovered job, apart from its origin', () => {
    const discovered = normaliseJob(raw());
    const posted = normaliseJob(raw({ source: 'employer', origin: 'employer' }));
    expect(posted?.origin).toBe('employer');
    expect(Object.keys(posted ?? {}).sort()).toEqual(Object.keys(discovered ?? {}).sort());
    const { id: _a, source: _b, origin: _c, ...restPosted } = posted ?? ({} as never);
    const { id: _d, source: _e, origin: _f, ...restDiscovered } = discovered ?? ({} as never);
    expect(restPosted).toEqual(restDiscovered);
  });

  it('Reed jobs are marked GB', async () => {
    const jobs = await createReedSource({ apiKey: 'k', keywords: 'nurse', fetch: fakeFetch(fixture('reed.json')).fetch }).fetchJobs();
    expect(jobs.length).toBeGreaterThan(0);
    for (const job of jobs) expect(job).toMatchObject({ country: 'GB', region: 'uk', origin: 'discovered' });
  });
});

describe('demo jobs for every pack', () => {
  it('without allPacks, returns the three v1 healthcare jobs as before, now with pack and place', async () => {
    const jobs = await createSampleSource().fetchJobs();
    expect(jobs.map((j) => j.id)).toEqual(['sample:staff-nurse-medical', 'sample:hca-elderly-care', 'sample:support-worker-ld']);
    for (const job of jobs) expect(job).toMatchObject({ pack: 'hc', country: 'GB', region: 'uk', language: 'en', origin: 'discovered', criteriaSource: 'fallback' });
  });

  it('with allPacks, has a few fictional jobs per pack across several countries and regions', async () => {
    const jobs = await createSampleSource({ allPacks: true }).fetchJobs();
    expect(new Set(jobs.map((j) => j.id)).size).toBe(jobs.length);
    for (const pack of PACK_IDS) expect(jobs.filter((j) => j.pack === pack).length, pack).toBeGreaterThanOrEqual(3);
    expect(new Set(jobs.map((j) => j.country)).size).toBeGreaterThanOrEqual(10);
    expect([...new Set(jobs.map((j) => j.region))].sort()).toEqual(['africa', 'am', 'eu', 'mena', 'uk']);
    for (const job of jobs) {
      expect(job.employer, job.id).toMatch(/\(example\)$/);
      expect(job.url, job.id).toMatch(/^https:\/\/example\.org\//);
      if (job.criteriaSource === 'provided') expect(job.description, job.id).toMatch(/fictional employer|employeur fictif/);
      expect(job.origin, job.id).toBe('discovered');
      expect(job.country, job.id).toMatch(/^[A-Z]{2}$/);
      expect(job.region, job.id).toBe(regionOf(job.country));
      expect(job.city, job.id).toBeTruthy();
      expect(job.criteria.length, job.id).toBeGreaterThanOrEqual(3);
      expect(['en', 'fr'], job.id).toContain(job.language);
    }
  });

  it('follows the demo: ids, packs, places, French jobs and required credentials', async () => {
    const jobs = await createSampleSource({ allPacks: true }).fetchJobs();
    const byId = Object.fromEntries(jobs.map((j) => [j.externalId, j]));
    expect(byId.c1).toMatchObject({ pack: 'con', title: 'Senior Construction Manager - Hospital New Build', city: 'Birmingham', country: 'GB', criteriaSource: 'provided' });
    expect(byId.c3).toMatchObject({ pack: 'con', requiredCredential: 'sc', requiresRegistration: false });
    expect(byId.e5).toMatchObject({ pack: 'en', requiredCredential: 'sc' });
    expect(byId.d2).toMatchObject({ pack: 'dc', city: 'Frankfurt', country: 'DE', region: 'eu' });
    expect(byId.r4).toMatchObject({ pack: 'rail', language: 'fr', country: 'FR' });
    expect(byId.f1).toMatchObject({ pack: 'fr', language: 'fr', city: 'Kinshasa', country: 'CD', region: 'africa' });
    expect(byId.f5).toMatchObject({ pack: 'fr', language: 'en', country: 'CI' });
    expect(byId.h7).toMatchObject({ pack: 'hc', country: 'IE', requiredCredential: 'pin', requiresRegistration: true });
    expect(jobs.filter((j) => j.language === 'fr').map((j) => j.externalId).sort()).toEqual(['f1', 'f2', 'f3', 'f4', 'r4']);
    expect(jobs.filter((j) => j.requiredCredential === 'sc').map((j) => j.externalId).sort()).toEqual(['c3', 'e5']);
    expect(byId.c1?.criteria[0]).toEqual({ label: 'Chartered status (MCIOB or MRICS)', essential: true, keywords: ['mciob', 'mrics'] });
    expect(byId.f1?.description).toMatch(/^Compagnie Énergie du Fleuve \(employeur fictif\) recrute/);
  });

  it('scope applies to them: French-only candidates see the French jobs, a UK-only candidate sees UK jobs', async () => {
    const jobs = await createSampleSource({ allPacks: true }).fetchJobs();
    const french = jobs.filter((j) => inScope(j, { languages: ['French'], countries: [], cities: [] }));
    expect(french.map((j) => j.externalId).sort()).toEqual(['f1', 'f2', 'f3', 'f4', 'r4']);
    const uk = jobs.filter((j) => inScope(j, { languages: [], countries: ['GB'], cities: [] }));
    expect(uk.length).toBeGreaterThan(5);
    expect(uk.every((j) => j.country === 'GB')).toBe(true);
    expect(jobs.filter((j) => inScope(j, { languages: [], countries: [], cities: [] }))).toHaveLength(jobs.length);
  });
});
