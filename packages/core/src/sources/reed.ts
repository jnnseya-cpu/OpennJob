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

/** Reed asked per search (job title from the CV, city from the preferences). UK only. */
export function createReedSearch(options: { apiKey: string; fetch: FetchLike }): SearchSource {
  return {
    name: 'reed',
    label: 'reed',
    countries: ['GB'],
    search: (q) => (q.country.toUpperCase() === 'GB' ? reedSearch(options.apiKey, options.fetch, q.what, q.where) : Promise.resolve([])),
  };
}

async function reedSearch(apiKey: string, fetchFn: FetchLike, keywords: string, locationName: string | undefined) {
  const label = 'reed';
  const params = new URLSearchParams({ keywords });
  if (locationName) params.set('locationName', locationName);
  const url = `https://www.reed.co.uk/api/1.0/search?${params.toString()}`;
  const body = obj(await getJson(fetchFn, label, url, { Authorization: reedAuthHeader(apiKey) }));
  return arr(body.results)
    .map((item) => {
      const j = obj(item);
      const postedAt = toIso(j.date);
      const salaryMin = num(j.minimumSalary);
      const salaryMax = num(j.maximumSalary);
      return normaliseJob({
        source: 'reed',
        externalId: str(j.jobId),
        title: str(j.jobTitle),
        employer: str(j.employerName),
        location: str(j.locationName),
        // Reed is treated as a UK board. An assumption, not something the API states per job.
        country: 'GB',
        url: str(j.jobUrl),
        applyUrl: str(j.jobUrl),
        description: tidy(decodeEntities(stripTags(str(j.jobDescription)))),
        ...(salaryMin !== undefined ? { salaryMin } : {}),
        ...(salaryMax !== undefined ? { salaryMax } : {}),
        ...(postedAt ? { postedAt } : {}),
      });
    })
    .filter(present);
}
