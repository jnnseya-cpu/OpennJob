import { describe, expect, it } from 'vitest';
import { createCareerSiteSearch, parseCareerSite, parseCareerSites } from '../src';
import type { FetchLike } from '../src';

/**
 * Employers' own careers sites, driven by an injected fetch serving the remembered response shapes
 * (unverified against live sites). No live calls. Fictional employers and adverts.
 */
describe('careers sites listed by the operator', () => {
  it('reads Workday and SuccessFactors addresses, and refuses anything malformed', () => {
    expect(parseCareerSite('https://examplegrid.wd3.myworkdayjobs.com/en-GB/EG_Careers|Example Grid (fictional)|gb')).toMatchObject({ kind: 'workday', host: 'examplegrid.wd3.myworkdayjobs.com', tenant: 'examplegrid', site: 'EG_Careers', employer: 'Example Grid (fictional)', country: 'GB' });
    expect(parseCareerSite('https://jobs.example.org|Example Build (fictional)|GB')).toMatchObject({ kind: 'successfactors', host: 'jobs.example.org' });
    expect(parseCareerSite('http://jobs.example.org|Example|GB')).toBeUndefined(); // https only
    expect(parseCareerSite('https://jobs.example.org|Example')).toBeUndefined(); // no country
    expect(parseCareerSite('https://examplegrid.wd3.myworkdayjobs.com/|Example|GB')).toBeUndefined(); // no Workday site name
    expect(parseCareerSites('https://jobs.example.org|A (fictional)|GB, nonsense\nhttps://x.wd1.myworkdayjobs.com/Careers|B (fictional)|AE')).toHaveLength(2);
    expect(parseCareerSites(undefined)).toEqual([]);
  });
});

describe('Workday careers site search', () => {
  const sites = parseCareerSites('https://examplegrid.wd3.myworkdayjobs.com/en-GB/EG_Careers|Example Grid (fictional)|GB');
  const fetchFor = () => {
    const calls: { url: string; method?: string; body?: unknown }[] = [];
    const fetch: FetchLike = async (url, init) => {
      calls.push({ url, ...(init?.method ? { method: init.method } : {}), ...(init?.body ? { body: JSON.parse(init.body) } : {}) });
      if (url.endsWith('/jobs')) {
        return { ok: true, status: 200, json: async () => ({ total: 3, jobPostings: [{ title: 'Senior Project Manager (fictional)', externalPath: '/job/Warwick/Senior-Project-Manager_R101', locationsText: 'Warwick' }, { title: 'Planner (fictional)', externalPath: '/job/Coventry/Planner_R102', locationsText: 'Coventry' }, { title: 'Process Engineer (fictional)', externalPath: '/job/Raleigh/Process-Engineer_R103', locationsText: 'Raleigh, North Carolina, United States' }, { title: 'Responsable Achats (fictional)', externalPath: '/job/Massy/Responsable_R104', locationsText: 'Massy' }] }) };
      }
      if (url.endsWith('_R101')) {
        return { ok: true, status: 200, json: async () => ({ jobPostingInfo: { title: 'Senior Project Manager (fictional)', location: 'Warwick', jobDescription: '<p>Lead substation projects.</p><ul><li>APM qualification</li><li>NEC3 contracts</li></ul>', externalUrl: 'https://examplegrid.wd3.myworkdayjobs.com/en-GB/EG_Careers/job/Warwick/Senior-Project-Manager_R101' }, hiringOrganization: { name: 'Example Grid plc' } }) };
      }
      if (url.endsWith('_R104')) {
        // Only the advert's own country says it is abroad: "Massy" alone names no country.
        return { ok: true, status: 200, json: async () => ({ jobPostingInfo: { title: 'Responsable Achats (fictional)', location: 'Massy', country: { descriptor: 'France' }, jobDescription: '<p>Fictional.</p>' } }) };
      }
      return { ok: false, status: 500, json: async () => ({}) };
    };
    return { fetch, calls };
  };

  it('searches by title, reads each advert, and gives the employer\'s own application page', async () => {
    const { fetch, calls } = fetchFor();
    const jobs = await createCareerSiteSearch({ kind: 'workday', sites, fetch }).search({ what: 'project manager', where: 'Birmingham', country: 'GB' });
    expect(calls[0]).toMatchObject({ url: 'https://examplegrid.wd3.myworkdayjobs.com/wday/cxs/examplegrid/EG_Careers/jobs', method: 'POST', body: { searchText: 'project manager', limit: 20, offset: 0 } });
    expect(jobs).toHaveLength(2); // the jobs in the United States and in France are not UK jobs
    expect(jobs[0]).toMatchObject({ source: 'workday', title: 'Senior Project Manager (fictional)', employer: 'Example Grid (fictional)', country: 'GB', city: 'Warwick', applyUrl: 'https://examplegrid.wd3.myworkdayjobs.com/en-GB/EG_Careers/job/Warwick/Senior-Project-Manager_R101' });
    expect(jobs[0]?.description).toContain('NEC3 contracts');
    // An advert that could not be read keeps the posting, with a page built from the list.
    expect(jobs[1]).toMatchObject({ title: 'Planner (fictional)', applyUrl: 'https://examplegrid.wd3.myworkdayjobs.com/EG_Careers/job/Coventry/Planner_R102' });
  });

  it('asks a site once per title however many places, and never for another country', async () => {
    const { fetch, calls } = fetchFor();
    const source = createCareerSiteSearch({ kind: 'workday', sites, fetch });
    expect(source.countries).toEqual(['GB']);
    await source.search({ what: 'project manager', where: 'Birmingham', country: 'GB' });
    await source.search({ what: 'project manager', where: 'Coventry', country: 'GB' });
    expect(calls.filter((c) => c.url.endsWith('/jobs'))).toHaveLength(1);
    expect(await source.search({ what: 'project manager', country: 'AE' })).toEqual([]);
    expect(calls.filter((c) => c.url.endsWith('/jobs'))).toHaveLength(1);
  });
});

