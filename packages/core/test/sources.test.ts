import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SourceError,
  collectJobs,
  createAdzunaSource,
  createAshbySource,
  createGreenhouseSource,
  createLeverSource,
  createReedSearch,
  createReedSource,
  createAdzunaSearch,
  createSampleSource,
  decodeEntities,
  dedupeJobs,
  dedupeKey,
  escapedHtmlToText,
  reedAuthHeader,
} from '../src';
import type { FetchLike, Job } from '../src';

/**
 * No live calls. Every adapter is driven by an injected fetch that serves a hand-written
 * fixture in the remembered response shape and records the request it was given.
 */
const fixture = (name: string): unknown => JSON.parse(readFileSync(path.join(__dirname, 'fixtures/sources', name), 'utf8'));

function fakeFetch(body: unknown, status = 200) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, headers: init?.headers ?? {} });
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return { fetch, calls };
}

describe('greenhouse adapter', () => {
  it('requests the board with content=true and normalises jobs', async () => {
    const { fetch, calls } = fakeFetch(fixture('greenhouse.json'));
    const jobs = await createGreenhouseSource({ boardToken: 'examplecare', employer: 'Example Care', fetch }).fetchJobs();
    expect(calls[0]?.url).toBe('https://boards-api.greenhouse.io/v1/boards/examplecare/jobs?content=true');
    expect(jobs).toHaveLength(2); // the malformed third row is skipped
    expect(jobs[0]).toMatchObject({
      id: 'greenhouse:4011223',
      source: 'greenhouse',
      externalId: '4011223',
      title: 'Registered Nurse - Community',
      employer: 'Example Care',
      location: 'Birmingham, UK',
      url: 'https://boards.greenhouse.io/examplecare/jobs/4011223',
      postedAt: '2026-09-20T14:15:00.000Z',
      requiresRegistration: true,
      criteriaSource: 'fallback',
    });
  });

  it('decodes the HTML-escaped content and strips the tags', async () => {
    const { fetch } = fakeFetch(fixture('greenhouse.json'));
    const [job] = await createGreenhouseSource({ boardToken: 'examplecare', fetch }).fetchJobs();
    expect(job?.description).toBe(
      'Join our community team.\nEssential\n- Current NMC registration\n- Medication administration & wound care\nDesirable\n- Full UK driving licence\nSalary: £34,000 per year',
    );
    expect(job?.description).not.toMatch(/[<>]|&lt;|&amp;/);
    expect(job?.employer).toBe('examplecare'); // defaults to the board token
    const labels = Object.fromEntries((job?.criteria ?? []).map((c) => [c.label, c.essential]));
    expect(labels).toMatchObject({ 'NMC registration': true, 'Medication administration': true, 'Wound care': true, 'Full UK driving licence': false });
  });
});

describe('lever adapter', () => {
  it('requests mode=json and normalises postings', async () => {
    const { fetch, calls } = fakeFetch(fixture('lever.json'));
    const jobs = await createLeverSource({ company: 'examplesupport', employer: 'Example Support', fetch }).fetchJobs();
    expect(calls[0]?.url).toBe('https://api.lever.co/v0/postings/examplesupport?mode=json');
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({
      id: 'lever:a1b2c3d4-0000-4000-8000-000000000001',
      title: 'Support Worker - Learning Disabilities',
      employer: 'Example Support',
      location: 'Coventry',
      url: 'https://jobs.lever.co/examplesupport/a1b2c3d4-0000-4000-8000-000000000001',
      applyUrl: 'https://jobs.lever.co/examplesupport/a1b2c3d4-0000-4000-8000-000000000001/apply',
      employmentType: 'Full-time',
      postedAt: new Date(1758700800000).toISOString(),
      requiresRegistration: false,
    });
    // applyUrl falls back to hostedUrl when absent
    expect(jobs[1]?.applyUrl).toBe(jobs[1]?.url);
  });
});

describe('ashby adapter', () => {
  it('requests the job board and normalises jobs', async () => {
    const { fetch, calls } = fakeFetch(fixture('ashby.json'));
    const jobs = await createAshbySource({ boardName: 'examplehealth', employer: 'Example Health', fetch }).fetchJobs();
    expect(calls[0]?.url).toBe('https://api.ashbyhq.com/posting-api/job-board/examplehealth');
    expect(jobs).toEqual([
      expect.objectContaining({
        id: 'ashby:7f3c1e9a-1111-4222-8333-444455556666',
        title: 'Staff Nurse (RGN) - Nights',
        employer: 'Example Health',
        location: 'Manchester',
        employmentType: 'FullTime',
        applyUrl: 'https://jobs.ashbyhq.com/examplehealth/7f3c1e9a-1111-4222-8333-444455556666/application',
        postedAt: '2026-09-25T08:00:00.000Z',
        requiresRegistration: true,
      }),
    ]);
  });
});

