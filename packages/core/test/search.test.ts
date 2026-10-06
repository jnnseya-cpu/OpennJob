import { describe, expect, it } from 'vitest';
import { homeCountry, queryKey, searchPlan, titlesFromCv } from '../src';

/** Searches come from the person's CV and preferences, never from a server setting. Fictional CVs. */
const SITE_MANAGER_CV = [
  'Kofi Mensah (fictional)',
  'Senior Site Manager - commercial and residential construction',
  'Site manager on a 120-home scheme for Example Homes (fictional), 2021 to 2025.',
  'Assistant to the project manager on a school extension.',
  'SMSTS, CSCS Black Card, first aid.',
].join('\n');

describe('titlesFromCv', () => {
  it('ranks the headline title first, does not double-count a title inside a longer one, and caps the list', () => {
    expect(titlesFromCv(SITE_MANAGER_CV)).toEqual(['senior site manager', 'site manager', 'project manager']);
    expect(titlesFromCv(SITE_MANAGER_CV, 1)).toEqual(['senior site manager']);
  });

  it('reads French titles and returns nothing when no known title is present', () => {
    expect(titlesFromCv('Conducteur de travaux, génie civil, Abidjan.')).toEqual(['conducteur de travaux']);
    expect(titlesFromCv('I enjoy hiking and chess.')).toEqual([]);
  });
});

describe('searchPlan', () => {
  const base = { cvText: SITE_MANAGER_CV, city: 'Manchester' };

  it('no preferences: every title in the home country', () => {
    const plan = searchPlan(base);
    expect(plan.places).toEqual([{ country: 'GB' }]);
    expect(plan.queries).toEqual([
      { what: 'senior site manager', country: 'GB' },
      { what: 'site manager', country: 'GB' },
      { what: 'project manager', country: 'GB' },
    ]);
  });

  it('chosen cities with their country, chosen countries without a city, capped in rank order', () => {
    const plan = searchPlan({ ...base, preferences: { languages: [], countries: ['GB', 'FR'], cities: ['London'] } }, 4);
    expect(plan.places).toEqual([{ where: 'London', country: 'GB' }, { country: 'FR' }]);
    expect(plan.queries).toEqual([
      { what: 'senior site manager', where: 'London', country: 'GB' },
      { what: 'senior site manager', country: 'FR' },
      { what: 'site manager', where: 'London', country: 'GB' },
      { what: 'site manager', country: 'FR' },
    ]);
  });

  it('no title in the CV: no search at all, rather than a guess', () => {
    expect(searchPlan({ cvText: 'I enjoy hiking.', city: 'Leeds' }).queries).toEqual([]);
  });

  it('home country from the town, else the UK; one key per distinct search', () => {
    expect(homeCountry({ city: 'Lyon' })).toBe('FR');
    expect(homeCountry({ city: 'Nowhere-in-particular' })).toBe('GB');
    expect(queryKey({ what: 'Site Manager', where: 'London', country: 'gb' })).toBe(queryKey({ what: 'site manager', where: 'london', country: 'GB' }));
  });
});
