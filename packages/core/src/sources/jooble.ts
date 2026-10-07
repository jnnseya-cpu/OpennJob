/*
 * UNVERIFIED RESPONSE SHAPE. Written from Jooble's API description (jooble.org/api/about) as
 * remembered; not checked against the live API. Terms not yet checked (docs/sources.md).
 *
 * POST https://jooble.org/api/{key}   { keywords, location, page }
 * -> { totalCount, jobs: [{ id, title, location, snippet, salary, source, type, link, company, updated }] }
 *
 * Jooble aggregates job sites in about 60 countries, including ones Adzuna does not cover (the UAE,
 * Saudi Arabia, Qatar, Ireland...). Its adverts are snippets: the full text is on the linked site.
 */
import type { FetchLike, SearchSource } from './common';
import { arr, decodeEntities, normaliseJob, obj, postJson, present, str, stripTags, tidy, toIso } from './common';
import { countryName } from '../geo';

/** Countries Jooble is asked for: those no other configured source covers well. As remembered, unverified. */
export const JOOBLE_COUNTRIES: readonly string[] = ['AE', 'SA', 'QA', 'KW', 'BH', 'OM', 'IE', 'PT', 'SE', 'NO', 'DK', 'FI', 'CZ', 'RO', 'HU', 'GR', 'TR', 'MA', 'NG', 'KE', 'EG'];

export function createJoobleSearch(options: { apiKey: string; fetch: FetchLike; countries?: readonly string[] }): SearchSource {
  return {
    name: 'jooble',
    label: 'jooble',
    countries: (options.countries ?? JOOBLE_COUNTRIES).map((c) => c.toUpperCase()),
    search: async (q) => {
      const country = q.country.toUpperCase();
      const place = [q.where, countryName(country)].filter(Boolean).join(', ');
      const body = obj(await postJson(options.fetch, 'jooble', `https://jooble.org/api/${encodeURIComponent(options.apiKey)}`, { keywords: q.what, location: place, page: '1' }));
      return arr(body.jobs)
        .map((item) => {
          const j = obj(item);
          const postedAt = toIso(j.updated);
          return normaliseJob({
            source: 'jooble',
            externalId: str(j.id),
            title: tidy(decodeEntities(stripTags(str(j.title)))),
            employer: str(j.company),
            location: str(j.location) || place,
            country,
            url: str(j.link),
            applyUrl: str(j.link),
            description: tidy(decodeEntities(stripTags(str(j.snippet)))),
            ...(str(j.type) ? { employmentType: str(j.type) } : {}),
            ...(postedAt ? { postedAt } : {}),
          });
        })
        .filter(present);
    },
  };
}