describe('adzuna adapter', () => {
  it('asks for the largest page (50) by default; a configured size is kept within 1 to 50', async () => {
    const sizes: (string | null)[] = [];
    for (const resultsPerPage of [undefined, 20, 500, 0]) {
      const { fetch, calls } = fakeFetch(fixture('adzuna.json'));
      await createAdzunaSource({ appId: 'a', appKey: 'b', what: 'site manager', fetch, ...(resultsPerPage !== undefined ? { resultsPerPage } : {}) }).fetchJobs();
      sizes.push(new URL(calls[0]?.url ?? '').searchParams.get('results_per_page'));
    }
    expect(sizes).toEqual(['50', '20', '50', '1']);
  });

  it('builds the gb search URL with credentials and query, and normalises results', async () => {
    const { fetch, calls } = fakeFetch(fixture('adzuna.json'));
    const jobs = await createAdzunaSource({ appId: 'ID123', appKey: 'KEY456', what: 'healthcare assistant', where: 'Leeds', page: 2, fetch }).fetchJobs();
    const url = new URL(calls[0]?.url as string);
    expect(url.origin + url.pathname).toBe('https://api.adzuna.com/v1/api/jobs/gb/search/2');
    expect(Object.fromEntries(url.searchParams)).toEqual({ app_id: 'ID123', app_key: 'KEY456', results_per_page: '50', what: 'healthcare assistant', where: 'Leeds' });
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({
      id: 'adzuna:5123456789',
      title: 'Healthcare Assistant',
      employer: 'Example Care',
      location: 'Leeds, UK',
      salaryMin: 23500,
      salaryMax: 25100.5,
      postedAt: '2026-09-28T12:30:45.000Z',
    });
    expect(jobs[0]?.description).toBe('We need a caring Healthcare Assistant to provide personal care & support with moving and handling ...');
    expect(jobs[1]).toMatchObject({ employer: 'Unknown employer' });
    expect(jobs[1]?.salaryMin).toBeUndefined();
  });

  it('defaults to page 1 and omits where when not given', async () => {
    const { fetch, calls } = fakeFetch({ results: [] });
    await createAdzunaSource({ appId: 'a', appKey: 'b', what: 'nurse', fetch }).fetchJobs();
    expect(calls[0]?.url).toBe('https://api.adzuna.com/v1/api/jobs/gb/search/1?app_id=a&app_key=b&results_per_page=50&what=nurse');
  });
});

describe('reed adapter', () => {
  it('uses HTTP Basic auth with the API key as username and an empty password', async () => {
    const { fetch, calls } = fakeFetch(fixture('reed.json'));
    await createReedSource({ apiKey: 'my-reed-key', keywords: 'mental health nurse', locationName: 'Birmingham', fetch }).fetchJobs();
    expect(calls[0]?.url).toBe('https://www.reed.co.uk/api/1.0/search?keywords=mental+health+nurse&resultsToTake=100&locationName=Birmingham');
    const auth = calls[0]?.headers.Authorization as string;
    expect(auth).toBe(reedAuthHeader('my-reed-key'));
    expect(Buffer.from(auth.replace('Basic ', ''), 'base64').toString('utf8')).toBe('my-reed-key:');
  });

  it('normalises results, including dd/mm/yyyy dates and null salaries', async () => {
    const { fetch } = fakeFetch(fixture('reed.json'));
    const jobs = await createReedSource({ apiKey: 'k', keywords: 'nurse', fetch }).fetchJobs();
    expect(jobs[0]).toMatchObject({
      id: 'reed:55001122',
      title: 'Registered Mental Health Nurse',
      employer: 'Brookvale Care Agency (example)',
      location: 'Birmingham',
      salaryMin: 38000,
      salaryMax: 44000,
      url: 'https://www.reed.co.uk/jobs/registered-mental-health-nurse/55001122',
      postedAt: '2026-10-02T00:00:00.000Z',
      requiresRegistration: true,
    });
    expect(jobs[1]?.salaryMin).toBeUndefined();
    expect(jobs[1]?.salaryMax).toBeUndefined();
  });
});

