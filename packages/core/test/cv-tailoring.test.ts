import { describe, expect, it } from 'vitest';
import { CV_TAILOR_SYSTEM_PROMPT, FakeLlm, tailorCv, tailorCvForJob, traceRewrittenCv } from '../src';

/** The CV rewritten for one advert, and the fact-level trace check that guards it. Fictional people only. */
const CV = [
  'Sam Example (fictional)',
  'Leeds | sam.example@example.org | 07700 900222',
  'PROFILE',
  'Chartered Construction Manager (MCIOB) with 12 years in major infrastructure.',
  'EXPERIENCE',
  'Project Manager, Example Build Ltd, 2018 to 2025',
  '- Led multidisciplinary teams on a hospital new build under CDM 2015.',
  '- Managed MEP and civils interfaces and NEC4 contract administration.',
  'EDUCATION',
  'BSc (Hons) Construction Management',
].join('\n');
const JOB = { title: 'Senior Project Manager', employer: 'Hollins Rail (fictional)', location: 'Leeds', description: 'Lead MEP coordination and NEC4 contracts on a rail upgrade.' };
const MATCH = { hits: [{ criterion: { label: 'NEC contract administration', essential: true, keywords: ['NEC4'] }, matched: true, evidence: '- Managed MEP and civils interfaces and NEC4 contract administration.' }] };
const SOURCES = { cvText: CV, personName: 'Sam Example' };

const FAITHFUL = [
  'Sam Example (fictional)',
  'Leeds | sam.example@example.org | 07700 900222',
  'PROFESSIONAL PROFILE',
  'Chartered Construction Manager (MCIOB) with 12 years in major infrastructure, leading NEC4 contract administration and MEP interfaces.',
  'KEY SKILLS',
  '- NEC4 contract administration',
  '- MEP and civils interface management',
  'PROFESSIONAL EXPERIENCE',
  'Project Manager, Example Build Ltd, 2018 to 2025',
  '- Managed MEP and civils interfaces and NEC4 contract administration.',
  '- Led multidisciplinary teams on a hospital new build under CDM 2015.',
  'EDUCATION',
  'BSc (Hons) Construction Management',
].join('\n');

describe('the CV rewritten for the advert', () => {
  it('uses a rewrite that rewords and reorders but adds no fact', async () => {
    const llm = new FakeLlm(() => FAITHFUL);
    const out = await tailorCvForJob({ cvText: CV, job: JOB, match: MATCH }, llm, SOURCES);
    expect(out).toEqual({ text: FAITHFUL, source: 'llm' });
    expect(llm.calls[0]?.system).toBe(CV_TAILOR_SYSTEM_PROMPT);
    expect(llm.calls[0]?.prompt).toContain('REQUIREMENTS THE CV MEETS (lead with these): NEC contract administration');
  });

  it('falls back to the CV\'s own lines when the rewrite invents a figure, an employer or a qualification', async () => {
    for (const invented of [
      FAITHFUL.replace('12 years', '15 years'),
      FAITHFUL.replace('Example Build Ltd', 'Hollins Rail'),
      `${FAITHFUL}\n- PRINCE2 Practitioner`,
      FAITHFUL.replace('2018 to 2025', '2016 to 2025'),
    ]) {
      const out = await tailorCvForJob({ cvText: CV, job: JOB, match: MATCH }, new FakeLlm(() => invented), SOURCES);
      expect(out).toEqual({ text: tailorCv(CV, MATCH), source: 'reorder' });
    }
  });

  it('falls back when the call fails, returns too little, or there is no LLM', async () => {
    const failing = new FakeLlm(() => {
      throw new Error('down');
    });
    expect((await tailorCvForJob({ cvText: CV, job: JOB, match: MATCH }, failing, SOURCES)).source).toBe('reorder');
    expect((await tailorCvForJob({ cvText: CV, job: JOB, match: MATCH }, new FakeLlm(() => 'short'), SOURCES)).source).toBe('reorder');
    expect((await tailorCvForJob({ cvText: CV, job: JOB, match: MATCH }, undefined, SOURCES)).source).toBe('reorder');
  });

  it('the trace check names exactly what is unsupported, and accepts headings', () => {
    expect(traceRewrittenCv(FAITHFUL, SOURCES)).toEqual([]);
    const failures = traceRewrittenCv('Project Manager at Hollins Rail since 2016', SOURCES);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.unsupported).toEqual(expect.arrayContaining(['2016', 'Hollins', 'Rail']));
  });
});
