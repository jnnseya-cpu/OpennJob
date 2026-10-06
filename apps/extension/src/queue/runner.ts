import type { FillValues, WorkRightsContext } from '@opennjob/core/browser';
import type { Confirmation } from '../agent/confirmation';
import type { RunReport, SubmitReport } from '../agent/types';
import { holdReasonsOf } from './reasons';

/**
 * The queue, in the person's own browser (APP-3, OD-4). Started by the person from the
 * popup. For each application the API hands out it:
 *   1. checks the person allowed OpennJob on that site (optional, per-site permission)
 *   2. opens the form in a background tab and fills it, in auto mode, holding submit
 *   3. holds the application for the person if anything on the page needs them
 *   4. asks the API for the go (authorisation, pauses and the daily limit are checked again)
 *   5. presses submit and reads the site's confirmation; with none it records "uncertain"
 * It stops at the first reason to wait, and never retries an attempted application.
 */

export interface QueueState {
  running: boolean;
  message: string;
  sent: number;
  held: number;
  uncertain: number;
  /** A site the person needs to allow before the queue can go on. */
  needsSite?: string;
  at: string;
}

interface NextReply {
  wait?: string;
  message?: string;
  application?: { id: string; jobTitle: string; employer: string; applyUrl: string };
  values?: FillValues;
  custom?: Record<string, string>;
  /** The job's country and whether right to work comes from the person's record (OD-5). */
  workRights?: WorkRightsContext;
}

const STEP_LIMIT = 25;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function setState(state: Partial<QueueState>): Promise<QueueState> {
  const current = ((await chrome.storage.local.get('queueState')).queueState ?? {}) as Partial<QueueState>;
  const next = { running: false, message: '', sent: 0, held: 0, uncertain: 0, ...current, ...state, at: new Date().toISOString() } as QueueState;
  // Passing needsSite: undefined clears it; leaving it out keeps it.
  if ('needsSite' in state && state.needsSite === undefined) delete next.needsSite;
  await chrome.storage.local.set({ queueState: next });
  return next;
}

async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const s = await chrome.storage.local.get(['apiBase', 'accessToken']);
  if (typeof s.accessToken !== 'string' || typeof s.apiBase !== 'string') throw new Error('Sign in first.');
  const res = await fetch(`${s.apiBase.replace(/\/+$/, '')}${path}`, {
    method: init.method ?? 'GET',
    headers: { Authorization: `Bearer ${s.accessToken}`, ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  if (res.status === 401) throw new Error('Your session has expired. Sign in again.');
  if (!res.ok) throw new Error(`The API replied ${res.status}.`);
  return (await res.json()) as T;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function waitForLoad(tabId: number, timeoutMs = 20_000): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const listener = (id: number, info: chrome.tabs.TabChangeInfo) => {
      if (id === tabId && info.status === 'complete') done();
    };
    const timer = setTimeout(done, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    void chrome.tabs.get(tabId).then((t) => {
      if (t.status === 'complete') done();
    });
  });
}

async function inject(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
}

/** Polls the page for the site's confirmation, re-injecting after any navigation. */
async function awaitConfirmation(tabId: number, timeoutMs = 10_000): Promise<Confirmation | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await waitForLoad(tabId, 5_000);
      await inject(tabId);
      const reply = (await chrome.tabs.sendMessage(tabId, { type: 'OPENNJOB_CONFIRMATION' })) as { confirmation: Confirmation | null } | undefined;
      if (reply?.confirmation && /^https?:\/\//.test(reply.confirmation.pageUrl)) return reply.confirmation;
    } catch {
      // The page was navigating; try again.
    }
    await sleep(400);
  }
  return undefined;
}

let running = false;

export async function runQueue(): Promise<QueueState> {
  if (running) return setState({});
  running = true;
  let state = await setState({ running: true, message: 'Working through the queue…', sent: 0, held: 0, uncertain: 0, needsSite: undefined });
  try {
    for (let step = 0; step < STEP_LIMIT; step += 1) {
      const next = await api<NextReply>('/agent/queue/next');
      if (!next.application || !next.values) {
        state = await setState({ message: next.message ?? 'Nothing is ready to send.' });
        break;
      }
      const app = next.application;
      const url = new URL(app.applyUrl);
      const origin = `${url.protocol}//${url.hostname}/*`;
      if (!(await chrome.permissions.contains({ origins: [origin] }))) {
        state = await setState({ message: `Allow OpennJob on ${url.hostname} to go on.`, needsSite: url.hostname });
        break;
      }

      const tab = await chrome.tabs.create({ url: app.applyUrl, active: false });
      const tabId = tab.id as number;
      try {
        await waitForLoad(tabId);
        await inject(tabId);
        const report = (await chrome.tabs.sendMessage(tabId, { type: 'OPENNJOB_RUN', mode: 'auto', values: next.values, custom: next.custom ?? {}, confirmedFieldIds: [], holdSubmit: true, ...(next.workRights ? { workRights: next.workRights } : {}) })) as RunReport;
        const reasons = holdReasonsOf(report);
        if (reasons.length > 0) {
          await api(`/agent/queue/${app.id}/result`, { method: 'POST', body: { outcome: 'held', reasons } });
          state = await setState({ held: state.held + 1 });
          continue;
        }
        const go = await api<{ go: boolean; reason?: string; message?: string }>(`/agent/queue/${app.id}/go`, { method: 'POST' });
        if (!go.go) {
          state = await setState({ message: go.message ?? 'Stopped.' });
          break;
        }
        const submitted = (await chrome.tabs.sendMessage(tabId, { type: 'OPENNJOB_SUBMIT' })) as SubmitReport;
        if (!submitted.submitted) {
          await api(`/agent/queue/${app.id}/result`, { method: 'POST', body: { outcome: 'held', reasons: ['form-changed'] } });
          state = await setState({ held: state.held + 1 });
          continue;
        }
        const confirmation = await awaitConfirmation(tabId);
        if (confirmation) {
          const documentsSha256 = typeof next.values.supportingStatement === 'string' ? { statement: await sha256Hex(next.values.supportingStatement) } : {};
          await api(`/agent/queue/${app.id}/result`, { method: 'POST', body: { outcome: 'submitted', receipt: { pageUrl: confirmation.pageUrl, confirmationText: confirmation.text.slice(0, 2000), documentsSha256 } } });
          state = await setState({ sent: state.sent + 1 });
        } else {
          await api(`/agent/queue/${app.id}/result`, { method: 'POST', body: { outcome: 'uncertain', pageUrl: app.applyUrl } });
          state = await setState({ uncertain: state.uncertain + 1 });
        }
      } finally {
        await chrome.tabs.remove(tabId).catch(() => undefined);
      }
    }
  } catch (err) {
    state = await setState({ message: err instanceof Error ? err.message : String(err) });
  } finally {
    running = false;
    state = await setState({ running: false });
  }
  return state;
}
