/*
 * UNVERIFIED RESPONSE SHAPES.
 * Employers' own careers sites, searched directly: every job found comes with the employer's own
 * application page, so the queue can apply there (when that application system is switched on).
 * The operator lists each site only after reading its terms of use (CLAUDE.md rule 5,
 * deploy/add-career-site.sh). Both shapes below are written from memory of how these sites work
 * and have NOT been checked against a live site. The tests use fixtures in that remembered shape.
 *
 * Workday (https://<tenant>.wd<N>.myworkdayjobs.com/<locale>/<site>): the careers page's own
 * search calls
 *   POST https://<host>/wday/cxs/<tenant>/<site>/jobs  { appliedFacets: {}, limit, offset: 0, searchText }
 *   -> { total, jobPostings: [{ title, externalPath, locationsText, postedOn }] }
 *   GET  https://<host>/wday/cxs/<tenant>/<site><externalPath>
 *   -> { jobPostingInfo: { title, jobDescription (HTML), location, externalUrl }, hiringOrganization: { name } }
 *
 * SAP SuccessFactors career sites (the "Recruiting Marketing" sites, often on the employer's own
 * domain, e.g. https://jobs.example.org): a job feed per search
 *   GET https://<host>/services/rss/job/?locale=en_GB&keywords=(<what>)
 *   -> RSS: <item><title>Title (Place)</title><link>job page</link><description>HTML</description><pubDate>
 * The older SuccessFactors portals (career4.successfactors.com/career?company=...) have no such
 * feed and are not searched.
 */
import { arr, decodeEntities, getJson, getText, normaliseJob, obj, postJson, present, str, stripTags, tidy, toIso } from './common';
import type { FetchLike, SearchSource } from './common';
import { inferPlace, normaliseCountryCode } from '../geo';
import type { Job } from '../types';

export interface CareerSite {
  kind: 'workday' | 'successfactors';
  /** The careers site's address as the operator gave it. */
  url: string;
  host: string;
  employer: string;
  /** ISO alpha-2, upper case: the country its jobs are in (the sites do not say reliably). */
  country: string;
  /** Workday only. */
  tenant?: string;
  site?: string;
}

const WORKDAY_HOST = /(^|\.)(myworkdayjobs|myworkdaysite)\.com$/i;
const LOCALE = /^[a-z]{2}-[A-Z]{2}$/;

/**
 * One careers site from "url|Employer|GB". A Workday address is recognised by its host; any other
 * https address is taken as a SuccessFactors career site. Anything malformed is undefined.
 */
export function parseCareerSite(entry: string): CareerSite | undefined {
  const [rawUrl = '', rawEmployer = '', rawCountry = ''] = entry.split('|').map((x) => x.trim());
  const employer = rawEmployer;
  const country = rawCountry.toUpperCase();
  if (!employer || !/^[A-Z]{2}$/.test(country)) return undefined;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:') return undefined;
  const host = url.hostname.toLowerCase();
  if (WORKDAY_HOST.test(host)) {
    const tenant = host.split('.')[0] ?? '';
    const site = url.pathname.split('/').filter(Boolean).find((p) => !LOCALE.test(p)) ?? '';
    if (!tenant || !site) return undefined;
    return { kind: 'workday', url: url.toString(), host, employer, country, tenant, site };
  }
  return { kind: 'successfactors', url: url.toString(), host, employer, country };
}

/** Sites from OPENNJOB_CAREER_SITES: entries separated by commas or new lines. */
export function parseCareerSites(value: string | undefined): CareerSite[] {
  return (value ?? '')
    .split(/[,\n]/)
    .map((e) => e.trim())
    .filter(Boolean)
    .map(parseCareerSite)
    .filter(present);
}

/** How many jobs one search of one site reads (each is one more call for its whole advert). */
export const CAREER_SITE_JOBS_PER_SEARCH = 20;
/** One title is searched once per site per refresh, whatever the number of places asked. */
const MEMO_MS = 30 * 60_000;

/** The town from a site's location text ("Warwick", "Warwick, GB"); none for "3 Locations" or "Remote". */
const townOf = (location: string): string | undefined => {
  const first = location.split(/[,;|]/)[0]?.trim() ?? '';
  return first && !/\d|locations?|remote|multiple/i.test(first) ? first : undefined;
};

const htmlText = (html: string) => tidy(decodeEntities(stripTags(html.replace(/<\/(p|li|div|h\d)>|<br\s*\/?>/gi, '\n'))));

