import { describe, expect, it } from 'vitest';
import { MODES, decide, fieldsAllowedToFill, maySubmit } from '../src';
import type { Mode, PolicyDecision, PolicyField, PolicyInput } from '../src';

const f = (id: string, sensitive: boolean, extra: Partial<PolicyField> = {}): PolicyField => ({ id, sensitive, ...extra });

describe('policy: review mode', () => {
  it('awaits confirmation until every field is confirmed', () => {
    const fields = [f('a', false), f('b', true)];
    expect(decide({ mode: 'review', fields, confirmedFieldIds: [] })).toBe('await-confirmation');
    expect(decide({ mode: 'review', fields, confirmedFieldIds: ['a'] })).toBe('await-confirmation');
    expect(decide({ mode: 'review', fields, confirmedFieldIds: ['b'] })).toBe('await-confirmation');
  });
  it('is fill-only once every field is confirmed, and never submit', () => {
    const fields = [f('a', false), f('b', true)];
    expect(decide({ mode: 'review', fields, confirmedFieldIds: ['a', 'b'] })).toBe('fill-only');
    expect(decide({ mode: 'review', fields: [f('a', false)], confirmedFieldIds: ['a'] })).toBe('fill-only');
    expect(decide({ mode: 'review', fields: [], confirmedFieldIds: [] })).toBe('fill-only');
  });
  it('only allows confirmed fields to be filled', () => {
    const fields = [f('a', false), f('b', true), f('c', false)];
    expect(fieldsAllowedToFill({ mode: 'review', fields, confirmedFieldIds: [] })).toEqual([]);
    expect(fieldsAllowedToFill({ mode: 'review', fields, confirmedFieldIds: ['c'] })).toEqual(['c']);
  });
});

describe('policy: hybrid mode', () => {
  it('awaits confirmation while any sensitive field is unconfirmed', () => {
    const fields = [f('a', false), f('pin', true), f('dbs', true)];
    expect(decide({ mode: 'hybrid', fields, confirmedFieldIds: [] })).toBe('await-confirmation');
    expect(decide({ mode: 'hybrid', fields, confirmedFieldIds: ['pin'] })).toBe('await-confirmation');
    expect(decide({ mode: 'hybrid', fields, confirmedFieldIds: ['a'] })).toBe('await-confirmation');
  });
  it('is fill-only (the user presses submit) once sensitive fields are confirmed or there are none', () => {
    expect(decide({ mode: 'hybrid', fields: [f('a', false), f('pin', true)], confirmedFieldIds: ['pin'] })).toBe('fill-only');
    expect(decide({ mode: 'hybrid', fields: [f('a', false)], confirmedFieldIds: [] })).toBe('fill-only');
    expect(decide({ mode: 'hybrid', fields: [], confirmedFieldIds: [] })).toBe('fill-only');
  });
  it('fills non-sensitive fields immediately and sensitive fields only when confirmed', () => {
    const fields = [f('a', false), f('pin', true), f('dbs', true)];
    expect(fieldsAllowedToFill({ mode: 'hybrid', fields, confirmedFieldIds: [] })).toEqual(['a']);
    expect(fieldsAllowedToFill({ mode: 'hybrid', fields, confirmedFieldIds: ['dbs'] })).toEqual(['a', 'dbs']);
  });
});

