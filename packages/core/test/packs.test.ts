import { describe, expect, it } from 'vitest';
import {
  COUNTRIES,
  CREDENTIAL_IDS,
  ISO_COUNTRY_CODES,
  KNOWN_CITIES,
  LANGUAGES,
  PACKS,
  PACK_IDS,
  REGION_IDS,
  cityCountry,
  classifyPack,
  countryName,
  credentialLabel,
  credentialOf,
  detectLanguage,
  detectRequiredCredential,
  getPack,
  inferPlace,
  isCountryCode,
  languagesAskedBy,
  matchJob,
  nmcPinOf,
  normaliseCountryCode,
  normaliseLanguage,
  parseCity,
  regionOf,
  requiredCredentialOf,
} from '../src';
import type { Criterion } from '../src';
import { CV_TEXT, PASSPORT } from './fixtures/cv';

describe('pack registry', () => {
  it('has the six packs with the ids and names the demo uses', () => {
    expect(PACKS.map((p) => [p.id, p.name])).toEqual([
      ['con', 'Construction and infrastructure'],
      ['dc', 'Data centres and mission-critical'],
      ['en', 'Energy and grid'],
      ['rail', 'Rail and transport'],
      ['fr', 'Francophone Africa and diaspora'],
      ['hc', 'Healthcare'],
    ]);
    expect(PACK_IDS).toEqual(['con', 'dc', 'en', 'rail', 'fr', 'hc']);
  });

  it('gives every pack credential fields, declarations and three questions, each complete', () => {
    for (const pack of PACKS) {
      expect(pack.credentialFields.length, pack.id).toBeGreaterThan(0);
      expect(pack.declarations.length, pack.id).toBeGreaterThan(0);
      expect(pack.questions, pack.id).toHaveLength(3);
      for (const f of [...pack.credentialFields, ...pack.declarations]) {
        expect(f.id).toMatch(/^[a-z]+$/);
        expect(f.label.length).toBeGreaterThan(2);
      }
      expect(new Set(pack.credentialFields.map((f) => f.id)).size).toBe(pack.credentialFields.length);
      // A declaration may only depend on a credential the same pack's passport has a line for.
      for (const d of pack.declarations) if (d.requiresCredential) expect(pack.credentialFields.map((f) => f.id)).toContain(d.requiresCredential);
    }
  });

  it('uses the infrastructure passport and declarations for the five non-healthcare packs', () => {
    for (const id of ['con', 'dc', 'en', 'rail', 'fr'] as const) {
      const pack = getPack(id);
      expect(pack?.credentialFields.map((f) => f.id)).toEqual(['prof', 'sc', 'cdm', 'pm', 'cscs', 'smsts', 'pts', 'lang', 'rtw']);
      expect(pack?.declarations).toEqual([
        { id: 'rtw', label: 'Right to work or visa sponsorship for this country' },
        { id: 'sc', label: 'Security clearance and vetting declaration', requiresCredential: 'sc' },
        { id: 'conv', label: 'Criminal convictions declaration' },
        { id: 'coi', label: 'Conflict of interest declaration' },
        { id: 'ref', label: "Referees' names and contact details" },
      ]);
    }
  });

  it('keeps healthcare as it was: NMC PIN, DBS, and the fitness-to-practise declaration tied to the PIN', () => {
    const hc = getPack('hc');
    expect(hc?.credentialFields).toEqual([
      { id: 'pin', label: 'Professional registration number (NMC PIN)' },
      { id: 'dbs', label: 'DBS' },
      { id: 'rtw', label: 'Countries you can work in' },
    ]);
    expect(hc?.declarations.map((d) => [d.id, d.requiresCredential])).toEqual([['pin', 'pin'], ['rtw', undefined], ['dbs', undefined], ['conv', undefined], ['ftp', 'pin']]);
  });

  it('does not share arrays between packs', () => {
    expect(getPack('con')?.credentialFields).not.toBe(getPack('dc')?.credentialFields);
    expect(getPack('con')?.declarations[0]).not.toBe(getPack('dc')?.declarations[0]);
  });

  it('lists every credential id once and labels them', () => {
    expect([...CREDENTIAL_IDS].sort()).toEqual(['cdm', 'cscs', 'dbs', 'lang', 'pin', 'pm', 'prof', 'pts', 'rtw', 'sc', 'smsts']);
    expect(credentialLabel('sc')).toBe('Security clearance');
    expect(credentialLabel('pin')).toBe('Professional registration number (NMC PIN)');
    expect(credentialLabel('nope')).toBe('nope');
    expect(getPack('nope')).toBeUndefined();
    expect(getPack(undefined)).toBeUndefined();
  });
});

