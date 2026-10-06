import { decide, fieldsAllowedToFill, maySubmit } from '@opennjob/core/browser';
import type { FillValue, PolicyField } from '@opennjob/core/browser';
import { blockerMessage, detectBlockers } from './blockers';
import { fillField } from './fill';
import { hasValue, scanFields } from './scan';
import type { DetectedField, FieldReport, FieldState, RunReport, RunRequest } from './types';

const SENSITIVE_OUTLINE = '3px solid #b45309';

function preview(value: FillValue | undefined): string | null {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  const oneLine = value.replace(/\s+/g, ' ').trim();
  return oneLine.length > 60 ? `${oneLine.slice(0, 57)}...` : oneLine;
}

/** Visible outline plus data attributes on every sensitive control, so the user can see what is being held back. */
function markSensitive(field: DetectedField, state: FieldState): void {
  const targets = field.kind === 'radio' ? [field.elements[0]?.closest('fieldset') ?? field.elements[0]] : field.elements;
  for (const el of targets) {
    if (!(el instanceof HTMLElement)) continue;
    el.style.outline = SENSITIVE_OUTLINE;
    el.style.outlineOffset = '2px';
    el.setAttribute('data-opennjob-sensitive', field.category ?? 'sensitive');
    el.setAttribute('data-opennjob-state', state);
  }
}

function findSubmitControl(fields: DetectedField[]): HTMLElement | null {
  const forms = new Set<HTMLFormElement>();
  for (const f of fields) {
    const form = (f.elements[0] as HTMLInputElement | undefined)?.form;
    if (form) forms.add(form);
  }
  if (forms.size !== 1) return null; // no form, or more than one: too ambiguous to submit
  const [form] = [...forms];
  const controls = Array.from((form as HTMLFormElement).querySelectorAll<HTMLElement>('button[type="submit"], input[type="submit"], button:not([type])'));
  return controls.length === 1 ? (controls[0] as HTMLElement) : null;
}

/**
 * The whole agent, for one page, in one synchronous pass:
 *   1. stop if there is a CAPTCHA or a login wall
 *   2. find and classify the fields; outline the sensitive ones
 *   3. fill only what the policy allows for this mode and these confirmations
 *   4. ask the policy what to do next; click submit only if it says 'submit'
 */
export function runAgent(doc: Document, request: RunRequest): RunReport {
  const dryRun = request.dryRun === true;
  const base = { mode: request.mode, dryRun, submitted: false };

  const blockers = detectBlockers(doc);
  if (blockers.length > 0) {
    return { ...base, status: 'blocked', blockers, decision: null, fields: [], message: blockerMessage(blockers) };
  }

  const fields = scanFields(doc);
  const confirmedFieldIds = request.confirmedFieldIds ?? [];
  const toPolicy = (): PolicyField[] => fields.map((f) => ({ id: f.id, sensitive: f.sensitive, required: f.required, filled: hasValue(f) }));
  const allowed = new Set(fieldsAllowedToFill({ mode: request.mode, fields: toPolicy(), confirmedFieldIds }));

  const reports: FieldReport[] = fields.map((field) => {
    const value = field.key ? request.values[field.key] : undefined;
    let state: FieldState;
    let reason: string | undefined;

    if (value === undefined) {
      state = field.sensitive ? 'answer-yourself' : 'no-data';
    } else if (!allowed.has(field.id)) {
      state = 'awaiting-confirmation';
    } else if (dryRun) {
      state = 'will-fill';
    } else {
      const outcome = fillField(field, value);
      state = outcome.filled ? 'filled' : 'skipped';
      reason = outcome.reason;
    }
    if (field.sensitive) markSensitive(field, state);
    else if (state === 'filled') field.elements[0]?.setAttribute('data-opennjob-state', 'filled');

    return {
      id: field.id,
      label: field.label.length > 120 ? `${field.label.slice(0, 117)}...` : field.label,
      kind: field.kind,
      sensitive: field.sensitive,
      category: field.category,
      key: field.key,
      required: field.required,
      proposed: preview(value),
      state,
      ...(reason ? { reason } : {}),
    };
  });

  // Decide on the state of the page AFTER filling.
  const decision = decide({ mode: request.mode, fields: toPolicy(), confirmedFieldIds });
  let submitted = false;
  let message: string;

  if (dryRun) {
    message = 'Preview only. Nothing has been filled.';
  } else if (maySubmit(decision) && request.mode === 'auto' && !fields.some((f) => f.sensitive)) {
    // The second and third conditions repeat what the policy already guarantees. Deliberate belt and braces.
    const control = findSubmitControl(fields);
    if (control) {
      control.click();
      submitted = true;
      message = 'Auto mode: this form has no sensitive fields, so OpennJob pressed submit.';
    } else {
      message = 'Auto mode: the form is filled but OpennJob could not identify a single submit button, so it did not submit. Press submit yourself.';
    }
  } else if (decision === 'await-confirmation') {
    message =
      request.mode === 'review'
        ? 'Review mode: tick each field you want filled, then press Fill again. OpennJob never presses submit in review mode.'
        : 'Sensitive fields are outlined and have not been filled. Confirm each one, then press Fill again. OpennJob will not submit this form.';
  } else {
    message =
      request.mode === 'auto'
        ? 'Auto mode did not submit this form (it has sensitive fields or required fields are still empty). Check it and press submit yourself.'
        : 'Filled. Check every field, then press submit on the page yourself. OpennJob never presses submit in this mode.';
  }

  return { ...base, status: 'ok', blockers: [], decision, submitted, fields: reports, message };
}
