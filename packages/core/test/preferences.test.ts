import { describe, expect, it } from 'vitest';
import { EMPTY_PREFERENCES, inScope, matchJob, preferencesOf } from '../src';
import { contractTypeOf } from '../src/sources/common';
import type { Criterion, Job, Preferences } from '../src';

type Place = Pick<Job, 'country' | 'city' | 'language'>;
const prefs = (p: Partial<Preferences> = {}): Preferences => ({ languages: [], countries: [], cities: [], ...p });

const BIRMINGHAM: Place = { country: 'GB', city: 'Birmingham', language: 'en' };
const GLASGOW: Place = { country: 'GB', city: 'Glasgow', language: 'en' };
const DUBLIN: Place = { country: 'IE', city: 'Dublin', language: 'en' };
const LYON_FR: Place = { country: 'FR', city: 'Lyon', language: 'fr' };
const KINSHASA_FR: Place = { country: 'CD', city: 'Kinshasa', language: 'fr' };
const ABIDJAN_EN: Place = { country: 'CI', city: 'Abidjan', language: 'en' };
const EVERY: Place[] = [BIRMINGHAM, GLASGOW, DUBLIN, LYON_FR, KINSHASA_FR, ABIDJAN_EN];

describe('inScope: if nothing is selected, everything is available', () => {
  it('passes every job when all three lists are empty, or there are no preferences at all', () => {
    for (const job of EVERY) {
      expect(inScope(job, prefs())).toBe(true);
      expect(inScope(job, EMPTY_PREFERENCES)).toBe(true);
      expect(inScope(job, undefined)).toBe(true);
    }
    // Even a job the system knows almost nothing about.
    expect(inScope({}, prefs())).toBe(true);
    expect(inScope({ language: 'fr' }, undefined)).toBe(true);
  });

  it('is a pure function: it does not change its arguments and gives the same answer twice', () => {
    const p = prefs({ languages: ['French'], countries: ['FR'], cities: ['Lyon'] });
    const before = JSON.stringify(p);
    const job = { ...LYON_FR };
    expect(inScope(job, p)).toBe(inScope(job, p));
    expect(JSON.stringify(p)).toBe(before);
    expect(job).toEqual(LYON_FR);
  });
});

describe('inScope: countries', () => {
  it('empty countries = any country', () => {
    for (const job of EVERY) expect(inScope(job, prefs({ countries: [] }))).toBe(true);
  });

  it('with countries selected, only jobs in those countries pass', () => {
    const p = prefs({ countries: ['GB', 'CD'] });
    expect(EVERY.map((j) => inScope(j, p))).toEqual([true, true, false, false, true, false]);
  });

  it('compares codes without regard to case or spaces', () => {
    expect(inScope({ country: 'gb' }, prefs({ countries: [' GB '] }))).toBe(true);
    expect(inScope({ country: 'GB' }, prefs({ countries: ['gb'] }))).toBe(true);
  });

  it('a job whose country is unknown is out of scope once any country is selected, and in scope otherwise', () => {
    expect(inScope({ city: 'Somewhere' }, prefs({ countries: ['GB'] }))).toBe(false);
    expect(inScope({ city: 'Somewhere' }, prefs())).toBe(true);
  });
});

