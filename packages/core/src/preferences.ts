import type { Job, Preferences, Profile } from './types';
import { JOB_LANGUAGE_NAME } from './languages';
import { cityCountry, foldPlace, parseCity, placeInCity } from './geo';

export const EMPTY_PREFERENCES: Preferences = { languages: [], countries: [], cities: [], searchTypes: [] };

export function preferencesOf(profile: Pick<Profile, 'preferences'> | undefined): Preferences {
  const p = profile?.preferences;
  return {
    languages: [...(p?.languages ?? [])],
    countries: [...(p?.countries ?? [])],
    cities: [...(p?.cities ?? [])],
    searchTypes: [...(p?.searchTypes ?? [])],
    ...(p?.searchTitles?.length ? { searchTitles: [...p.searchTitles] } : {}),
    ...(typeof p?.minScore === 'number' ? { minScore: p.minScore } : {}),
    ...(p?.targetEmployers?.length ? { targetEmployers: [...p.targetEmployers] } : {}),
    ...(typeof p?.targetInterviewRate === 'number' ? { targetInterviewRate: p.targetInterviewRate } : {}),
  };
}

/**
 * Is this job inside what the candidate asked to see?
 *
 * The owner's rule: IF NOTHING IS SELECTED, EVERYTHING IS AVAILABLE.
 *
 *  - countries: empty = any country. Otherwise the job's country must be one of them.
 *    A job whose country is unknown cannot be shown to be in a selected country, so it
 *    is out of scope while any country is selected.
 *  - cities: a chosen city narrows the country it belongs to (owner decision, 15 October 2026:
 *    reverted to a hard filter). With "Birmingham" selected, UK jobs must be in Birmingham; jobs
 *    in other selected countries are unaffected. A job in a selected country with no selected city
 *    in that country still passes; a job with no readable city, in a country narrowed by a city,
 *    does not. A city whose country OpennJob cannot tell narrows nothing.
 *    Owner decision OD-7 (16 October 2026): CONTRACT roles are searched country-wide. Interim and
 *    contract work is national in most fields, so a chosen city narrows only permanent and
 *    unknown-type roles in that country; a contract role in that country passes wherever it is.
 *  - languages: empty excludes nothing. Otherwise the language the application is written
 *    in (job.language, "en" when not stated) must be one of them.
 */
export function inScope(
  job: Pick<Job, 'country' | 'city' | 'language'> & Partial<Pick<Job, 'contractType' | 'location'>>,
  preferences: Preferences | undefined,
): boolean {
  const p = preferences ?? EMPTY_PREFERENCES;
  const country = job.country?.trim().toUpperCase();

  if (p.countries.length > 0) {
    if (!country || !p.countries.some((c) => c.trim().toUpperCase() === country)) return false;
  }

  if (country) {
    const citiesHere = p.cities.filter((c) => cityCountry(c) === country);
    if (citiesHere.length > 0 && job.contractType !== 'contract') {
      // A chosen city matches a job by its town name OR by a postcode in that town's area, because
      // adverts usually give a postcode ("B24 6BF"), not a town name (see placeInCity). Contract roles
      // skip this narrowing (OD-7): they are searched country-wide.
      if (!citiesHere.some((c) => placeInCity(job.city, job.location, parseCity(c).city))) return false;
    }
  }

  if (p.languages.length > 0) {
    const needed = JOB_LANGUAGE_NAME[job.language ?? 'en'].toLowerCase();
    if (!p.languages.some((l) => l.trim().toLowerCase() === needed)) return false;
  }
  return matchesSearchTypes(job, p.searchTypes);
}

/**
 * A soft preference used to rank, never to exclude (owner decision, 14 October 2026): true when the
 * job is in one of the person's chosen cities. A chosen city with a known country (see geo.ts) only
 * prefers jobs in that country; one whose country OpennJob cannot tell prefers jobs of that name
 * anywhere. Nothing chosen, or a job with no city, is not preferred (false), not excluded.
 */
export function cityPreferred(job: Pick<Job, 'country' | 'city'>, preferences: Preferences | undefined): boolean {
  const p = preferences ?? EMPTY_PREFERENCES;
  if (!job.city || p.cities.length === 0) return false;
  const country = job.country?.trim().toUpperCase();
  const jobCity = foldPlace(job.city);
  return p.cities.some((c) => {
    const cc = cityCountry(c);
    if (cc && country && cc !== country) return false;
    return foldPlace(parseCity(c).city) === jobCity;
  });
}

/**
 * Search types (PRO-3). Nothing selected: everything. A UK job needs "UK permanent" or "UK
 * contract" matching its contract type; a UK job whose type is not known passes only when both
 * UK types are selected (the type then does not matter). A job outside the UK needs
 * "international". A job whose country is not known passes only when all three are selected.
 */
export function matchesSearchTypes(job: Pick<Job, 'country'> & Partial<Pick<Job, 'contractType'>>, types: readonly string[] | undefined): boolean {
  const t = types ?? [];
  if (t.length === 0) return true;
  const country = job.country?.trim().toUpperCase();
  if (!country) return t.includes('uk-permanent') && t.includes('uk-contract') && t.includes('international');
  if (country !== 'GB') return t.includes('international');
  if (job.contractType === 'permanent') return t.includes('uk-permanent');
  if (job.contractType === 'contract') return t.includes('uk-contract');
  return t.includes('uk-permanent') && t.includes('uk-contract');
}
