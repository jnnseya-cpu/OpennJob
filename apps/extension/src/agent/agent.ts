import { decide, fieldsAllowedToFill, maySubmit, ownAnswer, screeningKey, workRightsAnswer } from '@opennjob/core/browser';
import type { DeclarationAnswers, FillValue, FillValues, PolicyField, WorkRightsContext } from '@opennjob/core/browser';
import { blockerMessage, detectBlockers } from './blockers';
import { attachCoverLetter, attachCv, countFileInputs } from './files';
import { fillField } from './fill';
import { hasValue, scanFields } from './scan';
import { isNextLabel, stepControls } from './steps';
import type { DetectedField, FieldReport, FieldState, RunReport, RunRequest, SubmitReport } from './types';

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

/**
 * The value proposed for a field, and whether it comes from the person's own right-to-work record
 * (OD-5). Right-to-work fields go through workRightsAnswer(), which checks the country.
 */
function proposedValue(field: DetectedField, request: Pick<RunRequest, 'values' | 'custom' | 'workRights' | 'declarations'>): { value: FillValue | undefined; fromRecord: boolean } {
  if (field.category === 'right-to-work') return workRightsAnswer(field, request.values, request.workRights);
  // OD-6: a declaration the person answered once (convictions, conflict of interest, certify and
  // consent, equality "Prefer not to say").
  if (field.sensitive) {
    const own = ownAnswer(field, request.declarations);
    if (own.fromOwnRecord) return { value: own.value, fromRecord: true };
  }
  const value = field.key ? request.values[field.key] : !field.sensitive && request.custom ? request.custom[screeningKey(field.label)] : undefined;
  return { value, fromRecord: false };
}

/** A sensitive field that stops auto mode: every sensitive field except one answered from the record. */
const blocksAuto = (field: DetectedField, fromRecord: ReadonlySet<string>) => field.sensitive && !fromRecord.has(field.id);

function findSubmitControl(fields: DetectedField[], doc?: Document): HTMLElement | null {
  const forms = new Set<HTMLFormElement>();
  for (const f of fields) {
    const form = (f.elements[0] as HTMLInputElement | undefined)?.form;
    if (form) forms.add(form);
  }
  if (forms.size === 1) {
    const [form] = [...forms];
    const controls = Array.from((form as HTMLFormElement).querySelectorAll<HTMLElement>('button[type="submit"], input[type="submit"], button:not([type])'));
    const only = controls.length === 1 ? (controls[0] as HTMLElement) : null;
    // "Next" / "Save and Continue" leads to another step: it is not the final submit.
    if (only && isNextLabel(only instanceof HTMLInputElement ? only.value : (only.textContent ?? ''))) return null;
    if (only) return only;
  }
  if (forms.size > 1) return null; // more than one form: too ambiguous to submit
  // No <form> on a recognised multi-step system (Workday is a single-page app): its own submit
  // control, when there is exactly one. Other pages without a form are not submitted.
  if (!doc) return null;
  const controls = stepControls(doc);
  return controls.flow !== 'generic' ? (controls.submit ?? null) : null;
}