describe('classifyPack', () => {
  const classify = (title: string, description = '', extra: { country?: string; language?: 'en' | 'fr' } = {}) => classifyPack({ title, description, ...extra });

  it.each([
    ['Staff Nurse - Acute Medical Ward', 'Current NMC registration.', 'hc'],
    ['Healthcare Assistant', 'Personal care in a care home.', 'hc'],
    ['Senior Construction Manager - Hyperscale Data Centre', 'MEP coordination.', 'dc'],
    ['Commissioning Manager', 'Mission-critical colocation campus.', 'dc'],
    ['Senior Project Manager - Main Line Electrification', 'Rail programme delivery.', 'rail'],
    ['Programme Delivery Lead - Metro Extension', '', 'rail'],
    ['Head of Construction - HVDC Converter Station', 'Grid and substation delivery.', 'en'],
    ['Site Manager - 200MW Solar and Storage', '', 'en'],
    ['Construction Lead', 'Offshore wind onshore works.', 'en'],
    ['Senior Construction Manager - Hospital New Build', 'CDM 2015 duties. NEC4.', 'con'],
    ['Quantity Surveyor', 'Mixed-use regeneration.', 'con'],
  ])('%s -> %s', (title, description, pack) => {
    expect(classify(title, description)).toBe(pack);
  });

  it('prefers the more specific sector: a data-centre construction job is "dc", a rail BIM job is "rail"', () => {
    expect(classify('Construction Manager', 'Building a data centre under NEC4 with CDM duties.')).toBe('dc');
    expect(classify('BIM Manager', 'High-speed rail programme.')).toBe('rail');
    expect(classify('Construction Manager', 'Substation civil works under CDM.')).toBe('en');
  });

  it('puts infrastructure jobs in French-speaking African countries, and diaspora roles, in the francophone pack', () => {
    expect(classify('Directeur de projet - Infrastructure énergétique', 'Réseau haute tension.', { country: 'CD', language: 'fr' })).toBe('fr');
    expect(classify('Country Construction Lead - Data Centre', 'Client-side authority.', { country: 'CI' })).toBe('fr');
    expect(classify('Chargé de programme diaspora', 'Réseau associatif.', { country: 'BE', language: 'fr' })).toBe('fr');
    // The same job in a country outside that list stays in its sector pack.
    expect(classify('Country Construction Lead - Data Centre', 'Client-side authority.', { country: 'NG' })).toBe('dc');
    expect(classify('Responsable BIM - Ligne à grande vitesse', 'Projet ferroviaire.', { country: 'FR', language: 'fr' })).toBe('rail');
  });

  it('keeps healthcare first, wherever the job is', () => {
    expect(classify('Infirmier diplômé', 'Soins en service de médecine.', { country: 'SN', language: 'fr' })).toBe('hc');
    expect(classify('Registered Nurse - Private Hospital', '', { country: 'AE' })).toBe('hc');
  });

  it('matches whole words only and returns undefined for an unrelated job', () => {
    expect(classify('Accountant', 'Month-end close and VAT returns.')).toBeUndefined();
    expect(classify('Marketing Manager', 'Metropolitan area campaigns.')).toBeUndefined();
    expect(classify('Nursery Assistant', 'Working with children aged two to four.')).toBeUndefined();
    expect(classify('', '')).toBeUndefined();
  });
});

