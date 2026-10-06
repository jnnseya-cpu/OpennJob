import { describe, expect, it } from 'vitest';
import {
  FakeLlm,
  buildCriteriaPrompt,
  detectRequiresRegistration,
  extractCriteria,
  extractCriteriaFallback,
  keywordInText,
  matchJob,
  parseCriteriaReply,
  splitSentences,
} from '../src';
import type { Criterion } from '../src';
import { CV_TEXT } from './fixtures/cv';

const crit = (label: string, essential: boolean, ...keywords: string[]): Criterion => ({ label, essential, keywords });

describe('keywordInText', () => {
  it('is case-insensitive', () => {
    expect(keywordInText('safeguarding', 'Raised SAFEGUARDING concerns')).toBe(true);
    expect(keywordInText('NEWS2', 'using news2 scores')).toBe(true);
  });
  it('does not match short acronyms inside other words', () => {
    expect(keywordInText('RN', 'I am keen to learn')).toBe(false);
    expect(keywordInText('RN', 'Qualified RN, adult branch')).toBe(true);
    expect(keywordInText('HCA', 'HCAs on the ward')).toBe(false);
  });
  it('lets longer keywords take a suffix but not a prefix', () => {
    expect(keywordInText('medication', 'administered medications')).toBe(true);
    expect(keywordInText('care plan', 'wrote care  plans')).toBe(true);
    expect(keywordInText('ward', 'looking forward')).toBe(false);
  });
  it('treats regex characters literally and ignores empty keywords', () => {
    expect(keywordInText('BSc (Hons)', 'I hold a BSc (Hons) Nursing')).toBe(true);
    expect(keywordInText('c++', 'a+b')).toBe(false);
    expect(keywordInText('   ', 'anything')).toBe(false);
  });
});

describe('splitSentences', () => {
  it('returns verbatim substrings without bullet markers', () => {
    const s = splitSentences(CV_TEXT);
    expect(s).toContain('Wrote and reviewed care plans with patients and families.');
    for (const sentence of s) expect(CV_TEXT).toContain(sentence);
  });
});

describe('matchJob', () => {
  it('scores round(100 x matched weight / total weight) with essential=2 and desirable=1', () => {
    const job = {
      requiresRegistration: false,
      criteria: [
        crit('Medication', true, 'medication'), // hit, 2
        crit('Safeguarding', true, 'safeguarding'), // hit, 2
        crit('Venepuncture', true, 'venepuncture', 'cannulation'), // miss, 2
        crit('Dementia', false, 'dementia'), // hit, 1
        crit('Driving', false, 'driving licence'), // miss, 1
      ],
    };
    const r = matchJob(job, CV_TEXT, undefined);
    expect(r.matchedWeight).toBe(5);
    expect(r.totalWeight).toBe(8);
    expect(r.score).toBe(63); // 62.5 rounds to 63
    expect(r.unmetEssential).toEqual(['Venepuncture']);
    expect(r.hits.map((h) => h.matched)).toEqual([true, true, false, true, false]);
  });

  it('rounds to the nearest whole number', () => {
    const one = matchJob({ requiresRegistration: false, criteria: [crit('a', true, 'medication'), crit('b', false, 'zzz')] }, CV_TEXT, undefined);
    expect(one.score).toBe(67); // 2/3
    const two = matchJob({ requiresRegistration: false, criteria: [crit('a', false, 'medication'), crit('b', true, 'zzz')] }, CV_TEXT, undefined);
    expect(two.score).toBe(33); // 1/3
  });

  it('gives 100 when everything matches, 0 when nothing does, and 0 for a job with no criteria', () => {
    expect(matchJob({ requiresRegistration: false, criteria: [crit('a', true, 'NEWS2'), crit('b', false, 'dementia')] }, CV_TEXT, undefined).score).toBe(100);
    expect(matchJob({ requiresRegistration: false, criteria: [crit('a', true, 'paediatric')] }, CV_TEXT, undefined).score).toBe(0);
    expect(matchJob({ requiresRegistration: false, criteria: [] }, CV_TEXT, undefined).score).toBe(0);
  });

  it('matches a criterion when ANY keyword appears', () => {
    const r = matchJob({ requiresRegistration: false, criteria: [crit('Obs', true, 'vital signs', 'NEWS2')] }, CV_TEXT, undefined);
    expect(r.hits[0]).toMatchObject({ matched: true, keyword: 'NEWS2' });
  });

  it('returns the first CV sentence that evidences each hit', () => {
    const r = matchJob(
      { requiresRegistration: false, criteria: [crit('Care', true, 'care plan', 'personal care'), crit('Dementia', false, 'dementia')] },
      CV_TEXT,
      undefined,
    );
    expect(r.hits[0]?.evidence).toBe('Wrote and reviewed care plans with patients and families.');
    expect(r.hits[1]?.evidence).toBe('Provided personal care to residents living with dementia.');
    for (const h of r.hits) expect(CV_TEXT).toContain(h.evidence as string);
  });

  it('gives no evidence for a miss', () => {
    const r = matchJob({ requiresRegistration: false, criteria: [crit('x', true, 'paediatric')] }, CV_TEXT, undefined);
    expect(r.hits[0]).toEqual({ criterion: crit('x', true, 'paediatric'), matched: false });
  });

  it('eligible = !requiresRegistration || passport.nmcPin is non-empty', () => {
    const reg = { requiresRegistration: true, criteria: [] };
    const open = { requiresRegistration: false, criteria: [] };
    expect(matchJob(reg, CV_TEXT, { nmcPin: '18A1234E' }).eligible).toBe(true);
    expect(matchJob(reg, CV_TEXT, { nmcPin: '' }).eligible).toBe(false);
    expect(matchJob(reg, CV_TEXT, { nmcPin: '   ' }).eligible).toBe(false);
    expect(matchJob(reg, CV_TEXT, {}).eligible).toBe(false);
    expect(matchJob(reg, CV_TEXT, undefined).eligible).toBe(false);
    expect(matchJob(open, CV_TEXT, undefined).eligible).toBe(true);
    expect(matchJob(open, CV_TEXT, { nmcPin: '' }).eligible).toBe(true);
  });
});

