import { describe, expect, it } from 'vitest';
import { keywordMatch, stemWord } from '../src/score-keywords';

describe('stemWord', () => {
  it('lines up common variants so a stem match is forgiving', () => {
    const s = stemWord('management');
    expect(stemWord('managing')).toBe(s);
    expect(stemWord('manager')).toBe(s);
    expect(stemWord('communications')).toBe(stemWord('communication'));
  });
});

describe('keywordMatch', () => {
  const CV = 'Registered nurse. Experienced in medication administration, care planning and patient observations. Strong communication and managing a ward team on night shifts.';

  it('a relevant CV scores well and is not a literal 0%', () => {
    const advert = 'Staff nurse needed. Essential: medication administration, care planning, patient observations, communication skills, team management.';
    const r = keywordMatch(advert, 'Staff Nurse', CV);
    expect(r.percent).toBeGreaterThan(50); // the old literal match scored this near 0
    // synonyms via stem: "communication skills" and "team management" count against the CV's wording
    expect(r.hits.find((h) => /communication/i.test(h.label))?.matched).toBe(true);
    expect(r.hits.find((h) => /management/i.test(h.label))?.matched).toBe(true);
  });

  it('an unrelated advert scores low and lists what is missing', () => {
    const advert = 'Data centre delivery manager. Required: Kubernetes, substation commissioning, HV power systems.';
    const r = keywordMatch(advert, 'Delivery Manager', CV);
    expect(r.percent).toBeLessThan(50);
    expect(r.hits.some((h) => /kubernetes/i.test(h.label) && !h.matched)).toBe(true);
  });

  it('ignores filler words and caps the number of terms weighed', () => {
    const advert = 'We are looking for a candidate with experience and strong skills. ' + Array.from({ length: 40 }, (_, i) => `term${i}`).join(' ');
    const r = keywordMatch(advert, '', CV, 16);
    expect(r.hits.length).toBeLessThanOrEqual(16);
    expect(r.hits.some((h) => /looking|candidate|experience|skills/i.test(h.label))).toBe(false);
  });

  it('empty advert gives 0, not a divide-by-zero', () => {
    const r = keywordMatch('', '', CV);
    expect(r.percent).toBe(0);
    expect(r.hits).toEqual([]);
  });
});