describe('countries and regions', () => {
  it('has the full ISO 3166-1 alpha-2 list: 249 unique, well-formed, sorted codes with names', () => {
    expect(ISO_COUNTRY_CODES).toHaveLength(249);
    expect(new Set(ISO_COUNTRY_CODES).size).toBe(249);
    expect([...ISO_COUNTRY_CODES]).toEqual([...ISO_COUNTRY_CODES].sort());
    for (const c of COUNTRIES) {
      expect(c.code).toMatch(/^[A-Z]{2}$/);
      expect(c.name.trim().length).toBeGreaterThan(2);
      expect(REGION_IDS).toContain(c.region);
    }
    expect(new Set(COUNTRIES.map((c) => c.name)).size).toBe(249);
  });

  it('agrees with the region data that ships with Node (ICU): every code is a known region, and nothing well known is missing', () => {
    const names = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' });
    for (const code of ISO_COUNTRY_CODES) expect(names.of(code), code).toBeTruthy();
    for (const code of ['GB', 'IE', 'FR', 'DE', 'DK', 'BE', 'CD', 'CG', 'SN', 'CI', 'NG', 'ZA', 'SA', 'QA', 'AE', 'US', 'CA', 'BR', 'IN', 'CN', 'JP', 'AU', 'NZ']) {
      expect(ISO_COUNTRY_CODES, code).toContain(code);
    }
    // Not ISO 3166-1 alpha-2 codes: "UK" is reserved, "EU" is a union, "XK" is user-assigned.
    for (const code of ['UK', 'EU', 'XK', 'ZZ', 'AA']) expect(ISO_COUNTRY_CODES, code).not.toContain(code);
  });

  it('normalises and validates codes', () => {
    expect(normaliseCountryCode(' gb ')).toBe('GB');
    expect(normaliseCountryCode('Cd')).toBe('CD');
    for (const bad of ['UK', 'GBR', 'G', '', 'United Kingdom', 12, null, undefined]) expect(normaliseCountryCode(bad), String(bad)).toBeUndefined();
    expect(isCountryCode('fr')).toBe(true);
    expect(isCountryCode('xx')).toBe(false);
    expect(countryName('cd')).toBe('DR Congo');
    expect(countryName('ZZ')).toBeUndefined();
    expect(countryName(undefined)).toBeUndefined();
  });

  it.each([
    ['GB', 'uk'], ['IE', 'eu'], ['DE', 'eu'], ['DK', 'eu'], ['FR', 'eu'], ['BE', 'eu'],
    ['CD', 'africa'], ['SN', 'africa'], ['CI', 'africa'], ['NG', 'africa'], ['ZA', 'africa'], ['MA', 'africa'],
    ['SA', 'mena'], ['QA', 'mena'], ['AE', 'mena'],
    ['US', 'am'], ['CA', 'am'], ['BR', 'am'],
    ['IN', 'apac'], ['AU', 'apac'], ['AQ', 'other'],
  ])('regionOf(%s) is %s', (country, region) => {
    expect(regionOf(country)).toBe(region);
  });

  it('regionOf ignores case and spaces and returns undefined for an unknown or missing country', () => {
    expect(regionOf(' gb ')).toBe('uk');
    expect(regionOf('UK')).toBeUndefined();
    expect(regionOf('')).toBeUndefined();
    expect(regionOf(undefined)).toBeUndefined();
  });

  it('gives every country exactly one region and every region at least one country', () => {
    for (const region of REGION_IDS) expect(COUNTRIES.some((c) => c.region === region), region).toBe(true);
    for (const code of ISO_COUNTRY_CODES) expect(REGION_IDS).toContain(regionOf(code));
    expect(COUNTRIES.filter((c) => c.region === 'uk').map((c) => c.code)).toEqual(['GB']);
  });

  it('knows the country of the demo cities, accepts "City, CC", and admits what it does not know', () => {
    for (const [city, code] of Object.entries(KNOWN_CITIES)) expect(ISO_COUNTRY_CODES, city).toContain(code);
    expect(cityCountry('Lyon')).toBe('FR');
    expect(cityCountry(' kinshasa ')).toBe('CD');
    expect(cityCountry('Northern Cape')).toBe('ZA');
    expect(cityCountry('Lille, FR')).toBe('FR');
    expect(parseCity('Lille, fr')).toEqual({ city: 'Lille', country: 'FR' });
    expect(parseCity('Lille, XX')).toEqual({ city: 'Lille, XX', country: undefined });
    expect(cityCountry('Lille')).toBeUndefined();
  });

  it('infers a place from free-text locations, and returns nothing rather than guess', () => {
    expect(inferPlace('Birmingham')).toEqual({ country: 'GB', city: 'Birmingham' });
    expect(inferPlace('Leeds, UK')).toEqual({ country: 'GB', city: 'Leeds' });
    expect(inferPlace('Lyon, France')).toEqual({ country: 'FR', city: 'Lyon' });
    expect(inferPlace('Germany')).toEqual({ country: 'DE' });
    expect(inferPlace('Remote')).toEqual({});
    expect(inferPlace(undefined)).toEqual({});
  });
});

describe('languages', () => {
  it('offers the demo language list and normalises names', () => {
    expect([...LANGUAGES]).toEqual(['English', 'French', 'Lingala', 'Swahili', 'Arabic', 'German', 'Spanish', 'Portuguese']);
    expect(normaliseLanguage(' FRENCH ')).toBe('French');
    expect(normaliseLanguage('Klingon')).toBeUndefined();
    expect(normaliseLanguage(3)).toBeUndefined();
  });

  it('tells which languages a criterion asks for', () => {
    const asked = (label: string, ...keywords: string[]) => languagesAskedBy({ label, keywords });
    expect(asked('French, fluent', 'french', 'français')).toEqual(['French']);
    expect(asked('French or Arabic language', 'french', 'arabic')).toEqual(['French', 'Arabic']);
    expect(asked('German language', 'german')).toEqual(['German']);
    expect(asked('Maîtrise du français', 'français')).toEqual(['French']);
    expect(asked('Medication administration', 'medication')).toEqual([]);
    // Whole words: "Germany experience" is not a request for German.
    expect(asked('Germany experience', 'germany')).toEqual([]);
  });

  it('guesses French or English from the wording, defaulting to English', () => {
    expect(detectLanguage("Parlez-nous d'un programme d'infrastructure que vous avez redressé.")).toBe('fr');
    expect(detectLanguage('Nous recrutons pour le poste de directeur de projet au sein de notre équipe.')).toBe('fr');
    expect(detectLanguage('Tell me about a programme you recovered.')).toBe('en');
    expect(detectLanguage('How would you adapt UK delivery standards to a site in the DRC or Senegal?')).toBe('en');
    expect(detectLanguage('')).toBe('en');
    expect(detectLanguage('Responsable BIM')).toBe('en'); // too little to go on
  });
});

