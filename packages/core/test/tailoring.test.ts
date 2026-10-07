import { describe, expect, it } from 'vitest';
import { FRENCH_FALLBACK_OPENING, describeTraceFailure, draftStatementFallback, factsIn, matchJob, nextZonedDayStart, tailorCv, traceCheck, zonedDate, zonedDayStart } from '../src';
import type { Criterion, Passport } from '../src';

/** Fictional person. */
const CV = [
  'Site manager with nine years on residential schemes.',
  'Delivered a 40-home scheme for Hollin Homes (fictional) between 2019 and 2023.',
  'Holds the SMSTS certificate and a CSCS black card.',
  'Managed subcontractors and kept the programme on track.',
  'Ran toolbox talks every Monday.',
].join('\n');

const PASSPORT: Passport = { rightToWorkConfirmed: true, credentials: { cscs: 'CSCS 00000000 (fictional)' }, training: [{ name: 'First aid at work', completedOn: '2025-02-01' }], referees: [] };
const JOB = { title: 'Senior Site Manager', employer: 'Ashgrove Build (fictional)', location: 'Leeds' };

const crit = (label: string, essential: boolean, keywords: string[]): Criterion => ({ label, essential, keywords });
const CRITERIA = [crit('Subcontractor management', true, ['subcontractors']), crit('SMSTS', true, ['smsts']), crit('Housebuilding', false, ['residential'])];
const MATCH = matchJob({ criteria: CRITERIA, requiresRegistration: false }, CV, PASSPORT);

const lines = (s: string) => s.split('\n').filter(Boolean);

describe('TAI-2: without AI the CV sent is the person\'s own, as written, and adds nothing', () => {
  it('keeps the CV in its own order (no line moved above the name or under another employer)', () => {
    const tailored = tailorCv(CV, MATCH);
    expect(tailored).toBe(lines(CV).join('\n'));
    expect(traceCheck({ tailoredCv: tailored }, { cvText: CV })).toEqual([]);
  });

  it('joins lines a PDF conversion broke mid-sentence, and changes nothing else', () => {
    const broken = 'EXAMPLE PERSON (fictional)\nPROFILE\nChartered manager leading teams through the full\nproject lifecycle on rail schemes.\nEXPERIENCE\nExample Rail Ltd (fictional)';
    expect(tailorCv(broken)).toBe('EXAMPLE PERSON (fictional)\nPROFILE\nChartered manager leading teams through the full project lifecycle on rail schemes.\nEXPERIENCE\nExample Rail Ltd (fictional)');
  });
});

describe('spec T-05: a tailored document with an invented fact is rejected', () => {
  const tailored = tailorCv(CV, MATCH);
  const cases: [string, string, string[]][] = [
    ['an employer', 'Delivered a 40-home scheme for Barrow Estates between 2019 and 2023.', ['Barrow', 'Estates']],
    ['a date', 'Delivered a 40-home scheme for Hollin Homes (fictional) between 2017 and 2023.', ['2017']],
    ['a qualification', 'Holds the SMSTS certificate, a CSCS black card and an MSc in construction management.', ['MSc']],
    ['a figure', 'Delivered a 400-home scheme for Hollin Homes (fictional) between 2019 and 2023.', ['400-home']],
  ];
  for (const [what, invented, flagged] of cases) {
    it(`in the tailored CV: ${what}`, () => {
      const doctored = lines(tailored).map((l) => (l.startsWith(invented.slice(0, 12)) ? invented : l)).join('\n');
      expect(doctored).toContain(invented);
      const failures = traceCheck({ tailoredCv: doctored }, { cvText: CV, passport: PASSPORT, job: JOB });
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({ document: 'tailoredCv', text: invented });
      for (const token of flagged) expect(failures[0]?.unsupported.join(' ')).toContain(token.replace(/-home$/, ''));
    });
  }

  it('an added line that is not in the CV is rejected even when it states no checkable fact', () => {
    const failures = traceCheck({ tailoredCv: `${tailored}\nA natural leader who inspires teams.` }, { cvText: CV });
    expect(failures).toEqual([{ document: 'tailoredCv', text: 'A natural leader who inspires teams.', unsupported: [] }]);
    expect(describeTraceFailure(failures[0] as never)).toBe('Tailored CV: "A natural leader who inspires teams." is not a line of your CV.');
  });

  it('a CV line repeated more often than the CV has it is rejected', () => {
    expect(traceCheck({ tailoredCv: `${tailored}\nRan toolbox talks every Monday.` }, { cvText: CV })).toHaveLength(1);
  });

  it('in the statement: invented employers, dates, qualifications, figures and counted words are each caught', () => {
    const statement = [
      'I have managed subcontractors and kept the programme on track.', // traceable: no new fact
      'I delivered schemes for Barrow Estates.', // employer
      'I have worked as a site manager since 2012.', // date
      'I hold an MSc and the SMSTS certificate.', // qualification
      'I led teams of 85 operatives.', // figure
      'I have twelve years of experience.', // counted word
      'I earned £65,000 a year.', // money
    ].join(' ');
    const failures = traceCheck({ statement }, { cvText: CV, passport: PASSPORT, job: JOB });
    expect(failures.map((f) => f.unsupported)).toEqual([['Barrow', 'Estates'], ['2012'], ['MSc'], ['85'], ['twelve'], ['65,000']]);
  });

  it('accepts what the sources do contain: CV and passport facts, the job title, employer and location, and the drafter openings', () => {
    const statement = [
      'Ran toolbox talks every Monday.', // verbatim
      'I am applying for the Senior Site Manager post at Ashgrove Build in Leeds.', // the job's own names
      'Between 2019 and 2023 I delivered a 40-home scheme for Hollin Homes.', // facts all in the CV
      'My CSCS card is CSCS 00000000 and I completed First aid at work training.', // passport
    ].join(' ');
    expect(traceCheck({ statement }, { cvText: CV, passport: PASSPORT, job: JOB })).toEqual([]);
    expect(traceCheck({ statement: `${FRENCH_FALLBACK_OPENING}\n${lines(CV)[0]}` }, { cvText: CV })).toEqual([]);
  });

  it("does not accept the advert's own figures or requirements as facts about the person", () => {
    // The description is not a source: "5 years required" in an advert is not evidence of 5 years.
    const failures = traceCheck({ statement: 'I have 5 years of NEC4 experience.' }, { cvText: CV, job: JOB });
    expect(failures[0]?.unsupported).toEqual(['5', 'NEC4']);
  });

  it('the no-LLM draft always traces', () => {
    const draft = draftStatementFallback({ job: { title: JOB.title, employer: JOB.employer, criteria: CRITERIA }, cvText: CV, match: MATCH });
    expect(draft.statement.length).toBeGreaterThan(0);
    expect(traceCheck({ statement: draft.statement, tailoredCv: tailorCv(CV, MATCH) }, { cvText: CV })).toEqual([]);
  });

  it('factsIn ignores the opening word of a sentence and plain letter words, but not acronyms', () => {
    expect(factsIn('Dear Hiring Manager, I am writing.')).toEqual({ figures: [], names: [] });
    expect(factsIn('Delivered schemes.')).toEqual({ figures: [], names: [] });
    expect(factsIn('NEBOSH holder.')).toEqual({ figures: [], names: ['NEBOSH'] });
  });
});

