/**
 * What OpennJob searches for, for one person: built from their CV and their preferences, never
 * from a server setting. The job titles come from the CV; the places from the cities and countries
 * they chose, or their home country when they chose none. Job-search APIs (Adzuna, Reed) are asked
 * these searches; employers' boards list everything and are filtered by matching instead.
 *
 * The person may also name companies to search for (preferences.targetEmployers): each is asked as
 * an exact phrase in each country searched, so adverts by that company, and adverts that name it
 * (its contractors' jobs on its projects), are found. They are scored against the CV like any other.
 *
 * Only a job title or a company name, and a place, leave OpennJob in a search: no name of the
 * person, contact detail or CV text.
 */
import { cityCountry } from './geo';
import type { SearchQuery } from './sources/common';
import type { Profile } from './types';

/**
 * Job titles OpennJob recognises in a CV, across its industry packs (English and French).
 * A heuristic list: a title not on it is not searched for. Longer titles are matched first, so
 * "senior project manager" is not also counted as "project manager".
 */
export const ROLE_TITLES: readonly string[] = [
  // construction, infrastructure, rail, energy, data centres
  'site manager', 'senior site manager', 'project manager', 'senior project manager', 'project director', 'programme manager',
  'construction manager', 'contracts manager', 'package manager', 'design manager', 'commercial manager', 'quantity surveyor',
  'senior quantity surveyor', 'estimator', 'planner', 'project planner', 'site engineer', 'civil engineer', 'structural engineer',
  'project engineer', 'electrical engineer', 'mechanical engineer', 'commissioning manager', 'commissioning engineer',
  'health and safety manager', 'hse manager', 'quality manager', 'document controller', 'bim manager', 'bim coordinator',
  'building services manager', 'mep manager', 'operations manager', 'delivery manager', 'site supervisor', 'foreman',
  'rail engineer', 'signalling engineer', 'track engineer', 'substation engineer', 'grid engineer', 'power engineer',
  'data centre technician', 'critical facilities manager', 'facilities manager', 'electrician',
  // healthcare
  'registered nurse', 'staff nurse', 'nurse', 'healthcare assistant', 'health care assistant', 'care assistant', 'support worker',
  'senior carer', 'carer', 'midwife', 'ward manager',
  // French
  'chef de projet', 'directeur de projet', 'conducteur de travaux', 'chef de chantier', 'ingénieur génie civil', 'ingénieur travaux',
  'ingénieur électricien', 'responsable hse', 'infirmier', 'infirmière', 'aide-soignant', 'aide-soignante',
];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The job titles in a CV, best first: a title in the first lines (the headline and the most recent
 * role) counts most, then how often it appears. At most `max`.
 */
export function titlesFromCv(cvText: string, max = 3): string[] {
  const lines = cvText.split('\n').map((l) => l.trim()).filter(Boolean);
  let text = lines.join('\n').toLowerCase();
  const lineStarts = lines.reduce<number[]>((acc, l, i) => (acc.push(i === 0 ? 0 : (acc[i - 1] ?? 0) + (lines[i - 1]?.length ?? 0) + 1), acc), []);
  const lineOf = (index: number) => lineStarts.filter((start) => start <= index).length - 1;
  const found: { title: string; score: number; first: number }[] = [];
  for (const title of [...ROLE_TITLES].sort((a, b) => b.length - a.length)) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escape(title).replace(/\s+/g, '\\s+')}s?(?![\\p{L}\\p{N}])`, 'giu');
    const hits = [...text.matchAll(re)];
    const first = hits[0]?.index;
    if (first === undefined) continue;
    // The headline (first three lines) counts most, then the first twelve (the most recent roles), then how often.
    const line = lineOf(first);
    found.push({ title, score: hits.length + (line < 3 ? 5 : line < 12 ? 2 : 0), first });
    // Blank what was matched (same length), so a shorter title inside it is not counted again.
    text = text.replace(re, (m) => ' '.repeat(m.length));
  }
  return found
    .sort((a, b) => b.score - a.score || a.first - b.first)
    .slice(0, max)
    .map((f) => f.title);
}

/** The person's home country: from their town when OpennJob knows it, else the UK (the platform's base). */
export function homeCountry(profile: Pick<Profile, 'city'>): string {
  return cityCountry(profile.city ?? '') ?? 'GB';
}

export interface SearchPlan {
  /** Job titles read from the CV, best first. Empty: no search can be made. */
  titles: string[];
  /** Places searched: chosen cities (with their country), chosen countries, else the home country. */
  places: { where?: string; country: string }[];
  /** Companies the person asked to search for by name. */
  employers: string[];
  queries: SearchQuery[];
}

/** At most this many company searches per person, on top of the title searches. */
export const MAX_EMPLOYER_QUERIES = 60;

/** The searches for one person, at most `maxQueries`: titles in rank order, each in every place. */
export function searchPlan(profile: Pick<Profile, 'cvText' | 'city' | 'preferences'>, maxQueries = 6, maxEmployerQueries = MAX_EMPLOYER_QUERIES): SearchPlan {
  const titles = titlesFromCv(profile.cvText ?? '', 5);
  const prefs = profile.preferences;
  const places: { where?: string; country: string }[] = [];
  const countriesWithCity = new Set<string>();
  const chosenCountries = (prefs?.countries ?? []).map((c) => c.toUpperCase());
  for (const city of prefs?.cities ?? []) {
    const country = cityCountry(city) ?? (chosenCountries.length === 1 ? chosenCountries[0] : undefined);
    if (!country) continue;
    places.push({ where: city, country });
    countriesWithCity.add(country);
  }
  for (const c of chosenCountries) if (!countriesWithCity.has(c)) places.push({ country: c });
  if (places.length === 0) places.push({ country: homeCountry(profile) });
  const queries: SearchQuery[] = [];
  for (const what of titles) for (const p of places) if (queries.length < maxQueries) queries.push({ what, ...p });
  // Companies: once per country (a company's jobs are fewer, so a city would miss most of them).
  const firstSpelling = new Map<string, string>();
  for (const e of (prefs?.targetEmployers ?? []).map((n) => n.trim()).filter(Boolean)) if (!firstSpelling.has(e.toLowerCase())) firstSpelling.set(e.toLowerCase(), e);
  const employers = [...firstSpelling.values()];
  const countries = [...new Set(places.map((p) => p.country))];
  let employerQueries = 0;
  for (const what of employers) for (const country of countries) if (employerQueries < maxEmployerQueries) (queries.push({ what, country }), (employerQueries += 1));
  return { titles, places, employers, queries };
}

/** The same search asked once, however many people need it. */
export function queryKey(q: SearchQuery): string {
  return `${q.what.toLowerCase()}|${(q.where ?? '').toLowerCase()}|${q.country.toUpperCase()}`;
}

/**
 * Which of the person's target companies a job belongs to: the advertiser itself ('employer'), or a
 * company the advert names, such as the client of a contractor ('named'). Whole words, any case.
 */
export function targetEmployerOf(job: { employer: string; description: string }, names: readonly string[] | undefined): { name: string; how: 'employer' | 'named' } | undefined {
  const re = (name: string) => new RegExp(`(?<![\\p{L}\\p{N}])${escape(name.trim()).replace(/\s+/g, '\\s+')}(?![\\p{L}\\p{N}])`, 'iu');
  const list = (names ?? []).filter((n) => n.trim());
  const own = list.find((n) => re(n).test(job.employer));
  if (own) return { name: own, how: 'employer' };
  const named = list.find((n) => re(n).test(job.description));
  return named ? { name: named, how: 'named' } : undefined;
}
