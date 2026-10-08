import { afterEach, describe, expect, it } from 'vitest';
import { createSampleSource, CV_TAILOR_SYSTEM_PROMPT } from '@opennjob/core';
import type { FetchLike } from '@opennjob/core';
import { buildSearchSources, DEFAULT_APPLY_THRESHOLD, applyThresholdOf, buildSources, loadConfig } from '../src/deps';
import type { OpennJobDeps } from '../src/deps';
import { PASSPORT, PROFILE, TOKEN, createTestApp, scriptedLlm, testConfig } from './helpers';
import type { TestApp } from './helpers';

/** A fictional confirmation page, as "I have submitted it" records it (APP-7). */
const RECEIPT = { pageUrl: 'https://example.org/applied/thanks', confirmationText: 'Thank you, your application has been received. (fictional)' };

let t: TestApp;
afterEach(async () => {
  await t?.app.close();
});

const EMPLOYER_KEY = 'employer-key-not-a-secret';
const BASE_CONFIG = testConfig();

/** Entirely fictional person. Says nothing about languages, security clearance or registration. */
const INFRA_CV = [
  'Chartered construction manager (MCIOB) with fourteen years on major infrastructure programmes.',
  'Led multi-contractor site teams on a hyperscale data centre, coordinating MEP and HV packages through commissioning.',
  'Discharged CDM 2015 duties and administered NEC4 contracts.',
  'Holds the SMSTS certificate and plans in Primavera P6.',
  'Client-side lead managing Tier 1 contractors, QA/QC and HSE.',
].join('\n');

const INFRA_PROFILE = {
  firstName: 'Mireille',
  lastName: 'Kabongo-Example',
  email: 'mireille.kabongo@example.org',
  phone: '07700 900555',
  addressLine1: '4 Sample Yard',
  city: 'Birmingham',
  postcode: 'B2 2ZZ',
  cvText: INFRA_CV,
};
const INFRA_PASSPORT = { rightToWorkConfirmed: true, credentials: { prof: 'MCIOB 0000000', cscs: '00000000' }, training: [], referees: [] };

type Prefs = { languages?: string[]; countries?: string[]; cities?: string[] };
interface MatchRow {
  job: { id: string; pack?: string; country?: string; city?: string; region?: string; language: string; origin: string; requiredCredential?: string };
  score: number;
  eligible: boolean;
  missingCredential?: string;
  hits: { label: string; matched: boolean; evidence?: string; statedLanguage?: string }[];
}

/** An API with the fictional demo jobs for every pack, and the infrastructure candidate stored. */
async function infra(options: { preferences?: Prefs; config?: Partial<OpennJobDeps['config']>; overrides?: Partial<OpennJobDeps>; passport?: object } = {}): Promise<TestApp> {
  t = await createTestApp({ sources: [createSampleSource({ allPacks: true })], config: { ...BASE_CONFIG, ...options.config }, ...options.overrides });
  await t.api.put('/profile').send({ ...INFRA_PROFILE, ...(options.preferences ? { preferences: options.preferences } : {}) }).expect(200);
  await t.api.put('/passport').send(options.passport ?? INFRA_PASSPORT).expect(200);
  await t.api.post('/jobs/refresh').expect(200);
  return t;
}

const setPreferences = (preferences: Prefs) => t.api.put('/profile').send({ ...INFRA_PROFILE, preferences }).expect(200);
const matches = async (query = ''): Promise<MatchRow[]> => (await t.api.get(`/jobs/matches${query}`).expect(200)).body;
const ids = (rows: { job: { id: string } }[]) => rows.map((m) => m.job.id).sort();
const employerPost = (body: object, key: string | null = EMPLOYER_KEY) => {
  const req = t.raw().post('/employer/jobs');
  return (key === null ? req : req.set('Authorization', `Bearer ${key}`)).send(body);
};

/** Fictional employer and vacancy. */
const EMPLOYER_JOB = {
  title: 'Construction Manager - Data Centre Fit-out',
  employer: 'Wrenfield Critical Build (example)',
  description: 'Wrenfield Critical Build (a fictional employer) needs a construction manager for a data centre fit-out.',
  country: 'gb',
  city: 'Leeds',
  applyUrl: 'https://example.org/apply/wrenfield-1',
  criteria: [
    { label: 'Data centre delivery', essential: true, keywords: ['data centre'] },
    { label: 'MEP coordination', essential: true, keywords: ['mep'] },
    { label: 'Fluent Klingon', essential: false, keywords: ['klingon'] },
  ],
};

