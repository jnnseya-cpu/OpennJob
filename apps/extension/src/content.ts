/**
 * Content script. Injected into the current tab only when the user opens the popup and
 * presses Scan (activeTab + scripting), never automatically on page load.
 */
import { runAgent, submitNow } from './agent/agent';
import { detectConfirmation } from './agent/confirmation';
import type { Confirmation } from './agent/confirmation';
import type { RunReport, RunRequest, SubmitReport } from './agent/types';

type Message = { type: 'OPENNJOB_PING' } | ({ type: 'OPENNJOB_RUN' } & RunRequest) | { type: 'OPENNJOB_SUBMIT' } | { type: 'OPENNJOB_CONFIRMATION' };

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

if (!scope.__opennjob) {
  // Exposed for the Playwright tests (which inject this bundle into fixture pages). When
  // running as a real content script this lives in the extension's isolated world and
  // is not visible to the page.
  scope.__opennjob = { run, submit: () => submitNow(document, lastFill), confirmation: () => detectConfirmation(document) ?? null };

  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message: Message, _sender, sendResponse) => {
      if (message?.type === 'OPENNJOB_PING') {
        sendResponse({ ok: true });
      } else if (message?.type === 'OPENNJOB_SUBMIT') {
        sendResponse(submitNow(document, lastFill));
      } else if (message?.type === 'OPENNJOB_CONFIRMATION') {
        sendResponse({ confirmation: detectConfirmation(document) ?? null });
      } else if (message?.type === 'OPENNJOB_RUN') {
        try {
          sendResponse(run(message));
        } catch (err) {
          sendResponse({ error: err instanceof Error ? err.message : String(err) });
        }
      }
      return false; // all responses are synchronous
    });
  }
}
