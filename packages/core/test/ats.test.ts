import { describe, expect, it } from 'vitest';
import { atsReadiness } from '../src/ats';
import type { AtsHit } from '../src/ats';

const STRONG_CV = [
  'Jane Example (fictional)',
  'jane.example@example.org · 07700 900123 · London',
  '',
  'Summary',
  'Registered nurse with eight years of ward experience across acute medicine and elderly care,',
  'known for calm leadership on busy night shifts and for mentoring newly qualified colleagues.',
  '',
  'Experience',
  '- Medication administration on a thirty-bed acute medical ward, consistently error free',
  '- Care planning and daily patient observations for a caseload of up to twelve patients',
  '- Safeguarding training completed annually and applied to several escalations',
  '- Led handovers and coordinated discharge planning with the multidisciplinary team',
  '- Supported audits of record keeping and infection control, improving compliance scores',
  '- Precepted three student nurses through their final placements to a successful sign off',
  '',
  'Education',
  'BSc Nursing, Example University, with distinction in adult nursing practice and placements',
  'across medicine, surgery and community settings in and around the London region over three years',
  '',
  'Skills',
  'Teamwork, clear communication with patients and families, clinical observations, prioritisation,',
  'time management under pressure, electronic patient records, and reflective continuing development.',
].join('\n');

const hits = (rows: [string, boolean, boolean][]): AtsHit[] => rows.map(([label, essential, matched]) => ({ label, essential, matched }));

describe('atsReadiness', () => {
  it('scores coverage (essential weighted double) and lists missing essentials first', () => {
    const r = atsReadiness(
      hits([
        ['Medication administration', true, true],
        ['Care planning', true, true],
        ['Venepuncture', true, false],
        ['Audit experience', false, false],
      ]),
      STRONG_CV,
    );
    // matched weight 2+2 of total 2+2+2+1 = 4/7 → 57
    expect(r.coverage).toEqual({ matched: 2, total: 4, percent: 57 });
    // Essential 'Venepuncture' before desirable 'Audit experience'.
    expect(r.missing).toEqual(['Venepuncture', 'Audit experience']);
    expect(r.checks.find((c) => c.id === 'contact')?.ok).toBe(true);
    expect(r.checks.find((c) => c.id === 'sections')?.ok).toBe(true);
  });

  it('a clean, fully-covered CV scores strong with no fix-it tips', () => {
    const r = atsReadiness(
      hits([
        ['Medication administration', true, true],
        ['Care planning', true, true],
        ['Safeguarding', true, true],
      ]),
      STRONG_CV,
    );
    expect(r.band).toBe('strong');
    expect(r.coverage.percent).toBe(100);
    expect(r.tips).toHaveLength(1);
    expect(r.tips[0]).toMatch(/Strong match/);
  });

  it('flags a parser-hostile, contactless, too-short CV', () => {
    const bad = 'Name | Role | Dates\nDid stuff | here | 2020';
    const r = atsReadiness(hits([['Project management', true, false]]), bad);
    const ids = (ok: boolean) => r.checks.filter((c) => c.ok === ok).map((c) => c.id);
    expect(ids(false)).toEqual(expect.arrayContaining(['contact', 'sections', 'length', 'parserSafe']));
    expect(r.band).toBe('weak');
    expect(r.score).toBeLessThan(60);
  });

  it('never invents: a keyword tip always says to add only if genuinely true', () => {
    const r = atsReadiness(hits([['CSCS card', true, false]]), STRONG_CV);
    const tip = r.tips.find((t) => t.includes('CSCS card'));
    expect(tip).toBeDefined();
    expect(tip).toMatch(/only if they are genuinely true of you/i);
    expect(tip).toMatch(/never invents/i);
  });

  it('no requirements means full coverage, not a divide-by-zero', () => {
    const r = atsReadiness([], STRONG_CV);
    expect(r.coverage).toEqual({ matched: 0, total: 0, percent: 100 });
    expect(Number.isFinite(r.score)).toBe(true);
  });

  it('empty CV is handled and scores weak', () => {
    const r = atsReadiness(hits([['Anything', true, false]]), '');
    expect(r.band).toBe('weak');
    expect(r.checks.find((c) => c.id === 'contact')?.ok).toBe(false);
  });
});
