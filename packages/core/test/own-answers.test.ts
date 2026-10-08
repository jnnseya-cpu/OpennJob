import { describe, expect, it } from 'vitest';
import { decide, fieldsAllowedToFill, ownAnswer, PREFER_NOT_TO_SAY } from '../src';
import type { OwnAnswerField } from '../src';

/** OD-6 (owner decision, 8 October 2026): declarations answered from the person's own answers. */
const ALL = { everConvicted: false, conflictOfInterest: false, certifyAndConsent: true, equalityPreferNotToSay: true };
const f = (category: OwnAnswerField['category'], label: string, kind: OwnAnswerField['kind'] = 'radio'): OwnAnswerField => ({ category, label, kind });

describe('declarations from the person\'s own answers', () => {
  it('convictions and conflict of interest: their yes/no, only on plain questions', () => {
    expect(ownAnswer(f('convictions', 'Have you ever been convicted of a criminal offence?'), ALL)).toEqual({ value: false, fromOwnRecord: true });
    expect(ownAnswer(f('convictions', 'Do you have any unspent convictions?'), { everConvicted: true })).toEqual({ value: true, fromOwnRecord: true });
    expect(ownAnswer(f('convictions', 'I have no criminal convictions', 'checkbox'), ALL)).toEqual({ value: true, fromOwnRecord: true });
    expect(ownAnswer(f('convictions', 'I have no criminal convictions', 'checkbox'), { everConvicted: true }).fromOwnRecord).toBe(false);
    expect(ownAnswer(f('convictions', 'Please give details of any convictions', 'textarea'), ALL).fromOwnRecord).toBe(false);
    expect(ownAnswer(f('convictions', 'Are you not subject to any conviction?'), ALL).fromOwnRecord).toBe(false); // worded the other way: left
    expect(ownAnswer(f('conflict-of-interest', 'Do you have a conflict of interest?'), ALL)).toEqual({ value: false, fromOwnRecord: true });
    expect(ownAnswer(f('convictions', 'Have you ever been convicted?'), { conflictOfInterest: false }).fromOwnRecord).toBe(false); // not answered
  });

  it('certify and consent boxes when allowed; a box claiming a fact never', () => {
    expect(ownAnswer(f('declaration', 'I certify that the information I have given is true and complete.', 'checkbox'), ALL)).toEqual({ value: true, fromOwnRecord: true });
    expect(ownAnswer(f('declaration', 'I have read and accept the privacy notice.', 'checkbox'), ALL)).toEqual({ value: true, fromOwnRecord: true });
    expect(ownAnswer(f('declaration', 'I confirm I hold a full UK driving licence', 'checkbox'), ALL).fromOwnRecord).toBe(false);
    expect(ownAnswer(f('declaration', 'I confirm I am eligible for security clearance', 'checkbox'), ALL).fromOwnRecord).toBe(false);
    expect(ownAnswer(f('declaration', 'I certify the information is true', 'checkbox'), { ...ALL, certifyAndConsent: undefined }).fromOwnRecord).toBe(false);
  });

  it('equality monitoring: "Prefer not to say" on choices, never a tick box', () => {
    expect(ownAnswer(f('equality', 'Ethnicity', 'select'), ALL)).toEqual({ value: PREFER_NOT_TO_SAY, fromOwnRecord: true });
    expect(ownAnswer(f('equality', 'I consider myself disabled', 'checkbox'), ALL).fromOwnRecord).toBe(false);
  });

  it('health, safeguarding and the rest stay the person\'s', () => {
    for (const c of ['health', 'safeguarding', 'fitness-to-practise', 'security-clearance', 'dbs', 'referee'] as const) {
      expect(ownAnswer(f(c, 'Any question'), ALL).fromOwnRecord).toBe(false);
    }
    expect(ownAnswer(f('convictions', 'Have you ever been convicted?'), undefined).fromOwnRecord).toBe(false);
  });
});

describe('policy with answers from the record', () => {
  const fields = [
    { id: 'name', sensitive: false, required: true, filled: true },
    { id: 'conv', sensitive: true, required: true, filled: true, fromOwnRecord: true },
    { id: 'certify', sensitive: true, required: true, filled: true, fromOwnRecord: true },
  ];
  it('auto submits when every sensitive field is answered from the record; review still asks', () => {
    expect(decide({ mode: 'auto', fields, confirmedFieldIds: [] })).toBe('submit');
    expect(decide({ mode: 'hybrid', fields, confirmedFieldIds: [] })).toBe('fill-only');
    expect(decide({ mode: 'review', fields, confirmedFieldIds: [] })).toBe('await-confirmation');
    expect(fieldsAllowedToFill({ mode: 'auto', fields, confirmedFieldIds: [] }).sort()).toEqual(['certify', 'conv', 'name']);
  });
  it('one sensitive field not from the record still stops auto', () => {
    const health = [...fields, { id: 'health', sensitive: true, required: false, filled: false }];
    expect(decide({ mode: 'auto', fields: health, confirmedFieldIds: [] })).toBe('await-confirmation');
    expect(decide({ mode: 'auto', fields: health, confirmedFieldIds: ['health'] })).toBe('fill-only');
  });
});