describe('inScope: cities only narrow the country they belong to', () => {
  it('a selected city narrows its own country and leaves every other country alone', () => {
    const p = prefs({ cities: ['Birmingham'] });
    expect(inScope(BIRMINGHAM, p)).toBe(true);
    expect(inScope(GLASGOW, p)).toBe(false); // same country, different city
    expect(inScope(DUBLIN, p)).toBe(true); // no country filter, no Irish city selected
    expect(inScope(LYON_FR, p)).toBe(true);
    expect(inScope(KINSHASA_FR, p)).toBe(true);
  });

  it('a job in a selected country with no selected city in that country still passes', () => {
    const p = prefs({ countries: ['GB', 'IE'], cities: ['Birmingham'] });
    expect(inScope(BIRMINGHAM, p)).toBe(true);
    expect(inScope(GLASGOW, p)).toBe(false);
    expect(inScope(DUBLIN, p)).toBe(true); // Ireland is selected and no Irish city narrows it
    expect(inScope(LYON_FR, p)).toBe(false); // France is not selected
  });

  it('several cities in one country: any of them passes', () => {
    const p = prefs({ cities: ['Birmingham', 'Glasgow'] });
    expect(inScope(BIRMINGHAM, p)).toBe(true);
    expect(inScope(GLASGOW, p)).toBe(true);
    expect(inScope({ country: 'GB', city: 'London' }, p)).toBe(false);
  });

  it('a city in a country that is not selected does not let that country in', () => {
    const p = prefs({ countries: ['GB'], cities: ['Lyon'] });
    expect(inScope(LYON_FR, p)).toBe(false);
    expect(inScope(BIRMINGHAM, p)).toBe(true);
    expect(inScope(GLASGOW, p)).toBe(true); // Lyon narrows France, not the UK
  });

  it('matches city names without regard to case, accents or spacing, and accepts "City, CC"', () => {
    expect(inScope({ country: 'GB', city: 'birmingham ' }, prefs({ cities: ['  BIRMINGHAM'] }))).toBe(true);
    expect(inScope({ country: 'FR', city: 'Lille' }, prefs({ cities: ['Lille, FR'] }))).toBe(true);
    expect(inScope({ country: 'FR', city: 'Lyon' }, prefs({ cities: ['Lille, FR'] }))).toBe(false);
    expect(inScope({ country: 'BE', city: 'Brussels' }, prefs({ cities: ['Lille, FR'] }))).toBe(true);
  });

  it('a job with no city, in a country narrowed by a city, cannot be shown to be in that city', () => {
    expect(inScope({ country: 'GB' }, prefs({ cities: ['Birmingham'] }))).toBe(false);
    expect(inScope({ country: 'IE' }, prefs({ cities: ['Birmingham'] }))).toBe(true);
  });

  it('a city OpennJob cannot place in a country narrows nothing', () => {
    for (const job of EVERY) expect(inScope(job, prefs({ cities: ['Atlantis'] }))).toBe(true);
  });
});

describe('inScope: languages', () => {
  it('an empty languages list excludes nothing', () => {
    for (const job of EVERY) expect(inScope(job, prefs({ languages: [] }))).toBe(true);
  });

  it('a job whose application language is not among a non-empty list is out of scope', () => {
    expect(EVERY.map((j) => inScope(j, prefs({ languages: ['English'] })))).toEqual([true, true, true, false, false, true]);
    expect(EVERY.map((j) => inScope(j, prefs({ languages: ['French'] })))).toEqual([false, false, false, true, true, false]);
    expect(EVERY.map((j) => inScope(j, prefs({ languages: ['English', 'French'] })))).toEqual([true, true, true, true, true, true]);
  });

  it('languages a form cannot be written in (Lingala, German, ...) do not bring any job into scope by themselves', () => {
    expect(EVERY.map((j) => inScope(j, prefs({ languages: ['Lingala', 'German'] })))).toEqual([false, false, false, false, false, false]);
    expect(inScope(KINSHASA_FR, prefs({ languages: ['Lingala', 'French'] }))).toBe(true);
  });

  it('a job with no stated language is treated as English', () => {
    expect(inScope({ country: 'GB' }, prefs({ languages: ['English'] }))).toBe(true);
    expect(inScope({ country: 'GB' }, prefs({ languages: ['French'] }))).toBe(false);
  });

  it('compares language names without regard to case', () => {
    expect(inScope(LYON_FR, prefs({ languages: [' french '] }))).toBe(true);
  });
});

