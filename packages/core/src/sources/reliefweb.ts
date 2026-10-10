/*
 * UNVERIFIED RESPONSE SHAPE. Written from ReliefWeb's public API documentation (apidoc.reliefweb.int)
 * as remembered; not checked against the live API. Terms not yet checked (docs/sources.md).
 *
 * POST https://api.reliefweb.int/v2/jobs?appname={approved appname}
 *   { query: { value, fields: ['title'], operator: 'AND' }, filter: { field: 'country.iso3', value },
 *     fields: { include: [...] }, sort: ['date.created:desc'], limit }
 * -> { data: [{ id, fields: { title, body, how_to_apply, url, source: [{ name }], country: [{ iso3, name }],
 *      city: [{ name }], date: { created } } }] }
 *
 * ReliefWeb (UN OCHA) lists humanitarian and development jobs: UN agencies, NGOs, their contractors.
 * It covers countries the commercial job APIs do not, such as DR Congo. Since 1 November 2025 the
 * API needs an appname approved by ReliefWeb (OPENNJOB_RELIEFWEB_APPNAME).
 */
import type { FetchLike, SearchSource } from './common';
import { arr, decodeEntities, normaliseJob, obj, postJson, present, str, stripTags, tidy, toIso } from './common';

/** ISO alpha-2 -> alpha-3, for the countries a person can choose where ReliefWeb has jobs. */
export const ISO3: Readonly<Record<string, string>> = {
  CD: 'COD', CG: 'COG', CF: 'CAF', CM: 'CMR', TD: 'TCD', GA: 'GAB', AO: 'AGO', BI: 'BDI', RW: 'RWA', UG: 'UGA', KE: 'KEN', TZ: 'TZA',
  SS: 'SSD', SD: 'SDN', ET: 'ETH', SO: 'SOM', DJ: 'DJI', ER: 'ERI', NG: 'NGA', NE: 'NER', ML: 'MLI', BF: 'BFA', SN: 'SEN', GN: 'GIN',
  CI: 'CIV', GH: 'GHA', TG: 'TGO', BJ: 'BEN', LR: 'LBR', SL: 'SLE', MR: 'MRT', MA: 'MAR', DZ: 'DZA', TN: 'TUN', LY: 'LBY', EG: 'EGY',
  MZ: 'MOZ', MW: 'MWI', ZM: 'ZMB', ZW: 'ZWE', ZA: 'ZAF', NA: 'NAM', BW: 'BWA', MG: 'MDG', AE: 'ARE', SA: 'SAU', QA: 'QAT', KW: 'KWT',
  OM: 'OMN', BH: 'BHR', JO: 'JOR', LB: 'LBN', SY: 'SYR', IQ: 'IRQ', YE: 'YEM', TR: 'TUR', AF: 'AFG', PK: 'PAK', BD: 'BGD', IN: 'IND',
  MM: 'MMR', PH: 'PHL', ID: 'IDN', HT: 'HTI', CO: 'COL', VE: 'VEN', UA: 'UKR', GB: 'GBR', FR: 'FRA', BE: 'BEL', CH: 'CHE', CA: 'CAN',
  US: 'USA', DE: 'DEU', NL: 'NLD', IT: 'ITA', ES: 'ESP',
};

export function createReliefWebSearch(options: { appName: string; fetch: FetchLike; limit?: number }): SearchSource {
  return {
    name: 'reliefweb',
    label: 'reliefweb',
    countries: Object.keys(ISO3),
    search: async (q) => {
      const iso3 = ISO3[q.country.toUpperCase()];
      if (!iso3) return [];
      const url = `https://api.reliefweb.int/v2/jobs?appname=${encodeURIComponent(options.appName)}`;
      const body = obj(
        await postJson(options.fetch, 'reliefweb', url, {
          query: { value: q.what, fields: ['title'], operator: 'AND' },
          filter: { field: 'country.iso3', value: iso3 },
          fields: { include: ['title', 'body', 'how_to_apply', 'url', 'source.name', 'country.iso3', 'city.name', 'date.created'] },
          sort: ['date.created:desc'],
          limit: Math.min(100, options.limit ?? 50),
        }),
      );
      return arr(body.data)
        .map((item) => {
          const row = obj(item);
          const f = obj(row.fields);
          const postedAt = toIso(obj(f.date).created);
          const city = str(obj(arr(f.city)[0]).name);
          const text = (html: unknown) => tidy(decodeEntities(stripTags(str(html).replace(/<\/(p|li|div|h\d)>|<br\s*\/?>/gi, '\n'))));
          // How to apply often names the recruiter's e-mail address: kept with the advert so the e-mail route can use it.
          const description = [text(f.body), text(f.how_to_apply) ? `How to apply:\n${text(f.how_to_apply)}` : ''].filter(Boolean).join('\n\n');
          return normaliseJob({
            source: 'reliefweb',
            externalId: str(row.id),
            title: tidy(decodeEntities(str(f.title))),
            employer: str(obj(arr(f.source)[0]).name),
            location: city || q.country,
            country: q.country.toUpperCase(),
            ...(city ? { city } : {}),
            url: str(f.url),
            applyUrl: str(f.url),
            description,
            ...(postedAt ? { postedAt } : {}),
          });
        })
        .filter(present);
    },
  };
}