describe('per-person searches read more than the snippet', () => {
  it('reed: reads the full advert for the first results, so requirements come from the whole text', async () => {
    const calls: string[] = [];
    const fetch: FetchLike = async (url) => {
      calls.push(url);
      const body = url.includes('/jobs/55001122')
        ? { jobDescription: `<p>${'A fictional mental health unit looking for a registered nurse. '.repeat(4)}</p><p>Essential:</p><ul><li>NMC registration</li><li>Medication administration and care planning</li></ul>` }
        : url.includes('/jobs/')
          ? null
          : fixture('reed.json');
      return { ok: body !== null, status: body !== null ? 200 : 500, json: async () => body };
    };
    const jobs = await createReedSearch({ apiKey: 'k', fetch, detailsPerSearch: 2 }).search({ what: 'nurse', country: 'GB' });
    expect(calls.filter((u) => u.includes('/api/1.0/jobs/'))).toHaveLength(2);
    expect(jobs[0]?.description).toContain('Medication administration and care planning');
    expect(jobs[0]?.criteria.map((c) => c.label)).toContain('Care planning');
    // A failed detail call keeps the snippet.
    expect(jobs[1]?.description.length).toBeGreaterThan(0);
  });

  it('adzuna: sends the CV job title as an exact phrase', async () => {
    const { fetch, calls } = fakeFetch(fixture('adzuna.json'));
    await createAdzunaSearch({ appId: 'id', appKey: 'key', fetch }).search({ what: 'project manager', where: 'Leeds', country: 'GB' });
    expect(calls[0]?.url).toContain('what_phrase=project+manager');
    expect(calls[0]?.url).not.toContain('&what=');
  });
});

describe('adapter error handling', () => {
  it('throws a SourceError on a non-2xx response', async () => {
    const { fetch } = fakeFetch({ error: 'nope' }, 401);
    await expect(createReedSource({ apiKey: 'bad', keywords: 'nurse', fetch }).fetchJobs()).rejects.toMatchObject({ name: 'SourceError', status: 401 });
  });
  it('throws a SourceError when fetch itself fails or the body is not JSON', async () => {
    const down: FetchLike = async () => { throw new Error('ECONNREFUSED'); };
    await expect(createLeverSource({ company: 'x', fetch: down }).fetchJobs()).rejects.toBeInstanceOf(SourceError);
    const notJson: FetchLike = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad'); } });
    await expect(createAshbySource({ boardName: 'x', fetch: notJson }).fetchJobs()).rejects.toThrow(/not valid JSON/);
  });
  it('returns no jobs for an unexpected but valid JSON shape', async () => {
    for (const body of [null, {}, { jobs: 'none' }, [], 'text', { results: {} }]) {
      const { fetch } = fakeFetch(body);
      expect(await createGreenhouseSource({ boardToken: 'x', fetch }).fetchJobs()).toEqual([]);
      expect(await createLeverSource({ company: 'x', fetch }).fetchJobs()).toEqual([]);
      expect(await createAshbySource({ boardName: 'x', fetch }).fetchJobs()).toEqual([]);
      expect(await createAdzunaSource({ appId: 'a', appKey: 'b', what: 'n', fetch }).fetchJobs()).toEqual([]);
      expect(await createReedSource({ apiKey: 'k', keywords: 'n', fetch }).fetchJobs()).toEqual([]);
    }
  });
  it('URL-encodes board tokens', async () => {
    const { fetch, calls } = fakeFetch({ jobs: [] });
    await createGreenhouseSource({ boardToken: 'a/b?c', fetch }).fetchJobs();
    expect(calls[0]?.url).toBe('https://boards-api.greenhouse.io/v1/boards/a%2Fb%3Fc/jobs?content=true');
  });
});

describe('html helpers', () => {
  it('decodes named and numeric entities', () => {
    expect(decodeEntities('&lt;p&gt; &amp; &#163;5 &#x2014; &quot;ok&quot; &unknown;')).toBe('<p> & £5 — "ok" &unknown;');
  });
  it('drops scripts and keeps list structure', () => {
    expect(escapedHtmlToText('&lt;script&gt;alert(1)&lt;/script&gt;&lt;ul&gt;&lt;li&gt;One&lt;/li&gt;&lt;li&gt;Two&lt;/li&gt;&lt;/ul&gt;')).toBe('- One\n- Two');
  });
});

