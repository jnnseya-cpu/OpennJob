/*
 * UNVERIFIED RESPONSE SHAPE.
 * The endpoint, auth scheme and response shape below were written from memory of Reed's
 * public Jobseeker API docs and have NOT been checked against the live API. The tests
 * use a fixture in that remembered shape, never a live call. Verify against the live
 * API before relying on this adapter. Reed's API terms of use have not been reviewed
 * either.
 *
 * GET https://www.reed.co.uk/api/1.0/search?keywords=&locationName=
 * HTTP Basic auth: API key as the username, empty password.
 * -> { results: [{ jobId, employerName, jobTitle, locationName, minimumSalary,
 *                  maximumSalary, jobDescription, jobUrl, date }] }
 * Note: as remembered, `jobDescription` in search results is a truncated snippet.
 * GET https://www.reed.co.uk/api/1.0/jobs/{jobId} -> { jobDescription, ... } gives the full advert
 * (as remembered). Per-person searches read the full advert for the first REED_DETAILS_PER_SEARCH
 * results, so requirements are read from the whole text, not the snippet. A failed detail call
 * keeps the snippet.
 */
import { arr, decodeEntities, getJson, normaliseJob, num, obj, present, str, stripTags, tidy, toIso } from './common';
import type { FetchLike, JobSourceAdapter, SearchSource } from './common';

export interface ReedOptions {
  apiKey: string;
  keywords: string;
  locationName?: string;
  fetch: FetchLike;
}

export function reedAuthHeader(apiKey: string): string {
  return `Basic ${Buffer.from(`${apiKey}:`, 'utf8').toString('base64')}`;
}

export function createReedSource(options: ReedOptions): JobSourceAdapter {
  return { name: 'reed', label: 'reed', fetchJobs: () => reedSearch(options.apiKey, options.fetch, options.keywords, options.locationName) };
}

/** How many results of one search get their full advert read. */
export const REED_DETAILS_PER_SEARCH = 25;

/** Reed asked per search (job title from the CV, city from the preferences). UK only. */
export function createReedSearch(options: { apiKey: string; fetch: FetchLike; detailsPerSearch?: number }): SearchSource {
  return {
    name: 'reed',
    label: 'reed',
    countries: ['GB'],
    search: (q) =>
      q.country.toUpperCase() === 'GB' ? reedSearch(options.apiKey, options.fetch, q.what, q.where, options.detailsPerSearch ?? REED_DETAILS_PER_SEARCH) : Promise.resolve([]),
    // A job past the first results of its search was read from the snippet only: the agent asks
    // for its whole advert before the application goes out.
    details: async (job) => {
      if (job.source !== 'reed' || !job.externalId) return {};
      const d = await reedDetails(options.apiKey, options.fetch, job.externalId);
      return { ...(d.text ? { description: d.text } : {}), ...(d.externalUrl ? { applyUrl: d.externalUrl } : {}) };
    },
  };
}

/**
 * The full advert for one Reed job: its text, and the employer's own application address when the
 * job is applied for on the employer's site (externalUrl, as remembered from Reed's API; unverified).
 * That address is what lets the queue apply on the employer's Workday or SuccessFactors site.
 */
async function reedDetails(apiKey: string, fetchFn: FetchLike, jobId: string): Promise<{ text?: string; externalUrl?: string }> {
  try {
    const body = obj(await getJson(fetchFn, 'reed', `https://www.reed.co.uk/api/1.0/jobs/${encodeURIComponent(jobId)}`, { Authorization: reedAuthHeader(apiKey) }));
    const text = tidy(decodeEntities(stripTags(str(body.jobDescription).replace(/<\/(p|li|div|h\d)>|<br\s*\/?>/gi, '\n'))));
    const external = str(body.externalUrl);
    return { ...(text ? { text } : {}), ...(/^https:\/\//i.test(external) ? { externalUrl: external } : {}) };
  } catch {
    return {};
  }
}

async function reedSearch(apiKey: string, fetchFn: FetchLike, keywords: string, locationName: string | undefined, details = 0) {
  const label = 'reed';
  const params = new URLSearchParams({ keywords, resultsToTake: '100' });
  if (locationName) params.set('locationName', locationName);
  const url = `https://www.reed.co.uk/api/1.0/search?${params.toString()}`;
  const body = obj(await getJson(fetchFn, label, url, { Authorization: reedAuthHeader(apiKey) }));
  const items = arr(body.results).map((item) => obj(item));
  const full = new Map<string, string>();
  const external = new Map<string, string>();
  for (const j of items.slice(0, details)) {
    const id = str(j.jobId);
    if (!id) continue;
    const d = await reedDetails(apiKey, fetchFn, id);
    if (d.text) full.set(id, d.text);
    if (d.externalUrl) external.set(id, d.externalUrl);
  }
  return items
    .map((j) => {
      const postedAt = toIso(j.date);
      const salaryMin = num(j.minimumSalary);
      const salaryMax = num(j.maximumSalary);
      const snippet = tidy(decodeEntities(stripTags(str(j.jobDescription))));
      const whole = full.get(str(j.jobId));
      return normaliseJob({
        source: 'reed',
        externalId: str(j.jobId),
        title: str(j.jobTitle),
        employer: str(j.employerName),
        location: str(j.locationName),
        // Reed is treated as a UK board. An assumption, not something the API states per job.
        country: 'GB',
        url: str(j.jobUrl),
        // Applied for on the employer's own site: that address, so the queue can apply there.
        applyUrl: external.get(str(j.jobId)) ?? str(j.jobUrl),
        description: whole && whole.length > snippet.length ? whole : snippet,
        ...(salaryMin !== undefined ? { salaryMin } : {}),
        ...(salaryMax !== undefined ? { salaryMax } : {}),
        ...(postedAt ? { postedAt } : {}),
      });
    })
    .filter(present);
}