describe('inScope: the three rules together', () => {
  it('every rule must pass', () => {
    const p = prefs({ languages: ['French'], countries: ['FR', 'CD'], cities: ['Kinshasa'] });
    expect(inScope(LYON_FR, p)).toBe(true); // France selected, no French city selected
    expect(inScope(KINSHASA_FR, p)).toBe(true);
    expect(inScope({ country: 'CD', city: 'Kolwezi', language: 'fr' }, p)).toBe(false); // DRC is narrowed to Kinshasa
    expect(inScope({ country: 'CD', city: 'Kinshasa', language: 'en' }, p)).toBe(false); // right place, wrong language
    expect(inScope({ country: 'SN', city: 'Dakar', language: 'fr' }, p)).toBe(false); // right language, wrong country
  });

  it('agrees with a brute-force statement of the rule over every combination', () => {
    const countryOf: Record<string, string> = { Birmingham: 'GB', Glasgow: 'GB', Lyon: 'FR', Kinshasa: 'CD' };
    const subsets = <T>(items: T[]): T[][] => items.reduce<T[][]>((acc, item) => [...acc, ...acc.map((s) => [...s, item])], [[]]);
    const jobs: Place[] = [...EVERY, { country: 'CD', city: 'Kolwezi', language: 'fr' }, { country: 'FR', city: 'Lyon', language: 'en' }];
    let checked = 0;
    for (const languages of subsets(['English', 'French'])) {
      for (const countries of subsets(['GB', 'FR', 'CD'])) {
        for (const cities of subsets(['Birmingham', 'Glasgow', 'Lyon', 'Kinshasa'])) {
          for (const job of jobs) {
            const countryOk = countries.length === 0 || countries.includes(job.country as string);
            const citiesHere = cities.filter((c) => countryOf[c] === job.country);
            const cityOk = citiesHere.length === 0 || citiesHere.includes(job.city as string);
            const languageOk = languages.length === 0 || languages.includes(job.language === 'fr' ? 'French' : 'English');
            expect(inScope(job, { languages, countries, cities }), JSON.stringify({ job, languages, countries, cities })).toBe(countryOk && cityOk && languageOk);
            checked += 1;
          }
        }
      }
    }
    expect(checked).toBe(4 * 8 * 16 * 8);
  });
});

describe('preferencesOf', () => {
  it('returns empty lists for a profile with no preferences, and a copy otherwise', () => {
    // searchTypes (PRO-3) was added after this test was written; empty means all three.
    expect(preferencesOf(undefined)).toEqual({ languages: [], countries: [], cities: [], searchTypes: [] });
    expect(preferencesOf({})).toEqual({ languages: [], countries: [], cities: [], searchTypes: [] });
    const stored = { languages: ['French'], countries: ['CD'], cities: ['Kinshasa'] };
    const copy = preferencesOf({ preferences: stored });
    expect(copy).toEqual({ ...stored, searchTypes: [] });
    copy.languages.push('German');
    expect(stored.languages).toEqual(['French']);
    expect(EMPTY_PREFERENCES).toEqual({ languages: [], countries: [], cities: [], searchTypes: [] });
  });
});

describe('matching: a selected language is evidence for a criterion that asks for it', () => {
  const crit = (label: string, essential: boolean, ...keywords: string[]): Criterion => ({ label, essential, keywords });
  const job = {
    criteria: [crit('Grid and HV systems', true, 'grid', 'hv'), crit('French, fluent', true, 'french', 'français'), crit('German language', false, 'german')],
    requiresRegistration: false,
  };
  /** Fictional. Says nothing about languages. */
  const CV = 'Delivered a 400kV grid connection as client-side construction manager.\nLed HV commissioning for two substations.';

  it('without preferences the language criteria are unmet', () => {
    const m = matchJob(job, CV, undefined);
    expect(m.hits.map((h) => h.matched)).toEqual([true, false, false]);
    expect(m.score).toBe(40);
    expect(m.unmetEssential).toEqual(['French, fluent']);
  });

  it('an EMPTY language list never counts as evidence of speaking a language', () => {
    for (const preferences of [{ languages: [] }, { languages: ['', '  '] }, undefined]) {
      const m = matchJob(job, CV, undefined, preferences);
      expect(m.hits.map((h) => h.matched)).toEqual([true, false, false]);
      expect(m.hits.some((h) => h.statedLanguage !== undefined)).toBe(false);
      expect(m.score).toBe(40);
      expect(m.unmetEssential).toEqual(['French, fluent']);
    }
  });

  it('a selected language meets the criterion that asks for it, and only that one', () => {
    const m = matchJob(job, CV, undefined, { languages: ['French'] });
    expect(m.hits.map((h) => h.matched)).toEqual([true, true, false]);
    expect(m.hits[1]).toMatchObject({ matched: true, statedLanguage: 'French' });
    // There is no CV sentence behind it, and the result says so.
    expect(m.hits[1]?.evidence).toBeUndefined();
    expect(m.hits[1]?.keyword).toBeUndefined();
    expect(m.score).toBe(80);
    expect(m.unmetEssential).toEqual([]);
    expect(matchJob(job, CV, undefined, { languages: ['french', 'GERMAN'] }).score).toBe(100);
  });

  it('a selected language is not evidence for anything that does not ask for a language', () => {
    const m = matchJob({ criteria: [crit('Data centre delivery', true, 'data centre'), crit('Francophone Africa experience', false, 'drc', 'senegal')], requiresRegistration: false }, CV, undefined, { languages: ['English', 'Swahili'] });
    expect(m.hits.map((h) => h.matched)).toEqual([false, false]);
    expect(m.score).toBe(0);
  });

  it('a criterion offering two languages is met by selecting either', () => {
    const either = { criteria: [crit('French or Arabic language', false, 'french', 'arabic')], requiresRegistration: false };
    expect(matchJob(either, CV, undefined, { languages: ['Arabic'] }).hits[0]).toMatchObject({ matched: true, statedLanguage: 'Arabic' });
    expect(matchJob(either, CV, undefined, { languages: ['German'] }).hits[0]?.matched).toBe(false);
  });

  it('CV evidence is preferred over the stated language when the CV has it', () => {
    const cv = `${CV}\nI speak fluent French and Lingala.`;
    const hit = matchJob(job, cv, undefined, { languages: ['French'] }).hits[1];
    expect(hit).toMatchObject({ matched: true, keyword: 'french', evidence: 'I speak fluent French and Lingala.' });
    expect(hit?.statedLanguage).toBeUndefined();
  });

  it('selecting a language does not make anyone eligible for a job that needs a credential', () => {
    const m = matchJob({ ...job, requiredCredential: 'sc' }, CV, undefined, { languages: ['French', 'German'] });
    expect(m).toMatchObject({ score: 100, eligible: false, missingCredential: 'sc' });
  });
});