describe('de-duplication across sources', () => {
  const job = (id: string, title: string, employer: string, location: string): Job => ({
    id, source: 'sample', externalId: id, title, employer, location, url: '', description: '', criteria: [], criteriaSource: 'fallback', requiresRegistration: false,
  });

  it('treats the same normalised title + employer + location as one vacancy', () => {
    expect(dedupeKey(job('1', 'Healthcare Assistant', 'Example Care', 'Leeds, UK'))).toBe(dedupeKey(job('2', '  healthcare   assistant ', 'EXAMPLE CARE', 'Leeds UK')));
    expect(dedupeKey(job('1', 'Nurse', 'Smith & Sons', 'York'))).toBe(dedupeKey(job('2', 'Nurse', 'Smith and Sons', 'York')));
    // Sources spell the same employer and place differently (fictional employers).
    expect(dedupeKey(job('1', 'Senior Construction Delivery Manager', 'Clarion (example)', 'Birmingham'))).toBe(dedupeKey(job('2', 'Senior Construction Delivery Manager', 'Clarion Housing (example)', 'Birmingham, West Midlands')));
    expect(dedupeKey(job('1', 'Quantity Surveyor', 'Example Gordon Recruitment', 'Leeds'))).toBe(dedupeKey(job('2', 'Quantity Surveyor', 'Example Gordon Recruitment Limited', 'Leeds')));
    expect(dedupeKey(job('1', 'Quantity Surveyor', 'Example Build', 'Leeds'))).not.toBe(dedupeKey(job('2', 'Quantity Surveyor', 'Sample Build', 'Leeds')));
  });

  it('keeps jobs that differ in title, employer or location', () => {
    const base = job('1', 'Healthcare Assistant', 'Example Care', 'Leeds');
    const r = dedupeJobs([base, job('2', 'Senior Healthcare Assistant', 'Example Care', 'Leeds'), job('3', 'Healthcare Assistant', 'Other Care', 'Leeds'), job('4', 'Healthcare Assistant', 'Example Care', 'York')]);
    expect(r.jobs).toHaveLength(4);
    expect(r.duplicates).toHaveLength(0);
  });

  it('keeps the first occurrence', () => {
    const r = dedupeJobs([job('first', 'Nurse', 'A', 'B'), job('second', 'NURSE', 'a', 'b')]);
    expect(r.jobs.map((j) => j.id)).toEqual(['first']);
    expect(r.duplicates.map((j) => j.id)).toEqual(['second']);
  });

  it('collectJobs de-duplicates across the fixture sources and reports source failures without failing', async () => {
    const employer = 'Example Care';
    const sources = [
      createGreenhouseSource({ boardToken: 'examplecare', employer, fetch: fakeFetch(fixture('greenhouse.json')).fetch }),
      createLeverSource({ company: 'examplesupport', employer, fetch: fakeFetch(fixture('lever.json')).fetch }),
      createAdzunaSource({ appId: 'a', appKey: 'b', what: 'hca', fetch: fakeFetch(fixture('adzuna.json')).fetch }),
      createReedSource({ apiKey: 'k', keywords: 'hca', fetch: fakeFetch(fixture('reed.json')).fetch }),
      createAshbySource({ boardName: 'down', fetch: fakeFetch({}, 503).fetch }),
    ];
    const r = await collectJobs(sources);
    expect(r.fetched).toBe(8);
    // "Healthcare Assistant / Example Care / Leeds UK" appears in Greenhouse, Lever, Adzuna and Reed.
    expect(r.duplicates).toBe(3);
    expect(r.jobs).toHaveLength(5);
    expect(r.jobs.filter((j) => /healthcare assistant/i.test(j.title)).map((j) => j.id)).toEqual(['greenhouse:4011224']);
    expect(r.errors).toEqual([{ source: 'ashby:down', message: 'ashby:down: HTTP 503' }]);
  });
});

describe('sample source', () => {
  it('returns fictional demo jobs with criteria', async () => {
    const jobs = await createSampleSource().fetchJobs();
    expect(jobs).toHaveLength(3);
    expect(jobs.map((j) => j.requiresRegistration)).toEqual([true, false, false]);
    for (const j of jobs) {
      expect(j.employer).toMatch(/\(example\)/);
      expect(j.criteria.length).toBeGreaterThan(2);
    }
  });
});
