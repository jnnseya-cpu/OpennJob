import type { FieldKey, FillValues, Mode, PolicyDecision, SensitiveCategory } from '@opennjob/core/browser';

export type FieldKind = 'text' | 'textarea' | 'select' | 'checkbox' | 'radio';

/** A fillable control (or radio group) found on the page. */
export interface DetectedField {
  id: string;
  label: string;
  kind: FieldKind;
  sensitive: boolean;
  category: SensitiveCategory | null;
  key: FieldKey | null;
  required: boolean;
  elements: HTMLElement[];
}

export type FieldState =
  /** The agent wrote the value (or the same value was already there). */
  | 'filled'
  /** There is a value to fill but the user has not confirmed this field yet. */
  | 'awaiting-confirmation'
  /** Sensitive field OpennJob holds no answer for (e.g. convictions). The user must answer it personally. */
  | 'answer-yourself'
  /** Ordinary field OpennJob has no data for. */
  | 'no-data'
  /** There was a value but it was not written; see `reason`. */
  | 'skipped'
  /** Preview only: would be filled by a real run. */
  | 'will-fill';

export interface FieldReport {
  id: string;
  label: string;
  kind: FieldKind;
  sensitive: boolean;
  category: SensitiveCategory | null;
  key: FieldKey | null;
  required: boolean;
  /** Short preview of the value OpennJob proposes (never the full statement). */
  proposed: string | null;
  state: FieldState;
  reason?: string;
}

export type Blocker = 'captcha' | 'login-wall';

export interface RunRequest {
  mode: Mode;
  values: FillValues;
  confirmedFieldIds: string[];
  /** true = report what would happen and mark sensitive fields, but write nothing and never submit. */
  dryRun?: boolean;
}

export interface RunReport {
  status: 'ok' | 'blocked';
  blockers: Blocker[];
  mode: Mode;
  dryRun: boolean;
  decision: PolicyDecision | null;
  submitted: boolean;
  fields: FieldReport[];
  message: string;
}
