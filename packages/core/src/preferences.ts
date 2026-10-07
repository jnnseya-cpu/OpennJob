import type { Job, Preferences, Profile } from './types';
import { JOB_LANGUAGE_NAME } from './languages';
import { cityCountry, foldPlace, parseCity } from './geo';

export const EMPTY_PREFERENCES: Preferences = { languages: [], countries: [], cities: [], searchTypes: [] };

export function preferencesOf(profile: Pick<Profile, 'preferences'> | undefined): Preferences {
  const p = profile?.preferences;
  return {
    languages: [...(p?.languages ?? [])],
    countries: [...(p?.countries ?? [])],
    cities: [...(p?.cities ?? [])],
    searchTypes: [...(p?.searchTypes ?? [])],
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
 *  - cities: a city only narrows the country it belongs to. With "Lyon" selected, jobs in
 *    France must be in Lyon; jobs in every other country are unaffected. So a job in a
 *    selected country with no selected city in that country still passes. A city whose
 *    country OpennJob cannot tell (see geo.ts) narrows nothing.
 *  - languages: empty excludes nothing. Otherwise the language the application is written
 *    in (job.language, "en" when not stated) must be one of them.
 */
export function inScope(
  job: Pick<Job, 'country' | 'city' | 'language'> & Partial<Pick<Job, 'contractType'>>,
  preferences: Preferences | undefined,
): boolean {
  const p = preferences ?? EMPTY_PREFERENCES;
  const country = job.country?.trim().toUpperCase();

  if (p.countries.length > 0) {
    if (!country || !p.countries.some((c) => c.trim().toUpperCase() === country)) return false;
  }

  if (country) {
    const citiesHere = p.cities.filter((c) => cityCountry(c) === country);
    if (citiesHere.length > 0) {
      const jobCity = job.city ? foldPlace(job.city) : '';
      if (!jobCity || !citiesHere.some((c) => foldPlace(parseCity(c).city) === jobCity)) return false;
    }
  }

  if (p.languages.length > 0) {
    const needed = JOB_LANGUAGE_NAME[job.language ?? 'en'].toLowerCase();
    if (!p.languages.some((l) => l.trim().toLowerCase() === needed)) return false;
  }
  return matchesSearchTypes(job, p.searchTypes);
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