describe('SuccessFactors careers site search', () => {
  it('reads the job feed: title, place, the job page as the application page', async () => {
    const calls: string[] = [];
    const rss = `<?xml version="1.0"?><rss><channel><title>Jobs</title>
      <item><title>Construction Manager (Solihull, GB)</title><link>https://jobs.example.org/job/Solihull-Construction-Manager/4001/</link><description><![CDATA[<p>Manage a fictional school build.</p>]]></description><pubDate>Mon, 05 Oct 2026 09:00:00 GMT</pubDate></item>
      <item><title>No link (fictional)</title><description>x</description></item>
      </channel></rss>`;
    const fetch: FetchLike = async (url) => {
      calls.push(url);
      return { ok: true, status: 200, json: async () => ({}), text: async () => rss };
    };
    const sites = parseCareerSites('https://jobs.example.org|Example Build (fictional)|GB');
    const jobs = await createCareerSiteSearch({ kind: 'successfactors', sites, fetch }).search({ what: 'construction manager', country: 'GB' });
    expect(calls[0]).toBe('https://jobs.example.org/services/rss/job/?locale=en_GB&keywords=(construction%20manager)');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ source: 'successfactors', title: 'Construction Manager', employer: 'Example Build (fictional)', country: 'GB', city: 'Solihull', applyUrl: 'https://jobs.example.org/job/Solihull-Construction-Manager/4001/' });
    expect(jobs[0]?.description).toContain('fictional school build');
  });

  it('a failing site is an error only when no other site gave jobs', async () => {
    const fetch: FetchLike = async () => ({ ok: false, status: 503, json: async () => ({}) });
    const source = createCareerSiteSearch({ kind: 'successfactors', sites: parseCareerSites('https://jobs.example.org|A (fictional)|GB'), fetch });
    await expect(source.search({ what: 'planner', country: 'GB' })).rejects.toThrow(/HTTP 503/);
  });
});