describe('credential passport', () => {
  it('reads credentials from the map, trimmed, and returns an empty string for anything absent or blank', () => {
    const passport = { credentials: { prof: ' MCIOB 0000000 ', sc: 'SC (fictional)', cscs: '   ' } };
    expect(credentialOf(passport, 'prof')).toBe('MCIOB 0000000');
    expect(credentialOf(passport, 'sc')).toBe('SC (fictional)');
    expect(credentialOf(passport, 'cscs')).toBe('');
    expect(credentialOf(passport, 'pts')).toBe('');
    expect(credentialOf(undefined, 'sc')).toBe('');
    expect(credentialOf({}, 'pin')).toBe('');
  });

  it('keeps the existing NMC PIN accessor working for both the v1 field and the map', () => {
    expect(nmcPinOf(PASSPORT)).toBe('18A1234E');
    expect(nmcPinOf({ credentials: { pin: '20B5678C' } })).toBe('20B5678C');
    expect(nmcPinOf({ nmcPin: '18A1234E', credentials: { pin: '20B5678C' } })).toBe('20B5678C'); // the map wins
    expect(nmcPinOf({ nmcPin: '18A1234E', credentials: { pin: '  ' } })).toBe('18A1234E');
    expect(nmcPinOf({ credentials: { sc: 'SC' } })).toBe('');
    expect(nmcPinOf(undefined)).toBe('');
  });

  it('requiresRegistration: true means requiredCredential "pin"; an explicit credential wins', () => {
    expect(requiredCredentialOf({ requiresRegistration: true })).toBe('pin');
    expect(requiredCredentialOf({ requiresRegistration: false })).toBeUndefined();
    expect(requiredCredentialOf({ requiresRegistration: false, requiredCredential: 'sc' })).toBe('sc');
    expect(requiredCredentialOf({ requiresRegistration: true, requiredCredential: 'pin' })).toBe('pin');
    expect(requiredCredentialOf({ requiresRegistration: false, requiredCredential: '  ' })).toBeUndefined();
  });

  const criteria: Criterion[] = [{ label: 'Medication administration', essential: true, keywords: ['medication'] }];

  it('eligibility: a job needing security clearance needs credentials.sc; an NMC PIN does not open it', () => {
    const job = { criteria, requiresRegistration: false, requiredCredential: 'sc' };
    expect(matchJob(job, CV_TEXT, PASSPORT)).toMatchObject({ eligible: false, missingCredential: 'sc', score: 100 });
    expect(matchJob(job, CV_TEXT, { credentials: { sc: 'SC (fictional)' } })).toMatchObject({ eligible: true });
    expect(matchJob(job, CV_TEXT, { credentials: { sc: 'SC (fictional)' } }).missingCredential).toBeUndefined();
    expect(matchJob(job, CV_TEXT, undefined)).toMatchObject({ eligible: false, missingCredential: 'sc' });
  });

  it('eligibility: requiresRegistration still means the PIN, from either place it can be stored', () => {
    const job = { criteria, requiresRegistration: true };
    expect(matchJob(job, CV_TEXT, { nmcPin: '18A1234E' }).eligible).toBe(true);
    expect(matchJob(job, CV_TEXT, { credentials: { pin: '18A1234E' } }).eligible).toBe(true);
    expect(matchJob(job, CV_TEXT, { credentials: { sc: 'SC' } })).toMatchObject({ eligible: false, missingCredential: 'pin' });
    expect(matchJob({ criteria, requiresRegistration: false }, CV_TEXT, undefined).eligible).toBe(true);
  });

  it('detects the required credential from an advert: PIN, security clearance, or none', () => {
    expect(detectRequiredCredential('Staff Nurse', 'Current NMC registration is essential.')).toBe('pin');
    expect(detectRequiredCredential('Programme Manager - Government Estates', 'You must be SC cleared.')).toBe('sc');
    expect(detectRequiredCredential('Construction Lead', 'Security clearance (SC) is required for this site.')).toBe('sc');
    expect(detectRequiredCredential('Construction Lead', 'Security clearance is desirable.')).toBeUndefined();
    expect(detectRequiredCredential('Construction Lead', 'You must be willing to undergo security clearance.')).toBeUndefined();
    expect(detectRequiredCredential('Site Manager', 'SMSTS and CSCS required.')).toBeUndefined();
  });
});
