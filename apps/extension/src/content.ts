/**
 * Content script. Injected into the current tab only when the user opens the popup and
 * presses Scan (activeTab + scripting), never automatically on page load.
 */
import type { PolicyField } from '@opennjob/core/browser';
import { advanceNow, pressStart, runAgent, submitNow } from './agent/agent';
import { selectListboxOption } from './agent/fill';
import { scanFields } from './agent/scan';
import { stepErrors, stepSignature } from './agent/steps';
import { detectConfirmation } from './agent/confirmation';
import type { Confirmation } from './agent/confirmation';
import type { RunReport, RunRequest, SubmitReport } from './agent/types';

type Message =
  | { type: 'OPENNJOB_PING' }
  | ({ type: 'OPENNJOB_RUN' } & RunRequest)
  | { type: 'OPENNJOB_SUBMIT'; priorFields?: PolicyField[] }
  | { type: 'OPENNJOB_CONFIRMATION' }
  | { type: 'OPENNJOB_START' }
  | { type: 'OPENNJOB_NEXT' }
  | { type: 'OPENNJOB_STEP_STATE' };

interface OpennJobGlobal {
  __opennjob?: { run: (request: RunRequest) => RunReport; submit: () => SubmitReport; confirmation: () => Confirmation | null };
}

const scope = globalThis as unknown as OpennJobGlobal;

/** The values and country of the last fill on this page: the submit re-check uses the same ones. */
let lastFill: Pick<RunRequest, 'values' | 'workRights'> | undefined;
const run = (request: RunRequest): RunReport => {
  lastFill = { values: request.values, ...(request.workRights ? { workRights: request.workRights } : {}) };
  return runAgent(document, request);
};

/**
 * Fill, then choose the drop-down options the fill left pending (they have to wait for their list
 * to open), then read the page again so the report is about the page as it now is.
 */
async function runWithListboxes(request: RunRequest): Promise<RunReport> {
  const first = run(request);
  if (!first.pendingListboxes?.length || request.dryRun) return first;
  const byId = new Map(scanFields(document).map((f) => [f.id, f]));
  // Only the values runAgent already allowed under the policy, for the fields it allowed.
  for (const { id, value } of first.pendingListboxes) {
    const button = byId.get(id)?.elements[0];
    if (button) await selectListboxOption(button, value);
  }
  const second = run(request);
  // A list that still could not be chosen is reported as such, so the step waits for the person.
  return { ...second, pendingListboxes: undefined };
}

if (!scope.__opennjob) {
  // Exposed for the Playwright tests (which inject this bundle into fixture pages). When
  // running as a real content script this lives in the extension's isolated world and
  // is not visible to the page.
  scope.__opennjob = { run, submit: () => submitNow(document, lastFill), confirmation: () => detectConfirmation(document) ?? null };
  const stepState = () => ({ signature: stepSignature(document), errors: stepErrors(document) });

  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message: Message, _sender, sendResponse) => {
      if (message?.type === 'OPENNJOB_PING') {
        sendResponse({ ok: true });
      } else if (message?.type === 'OPENNJOB_SUBMIT') {
        sendResponse(submitNow(document, lastFill, message.priorFields ?? []));
      } else if (message?.type === 'OPENNJOB_CONFIRMATION') {
        sendResponse({ confirmation: detectConfirmation(document) ?? null });
      } else if (message?.type === 'OPENNJOB_START') {
        sendResponse(pressStart(document));
      } else if (message?.type === 'OPENNJOB_NEXT') {
        sendResponse(advanceNow(document, lastFill));
      } else if (message?.type === 'OPENNJOB_STEP_STATE') {
        sendResponse(stepState());
      } else if (message?.type === 'OPENNJOB_RUN') {
        runWithListboxes(message).then(sendResponse, (err: unknown) => sendResponse({ error: err instanceof Error ? err.message : String(err) }));
        return true; // the fill may wait for drop-down lists: the answer comes asynchronously
      }
      return false;
    });
  }
}