describe('policy: auto mode', () => {
  it('submits when there are no sensitive fields', () => {
    expect(decide({ mode: 'auto', fields: [f('a', false), f('b', false)], confirmedFieldIds: [] })).toBe('submit');
    expect(decide({ mode: 'auto', fields: [f('a', false, { required: true, filled: true })], confirmedFieldIds: [] })).toBe('submit');
  });
  it('holds for the user when a sensitive field is unconfirmed', () => {
    expect(decide({ mode: 'auto', fields: [f('a', false), f('pin', true)], confirmedFieldIds: [] })).toBe('await-confirmation');
    expect(decide({ mode: 'auto', fields: [f('pin', true)], confirmedFieldIds: ['a'] })).toBe('await-confirmation');
  });
  it('never submits a form with a sensitive field, even after the user confirmed it', () => {
    expect(decide({ mode: 'auto', fields: [f('a', false), f('pin', true)], confirmedFieldIds: ['pin'] })).toBe('fill-only');
    expect(decide({ mode: 'auto', fields: [f('pin', true), f('dbs', true)], confirmedFieldIds: ['pin', 'dbs', 'a'] })).toBe('fill-only');
  });
  it('does not submit an empty form or a form with a required field left empty', () => {
    expect(decide({ mode: 'auto', fields: [], confirmedFieldIds: [] })).toBe('fill-only');
    expect(decide({ mode: 'auto', fields: [f('a', false, { required: true, filled: false })], confirmedFieldIds: [] })).toBe('fill-only');
    expect(decide({ mode: 'auto', fields: [f('a', false, { required: true })], confirmedFieldIds: [] })).toBe('fill-only');
    expect(decide({ mode: 'auto', fields: [f('a', false, { required: false, filled: false })], confirmedFieldIds: [] })).toBe('submit');
  });
});

describe('policy: fail closed', () => {
  it('awaits confirmation for an unknown mode', () => {
    for (const mode of ['', 'AUTO', 'yolo', undefined, null, 3]) {
      const input = { mode, fields: [f('a', false)], confirmedFieldIds: [] } as unknown as PolicyInput;
      expect(decide(input)).toBe('await-confirmation');
      expect(fieldsAllowedToFill(input)).toEqual([]);
    }
  });
  it('awaits confirmation for malformed input', () => {
    expect(decide(undefined as unknown as PolicyInput)).toBe('await-confirmation');
    expect(decide({ mode: 'auto' } as unknown as PolicyInput)).toBe('await-confirmation');
    expect(decide({ mode: 'auto', fields: [f('a', false)] } as unknown as PolicyInput)).toBe('await-confirmation');
    expect(fieldsAllowedToFill(undefined as unknown as PolicyInput)).toEqual([]);
  });
  it('treats a field with a missing or non-boolean sensitive flag as sensitive', () => {
    for (const sensitive of [undefined, null, 'false', 0, 1]) {
      const fields = [{ id: 'x', sensitive }] as unknown as PolicyField[];
      expect(decide({ mode: 'auto', fields, confirmedFieldIds: [] })).toBe('await-confirmation');
      expect(decide({ mode: 'auto', fields, confirmedFieldIds: ['x'] })).toBe('fill-only');
      expect(decide({ mode: 'hybrid', fields, confirmedFieldIds: [] })).toBe('await-confirmation');
      expect(fieldsAllowedToFill({ mode: 'auto', fields, confirmedFieldIds: [] })).toEqual([]);
    }
  });
  it('maySubmit is true only for the submit decision', () => {
    expect(maySubmit('submit')).toBe(true);
    expect(maySubmit('fill-only')).toBe(false);
    expect(maySubmit('await-confirmation')).toBe(false);
    expect(maySubmit('SUBMIT' as PolicyDecision)).toBe(false);
  });
});

/**
 * Exhaustive sweep. Every combination of:
 *   3 modes x forms of 0..4 fields x each field in one of 6 states
 *   (sensitive?, required+empty / required+filled / optional) x every subset of confirmed ids.
 * For each combination the decision is checked against an independently written
 * specification and against the safety invariants.
 */