describe('PUT/GET /profile: preferences', () => {
  it('a profile without preferences is stored as before', async () => {
    t = await createTestApp();
    const res = await t.api.put('/profile').send(PROFILE).expect(200);
    expect(res.body).toEqual(PROFILE);
    expect((await t.api.get('/profile').expect(200)).body.preferences).toBeUndefined();
  });

  it('stores and returns preferences, normalised: upper-case country codes, proper language names, no repeats', async () => {
    t = await createTestApp();
    const res = await t.api.put('/profile').send({ ...PROFILE, preferences: { languages: ['french', 'English', 'French'], countries: ['gb', 'cd', 'GB'], cities: ['Kinshasa', 'Lille, FR'] } }).expect(200);
    const expected = { languages: ['French', 'English'], countries: ['GB', 'CD'], cities: ['Kinshasa', 'Lille, FR'] };
    expect(res.body.preferences).toEqual(expected);
    expect((await t.api.get('/profile').expect(200)).body.preferences).toEqual(expected);
  });

  it('accepts empty lists and missing lists: nothing selected', async () => {
    t = await createTestApp();
    expect((await t.api.put('/profile').send({ ...PROFILE, preferences: {} }).expect(200)).body.preferences).toEqual({ languages: [], countries: [], cities: [] });
    expect((await t.api.put('/profile').send({ ...PROFILE, preferences: { languages: [], countries: [], cities: [] } }).expect(200)).body.preferences).toEqual({ languages: [], countries: [], cities: [] });
  });

  it('validates countries against the ISO list, languages against the language list, and cities it cannot place', async () => {
    t = await createTestApp();
    const bad = async (preferences: object, path: string) => {
      const res = await t.api.put('/profile').send({ ...PROFILE, preferences }).expect(400);
      expect(res.body.issues.map((i: { path: string }) => i.path), JSON.stringify(preferences)).toContain(path);
    };
    await bad({ countries: ['UK'] }, 'preferences.countries.0'); // "UK" is not an ISO 3166-1 alpha-2 code; GB is
    await bad({ countries: ['GB', 'United Kingdom'] }, 'preferences.countries.1');
    await bad({ countries: ['ZZ'] }, 'preferences.countries.0');
    await bad({ languages: ['Klingon'] }, 'preferences.languages.0');
    await bad({ cities: ['Atlantis'] }, 'preferences.cities.0');
    await bad({ countries: 'GB' }, 'preferences.countries');
    await bad({ regions: ['uk'] }, 'preferences');
    await t.api.get('/profile').expect(404); // nothing was stored by any of the rejected requests
  });

  it('records only counts in the profile.updated event', async () => {
    t = await createTestApp();
    await t.api.put('/profile').send({ ...PROFILE, preferences: { languages: ['French'], countries: ['CD', 'SN'], cities: ['Kinshasa'] } }).expect(200);
    const events = await t.deps.repository.listEvents('dev-user');
    expect(events.at(-1)).toMatchObject({ type: 'profile.updated', payload: { languages: 1, countries: 2, cities: 1 } });
    expect(JSON.stringify(events)).not.toMatch(/Kinshasa|French|Okafor/);
  });
});

describe('PUT/GET /passport: credential map', () => {
  it('stores credentials by id and still accepts the v1 nmcPin field', async () => {
    t = await createTestApp();
    const body = { ...PASSPORT, credentials: { prof: 'MCIOB 0000000', sc: 'SC (fictional)', lang: 'English, French' } };
    const res = await t.api.put('/passport').send(body).expect(200);
    expect(res.body.passport.credentials).toEqual(body.credentials);
    expect(res.body.passport.nmcPin).toBe('18A1234E');
    expect(res.body.training).toHaveLength(3); // the training-expiry list is unchanged
    expect((await t.api.get('/passport').expect(200)).body.passport.credentials).toEqual(body.credentials);
  });

  it('rejects unknown credential ids and empty values', async () => {
    t = await createTestApp();
    await t.api.put('/passport').send({ rightToWorkConfirmed: true, credentials: { blood: 'O+' } }).expect(400);
    await t.api.put('/passport').send({ rightToWorkConfirmed: true, credentials: { sc: '  ' } }).expect(400);
    await t.api.put('/passport').send({ rightToWorkConfirmed: true, credentials: ['sc'] }).expect(400);
  });

  it('credentials.pin makes a registration-only job eligible, like nmcPin does', async () => {
    t = await createTestApp();
    await t.api.put('/profile').send(PROFILE).expect(200);
    await t.api.post('/jobs/refresh').expect(200);
    const nurse = async () => (await matches()).find((m) => m.job.id === 'sample:staff-nurse-medical');
    expect(await nurse()).toMatchObject({ eligible: false, missingCredential: 'pin', job: { requiredCredential: 'pin' } });
    await t.api.put('/passport').send({ rightToWorkConfirmed: true, credentials: { pin: '18A1234E' } }).expect(200);
    expect(await nurse()).toMatchObject({ eligible: true });
  });
});

