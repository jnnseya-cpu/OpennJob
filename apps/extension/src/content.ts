/**
 * Content script. Injected into the current tab only when the user opens the popup and
 * presses Scan (activeTab + scripting), never automatically on page load.
 */
import { runAgent } from './agent/agent';
import type { RunReport, RunRequest } from './agent/types';

type Message = { type: 'OPENNJOB_PING' } | ({ type: 'OPENNJOB_RUN' } & RunRequest);

interface OpennJobGlobal {
  __opennjob?: { run: (request: RunRequest) => RunReport };
}

const scope = globalThis as unknown as OpennJobGlobal;

if (!scope.__opennjob) {
  // Exposed for the Playwright tests (which inject this bundle into fixture pages). When
  // running as a real content script this lives in the extension's isolated world and
  // is not visible to the page.
  scope.__opennjob = { run: (request) => runAgent(document, request) };

  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message: Message, _sender, sendResponse) => {
      if (message?.type === 'OPENNJOB_PING') {
        sendResponse({ ok: true });
      } else if (message?.type === 'OPENNJOB_RUN') {
        try {
          sendResponse(runAgent(document, message));
        } catch (err) {
          sendResponse({ error: err instanceof Error ? err.message : String(err) });
        }
      }
      return false; // all responses are synchronous
    });
  }
}