const ADVERT = [
  'Staff Nurse, Ward 12',
  'Essential',
  '- Current NMC registration.',
  '- Medication administration.',
  '- Safeguarding adults.',
  'Desirable',
  '- Venepuncture.',
  '- A full UK driving licence would be an advantage.',
].join('\n');

describe('extractCriteria', () => {
  it('falls back to deterministic keyword extraction when no LLM is configured', async () => {
    const a = await extractCriteria(ADVERT, undefined, 'Staff Nurse');
    const b = await extractCriteria(ADVERT, undefined, 'Staff Nurse');
    expect(a).toEqual(b);
    expect(a.source).toBe('fallback');
    expect(a.requiresRegistration).toBe(true);
    const byLabel = Object.fromEntries(a.criteria.map((c) => [c.label, c.essential]));
    expect(byLabel).toMatchObject({
      'NMC registration': true,
      'Medication administration': true,
      Safeguarding: true,
      'Venepuncture and cannulation': false,
      'Full UK driving licence': false,
    });
    for (const c of a.criteria) expect(c.keywords.length).toBeGreaterThan(0);
  });

  it('marks an inline "desirable" line as desirable even without a heading', () => {
    const r = extractCriteriaFallback('You will give personal care. Dementia experience is desirable.');
    expect(r.criteria.find((c) => c.label === 'Personal care')?.essential).toBe(true);
    expect(r.criteria.find((c) => c.label === 'Dementia care')?.essential).toBe(false);
  });

  it('ignores the introduction when the advert has Essential/Desirable headings', () => {
    const r = extractCriteriaFallback('Join our busy acute ward team in the community.\nEssential\n- Safeguarding training.\nDesirable\n- Dementia experience.');
    expect(r.criteria).toEqual([
      { label: 'Safeguarding', essential: true, keywords: ['safeguarding'] },
      { label: 'Dementia care', essential: false, keywords: ['dementia'] },
    ]);
  });

  it('turns a line of alternatives ("A or B") into one criterion that either satisfies', () => {
    const r = extractCriteriaFallback('Essential\n- Care Certificate or NVQ Level 2 in Health and Social Care.\n- Personal care and dementia experience.');
    expect(r.criteria.map((c) => c.label)).toEqual(['Care Certificate or NVQ/QCF in Health and Social Care', 'Personal care', 'Dementia care']);
    const either = r.criteria[0];
    expect(matchJob({ criteria: [either as Criterion], requiresRegistration: false }, 'I hold the Care Certificate.', undefined).score).toBe(100);
    expect(matchJob({ criteria: [either as Criterion], requiresRegistration: false }, 'NVQ Level 2 completed in 2020.', undefined).score).toBe(100);
    expect(matchJob({ criteria: [either as Criterion], requiresRegistration: false }, 'No relevant qualification.', undefined).score).toBe(0);
  });

  it('keeps a criterion essential if it is essential anywhere', () => {
    const r = extractCriteriaFallback('Desirable\n- Dementia experience.\nEssential\n- Dementia care on every shift.');
    expect(r.criteria).toEqual([{ label: 'Dementia care', essential: true, keywords: ['dementia'] }]);
  });

  it('returns no criteria for text with no recognised terms', () => {
    expect(extractCriteriaFallback('Lorem ipsum dolor sit amet.').criteria).toEqual([]);
  });

  it('uses the LLM reply when it is valid JSON in the criteria shape', async () => {
    const llm = new FakeLlm(() =>
      '```json\n{"criteria":[{"label":"Tracheostomy care","essential":true,"keywords":["tracheostomy","trache"]},{"label":"Rota flexibility","essential":false,"keywords":["nights"]}],"requiresRegistration":false}\n```',
    );
    const r = await extractCriteria(ADVERT, llm, 'Staff Nurse');
    expect(r.source).toBe('llm');
    expect(r.criteria).toEqual([
      { label: 'Tracheostomy care', essential: true, keywords: ['tracheostomy', 'trache'] },
      { label: 'Rota flexibility', essential: false, keywords: ['nights'] },
    ]);
    // The advert explicitly asks for NMC registration, so the deterministic signal wins over the LLM's "false".
    expect(r.requiresRegistration).toBe(true);
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]?.prompt).toContain(ADVERT);
  });

  it('falls back when the LLM reply is unusable or the call throws', async () => {
    const garbage = await extractCriteria(ADVERT, new FakeLlm(() => 'Sorry, I cannot help.'));
    expect(garbage.source).toBe('fallback');
    const empty = await extractCriteria(ADVERT, new FakeLlm(() => '{"criteria":[]}'));
    expect(empty.source).toBe('fallback');
    const boom = await extractCriteria(ADVERT, { complete: async () => { throw new Error('network'); } });
    expect(boom.source).toBe('fallback');
    expect(boom.criteria.length).toBeGreaterThan(0);
  });

  it('drops malformed criteria from an LLM reply', () => {
    const parsed = parseCriteriaReply(
      '{"criteria":[{"label":"","essential":true,"keywords":["x"]},{"label":"No keywords","essential":true,"keywords":[]},{"label":"Good","essential":"yes","keywords":["a"," a ",3]}]}',
    );
    expect(parsed).toEqual({ criteria: [{ label: 'Good', essential: false, keywords: ['a'] }], requiresRegistration: false });
  });

  it('builds a prompt that asks for the exact shape', () => {
    const p = buildCriteriaPrompt('advert text', 'Nurse');
    expect(p).toContain('"criteria"');
    expect(p).toContain('"requiresRegistration"');
    expect(p).toContain('advert text');
  });
});

describe('detectRequiresRegistration', () => {
  it.each([
    ['Staff Nurse', 'A busy ward.', true],
    ['Registered Mental Health Nurse (RMN)', '', true],
    ['Healthcare Assistant', 'You will work alongside registered nurses.', false],
    ['Nursing Assistant', '', false],
    ['Student Nurse placement', '', false],
    ['Support Worker', 'Supporting adults at home.', false],
    ['Clinical Lead', 'You must hold a current NMC registration.', true],
    ['Senior Carer', 'NMC PIN not required.', false],
    ['Senior Carer', 'This is a non-clinical post. An NMC registration is not needed for it.', false],
  ])('%s -> %s', (title, description, expected) => {
    expect(detectRequiresRegistration(title, description)).toBe(expected);
  });
});