describe('GET /jobs/matches: packs, places and preferences', () => {
  it('returns pack, country, city, region, language and origin for every job', async () => {
    await infra();
    const rows = await matches();
    expect(rows.length).toBeGreaterThan(20);
    for (const m of rows) {
      expect(['con', 'dc', 'en', 'rail', 'fr', 'hc'], m.job.id).toContain(m.job.pack);
      expect(m.job.country, m.job.id).toMatch(/^[A-Z]{2}$/);
      expect(m.job.city, m.job.id).toBeTruthy();
      expect(['uk', 'eu', 'africa', 'mena', 'am'], m.job.id).toContain(m.job.region);
      expect(['en', 'fr'], m.job.id).toContain(m.job.language);
      expect(m.job.origin, m.job.id).toBe('discovered');
    }
    expect(rows.find((m) => m.job.id === 'sample:c1')).toMatchObject({ score: 100, eligible: true, job: { pack: 'con', country: 'GB', city: 'Birmingham', region: 'uk', language: 'en' } });
    expect(rows.find((m) => m.job.id === 'sample:c3')).toMatchObject({ eligible: false, missingCredential: 'sc', job: { requiredCredential: 'sc' } });
  });

  it('nothing selected: every stored job is available', async () => {
    await infra();
    const all = await matches();
    expect(all).toHaveLength((await t.deps.repository.listJobs()).length);
    await setPreferences({ languages: [], countries: [], cities: [] });
    expect(ids(await matches())).toEqual(ids(all));
  });

  it('applies the country preference', async () => {
    await infra({ preferences: { countries: ['GB', 'IE'] } });
    const rows = await matches();
    expect(rows.length).toBeGreaterThan(5);
    expect(new Set(rows.map((m) => m.job.country))).toEqual(new Set(['GB', 'IE']));
  });

  it('a city narrows only its own country: other selected countries still pass, with or without a city', async () => {
    await infra({ preferences: { countries: ['GB', 'DE', 'IE'], cities: ['Birmingham'] } });
    const rows = await matches();
    const uk = rows.filter((m) => m.job.country === 'GB');
    expect(uk.length).toBeGreaterThan(1);
    expect(uk.every((m) => m.job.city === 'Birmingham')).toBe(true);
    expect(ids(rows)).toContain('sample:d2'); // Frankfurt: Germany is selected and no German city narrows it
    expect(ids(rows)).toContain('sample:c4'); // Dublin
    expect(ids(rows)).not.toContain('sample:d1'); // Slough: the UK is narrowed to Birmingham
    expect(ids(rows)).not.toContain('sample:f1'); // Kinshasa: the DRC is not selected
  });

  it('a city with no country selected leaves the rest of the world available', async () => {
    await infra({ preferences: { cities: ['Birmingham'] } });
    const rows = await matches();
    expect(rows.filter((m) => m.job.country === 'GB').every((m) => m.job.city === 'Birmingham')).toBe(true);
    expect(new Set(rows.map((m) => m.job.country)).size).toBeGreaterThan(8);
  });

  it('applies the language preference to the language of the application', async () => {
    await infra({ preferences: { languages: ['French'] } });
    expect(ids(await matches())).toEqual(['sample:f1', 'sample:f2', 'sample:f3', 'sample:f4', 'sample:r4']);
    await setPreferences({ languages: ['English'] });
    const english = await matches();
    expect(english.every((m) => m.job.language === 'en')).toBe(true);
    expect(ids(english)).toContain('sample:f5'); // an English-language job in Côte d'Ivoire
    await setPreferences({ languages: ['English', 'French'] });
    expect(await matches()).toHaveLength((await t.deps.repository.listJobs()).length);
  });

  it('a selected language is evidence for a language criterion; an empty list is evidence of nothing', async () => {
    await infra();
    const f5 = async () => (await matches()).find((m) => m.job.id === 'sample:f5') as MatchRow;
    const before = await f5();
    expect(before.score).toBe(86);
    expect(before.hits.find((h) => h.label === 'French, working level')).toEqual({ label: 'French, working level', essential: false, matched: false });
    await setPreferences({ languages: [] });
    expect((await f5()).score).toBe(86);

    await setPreferences({ languages: ['English', 'French'] });
    const after = await f5();
    expect(after.score).toBe(100);
    // The hit says where it came from: the profile, not a CV sentence.
    expect(after.hits.find((h) => h.label === 'French, working level')).toEqual({ label: 'French, working level', essential: false, matched: true, statedLanguage: 'French' });
    for (const h of after.hits) if (h.evidence) expect(INFRA_CV).toContain(h.evidence);
  });

  it('filters by pack, region and country, alone and together', async () => {
    await infra();
    const all = await matches();
    for (const pack of ['con', 'dc', 'en', 'rail', 'fr', 'hc']) {
      const rows = await matches(`?pack=${pack}`);
      expect(rows.length, pack).toBeGreaterThanOrEqual(3);
      expect(ids(rows)).toEqual(ids(all.filter((m) => m.job.pack === pack)));
    }
    for (const region of ['uk', 'eu', 'africa', 'mena', 'am']) {
      const rows = await matches(`?region=${region}`);
      expect(rows.length, region).toBeGreaterThan(0);
      expect(ids(rows)).toEqual(ids(all.filter((m) => m.job.region === region)));
    }
    expect(await matches('?region=apac')).toEqual([]);
    expect(ids(await matches('?country=cd'))).toEqual(['sample:f1', 'sample:f2']);
    expect(ids(await matches('?country=DE'))).toEqual(['sample:d2']);
    expect(ids(await matches('?pack=dc&region=uk'))).toEqual(['sample:d1']);
    expect(ids(await matches('?pack=dc&min=80'))).toEqual(['sample:d1', 'sample:d2']);
    expect(await matches('?pack=hc&country=CD')).toEqual([]);
  });

  it('filters narrow the candidate preferences; they never widen them', async () => {
    await infra({ preferences: { countries: ['GB'] } });
    expect(await matches('?country=DE')).toEqual([]);
    expect(await matches('?region=africa')).toEqual([]);
    expect(ids(await matches('?pack=dc'))).toEqual(['sample:d1']);
  });

  it('validates the filters', async () => {
    await infra();
    for (const bad of ['pack=nursing', 'region=asia', 'country=UK', 'country=GBR', 'pack=']) await t.api.get(`/jobs/matches?${bad}`).expect(400);
    await t.api.get('/jobs/matches?pack=dc&min=101').expect(400);
  });
});

