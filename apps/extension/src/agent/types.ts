import type { FieldKey, FillValue, FillValues, Mode, PolicyDecision, PolicyField, SensitiveCategory, WorkRightsContext } from '@opennjob/core/browser';

/** 'listbox': a button that opens a list of options (Workday's drop-downs), chosen by clicking. */
export type FieldKind = 'text' | 'textarea' | 'select' | 'checkbox' | 'radio' | 'listbox';

/** A fillable control (or radio group) found on the page. */
export interface DetectedField {
  id: string;
  label: string;
  kind: FieldKind;
  sensitive: boolean;
  category: SensitiveCategory | null;
  key: FieldKey | null;
  /** Right-to-work fields: the country the question names, if any. */
  country?: string;
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
  /** OD-5: filled from the person's own right-to-work record, without asking on this form. */
  fromRecord?: boolean;
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
  /**
   * The person's own answers to other ordinary questions, keyed by screeningKey(question).
   * Used only for fields that are NOT sensitive (SCR-3).
   */
  custom?: Record<string, string>;
  /**
   * The queue's two-step submit: fill, report whether the form may be submitted, and stop.
   * The queue asks the API for the go, then sends OPENNJOB_SUBMIT.
   */
  holdSubmit?: boolean;
  /** The job's country and whether the right-to-work answers come from the person's record (OD-5). */
  workRights?: WorkRightsContext;
  /** The tailored CV, attached as a PDF to a field that asks for a CV (files.ts). */
  cv?: { fileName: string; text: string };
  /** The cover letter, attached as a PDF to a field that asks for a cover letter (files.ts). */
  coverLetter?: { fileName: string; text: string };
  /**
   * A multi-step application: the fields of the steps already completed, as the policy sees them.
   * The final submit is judged over these and the last step's fields together, as one form.
   */
  priorFields?: PolicyField[];
}

/** The step controls found on the page (steps.ts). */
export interface StepReport {
  flow: 'workday' | 'successfactors' | 'generic';
  start: boolean;
  next: boolean;
  submit: boolean;
  /** The step has nothing that waits for the person, so pressing next is allowed. */
  canAdvance: boolean;
}

export interface RunReport {
  status: 'ok' | 'blocked';
  blockers: Blocker[];
  mode: Mode;
  dryRun: boolean;
  decision: PolicyDecision | null;
  submitted: boolean;
  /** With holdSubmit: the policy allows submitting and there is exactly one submit button. */
  readyToSubmit?: boolean;
  /** File inputs (CV upload). The agent never sets a file, so a required one holds the form. */
  fileInputs?: { required: number; total: number };
  /** How many CV fields got the CV attached. */
  cvAttached?: number;
  /** How many cover-letter fields got the cover letter attached. */
  coverLetterAttached?: number;
  fields: FieldReport[];
  message: string;
  /** This step's fields as the policy sees them (the queue keeps them for the final decision). */
  policyFields?: PolicyField[];
  /**
   * Drop-down buttons to choose afterwards (they need to wait for their list to open), with the
   * value the policy already allowed for each. Never a value for a field that was not allowed.
   */
  pendingListboxes?: { id: string; value: FillValue }[];
  step?: StepReport;
}

/** The answer to OPENNJOB_SUBMIT. */
export interface SubmitReport {
  submitted: boolean;
  message: string;
}