describe('spec T-03: an empty language list is never evidence of a language', () => {
  const french = crit('Speaks French', true, ['french']);
  it('matching: the criterion is unmet with no languages selected, met when French is selected', () => {
    expect(matchJob({ criteria: [french], requiresRegistration: false }, CV, PASSPORT, { languages: [] }).hits[0]?.matched).toBe(false);
    expect(matchJob({ criteria: [french], requiresRegistration: false }, CV, PASSPORT).hits[0]?.matched).toBe(false);
    expect(matchJob({ criteria: [french], requiresRegistration: false }, CV, PASSPORT, { languages: ['French'] }).hits[0]).toMatchObject({ matched: true, statedLanguage: 'French' });
  });

  it('trace check: a claim to speak French fails with no languages selected and passes when French is selected', () => {
    const statement = 'I speak French.';
    expect(traceCheck({ statement }, { cvText: CV, languages: [] })[0]?.unsupported).toEqual(['French']);
    expect(traceCheck({ statement }, { cvText: CV })[0]?.unsupported).toEqual(['French']);
    expect(traceCheck({ statement }, { cvText: CV, languages: ['French'] })).toEqual([]);
  });
});

describe('London days (APP-8 and NFR-5 count by the London calendar day)', () => {
  it('winter: the day starts at midnight UTC; summer: at 23:00 UTC the day before', () => {
    expect(zonedDayStart(new Date('2026-01-15T12:00:00Z')).toISOString()).toBe('2026-01-15T00:00:00.000Z');
    expect(zonedDayStart(new Date('2026-07-15T12:00:00Z')).toISOString()).toBe('2026-07-14T23:00:00.000Z');
    expect(zonedDayStart(new Date('2026-07-15T23:30:00Z')).toISOString()).toBe('2026-07-15T23:00:00.000Z'); // already the 16th in London
    expect(zonedDate(new Date('2026-07-15T23:30:00Z'))).toBe('2026-07-16');
  });

  it('the days the clocks change are 23 and 25 hours long', () => {
    // Spring forward on Sunday 29 March 2026; fall back on Sunday 25 October 2026.
    const spring = zonedDayStart(new Date('2026-03-29T12:00:00Z'));
    expect(spring.toISOString()).toBe('2026-03-29T00:00:00.000Z');
    expect(nextZonedDayStart(spring).toISOString()).toBe('2026-03-29T23:00:00.000Z');
    const autumn = zonedDayStart(new Date('2026-10-25T12:00:00Z'));
    expect(autumn.toISOString()).toBe('2026-10-24T23:00:00.000Z');
    expect(nextZonedDayStart(autumn).toISOString()).toBe('2026-10-26T00:00:00.000Z');
  });
});