/** Every required field filled, no sensitive field other than one answered from the record. */
const stepIsClean = (fields: DetectedField[], fromRecord: ReadonlySet<string>) => !fields.some((f) => blocksAuto(f, fromRecord)) && fields.every((f) => !f.required || hasValue(f));

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
  const proposed = new Map(fields.map((f) => [f.id, proposedValue(f, request)]));
  const fromRecord = new Set(fields.filter((f) => proposed.get(f.id)?.fromRecord).map((f) => f.id));
  const toPolicy = (): PolicyField[] =>
    fields.map((f) => ({ id: f.id, sensitive: f.sensitive, required: f.required, filled: hasValue(f), ...(fromRecord.has(f.id) ? (f.category === 'right-to-work' ? { fromWorkRights: true } : { fromOwnRecord: true }) : {}) }));
  const allowed = new Set(fieldsAllowedToFill({ mode: request.mode, fields: toPolicy(), confirmedFieldIds }));
  const pendingListboxes: { id: string; value: FillValue }[] = [];

  const reports: FieldReport[] = fields.map((field) => {
    // A stored custom answer is only ever looked at for a field that is not sensitive (SCR-3).
    const value = proposed.get(field.id)?.value;
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
      if (outcome.pending) pendingListboxes.push({ id: field.id, value });
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
      ...(fromRecord.has(field.id) ? { fromRecord: true } : {}),
      state,
      ...(reason ? { reason } : {}),
    };
  });

  // The CV, as a PDF, into a field that asks for a CV and nothing else (files.ts). Not on a preview.
  const cvAttached = !dryRun && request.cv ? attachCv(doc, request.cv) : 0;
  const coverLetterAttached = !dryRun && request.coverLetter ? attachCoverLetter(doc, request.coverLetter) : 0;

  // Decide on the state of the page AFTER filling. A multi-step application is one form: the
  // fields of the steps already completed count with this step's.
  const decision = decide({ mode: request.mode, fields: [...(request.priorFields ?? []), ...toPolicy()], confirmedFieldIds });
  let submitted = false;
  let message: string;

  const fileInputs = countFileInputs(doc);
  let readyToSubmit: boolean | undefined;

  if (dryRun) {
    message = 'Preview only. Nothing has been filled.';
  } else if (request.holdSubmit) {
    // The queue: never submits here. It reports, asks the API for the go, then sends OPENNJOB_SUBMIT.
    readyToSubmit = maySubmit(decision) && request.mode === 'auto' && !fields.some((f) => blocksAuto(f, fromRecord)) && fileInputs.required === 0 && findSubmitControl(fields, doc) !== null;
    message = readyToSubmit ? 'Filled. Waiting for the go to submit.' : 'Filled as far as allowed. This form waits for you.';
  } else if (maySubmit(decision) && request.mode === 'auto' && !fields.some((f) => blocksAuto(f, fromRecord))) {
    // The second and third conditions repeat what the policy already guarantees. Deliberate belt and braces.
    const control = findSubmitControl(fields, doc);
    if (control) {
      control.click();
      submitted = true;
      message = fromRecord.size
        ? 'Auto mode: right to work answered from your record and no other sensitive field, so OpennJob pressed submit.'
        : 'Auto mode: this form has no sensitive fields, so OpennJob pressed submit.';
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

  const controls = stepControls(doc);
  const step = {
    flow: controls.flow,
    start: controls.start !== undefined,
    next: controls.next !== undefined,
    submit: findSubmitControl(fields, doc) !== null,
    canAdvance: !dryRun && request.mode === 'auto' && controls.next !== undefined && stepIsClean(fields, fromRecord) && fileInputs.required === 0,
  };
  return {
    ...base,
    status: 'ok',
    blockers: [],
    decision,
    submitted,
    fields: reports,
    message,
    fileInputs,
    policyFields: toPolicy(),
    step,
    ...(pendingListboxes.length ? { pendingListboxes } : {}),
    ...(cvAttached ? { cvAttached } : {}),
    ...(coverLetterAttached ? { coverLetterAttached } : {}),
    ...(readyToSubmit !== undefined ? { readyToSubmit } : {}),
  };
}

/** Presses the step's start control ("Apply", "Apply Manually"). Nothing is filled or sent by it. */
export function pressStart(doc: Document): { pressed: boolean } {
  if (detectBlockers(doc).length > 0) return { pressed: false };
  const { start, next, submit } = stepControls(doc);
  if (!start || next || submit) return { pressed: false };
  start.click();
  return { pressed: true };
}

/**
 * Presses "Save and Continue" / "Next" in auto mode, after checking the step again as it is now:
 * no blocker, no sensitive field other than right to work answered from the person's record, every
 * required field filled, no required file, exactly one next control. Pressing it saves this step on
 * the employer's site; it is not the final submit, which only submitNow does, after the API's go.
 */
export function advanceNow(doc: Document, filledWith?: { values: FillValues; workRights?: WorkRightsContext; declarations?: DeclarationAnswers }): { advanced: boolean; message: string } {
  if (detectBlockers(doc).length > 0) return { advanced: false, message: 'A CAPTCHA or sign-in appeared.' };
  const fields = scanFields(doc);
  const fromRecord = new Set(
    filledWith ? fields.filter((f) => f.sensitive && hasValue(f) && proposedValue(f, filledWith).fromRecord).map((f) => f.id) : [],
  );
  if (!stepIsClean(fields, fromRecord) || countFileInputs(doc).required > 0) return { advanced: false, message: 'This step waits for you.' };
  const { next } = stepControls(doc);
  if (!next) return { advanced: false, message: 'No single next button.' };
  next.click();
  return { advanced: true, message: 'Next step.' };
}


/**
 * The queue's second step, after the API gave the go. Everything is checked again on the
 * page as it is now: no blocker, no sensitive field other than right to work answered from the
 * person's record (OD-5, with the same values and country as the fill), every required field
 * filled, no required file, exactly one submit button. Only then is submit pressed. Auto mode
 * only; the same policy function as every other path (packages/core/src/policy.ts).
 */
export function submitNow(doc: Document, filledWith?: { values: FillValues; workRights?: WorkRightsContext; declarations?: DeclarationAnswers }, priorFields: PolicyField[] = []): SubmitReport {
  if (detectBlockers(doc).length > 0) return { submitted: false, message: 'A CAPTCHA or sign-in appeared. Not submitted.' };
  const fields = scanFields(doc);
  const fromRecord = new Set(
    filledWith ? fields.filter((f) => f.sensitive && hasValue(f) && proposedValue(f, filledWith).fromRecord).map((f) => f.id) : [],
  );
  const policyFields: PolicyField[] = fields.map((f) => ({ id: f.id, sensitive: f.sensitive, required: f.required, filled: hasValue(f), ...(fromRecord.has(f.id) ? (f.category === 'right-to-work' ? { fromWorkRights: true } : { fromOwnRecord: true }) : {}) }));
  const decision = decide({ mode: 'auto', fields: [...priorFields, ...policyFields], confirmedFieldIds: [] });
  if (!maySubmit(decision) || fields.some((f) => blocksAuto(f, fromRecord)) || countFileInputs(doc).required > 0) return { submitted: false, message: 'The form changed and now waits for you. Not submitted.' };
  const control = findSubmitControl(fields, doc);
  if (!control) return { submitted: false, message: 'No single submit button. Not submitted.' };
  control.click();
  return { submitted: true, message: 'Submitted.' };
}
