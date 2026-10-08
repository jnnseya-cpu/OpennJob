import type { FillValues, PolicyField, WorkRightsContext } from '@opennjob/core/browser';
import type { Confirmation } from '../agent/confirmation';
import type { RunReport, SubmitReport } from '../agent/types';
import { holdReasonsOf, stepHoldReasons } from './reasons';

/**
 * The queue, in the person's own browser (APP-3, OD-4). Started by the person from the
 * popup. For each application the API hands out it:
 *   1. checks the person allowed OpennJob on that site (optional, per-site permission)
 *   2. opens the form in a background tab and fills it, in auto mode, holding submit
 *   3. holds the application for the person if anything on the page needs them
 *   4. asks the API for the go (authorisation, pauses and the daily limit are checked again)
 *   5. presses submit and reads the site's confirmation; with none it records "uncertain"
 * It stops at the first reason to wait, and never retries an attempted application.
 *
 * Multi-step applications (Workday, SuccessFactors, any form split over pages): it presses the
 * start control ("Apply", "Apply Manually"), fills each step and presses "Save and Continue" only
 * when the step has nothing that waits for the person, and judges the final submit over the fields
 * of every step together. When it stops part-way, or at a sign-in page, the tab is left open so the
 * person can sign in, or finish the step it stopped at, where it is.
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
  /** The tailored CV, attached to a field that asks for a CV. */
  cv?: { fileName: string; text: string };
  /** The cover letter, attached to a field that asks for one. */
  coverLetter?: { fileName: string; text: string };
}

const STEP_LIMIT = 25;
/** Steps (pages or screens) of one application, at most. */
const MAX_STEPS = 15;
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

async function send<T>(tabId: number, message: object): Promise<T> {
  return (await chrome.tabs.sendMessage(tabId, message)) as T;
}

/** Waits until the step on screen changes (a new page, or a new screen of a single-page app). */
async function settle(tabId: number, before: string, timeoutMs = 10_000): Promise<{ changed: boolean; errors: string[] }> {
  const deadline = Date.now() + timeoutMs;
  let errors: string[] = [];
  while (Date.now() < deadline) {
    await sleep(300);
    try {
      await waitForLoad(tabId, 3_000);
      await inject(tabId);
      const state = await send<{ signature: string; errors: string[] }>(tabId, { type: 'OPENNJOB_STEP_STATE' });
      errors = state.errors;
      if (state.signature !== before) {
        await sleep(400); // let the new step finish drawing
        return { changed: true, errors: [] };
      }
    } catch {
      // The page was navigating; look again.
    }
  }
  return { changed: false, errors };
}

/** How long the queue waits for the person to sign in on an employer's site. */
export const SIGN_IN_WAIT_MS = 10 * 60_000;

/**
 * Brings the tab to the front and waits while the person signs in (or creates the account) there.
 * True once the sign-in form is gone; false after SIGN_IN_WAIT_MS.
 */
async function waitForSignIn(tabId: number, host: string): Promise<boolean> {
  // The tests set a shorter wait in storage; people get SIGN_IN_WAIT_MS.
  const stored = (await chrome.storage.local.get('signInWaitMs')).signInWaitMs;
  const timeoutMs = typeof stored === 'number' && stored > 0 ? stored : SIGN_IN_WAIT_MS;
  await chrome.tabs.update(tabId, { active: true });
  await setState({ message: `Sign in on ${host} in the tab OpennJob opened (create the account there if you have none). The queue goes on by itself once you are in.` });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(2_000);
    try {
      await waitForLoad(tabId, 3_000);
      await inject(tabId);
      const now = await send<{ signIn: boolean }>(tabId, { type: 'OPENNJOB_STEP_STATE' });
      if (!now.signIn) {
        await sleep(1_000); // let the page after sign-in finish drawing
        return true;
      }
    } catch {
      // The tab is navigating (the sign-in was sent), or it was closed: look again until the deadline.
      if (!(await chrome.tabs.get(tabId).catch(() => undefined))) return false;
    }
  }
  return false;
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
      // Left open when the person has something to do in it: sign in, or finish a step part-way.
      let keepTab = false;
      try {
        await waitForLoad(tabId);
        const runRequest = { type: 'OPENNJOB_RUN', mode: 'auto', values: next.values, custom: next.custom ?? {}, confirmedFieldIds: [], holdSubmit: true, ...(next.workRights ? { workRights: next.workRights } : {}), ...(next.cv ? { cv: next.cv } : {}), ...(next.coverLetter ? { coverLetter: next.coverLetter } : {}) };
        const prior: PolicyField[] = [];
        let stepsDone = 0;
        let report: RunReport | undefined;
        let reasons: string[] = [];
        for (let s = 0; s < MAX_STEPS; s += 1) {
          await inject(tabId);
          report = await send<RunReport>(tabId, { ...runRequest, priorFields: prior });
          if (report.status === 'blocked') {
            // A sign-in page: the person signs in, in this tab (doing any CAPTCHA on it as part of
            // their own sign-in), and the queue goes on from there. OpennJob never types a password
            // and never touches a CAPTCHA; it only waits (rule 4: nothing is worked around).
            if (report.blockers.includes('login-wall') && (await waitForSignIn(tabId, url.hostname))) {
              state = await setState({ message: 'Working through the queue…' });
              continue;
            }
            reasons = holdReasonsOf(report);
            keepTab = report.blockers.includes('login-wall') || report.blockers.includes('captcha'); // left for the person to finish
            break;
          }
          if (report.readyToSubmit) break; // the final step: submit after the go, below
          if (report.step?.next) {
            if (!report.step.canAdvance) {
              reasons = stepHoldReasons(report);
              break;
            }
            const before = await send<{ signature: string }>(tabId, { type: 'OPENNJOB_STEP_STATE' });
            const pressed = await send<{ advanced: boolean }>(tabId, { type: 'OPENNJOB_NEXT' });
            if (!pressed.advanced) {
              reasons = stepHoldReasons(report);
              break;
            }
            const moved = await settle(tabId, before.signature);
            if (!moved.changed) {
              reasons = [moved.errors[0] ? `step-refused:${moved.errors[0].slice(0, 200)}` : 'step-refused'];
              break;
            }
            prior.push(...(report.policyFields ?? []).map((f) => ({ ...f, id: `step${s}:${f.id}` })));
            stepsDone += 1;
            continue;
          }
          if (report.step?.start) {
            const before = await send<{ signature: string }>(tabId, { type: 'OPENNJOB_STEP_STATE' });
            const pressed = await send<{ pressed: boolean }>(tabId, { type: 'OPENNJOB_START' });
            if (pressed.pressed && (await settle(tabId, before.signature)).changed) continue;
          }
          reasons = holdReasonsOf(report);
          break;
        }
        if (!report?.readyToSubmit && reasons.length === 0) reasons = ['too-many-steps'];
        if (reasons.length > 0) {
          if (stepsDone > 0) {
            reasons.push(`steps-saved:${stepsDone}`);
            keepTab = true;
          }
          await api(`/agent/queue/${app.id}/result`, { method: 'POST', body: { outcome: 'held', reasons } });
          state = await setState({ held: state.held + 1 });
          continue;
        }
        const go = await api<{ go: boolean; reason?: string; message?: string }>(`/agent/queue/${app.id}/go`, { method: 'POST' });
        if (!go.go) {
          state = await setState({ message: go.message ?? 'Stopped.' });
          break;
        }
        const submitted = await send<SubmitReport>(tabId, { type: 'OPENNJOB_SUBMIT', priorFields: prior });
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
        if (!keepTab) await chrome.tabs.remove(tabId).catch(() => undefined);
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
