/*
 * UNVERIFIED RESPONSE SHAPE.
 * The endpoint and response shape below were written from memory of Adzuna's public
 * API docs and have NOT been checked against the live API. The tests use a fixture in
 * that remembered shape, never a live call. Verify against the live API before relying
 * on this adapter. Adzuna's terms of use for the API (attribution, caching, redirect
 * links) have not been reviewed either.
 *
 * GET https://api.adzuna.com/v1/api/jobs/{country}/search/{page}?app_id=&app_key=&results_per_page=&what=&where=
 * Per-person searches send the CV job title as what_phrase (exact phrase), as remembered. Unverified.
 * results_per_page: 50 is the largest page Adzuna allows, AS REMEMBERED (default 10). Unverified.
 * -> { results: [{ id, title, description, redirect_url, company: { display_name },
 *                  location: { display_name }, salary_min, salary_max, created }] }
 * Note: as remembered, `description` is a truncated snippet, not the full advert.
 *
 * COUNTRY: the country is a path segment of the URL (gb, us, fr, de, za, ...).
 * ADZUNA_COUNTRIES_UNVERIFIED below is the list of country codes Adzuna supports AS
 * REMEMBERED. It is from memory and has NOT been checked against Adzuna's documentation
 * or the live API: codes may be missing, or listed here and not supported. Because of
 * that the adapter does not refuse a two-letter code that is absent from the list; it
 * only refuses something that is not two letters. Check the list before relying on it.
 */
import { arr, decodeEntities, getJson, normaliseJob, num, obj, present, str, stripTags, tidy, toIso } from './common';
import type { FetchLike, JobSourceAdapter, SearchSource } from './common';

/** FROM MEMORY, UNVERIFIED. See the comment at the top of this file. */
export const ADZUNA_COUNTRIES_UNVERIFIED: readonly string[] = [
  'gb', 'us', 'at', 'au', 'be', 'br', 'ca', 'ch', 'de', 'es', 'fr', 'in', 'it', 'mx', 'nl', 'nz', 'pl', 'sg', 'za',
];

/** The largest page Adzuna allows, as remembered from its documentation. Unverified against the live API. */
export const ADZUNA_MAX_RESULTS_PER_PAGE = 50;

export interface AdzunaOptions {
  appId: string;
  appKey: string;
  /** Two-letter country code used as the URL path segment. Defaults to 'gb'. */
  country?: string;
  what: string;
  where?: string;
  page?: number;
  /** Jobs per request, 1 to ADZUNA_MAX_RESULTS_PER_PAGE. Defaults to the maximum. */
  resultsPerPage?: number;
  fetch: FetchLike;
}

export function createAdzunaSource(options: AdzunaOptions): JobSourceAdapter {
  const country = (options.country ?? 'gb').trim().toLowerCase();
  if (!/^[a-z]{2}$/.test(country)) throw new Error(`adzuna: "${options.country}" is not a two-letter country code`);
  // 'gb' keeps the v1 label so existing logs and configuration read the same.
  const label = country === 'gb' ? 'adzuna' : `adzuna:${country}`;
  return {
    name: 'adzuna',
    label,
    fetchJobs: () => adzunaSearch(options, label, country, options.what, options.where, options.page ?? 1),
  };
}

export interface AdzunaSearchOptions {
  appId: string;
  appKey: string;
  resultsPerPage?: number;
  fetch: FetchLike;
}

/**
 * Adzuna asked per search: the job title from the person's CV, and the place from their
 * preferences. Only countries Adzuna supports (as remembered, unverified) are asked.
 */
export function createAdzunaSearch(options: AdzunaSearchOptions): SearchSource {
  return {
    name: 'adzuna',
    label: 'adzuna',
    countries: ADZUNA_COUNTRIES_UNVERIFIED.map((c) => c.toUpperCase()),
    search: (q) => {
      const country = q.country.toLowerCase();
      if (!/^[a-z]{2}$/.test(country)) return Promise.resolve([]);
      // The job title as an exact phrase (what_phrase): "project manager" must not bring back every "manager".
      return adzunaSearch(options, country === 'gb' ? 'adzuna' : `adzuna:${country}`, country, q.what, q.where, 1, true);
    },
  };
}

async function adzunaSearch(
  options: { appId: string; appKey: string; resultsPerPage?: number; fetch: FetchLike },
  label: string,
  country: string,
  what: string,
  where: string | undefined,
  page: number,
  phrase = false,
) {
  const perPage = Math.min(ADZUNA_MAX_RESULTS_PER_PAGE, Math.max(1, Math.trunc(options.resultsPerPage ?? ADZUNA_MAX_RESULTS_PER_PAGE)));
  const params = new URLSearchParams({ app_id: options.appId, app_key: options.appKey, results_per_page: String(perPage) });
  params.set(phrase ? 'what_phrase' : 'what', what);
  if (where) params.set('where', where);
  const url = `https://api.adzuna.com/v1/api/jobs/${country}/search/${page}?${params.toString()}`;
  const body = obj(await getJson(options.fetch, label, url));
  return arr(body.results)
    .map((item) => {
      const j = obj(item);
      const postedAt = toIso(j.created);
      const salaryMin = num(j.salary_min);
      const salaryMax = num(j.salary_max);
      return normaliseJob({
        source: 'adzuna',
        externalId: str(j.id),
        title: tidy(decodeEntities(stripTags(str(j.title)))),
        employer: str(obj(j.company).display_name),
        location: str(obj(j.location).display_name),
        // The search was scoped to this country, so every result is in it. (Adzuna's 'gb' is ISO 'GB'.)
        country: country.toUpperCase(),
        url: str(j.redirect_url),
        applyUrl: str(j.redirect_url),
        description: tidy(decodeEntities(stripTags(str(j.description)))),
        ...(salaryMin !== undefined ? { salaryMin } : {}),
        ...(salaryMax !== undefined ? { salaryMax } : {}),
        ...(postedAt ? { postedAt } : {}),
      });
    })
    .filter(present);
}