describe('POST /agent/run: the 80% rule', () => {
  it('prepares a draft for every in-scope, eligible job at or above 80 and leaves the rest alone', async () => {
    await infra();
    const all = await matches();
    const expected = all.filter((m) => m.eligible && m.score >= 80);
    expect(ids(expected)).toEqual(['sample:c1', 'sample:d1', 'sample:d2', 'sample:f5']);

    const res = await t.api.post('/agent/run').send({}).expect(200);
    expect(res.body.threshold).toBe(80);
    expect(res.body.mode).toBe('hybrid');
    expect(res.body.considered).toBe(all.length);
    expect(res.body.prepared.map((a: { jobId: string }) => a.jobId).sort()).toEqual(ids(expected));
    for (const a of res.body.prepared) {
      expect(a.score).toBeGreaterThanOrEqual(80);
      expect(a).toMatchObject({ status: 'draft', mode: 'hybrid', statementSource: 'fallback', confirmedFields: [] });
      expect(a.submittedAt).toBeUndefined();
      // No LLM: every line of every draft is a sentence from the CV.
      expect(a.statement.length).toBeGreaterThan(20);
      for (const line of a.statement.split('\n')) expect(INFRA_CV).toContain(line);
    }
    // Highest score first.
    const scores = res.body.prepared.map((a: { score: number }) => a.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(res.body.skipped).toEqual({ outOfScope: 0, belowThreshold: all.length - 4, ineligible: 0, alreadyPrepared: 0 });

    // Jobs below the threshold have no application at all.
    const stored = (await t.api.get('/applications').expect(200)).body;
    expect(stored.map((a: { jobId: string }) => a.jobId).sort()).toEqual(ids(expected));
    expect(stored.every((a: { status: string }) => a.status === 'draft')).toBe(true);
  });

  it('prepares drafts only: nothing is confirmed, nothing is submitted, in any mode', async () => {
    for (const mode of ['review', 'hybrid', 'auto']) {
      await infra();
      const res = await t.api.post('/agent/run').send({ mode }).expect(200);
      expect(res.body.prepared).toHaveLength(4);
      for (const a of res.body.prepared) expect(a).toMatchObject({ mode, status: 'draft', confirmedFields: [] });
      const types = (await t.deps.repository.listEvents('dev-user')).map((e) => e.type);
      expect(types).toContain('agent.run');
      expect(types).not.toContain('application.submitted');
      expect(types).not.toContain('application.confirmed');
      await t.app.close();
    }
  });

  it('takes a job scoring exactly the threshold and leaves one just below it', async () => {
    await infra({ config: { employerKey: EMPLOYER_KEY } });
    // Two essential criteria met (weight 4) and one desirable unmet (weight 1): 4/5 = 80 exactly.
    const exactly80 = (await employerPost(EMPLOYER_JOB).expect(201)).body;
    // One more unmet desirable criterion: 4/6 = 67.
    const below = (await employerPost({ ...EMPLOYER_JOB, title: 'Construction Manager - Data Centre Shell', applyUrl: 'https://example.org/apply/wrenfield-2', criteria: [...EMPLOYER_JOB.criteria, { label: 'Fluent Elvish', essential: false, keywords: ['elvish'] }] }).expect(201)).body;
    const rows = await matches();
    expect(rows.find((m) => m.job.id === exactly80.id)?.score).toBe(80);
    expect(rows.find((m) => m.job.id === below.id)?.score).toBe(67);
    const prepared = (await t.api.post('/agent/run').send({}).expect(200)).body.prepared.map((a: { jobId: string }) => a.jobId);
    expect(prepared).toContain(exactly80.id);
    expect(prepared).not.toContain(below.id);
  });

  it('reads the threshold from the configuration', async () => {
    await infra({ config: { applyThreshold: 88 } });
    let res = await t.api.post('/agent/run').send({}).expect(200);
    expect(res.body.threshold).toBe(88);
    expect(res.body.prepared.map((a: { jobId: string }) => a.jobId).sort()).toEqual(['sample:c1', 'sample:d1', 'sample:d2']); // 100, 89, 88; f5 at 86 is left alone
    await t.app.close();

    await infra({ config: { applyThreshold: 100 } });
    res = await t.api.post('/agent/run').send({}).expect(200);
    expect(res.body.prepared.map((a: { jobId: string }) => a.jobId)).toEqual(['sample:c1']);
    await t.app.close();

    await infra({ config: { applyThreshold: 0 } });
    res = await t.api.post('/agent/run').send({}).expect(200);
    const all = await matches();
    expect(res.body.prepared).toHaveLength(all.filter((m) => m.eligible).length);
    expect(res.body.skipped).toMatchObject({ belowThreshold: 0, ineligible: all.filter((m) => !m.eligible).length });
  });

  it('only takes jobs inside the candidate preferences', async () => {
    await infra({ preferences: { countries: ['GB'] } });
    let res = await t.api.post('/agent/run').send({}).expect(200);
    expect(res.body.prepared.map((a: { jobId: string }) => a.jobId).sort()).toEqual(['sample:c1', 'sample:d1']);
    expect(res.body.skipped.outOfScope).toBeGreaterThan(10);
    await t.app.close();

    await infra({ preferences: { countries: ['GB', 'DE'], cities: ['Birmingham'] } });
    res = await t.api.post('/agent/run').send({}).expect(200);
    expect(res.body.prepared.map((a: { jobId: string }) => a.jobId).sort()).toEqual(['sample:c1', 'sample:d2']);
    await t.app.close();

    await infra({ preferences: { languages: ['French'] } });
    res = await t.api.post('/agent/run').send({}).expect(200);
    // French only: the English-language jobs are out of scope however well they score. One French job reaches 80
    // (infrastructure and HV from the CV, French from the selected languages: 6 of 7).
    expect(res.body.prepared.map((a: { jobId: string; score: number }) => [a.jobId, a.score])).toEqual([['sample:f1', 86]]);
    expect(res.body.skipped.outOfScope).toBe(23);
  });

  it('skips a job the candidate is not eligible for, however well it scores, until the credential is stored', async () => {
    await infra({ config: { employerKey: EMPLOYER_KEY } });
    const cleared = (await employerPost({ ...EMPLOYER_JOB, requiredCredential: 'sc', criteria: EMPLOYER_JOB.criteria.slice(0, 2) }).expect(201)).body;
    expect((await matches()).find((m) => m.job.id === cleared.id)).toMatchObject({ score: 100, eligible: false, missingCredential: 'sc' });
    let res = await t.api.post('/agent/run').send({}).expect(200);
    expect(res.body.prepared.map((a: { jobId: string }) => a.jobId)).not.toContain(cleared.id);
    expect(res.body.skipped.ineligible).toBe(1);
    const direct = await t.api.post('/applications').send({ jobId: cleared.id }).expect(422);
    expect(direct.body.message).toMatch(/Security clearance/);

    await t.api.put('/passport').send({ ...INFRA_PASSPORT, credentials: { ...INFRA_PASSPORT.credentials, sc: 'SC (fictional)' } }).expect(200);
    res = await t.api.post('/agent/run').send({}).expect(200);
    expect(res.body.prepared.map((a: { jobId: string }) => a.jobId)).toEqual([cleared.id]);
    expect(res.body.skipped).toMatchObject({ ineligible: 0, alreadyPrepared: 4 });
  });

  it('does not draft the same job twice', async () => {
    await infra();
    expect((await t.api.post('/agent/run').send({}).expect(200)).body.prepared).toHaveLength(4);
    const again = (await t.api.post('/agent/run').send({}).expect(200)).body;
    expect(again.prepared).toEqual([]);
    expect(again.skipped.alreadyPrepared).toBe(4);
    expect((await t.api.get('/applications').expect(200)).body).toHaveLength(4);
  });

  it('a French job is drafted with the French opening and the French prompt', async () => {
    // A fictional CV that meets a French-language demo job (f1) once French is selected.
    const cvText = [
      'Client-side construction manager on major infrastructure programmes for fourteen years.',
      'Delivered a 400kV grid connection and HV substations.',
      'Worked in the DRC for three years on a hydro scheme near Kinshasa.',
    ].join('\n');
    t = await createTestApp({ sources: [createSampleSource({ allPacks: true })] });
    await t.api.put('/profile').send({ ...INFRA_PROFILE, cvText, preferences: { languages: ['French'] } }).expect(200);
    await t.api.post('/jobs/refresh').expect(200);
    let res = await t.api.post('/agent/run').send({}).expect(200);
    expect(res.body.prepared.map((a: { jobId: string }) => a.jobId)).toEqual(['sample:f1']);
    const draft = res.body.prepared[0];
    expect(draft.score).toBe(100);
    expect(draft.statement.startsWith('Madame, Monsieur,\n')).toBe(true);
    for (const line of draft.statement.split('\n').slice(2)) expect(cvText).toContain(line);
    expect(draft.statement).not.toMatch(/french|français/i); // selected in the profile, not evidenced by the CV, so not written
    await t.app.close();

    const llm = scriptedLlm();
    t = await createTestApp({ sources: [createSampleSource({ allPacks: true })], llm });
    await t.api.put('/profile').send({ ...INFRA_PROFILE, cvText, preferences: { languages: ['French'] } }).expect(200);
    await t.api.post('/jobs/refresh').expect(200);
    res = await t.api.post('/agent/run').send({}).expect(200);
    expect(res.body.prepared).toHaveLength(1);
    expect(llm.calls.filter((c) => c.system !== CV_TAILOR_SYSTEM_PROMPT)).toHaveLength(1); // one call drafts the statement, one rewrites the CV for the advert
    expect(llm.calls[0]?.system).toMatch(/formal French/);
    expect(llm.calls[0]?.system).toMatch(/Use only evidence that is present in the CV/);
    expect(llm.calls[0]?.prompt).toMatch(/NOT IN THE CV\. The applicant states in their profile that they speak French/);
  });

  it('needs a profile, validates the body, and puts no personal data in its event', async () => {
    t = await createTestApp();
    await t.api.post('/agent/run').send({}).expect(404);
    await t.app.close();
    await infra();
    await t.api.post('/agent/run').send({ mode: 'turbo' }).expect(400);
    await t.api.post('/agent/run').send({ threshold: 10 }).expect(400); // the threshold is the operator's setting, not a request field
    await t.api.post('/agent/run').send({}).expect(200);
    const event = (await t.deps.repository.listEvents('dev-user')).find((e) => e.type === 'agent.run');
    expect(event?.payload).toEqual({ threshold: 80, considered: 28, prepared: 4, outOfScope: 0, belowThreshold: 24, ineligible: 0, alreadyPrepared: 0, closedOtherField: 0, closedDuplicates: 0, closedBelowBar: 0, closedBelowPay: 0, redrafted: 0, advertsRead: 0 });
    await t.raw().post('/agent/run').send({}).expect(401);
  });
});

describe('POST /employer/jobs: optional, never required', () => {
  it('everything works with zero employer jobs and no employer key configured', async () => {
    await infra();
    const jobs = await t.deps.repository.listJobs();
    expect(jobs.length).toBeGreaterThan(20);
    expect(jobs.every((j) => j.origin === 'discovered' && j.source !== 'employer')).toBe(true);
    expect((await matches()).every((m) => m.job.origin === 'discovered')).toBe(true);
    expect((await t.api.post('/agent/run').send({}).expect(200)).body.prepared).toHaveLength(4);
    const application = (await t.api.post('/applications').send({ jobId: 'sample:c4', mode: 'review' }).expect(201)).body;
    await t.api.post(`/applications/${application.id}/confirm`).send({ confirmedFields: ['rightToWork'] }).expect(200);
    await t.api.post(`/applications/${application.id}/submitted`).send(RECEIPT).expect(200);
    await t.api.get('/interview/questions?pack=con').expect(200);
    // The route is closed, not broken, when no key is configured: the user's token does not open it either.
    const closed = await employerPost(EMPLOYER_JOB, TOKEN).expect(401);
    expect(closed.body.message).toMatch(/OPENNJOB_EMPLOYER_KEY is not configured/);
    expect(await t.deps.repository.listJobs()).toHaveLength(jobs.length);
  });

  it('is guarded by its own key: the candidate token does not open it, and the employer key opens nothing else', async () => {
    await infra({ config: { employerKey: EMPLOYER_KEY } });
    await employerPost(EMPLOYER_JOB, null).expect(401);
    await employerPost(EMPLOYER_JOB, TOKEN).expect(401);
    await employerPost(EMPLOYER_JOB, 'wrong').expect(401);
    await employerPost(EMPLOYER_JOB).expect(201);
    for (const route of ['/profile', '/passport', '/jobs/matches', '/applications', '/usage']) {
      await t.raw().get(route).set('Authorization', `Bearer ${EMPLOYER_KEY}`).expect(401);
    }
    await t.raw().post('/agent/run').set('Authorization', `Bearer ${EMPLOYER_KEY}`).send({}).expect(401);
  });

  it('stores the job with origin "employer", derives region, language and pack, and matches it like any other job', async () => {
    await infra({ config: { employerKey: EMPLOYER_KEY } });
    const before = (await matches()).length;
    const job = (await employerPost(EMPLOYER_JOB).expect(201)).body;
    expect(job).toMatchObject({
      source: 'employer', origin: 'employer', title: EMPLOYER_JOB.title, employer: EMPLOYER_JOB.employer, country: 'GB', city: 'Leeds', region: 'uk',
      language: 'en', pack: 'dc', criteriaSource: 'provided', requiresRegistration: false, applyUrl: 'https://example.org/apply/wrenfield-1',
    });
    expect(job.id).toMatch(/^employer:/);
    const rows = await matches();
    expect(rows).toHaveLength(before + 1);
    const row = rows.find((m) => m.job.id === job.id) as MatchRow;
    expect(row).toMatchObject({ score: 80, eligible: true, job: { origin: 'employer', pack: 'dc', country: 'GB', region: 'uk' } });
    // Same sort and same scoring as discovered jobs: it sits among them by score, not first and not last.
    const position = rows.indexOf(row);
    expect(rows[position - 1]?.score).toBeGreaterThanOrEqual(80);
    expect(rows[position + 1]?.score).toBeLessThanOrEqual(80);
    expect(ids(await matches('?pack=dc&country=GB'))).toEqual([job.id, 'sample:d1'].sort());
    const application = (await t.api.post('/applications').send({ jobId: job.id }).expect(201)).body;
    expect(application).toMatchObject({ jobId: job.id, employer: EMPLOYER_JOB.employer, applyUrl: EMPLOYER_JOB.applyUrl, score: 80 });
  });

  it('is subject to the candidate preferences exactly like a discovered job', async () => {
    await infra({ config: { employerKey: EMPLOYER_KEY }, preferences: { countries: ['DE'] } });
    const job = (await employerPost(EMPLOYER_JOB).expect(201)).body;
    expect(ids(await matches())).not.toContain(job.id);
    const run = (await t.api.post('/agent/run').send({}).expect(200)).body;
    expect(run.prepared.map((a: { jobId: string }) => a.jobId)).toEqual(['sample:d2']);
  });

  it('reads criteria from the description when none are supplied, and detects a French posting', async () => {
    await infra({ config: { employerKey: EMPLOYER_KEY } });
    const { criteria: _omit, ...withoutCriteria } = EMPLOYER_JOB;
    const plain = (await employerPost({ ...withoutCriteria, description: 'A fictional vacancy.\nEssential\n- Data centre delivery.\n- MEP coordination.\nDesirable\n- Primavera P6 scheduling.' }).expect(201)).body;
    expect(plain.criteriaSource).toBe('fallback');
    expect(plain.criteria.map((c: { label: string; essential: boolean }) => [c.label, c.essential])).toEqual([['Data centre delivery', true], ['MEP coordination', true], ['Primavera P6 scheduling', false]]);

    const french = (await employerPost({
      title: 'Chef de chantier - Poste électrique',
      employer: 'Société Fictive du Fleuve (exemple)',
      description: 'Nous recrutons pour le poste de chef de chantier au sein de notre équipe à Dakar.\nProfil recherché\n- Expérience des postes HV.\n- Maîtrise du français.',
      country: 'SN',
      city: 'Dakar',
      applyUrl: 'https://example.org/apply/fleuve-1',
    }).expect(201)).body;
    expect(french).toMatchObject({ language: 'fr', country: 'SN', region: 'africa', pack: 'fr', origin: 'employer' });
  });

  it('validates the posting', async () => {
    await infra({ config: { employerKey: EMPLOYER_KEY } });
    const before = (await t.deps.repository.listJobs()).length;
    for (const patch of [
      { country: 'UK' },
      { country: undefined },
      { city: '' },
      { title: '' },
      { description: 'short' },
      { applyUrl: 'javascript:alert(1)' },
      { applyUrl: 'not a url' },
      { pack: 'nursing' },
      { language: 'de' },
      { requiredCredential: 'badge' },
      { criteria: [{ label: 'x', essential: true, keywords: [] }] },
      { origin: 'discovered' },
      { id: 'sample:c1' },
    ]) {
      await employerPost({ ...EMPLOYER_JOB, ...patch }).expect(400);
    }
    expect(await t.deps.repository.listJobs()).toHaveLength(before);
  });

  it('a refresh of the discovered sources does not remove employer jobs, and an employer cannot overwrite a discovered job', async () => {
    await infra({ config: { employerKey: EMPLOYER_KEY } });
    const job = (await employerPost(EMPLOYER_JOB).expect(201)).body;
    const again = (await employerPost(EMPLOYER_JOB).expect(201)).body;
    expect(again.id).not.toBe(job.id);
    await t.api.post('/jobs/refresh').expect(200);
    const stored = await t.deps.repository.listJobs();
    expect(stored.filter((j) => j.origin === 'employer').map((j) => j.id).sort()).toEqual([job.id, again.id].sort());
    expect(stored.find((j) => j.id === 'sample:c1')).toMatchObject({ origin: 'discovered', employer: 'Halden Build Group (example)' });
  });
});

describe('interview questions per pack', () => {
  it('GET /interview/questions?pack= returns that pack\'s questions; the healthcare bank is unchanged without it', async () => {
    t = await createTestApp();
    const rail = (await t.api.get('/interview/questions?pack=rail').expect(200)).body;
    expect(rail.map((q: { id: string }) => q.id)).toEqual(['rail-1', 'rail-2', 'rail-3']);
    const fr = (await t.api.get('/interview/questions?pack=fr').expect(200)).body;
    expect(fr.map((q: { language: string }) => q.language)).toEqual(['fr', 'en', 'fr']);
    expect(fr[0].text).toBe("Parlez-nous d'un programme d'infrastructure que vous avez redressé.");
    expect((await t.api.get('/interview/questions').expect(200)).body).toHaveLength(14);
    await t.api.get('/interview/questions?pack=law').expect(400);
  });

  it('POST /interview/feedback accepts a pack question and answers a French answer in French', async () => {
    t = await createTestApp();
    const res = await t.api.post('/interview/feedback').send({ questionId: 'fr-3', answer: "J'ai géré le chantier avec mon équipe pour le client." }).expect(200);
    expect(res.body.question).toBe('Comment gérez-vous plusieurs sous-traitants sur un chantier éloigné ?');
    expect(res.body.feedback.source).toBe('heuristic');
    expect(res.body.feedback.improvements[0]).toMatch(/^La réponse est très courte/);
    const en = await t.api.post('/interview/feedback').send({ questionId: 'fr-3', answer: 'I managed the site with my team.' }).expect(200);
    expect(en.body.feedback.improvements[0]).toMatch(/^The answer is very short/);
    await t.api.post('/interview/feedback').send({ questionId: 'rail-9', answer: 'x' }).expect(404);

    await t.app.close();
    const llm = scriptedLlm();
    t = await createTestApp({ llm });
    await t.api.post('/interview/feedback').send({ questionId: 'con-1', answer: 'I recovered the programme.' }).expect(200);
    expect(llm.calls[0]?.system).toMatch(/Write your feedback in the language the candidate answered in/);
    expect(llm.calls[0]?.prompt).toContain('Tell me about a programme you recovered.');
  });
});

describe('configuration', () => {
  const noFetch: FetchLike = async () => { throw new Error('tests must not make live calls'); };

  it('OPENNJOB_APPLY_THRESHOLD: default 80, a whole number from 0 to 100, anything else ignored', () => {
    expect(DEFAULT_APPLY_THRESHOLD).toBe(80);
    expect(applyThresholdOf(loadConfig({}))).toBe(80);
    expect(loadConfig({}).applyThreshold).toBeUndefined();
    expect(applyThresholdOf(loadConfig({ OPENNJOB_APPLY_THRESHOLD: '65' }))).toBe(65);
    expect(applyThresholdOf(loadConfig({ OPENNJOB_APPLY_THRESHOLD: ' 100 ' }))).toBe(100);
    expect(applyThresholdOf(loadConfig({ OPENNJOB_APPLY_THRESHOLD: '0' }))).toBe(0);
    for (const bad of ['', 'eighty', '80%', '-1', '101', '79.5', '1e2']) expect(applyThresholdOf(loadConfig({ OPENNJOB_APPLY_THRESHOLD: bad })), bad).toBe(80);
    expect(applyThresholdOf({ ...BASE_CONFIG, applyThreshold: Number.NaN })).toBe(80);
    expect(applyThresholdOf({ ...BASE_CONFIG, applyThreshold: 150 })).toBe(80);
  });

  it('OPENNJOB_EMPLOYER_KEY is optional and separate from the signing secret', () => {
    expect(loadConfig({ OPENNJOB_JWT_SECRET: 'user' }).employerKey).toBeUndefined();
    expect(loadConfig({ OPENNJOB_JWT_SECRET: 'user', OPENNJOB_EMPLOYER_KEY: '  ' }).employerKey).toBeUndefined();
    expect(loadConfig({ OPENNJOB_JWT_SECRET: 'user', OPENNJOB_EMPLOYER_KEY: ' emp ' })).toMatchObject({ jwtSecret: 'user', employerKey: 'emp' });
  });

  it('Adzuna searches the countries each person chose (not ADZUNA_COUNTRIES); it is asked only where it operates', () => {
    const [adzuna] = buildSearchSources({ ADZUNA_APP_ID: 'id', ADZUNA_APP_KEY: 'key', ADZUNA_COUNTRIES: 'gb' }, noFetch);
    expect(adzuna?.countries).toEqual(expect.arrayContaining(['GB', 'FR', 'DE', 'ZA']));
    expect(adzuna?.countries).not.toContain('CD');
  });

  it('OPENNJOB_DEMO_JOBS loads fictional jobs for every pack', async () => {
    const [sample] = buildSources({ OPENNJOB_DEMO_JOBS: 'true' }, noFetch);
    const jobs = await sample!.fetchJobs();
    expect(new Set(jobs.map((j) => j.pack))).toEqual(new Set(['con', 'dc', 'en', 'rail', 'fr', 'hc']));
  });
});