async function workdayJobs(site: CareerSite, what: string, fetchFn: FetchLike, limit: number): Promise<Job[]> {
  const base = `https://${site.host}/wday/cxs/${encodeURIComponent(site.tenant ?? '')}/${encodeURIComponent(site.site ?? '')}`;
  const label = `workday:${site.host}`;
  const list = obj(await postJson(fetchFn, label, `${base}/jobs`, { appliedFacets: {}, limit, offset: 0, searchText: what }));
  const postings = arr(list.jobPostings).map(obj).slice(0, limit);
  const jobs: Job[] = [];
  for (const p of postings) {
    const path = str(p.externalPath);
    if (!path.startsWith('/')) continue;
    let info: Record<string, unknown> = {};
    let organisation = '';
    try {
      const detail = obj(await getJson(fetchFn, label, `${base}${path}`));
      info = obj(detail.jobPostingInfo);
      organisation = str(obj(detail.hiringOrganization).name);
    } catch {
      // The advert could not be read: the posting is kept with what the list gave.
    }
    // A worldwide careers site lists jobs in many countries: one whose location names another
    // country is not this site's country's job.
    const where = str(info.location) || str(p.locationsText);
    // The advert's own country (jobPostingInfo.country.descriptor, as remembered), else the place.
    const stated = str(obj(info.country).descriptor);
    const named = (stated ? inferPlace(stated).country ?? normaliseCountryCode(stated) : undefined) ?? inferPlace(where).country;
    if (named && named !== site.country) continue;
    // A worldwide site whose advert could not be read says nothing of its country: not kept.
    if (!stated && !info.title && !inferPlace(where).country) continue;
    const external = str(info.externalUrl);
    const page = /^https:\/\//i.test(external) ? external : `https://${site.host}/${site.site ?? ''}${path}`;
    const job = normaliseJob({
      source: 'workday',
      externalId: `${site.host}${path}`,
      title: str(info.title) || str(p.title),
      employer: site.employer || organisation,
      location: str(info.location) || str(p.locationsText),
      country: site.country,
      ...(townOf(str(info.location) || str(p.locationsText)) ? { city: townOf(str(info.location) || str(p.locationsText)) } : {}),
      url: page,
      applyUrl: page,
      description: htmlText(str(info.jobDescription)) || str(p.title),
      ...(toIso(p.postedOn) ? { postedAt: toIso(p.postedOn) } : {}),
    });
    if (job) jobs.push(job);
  }
  return jobs;
}

const tag = (xml: string, name: string): string => {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(xml);
  return (m?.[1] ?? '').replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1').trim();
};

async function successFactorsJobs(site: CareerSite, what: string, fetchFn: FetchLike, limit: number): Promise<Job[]> {
  const label = `successfactors:${site.host}`;
  const url = `https://${site.host}/services/rss/job/?locale=en_GB&keywords=${encodeURIComponent(`(${what})`)}`;
  const xml = await getText(fetchFn, label, url);
  const items = xml.split(/<item[\s>]/i).slice(1).slice(0, limit);
  return items
    .map((item) => {
      const link = decodeEntities(tag(item, 'link'));
      if (!/^https:\/\//i.test(link)) return undefined;
      const rawTitle = decodeEntities(tag(item, 'title'));
      // "Project Manager (Warwick, GB)": the place is in brackets at the end.
      const place = /\(([^()]*)\)\s*$/.exec(rawTitle)?.[1] ?? '';
      const title = place ? rawTitle.slice(0, rawTitle.lastIndexOf('(')).trim() : rawTitle;
      const posted = toIso(tag(item, 'pubDate'));
      return normaliseJob({
        source: 'successfactors',
        externalId: link.replace(/^https:\/\//i, ''),
        title,
        employer: site.employer,
        location: place,
        country: site.country,
        ...(townOf(place) ? { city: townOf(place) } : {}),
        url: link,
        applyUrl: link,
        description: htmlText(decodeEntities(tag(item, 'description'))) || title,
        ...(posted ? { postedAt: posted } : {}),
      });
    })
    .filter(present);
}

/**
 * The careers sites as one search source per kind. A site is asked only for its own country, and
 * a title once per half hour (the same title is asked for every place, and these sites search by
 * title only). A site that fails is reported as that site's error, not as the whole source's.
 */
export function createCareerSiteSearch(options: { kind: CareerSite['kind']; sites: CareerSite[]; fetch: FetchLike; jobsPerSearch?: number; now?: () => number }): SearchSource {
  const sites = options.sites.filter((s) => s.kind === options.kind);
  const limit = options.jobsPerSearch ?? CAREER_SITE_JOBS_PER_SEARCH;
  const now = options.now ?? Date.now;
  const memo = new Map<string, { at: number; jobs: Promise<Job[]> }>();
  const ask = (site: CareerSite, what: string) => {
    const key = `${site.host}|${site.site ?? ''}|${what.toLowerCase()}`;
    const hit = memo.get(key);
    if (hit && now() - hit.at < MEMO_MS) return hit.jobs;
    const jobs = (site.kind === 'workday' ? workdayJobs(site, what, options.fetch, limit) : successFactorsJobs(site, what, options.fetch, limit)).catch((err: unknown) => {
      memo.delete(key);
      throw err;
    });
    memo.set(key, { at: now(), jobs });
    return jobs;
  };
  return {
    name: options.kind,
    label: options.kind,
    countries: [...new Set(sites.map((s) => s.country))],
    search: async (q) => {
      const here = sites.filter((s) => s.country === q.country.toUpperCase());
      const settled = await Promise.allSettled(here.map((s) => ask(s, q.what)));
      const jobs = settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
      const failed = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (failed && jobs.length === 0) throw failed.reason;
      return jobs;
    },
  };
}
