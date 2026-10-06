import { describe, expect, it } from 'vitest';
import {
  FakeLlm,
  buildStatementPrompt,
  draftStatement,
  draftStatementFallback,
  findUnsupportedClaims,
  matchJob,
  splitLlmStatement,
  splitSentences,
} from '../src';
import type { Criterion } from '../src';
import { CV_TEXT } from './fixtures/cv';

const criteria: Criterion[] = [
  { label: 'Medication administration', essential: true, keywords: ['medication'] },
  { label: 'Recognising deterioration', essential: true, keywords: ['NEWS2', 'deteriorating'] },
  { label: 'Paediatric experience', essential: true, keywords: ['paediatric', 'children'] },
  { label: 'Care planning', essential: true, keywords: ['care plan'] },
  { label: 'Dementia care', essential: false, keywords: ['dementia'] },
  { label: 'Venepuncture', essential: false, keywords: ['venepuncture'] },
];
const job = { title: 'Staff Nurse', employer: 'Midshire University Hospitals (example)', criteria, requiresRegistration: true };
const match = matchJob(job, CV_TEXT, { nmcPin: '18A1234E' });
const input = { job, cvText: CV_TEXT, match };

describe('buildStatementPrompt', () => {
  const { system, prompt } = buildStatementPrompt(input);

  it('contains every essential criterion', () => {
    for (const c of criteria.filter((c) => c.essential)) expect(prompt).toContain(c.label);
  });

  it('lists the essential criteria in their original order', () => {
    const positions = criteria.filter((c) => c.essential).map((c) => prompt.indexOf(c.label));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('carries the rules: CV-only evidence, never invent, gaps listed separately, about 250 words, UK English', () => {
    const all = `${system}\n${prompt}`;
    expect(all).toMatch(/only evidence (that is )?present in the CV/i);
    expect(all).toMatch(/never invent/i);
    expect(prompt).toContain('GAPS:');
    expect(prompt).toMatch(/about 250 words/i);
    expect(all).toMatch(/UK English/);
  });

  it('includes the CV and marks criteria with no evidence', () => {
    expect(prompt).toContain(CV_TEXT);
    expect(prompt).toMatch(/Paediatric experience - NO EVIDENCE IN CV/);
    expect(prompt).toContain('Staff Nurse');
    expect(prompt).toContain('Midshire University Hospitals (example)');
  });
});

describe('draftStatementFallback', () => {
  const draft = draftStatementFallback(input);

  it('never includes text that is not in the CV', () => {
    const cvSentences = new Set(splitSentences(CV_TEXT));
    const lines = draft.statement.split('\n');
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(cvSentences.has(line)).toBe(true);
      expect(CV_TEXT).toContain(line);
    }
    // Remove every CV sentence from the statement: nothing but whitespace may be left.
    let residue = draft.statement;
    for (const s of cvSentences) residue = residue.split(s).join('');
    expect(residue.trim()).toBe('');
  });

  it('holds for arbitrary CVs and criteria, including regex-like keywords', () => {
    const cv = 'I worked nights (2019-2021). Led a team of 4+ carers!\n* Used the hoist daily? Yes.\nNVQ3 in Health & Social Care';
    const j = {
      requiresRegistration: false,
      criteria: [
        { label: 'Teams', essential: true, keywords: ['team'] },
        { label: 'Hoist', essential: true, keywords: ['hoist'] },
        { label: 'NVQ', essential: false, keywords: ['NVQ3'] },
        { label: 'Missing', essential: true, keywords: ['phlebotomy'] },
      ],
    };
    const d = draftStatementFallback({ job: { title: 't', employer: 'e', criteria: j.criteria }, cvText: cv, match: matchJob(j, cv, undefined) });
    for (const line of d.statement.split('\n')) expect(cv).toContain(line);
    expect(d.statement).not.toMatch(/phlebotomy|Missing/);
    expect(d.gaps).toEqual(['Missing']);
  });

  it('addresses essential criteria first, in order, without repeating a sentence', () => {
    expect(draft.statement.split('\n')).toEqual([
      'Completed medication rounds for 28 patients and acted as second checker for controlled drugs.',
      'Escalated deteriorating patients using NEWS2 observations and SBAR handover.',
      'Wrote and reviewed care plans with patients and families.',
      'Provided personal care to residents living with dementia.',
    ]);
  });

  it('lists unmet essential criteria separately as gaps and never in the statement', () => {
    expect(draft.gaps).toEqual(['Paediatric experience']);
    expect(draft.statement).not.toContain('Paediatric');
    expect(draft.source).toBe('fallback');
  });

  it('returns an empty statement with a warning when the CV evidences nothing', () => {
    const cv = 'I enjoy gardening.';
    const d = draftStatementFallback({ job, cvText: cv, match: matchJob(job, cv, undefined) });
    expect(d.statement).toBe('');
    expect(d.gaps).toHaveLength(4);
    expect(d.warnings.join(' ')).toMatch(/empty/);
  });
});

describe('draftStatement', () => {
  it('uses the fallback when no LLM is given', async () => {
    expect((await draftStatement(input)).source).toBe('fallback');
  });

  it('uses the LLM text, strips its GAPS section and computes gaps from the match', async () => {
    const llm = new FakeLlm(() => 'I have completed medication rounds for 28 patients.\n\nGAPS:\n- Something the model made up\n- Paediatric experience');
    const d = await draftStatement(input, llm);
    expect(d.source).toBe('llm');
    expect(d.statement).toBe('I have completed medication rounds for 28 patients.');
    expect(d.gaps).toEqual(['Paediatric experience']);
    expect(llm.calls[0]?.system).toMatch(/Never invent/);
  });

  it('warns when the LLM draft mentions a criterion the CV does not evidence', async () => {
    const d = await draftStatement(input, new FakeLlm(() => 'I have extensive paediatric experience and perform venepuncture daily.\nGAPS:\nnone'));
    expect(d.warnings.join(' ')).toMatch(/Paediatric experience; Venepuncture/);
  });

  it('falls back with a warning when the LLM fails or returns nothing', async () => {
    const failed = await draftStatement(input, { complete: async () => { throw new Error('overloaded'); } });
    expect(failed.source).toBe('fallback');
    expect(failed.warnings[0]).toMatch(/overloaded/);
    const empty = await draftStatement(input, new FakeLlm(() => 'GAPS:\nnone'));
    expect(empty.source).toBe('fallback');
  });
});

describe('helpers', () => {
  it('splitLlmStatement tolerates missing or formatted GAPS headers', () => {
    expect(splitLlmStatement('Just a statement.')).toEqual({ statement: 'Just a statement.', llmGaps: [] });
    expect(splitLlmStatement('Body.\n**GAPS:**\n1. One\n2. Two')).toEqual({ statement: 'Body.', llmGaps: ['One', 'Two'] });
    expect(splitLlmStatement('Body.\nGAPS: none').llmGaps).toEqual([]);
  });
  it('findUnsupportedClaims ignores evidenced criteria', () => {
    expect(findUnsupportedClaims('I give medication and care for people with dementia.', match)).toEqual([]);
  });
});