describe('spec T-02 and T-04: scope by place and by search type', () => {
  const job = (country: string | undefined, city?: string, contractType?: 'permanent' | 'contract') => ({ country, city, language: 'en' as const, contractType });
  const prefs = (p: Partial<{ countries: string[]; cities: string[]; searchTypes: ('uk-permanent' | 'uk-contract' | 'international')[] }>) => ({ languages: [], countries: [], cities: [], searchTypes: [], ...p });

  it('T-02: nothing selected excludes nothing; a country excludes others; a city narrows only its own country', () => {
    const jobs = [job('GB', 'Birmingham'), job('GB', 'Leeds'), job('FR', 'Lyon'), job('CD', 'Kinshasa'), job(undefined)];
    expect(jobs.filter((j) => inScope(j, prefs({})))).toHaveLength(5);
    expect(jobs.filter((j) => inScope(j, prefs({ countries: ['GB'] }))).map((j) => j.city)).toEqual(['Birmingham', 'Leeds']);
    const narrowed = jobs.filter((j) => inScope(j, prefs({ countries: ['GB', 'FR'], cities: ['Birmingham'] })));
    expect(narrowed.map((j) => j.city)).toEqual(['Birmingham', 'Lyon']); // Leeds out; France untouched
  });

  it('T-04: no search type returns permanent, contract and international; "UK contract" alone returns only UK contracts', () => {
    const jobs = [job('GB', 'Leeds', 'permanent'), job('GB', 'Derby', 'contract'), job('GB', 'York'), job('DE', 'Frankfurt', 'contract')];
    expect(jobs.filter((j) => inScope(j, prefs({})))).toHaveLength(4);
    expect(jobs.filter((j) => inScope(j, prefs({ searchTypes: ['uk-contract'] }))).map((j) => j.city)).toEqual(['Derby']);
    expect(jobs.filter((j) => inScope(j, prefs({ searchTypes: ['uk-permanent'] }))).map((j) => j.city)).toEqual(['Leeds']);
    expect(jobs.filter((j) => inScope(j, prefs({ searchTypes: ['international'] }))).map((j) => j.city)).toEqual(['Frankfurt']);
    // A UK job of unknown type passes only when both UK types are chosen.
    expect(jobs.filter((j) => inScope(j, prefs({ searchTypes: ['uk-permanent', 'uk-contract'] }))).map((j) => j.city)).toEqual(['Leeds', 'Derby', 'York']);
  });

  it('DIS-3: contract type comes from the employment type, then the wording, and is never guessed', () => {
    expect(contractTypeOf('Contract', 'Site Manager', '')).toBe('contract');
    expect(contractTypeOf('Full-time, permanent', 'Site Manager', '')).toBe('permanent');
    expect(contractTypeOf(undefined, 'Interim Programme Lead', '£500 per day outside IR35')).toBe('contract');
    expect(contractTypeOf(undefined, 'Site Manager', 'A permanent role.')).toBe('permanent');
    expect(contractTypeOf(undefined, 'Site Manager', 'Lead the site.')).toBeUndefined();
  });
});