describe('policy: exhaustive sweep', () => {
  const FIELD_STATES: Array<Omit<PolicyField, 'id'>> = [
    { sensitive: false },
    { sensitive: false, required: true, filled: true },
    { sensitive: false, required: true, filled: false },
    { sensitive: true },
    { sensitive: true, required: true, filled: true },
    { sensitive: true, required: true, filled: false },
  ];

  function* forms(maxFields: number): Generator<PolicyField[]> {
    for (let n = 0; n <= maxFields; n++) {
      const total = FIELD_STATES.length ** n;
      for (let code = 0; code < total; code++) {
        const fields: PolicyField[] = [];
        let c = code;
        for (let i = 0; i < n; i++) {
          fields.push({ id: `f${i}`, ...(FIELD_STATES[c % FIELD_STATES.length] as Omit<PolicyField, 'id'>) });
          c = Math.floor(c / FIELD_STATES.length);
        }
        yield fields;
      }
    }
  }

  function* subsets(ids: string[]): Generator<string[]> {
    for (let mask = 0; mask < 1 << ids.length; mask++) yield ids.filter((_, i) => mask & (1 << i));
  }

  /** The specification, written out longhand and independently of the implementation. */
  function expected(mode: Mode, fields: PolicyField[], confirmed: string[]): PolicyDecision {
    const isConfirmed = (x: PolicyField) => confirmed.includes(x.id);
    const sensitive = fields.filter((x) => x.sensitive);
    if (mode === 'review') return fields.every(isConfirmed) ? 'fill-only' : 'await-confirmation';
    if (!sensitive.every(isConfirmed)) return 'await-confirmation';
    if (mode === 'hybrid') return 'fill-only';
    const requiredEmpty = fields.filter((x) => x.required && !x.filled);
    return sensitive.length === 0 && fields.length > 0 && requiredEmpty.length === 0 ? 'submit' : 'fill-only';
  }

  it('matches the specification and the safety invariants for every combination', () => {
    let combinations = 0;
    let submits = 0;
    const failures: string[] = [];
    for (const mode of MODES) {
      for (const fields of forms(4)) {
        const ids = fields.map((x) => x.id);
        for (const confirmed of subsets(ids)) {
          combinations += 1;
          const input: PolicyInput = { mode, fields, confirmedFieldIds: confirmed };
          const decision = decide(input);
          const allowed = fieldsAllowedToFill(input);
          // The context string is only built on failure; there are ~68,000 combinations.
          const check = (ok: boolean, rule: string) => {
            if (!ok && failures.length < 20) failures.push(`${rule}: got ${decision} for ${JSON.stringify(input)}`);
          };
          const anySensitive = fields.some((x) => x.sensitive);
          const unconfirmedSensitive = fields.filter((x) => x.sensitive && !confirmed.includes(x.id));

          check(decision === expected(mode, fields, confirmed), 'specification');
          // Invariant 1: review and hybrid never submit.
          check(mode === 'auto' || decision !== 'submit', 'review/hybrid never submit');
          // Invariant 2: a form with any sensitive field is never submitted, in any mode.
          check(!anySensitive || decision !== 'submit', 'sensitive form never submitted');
          // Invariant 3: an unconfirmed sensitive field always means await-confirmation.
          check(unconfirmedSensitive.length === 0 || decision === 'await-confirmation', 'unconfirmed sensitive awaits');
          // Invariant 4: an unconfirmed sensitive field is never fillable.
          check(unconfirmedSensitive.every((x) => !allowed.includes(x.id)), 'unconfirmed sensitive not fillable');
          // Invariant 5: in review nothing unconfirmed is fillable.
          check(mode !== 'review' || allowed.every((id) => confirmed.includes(id)), 'review fills confirmed only');
          // Invariant 6: a submit decision implies auto mode and every required field filled.
          if (decision === 'submit') {
            submits += 1;
            check(mode === 'auto' && fields.every((x) => !x.required || x.filled === true), 'submit implies required filled');
          }
          // Invariant 7: confirming an id that is not on the form never changes the outcome.
          check(decide({ ...input, confirmedFieldIds: [...confirmed, 'not-a-field'] }) === decision, 'unrelated confirmation is inert');
        }
      }
    }
    expect(failures).toEqual([]);
    // 3 modes x sum over n=0..4 of (6^n forms x 2^n subsets) = 3 x (1 + 12 + 144 + 1728 + 20736)
    expect(combinations).toBe(3 * 22621);
    expect(submits).toBeGreaterThan(0);
  });

  it('confirming more fields never moves a decision towards submit when sensitive fields exist', () => {
    for (const fields of forms(3)) {
      if (!fields.some((x) => x.sensitive)) continue;
      for (const confirmed of subsets(fields.map((x) => x.id))) {
        expect(decide({ mode: 'auto', fields, confirmedFieldIds: confirmed })).not.toBe('submit');
      }
    }
  });
});
