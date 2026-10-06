import type { Mode } from './types';

/**
 * THE SAFETY CORE.
 *
 * Decides what the agent may do with a form. It is a pure function with no I/O so that
 * every branch can be (and is) tested exhaustively. The extension must not click a
 * submit control unless this returns 'submit'.
 *
 * Rules:
 *  review  - the user confirms every field. Only confirmed fields may be filled.
 *            Never submits.
 *  hybrid  - non-sensitive fields are filled straight away; each sensitive field is
 *            filled only after the user confirms it. Never submits: the user presses
 *            submit themselves.
 *  auto    - like hybrid, and the agent may submit ONLY when the form has no sensitive
 *            field at all, at least one field, and no required field left empty.
 *            A form with any sensitive field is never submitted by the agent, even
 *            after the user has confirmed those fields: confirmation unlocks filling,
 *            and the user then presses submit. (Deliberately the stricter reading of
 *            "holds for the user".)
 *  anything else (unknown mode, malformed input) - await-confirmation. Fail closed.
 */

export interface PolicyField {
  id: string;
  sensitive: boolean;
  /** Is the field marked required on the form? Only used by auto mode. */
  required?: boolean;
  /** Does the field currently hold a value? Only used by auto mode. */
  filled?: boolean;
}

export interface PolicyInput {
  mode: Mode;
  fields: readonly PolicyField[];
  /** Ids of fields the user has explicitly confirmed. */
  confirmedFieldIds: readonly string[];
}

export type PolicyDecision = 'fill-only' | 'await-confirmation' | 'submit';

export function decide(input: PolicyInput): PolicyDecision {
  if (!input || !Array.isArray(input.fields) || !Array.isArray(input.confirmedFieldIds)) return 'await-confirmation';
  const confirmed = new Set(input.confirmedFieldIds);
  const sensitive = input.fields.filter((f) => f.sensitive !== false); // anything not explicitly non-sensitive counts as sensitive
  const unconfirmedSensitive = sensitive.some((f) => !confirmed.has(f.id));

  switch (input.mode) {
    case 'review':
      return input.fields.some((f) => !confirmed.has(f.id)) ? 'await-confirmation' : 'fill-only';
    case 'hybrid':
      return unconfirmedSensitive ? 'await-confirmation' : 'fill-only';
    case 'auto': {
      if (unconfirmedSensitive) return 'await-confirmation';
      if (sensitive.length > 0) return 'fill-only';
      if (input.fields.length === 0) return 'fill-only';
      if (input.fields.some((f) => f.required === true && f.filled !== true)) return 'fill-only';
      return 'submit';
    }
    default:
      return 'await-confirmation';
  }
}

/** Which fields may be written to right now. */
export function fieldsAllowedToFill(input: PolicyInput): string[] {
  if (!input || !Array.isArray(input.fields) || !Array.isArray(input.confirmedFieldIds)) return [];
  const confirmed = new Set(input.confirmedFieldIds);
  switch (input.mode) {
    case 'review':
      return input.fields.filter((f) => confirmed.has(f.id)).map((f) => f.id);
    case 'hybrid':
    case 'auto':
      return input.fields.filter((f) => f.sensitive === false || confirmed.has(f.id)).map((f) => f.id);
    default:
      return [];
  }
}

export function maySubmit(decision: PolicyDecision): boolean {
  return decision === 'submit';
}
