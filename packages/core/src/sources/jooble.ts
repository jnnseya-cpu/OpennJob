/*
 * UNVERIFIED RESPONSE SHAPE. Written from Jooble's API description (jooble.org/api/about) as
 * remembered; not checked against the live API. Terms not yet checked (docs/sources.md).
 *
 * POST https://{country}.jooble.org/api/{key}   { keywords, location, page }   (USA: jooble.org)
 * -> { totalCount, jobs: [{ id, title, location, snippet, salary, source, type, link, company, updated }] }
 *
 * Jooble aggregates job sites in about 60 countries, including ones Adzuna does not cover (the UAE,
 * Saudi Arabia, Qatar, Ireland...), with a separate API key for each country's site. Its adverts are
 * snippets: the full text is on the linked site.
 */
import type { FetchLike, SearchSource } from './common';
import { arr, decodeEntities, normaliseJob, obj, postJson, present, str, stripTags, tidy, toIso } from './common';
import { countryName } from '../geo';

/**
 * Each Jooble country site issues its own API key, and a key only returns that country's jobs (the
 * key from jooble.org is for the USA). So a key is configured per country, and the request goes to
 * that country's site: AE -> https://ae.jooble.org/api/{key}. The UK's site is uk.jooble.org.
 */
export function joobleHost(country: string): string {
  const c = country.toUpperCase();
  if (c === 'US') return 'jooble.org';
  return `${c === 'GB' ? 'uk' : c.toLowerCase()}.jooble.org`;
}

/** "AE:key1, SA:key2" -> { AE: 'key1', SA: 'key2' }. Malformed entries are ignored. */
export function parseJoobleKeys(value: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of (value ?? '').split(',')) {
    const m = /^\s*([A-Za-z]{2})\s*:\s*(\S+)\s*$/.exec(entry);
    if (m?.[1] && m[2]) out[m[1].toUpperCase()] = m[2];
  }
  return out;
}

export function createJoobleSearch(options: { keys: Record<string, string>; fetch: FetchLike }): SearchSource {
  const keys = Object.fromEntries(Object.entries(options.keys).map(([c, k]) => [c.toUpperCase(), k]));
  return {
    name: 'jooble',
    label: 'jooble',
    countries: Object.keys(keys),
    search: async (q) => {
      const country = q.country.toUpperCase();
      const key = keys[country];
      if (!key) return [];
      // The country comes from the site; the location narrows to a city when the person chose one.
      const place = q.where ?? '';
      const body = obj(await postJson(options.fetch, 'jooble', `https://${joobleHost(country)}/api/${encodeURIComponent(key)}`, { keywords: q.what, location: place, page: '1' }));
      return arr(body.jobs)
        .map((item) => {
          const j = obj(item);
          const postedAt = toIso(j.updated);
          return normaliseJob({
            source: 'jooble',
            externalId: str(j.id),
            title: tidy(decodeEntities(stripTags(str(j.title)))),
            employer: str(j.company),
            location: str(j.location) || place || (countryName(country) ?? country),
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
