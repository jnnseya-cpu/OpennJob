/**
 * Popup UI. Everything the agent does starts from a button press here.
 * Page-derived text (field labels) is only ever written with textContent.
 */
import { buildFillValues } from '@opennjob/core/browser';
import type { Application, FillValues, Mode, Passport, Profile } from '@opennjob/core/browser';
import type { Confirmation } from '../agent/confirmation';
import type { FieldReport, RunReport, RunRequest } from '../agent/types';
import type { QueueState } from '../queue/runner';

interface Settings {
  apiBase: string;
  mode: Mode;
}

/** What is kept after signing in: the access token and when it stops working. Never the password. */
interface Session {
  accessToken: string;
  /** ISO time. */
  expiresAt: string;
  email: string;
}

const DEFAULT_API_BASE = 'http://127.0.0.1:3000';
const SESSION_KEYS = ['accessToken', 'tokenExpiresAt', 'accountEmail'];
const SIGNED_OUT = 'Sign in to load your details.';
const EXPIRED = 'Your session has expired. Sign in again.';

/** Thrown by api() when the API says the token is no longer good. */
class SessionEndedError extends Error {}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const modeSelect = $<HTMLSelectElement>('mode');
const apiBaseInput = $<HTMLInputElement>('apiBase');
const signInForm = $<HTMLFormElement>('sign-in');
const emailInput = $<HTMLInputElement>('email');
const passwordInput = $<HTMLInputElement>('password');
const accountEl = $<HTMLParagraphElement>('account');
const applicationSelect = $<HTMLSelectElement>('application');
const statusEl = $<HTMLParagraphElement>('status');
const fillButton = $<HTMLButtonElement>('fill');
const fieldsList = $<HTMLUListElement>('fields');
const confirmAllButton = $<HTMLButtonElement>('confirm-all');
const markSubmittedButton = $<HTMLButtonElement>('mark-submitted');

const MODE_HELP: Record<Mode, string> = {
  review: 'Review: nothing is filled until you tick it. You press submit yourself.',
  hybrid: 'Hybrid: ordinary fields are filled for you. Sensitive fields (outlined on the page) wait for your tick. You press submit yourself.',
  auto: 'Auto: OpennJob may press submit, but only on a form with no sensitive fields at all. Anything else is held for you.',
};

const STATE_LABEL: Record<FieldReport['state'], string> = {
  filled: 'Filled',
  'awaiting-confirmation': 'Needs your tick',
  'answer-yourself': 'Answer yourself',
  'no-data': 'No data',
  skipped: 'Not filled',
  'will-fill': 'Will fill',
};

let profile: Profile | undefined;
let passport: Passport | undefined;
let applications: Application[] = [];
let lastReport: RunReport | undefined;
let session: Session | undefined;
const confirmed = new Set<string>();

function setStatus(text: string, kind: '' | 'blocked' | 'warn' = ''): void {
  statusEl.textContent = text;
  statusEl.className = kind;
}

async function loadSettings(): Promise<Settings> {
  const s = await chrome.storage.local.get(['apiBase', 'mode']);
  const mode: Mode = s.mode === 'review' || s.mode === 'auto' ? s.mode : 'hybrid';
  return { apiBase: typeof s.apiBase === 'string' && s.apiBase ? s.apiBase : DEFAULT_API_BASE, mode };
}

async function loadSession(): Promise<Session | undefined> {
  // `token` was the shared API token of the first version. It opens nothing now; remove it.
  await chrome.storage.local.remove('token');
  const s = await chrome.storage.local.get(SESSION_KEYS);
  if (typeof s.accessToken !== 'string' || !s.accessToken || typeof s.tokenExpiresAt !== 'string') return undefined;
  return { accessToken: s.accessToken, expiresAt: s.tokenExpiresAt, email: typeof s.accountEmail === 'string' ? s.accountEmail : '' };
}

const isExpired = (s: Session): boolean => !(Date.parse(s.expiresAt) > Date.now());

function currentApiBase(): string {
  return apiBaseInput.value.trim().replace(/\/+$/, '');
}

/**
 * The address the password and token are sent to. It must be https, except on this
 * computer (localhost, 127.0.0.1), where http is what a developer runs.
 */
function apiBaseProblem(apiBase: string): string | undefined {
  let url: URL;
  try {
    url = new URL(apiBase);
  } catch {
    return 'The OpennJob API address is not a web address.';
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol === 'https:' || (url.protocol === 'http:' && local)) return undefined;
  return 'The OpennJob API address must start with https:// (http:// is only allowed for this computer).';
}

function clearData(): void {
  profile = undefined;
  passport = undefined;
  applications = [];
  confirmed.clear();
  lastReport = undefined;
  applicationSelect.replaceChildren(new Option('No statement (profile details only)', ''));
  fieldsList.replaceChildren();
  $('results').hidden = true;
  fillButton.disabled = true;
  markSubmittedButton.hidden = true;
}

/** Shows the sign-in form or the signed-in line. */
function showSession(): void {
  // The last characters of the token in use, for the automated tests. Not enough to use as a token.
  if (session) document.body.dataset.sessionToken = session.accessToken.slice(-8);
  else delete document.body.dataset.sessionToken;
  signInForm.hidden = session !== undefined;
  accountEl.hidden = session === undefined;
  $('account-email').textContent = session ? `Signed in as ${session.email}` : '';
}

/** Forgets the token and everything loaded with it, and asks the user to sign in. */
async function endSession(message: string, kind: '' | 'blocked' | 'warn' = 'warn'): Promise<void> {
  session = undefined;
  await chrome.storage.local.remove(SESSION_KEYS);
  clearData();
  showSession();
  setStatus(message, kind);
}

async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T | undefined> {
  if (!session) throw new SessionEndedError(SIGNED_OUT);
  // Known to be out of date: do not send it at all.
  if (isExpired(session)) throw new SessionEndedError(EXPIRED);
  const res = await fetch(`${currentApiBase()}${path}`, {
    method: init.method ?? 'GET',
    headers: { Authorization: `Bearer ${session.accessToken}`, ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  if (res.status === 401) throw new SessionEndedError(EXPIRED); // expired, revoked, or the account was deleted
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`The API replied ${res.status}.`);
  return (await res.json()) as T;
}

/** Runs an API call; when the session has ended it signs the user out and returns false. */
async function withSession(work: () => Promise<void>, onError: (message: string) => void): Promise<boolean> {
  try {
    await work();
    return true;
  } catch (err) {
    if (err instanceof SessionEndedError) {
      await endSession(err.message);
      return false;
    }
    onError(err instanceof Error ? err.message : String(err));
    return false;
  }
}

async function loadData(): Promise<void> {
  const ok = await withSession(
    async () => {
      profile = await api<Profile>('/profile');
      passport = (await api<{ passport: Passport }>('/passport'))?.passport;
      applications = ((await api<Application[]>('/applications')) ?? []).filter((a) => a.status !== 'submitted');
    },
    (message) => {
      profile = undefined;
      setStatus(`Could not reach OpennJob: ${message}`, 'blocked');
    },
  );
  if (!ok) return;
  applicationSelect.replaceChildren(new Option('No statement (profile details only)', ''));
  for (const a of applications) applicationSelect.add(new Option(`${a.jobTitle} - ${a.employer}`, a.id));
  if (applications[0]) applicationSelect.value = applications[0].id;
  setStatus(profile ? `Loaded details for ${profile.firstName} ${profile.lastName}.` : 'No profile is saved in OpennJob yet.', profile ? '' : 'warn');
}

/** POST /auth/login. The password goes to the API and nowhere else; only the token is stored. */
async function signIn(): Promise<void> {
  const apiBase = currentApiBase();
  const problem = apiBaseProblem(apiBase);
  if (problem) {
    $<HTMLDetailsElement>('settings').open = true;
    setStatus(problem, 'blocked');
    return;
  }
  const email = emailInput.value.trim();
  const password = passwordInput.value;
  if (!email || !password) {
    setStatus('Enter your email address and password.', 'warn');
    return;
  }
  let res: Response;
  try {
    res = await fetch(`${apiBase}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  } catch {
    setStatus('Could not reach OpennJob at that address.', 'blocked');
    return;
  }
  passwordInput.value = '';
  if (!res.ok) {
    setStatus(res.status === 401 ? 'Email address or password is incorrect.' : res.status === 429 ? 'Too many attempts. Wait a few minutes and try again.' : `Sign-in failed: the API replied ${res.status}.`, 'blocked');
    return;
  }
  const body = (await res.json()) as { accessToken?: unknown; expiresAt?: unknown; user?: { email?: unknown } };
  if (typeof body.accessToken !== 'string' || typeof body.expiresAt !== 'string') {
    setStatus('Sign-in failed: the API reply was not understood.', 'blocked');
    return;
  }
  session = { accessToken: body.accessToken, expiresAt: body.expiresAt, email: typeof body.user?.email === 'string' ? body.user.email : email };
  await chrome.storage.local.set({ apiBase, accessToken: session.accessToken, tokenExpiresAt: session.expiresAt, accountEmail: session.email });
  showSession();
  await loadData();
  await loadQueue();
}

function selectedApplication(): Application | undefined {
  return applications.find((a) => a.id === applicationSelect.value);
}

function fillValues(): FillValues {
  return profile ? buildFillValues(profile, passport, selectedApplication()?.statement) : {};
}

/** The tab to work on. `?tabId=` is a hook for the automated tests; normally it is the active tab. */
async function targetTabId(): Promise<number> {
  const fromQuery = Number(new URLSearchParams(location.search).get('tabId'));
  if (Number.isInteger(fromQuery) && fromQuery > 0) return fromQuery;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) throw new Error('No active tab.');
  return tab.id;
}

async function sendToPage(request: RunRequest): Promise<RunReport> {
  const tabId = await targetTabId();
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  const reply = (await chrome.tabs.sendMessage(tabId, { type: 'OPENNJOB_RUN', ...request })) as RunReport | { error: string } | undefined;
  if (!reply) throw new Error('The page did not answer.');
  if ('error' in reply) throw new Error(reply.error);
  return reply;
}

/** The site's confirmation on the target tab, if one is showing (APP-7). */
async function readConfirmation(): Promise<Confirmation | undefined> {
  const tabId = await targetTabId();
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  const reply = (await chrome.tabs.sendMessage(tabId, { type: 'OPENNJOB_CONFIRMATION' })) as { confirmation: Confirmation | null } | undefined;
  const c = reply?.confirmation;
  return c && /^https?:\/\//.test(c.pageUrl) ? c : undefined;
}

async function awaitConfirmation(timeoutMs = 5_000): Promise<Confirmation | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await readConfirmation().catch(() => undefined);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return undefined;
}

// ----- the queue (standing authorisation, OD-4) ----------------------------------------

const queueSection = $<HTMLElement>('queue');
const queueStatus = $<HTMLParagraphElement>('queue-status');
const allowSiteButton = $<HTMLButtonElement>('allow-site');
let siteToAllow: string | undefined;

function showQueueState(state: QueueState | undefined): void {
  if (!state) return;
  const counts = `Sent ${state.sent}, held for you ${state.held}, unconfirmed ${state.uncertain}.`;
  queueStatus.textContent = state.running ? `Working… ${counts}` : `${state.message} ${counts}`.trim();
  if (state.needsSite) offerSite(state.needsSite);
}

function offerSite(host: string): void {
  siteToAllow = host;
  allowSiteButton.textContent = `Allow OpennJob on ${host}`;
  allowSiteButton.hidden = false;
}

interface AgentStatus {
  authorisation: { enabled: boolean };
  queue: { ready: number; waitingForSystem: number; needsYou: number };
  message?: string;
}

async function loadQueue(): Promise<void> {
  // Only while signed in: an ended session already told the person why.
  if (!session) return;
  await withSession(
    async () => {
      const status = await api<AgentStatus>('/agent/status');
      if (!status) return;
      queueSection.hidden = false;
      queueStatus.textContent = status.message ?? `${status.queue.ready} ready to send, ${status.queue.needsYou} waiting for you.`;
      const next = await api<{ application?: { applyUrl: string } }>('/agent/queue/next');
      if (next?.application) {
        const url = new URL(next.application.applyUrl);
        if (!(await chrome.permissions.contains({ origins: [`${url.protocol}//${url.hostname}/*`] }))) offerSite(url.hostname);
      }
      showQueueState((await chrome.storage.local.get('queueState')).queueState as QueueState | undefined);
    },
    () => undefined,
  );
}

function needsTick(field: FieldReport, mode: Mode): boolean {
  return mode === 'review' || field.sensitive;
}

function render(report: RunReport): void {
  lastReport = report;
  const mode = report.mode;
  $('results').hidden = report.status === 'blocked';
  fieldsList.replaceChildren();
  let tickable = 0;

  for (const field of report.fields) {
    const li = document.createElement('li');
    if (field.sensitive) li.className = 'sensitive';

    const tickCell = document.createElement('span');
    if (needsTick(field, mode)) {
      tickable += 1;
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = confirmed.has(field.id);
      box.dataset.fieldId = field.id;
      box.dataset.sensitive = String(field.sensitive);
      box.setAttribute('aria-label', `${field.proposed === null ? 'I will answer this myself' : 'Confirm'}: ${field.label}`);
      box.addEventListener('change', () => {
        if (box.checked) confirmed.add(field.id);
        else confirmed.delete(field.id);
      });
      tickCell.append(box);
    }

    const text = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = field.label;
    const value = document.createElement('div');
    value.className = 'value';
    value.textContent =
      field.reason ?? (field.proposed !== null ? field.proposed : field.sensitive ? 'OpennJob does not answer this. Tick to confirm you will.' : 'Nothing stored for this field.');
    text.append(name, value);

    const badge = document.createElement('span');
    badge.className = `badge ${field.state}`;
    badge.textContent = STATE_LABEL[field.state];

    li.append(tickCell, text, badge);
    fieldsList.append(li);
  }

  // Bulk ticking exists only for ordinary fields in review mode. Sensitive fields are always ticked one at a time.
  confirmAllButton.hidden = mode !== 'review' || tickable === 0;
  fillButton.disabled = report.status === 'blocked' || report.fields.length === 0 || !profile;
  setStatus(report.message, report.status === 'blocked' ? 'blocked' : report.decision === 'await-confirmation' ? 'warn' : '');
  markSubmittedButton.hidden = !selectedApplication() || report.status === 'blocked';
}

async function run(dryRun: boolean): Promise<void> {
  if (!profile && !dryRun) {
    setStatus(session ? 'No profile is saved in OpennJob yet.' : SIGNED_OUT, 'warn');
    return;
  }
  try {
    const mode = modeSelect.value as Mode;
    const report = await sendToPage({ mode, values: fillValues(), confirmedFieldIds: [...confirmed], dryRun });
    render(report);
    if (!dryRun) await recordOutcome(report);
  } catch (err) {
    setStatus(`OpennJob cannot work on this page: ${err instanceof Error ? err.message : String(err)}`, 'blocked');
  }
}

/** Tells the API which sensitive fields the user confirmed (names only, never values) and whether the agent submitted. */
async function recordOutcome(report: RunReport): Promise<void> {
  const application = selectedApplication();
  if (!application || report.status !== 'ok') return;
  const confirmedSensitive = report.fields.filter((f) => f.sensitive && confirmed.has(f.id)).map((f) => f.key ?? `${f.category}:${f.id}`);
  await withSession(
    async () => {
      if (confirmedSensitive.length > 0) await api(`/applications/${application.id}/confirm`, { method: 'POST', body: { confirmedFields: confirmedSensitive } });
      if (report.submitted) {
        // APP-7: recorded as submitted only with the site's own confirmation.
        const confirmation = await awaitConfirmation();
        if (confirmation) {
          await api(`/applications/${application.id}/submitted`, { method: 'POST', body: { pageUrl: confirmation.pageUrl, confirmationText: confirmation.text.slice(0, 2000) } });
          markSubmittedButton.hidden = true;
        } else {
          setStatus(`${report.message} No confirmation from the site was seen, so OpennJob has not recorded it as sent. When the site confirms it, press "I have submitted this application" on that page.`, 'warn');
        }
      }
    },
    (message) => setStatus(`${report.message} (Could not update OpennJob: ${message})`, 'warn'),
  );
}

async function init(): Promise<void> {
  const settings = await loadSettings();
  apiBaseInput.value = settings.apiBase;
  modeSelect.value = settings.mode;
  $('mode-help').textContent = MODE_HELP[settings.mode];
  session = await loadSession();
  if (session && isExpired(session)) await endSession(EXPIRED);
  else if (session) {
    showSession();
    await loadData();
    await loadQueue();
  } else {
    showSession();
    setStatus(SIGNED_OUT);
  }

  // Follow the stored session: signing out (or in) in another OpennJob window applies here too.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !SESSION_KEYS.some((k) => k in changes)) return;
    void loadSession().then((stored) => {
      const had = session !== undefined;
      session = stored;
      if (!stored && had) {
        clearData();
        setStatus(SIGNED_OUT, 'warn');
      }
      showSession();
    });
  });

  modeSelect.addEventListener('change', async () => {
    const mode = modeSelect.value as Mode;
    $('mode-help').textContent = MODE_HELP[mode];
    await chrome.storage.local.set({ mode });
    confirmed.clear();
    if (lastReport) await run(true);
  });
  $('save').addEventListener('click', async () => {
    const apiBase = currentApiBase();
    const problem = apiBaseProblem(apiBase);
    if (problem) {
      setStatus(problem, 'blocked');
      return;
    }
    const previous = (await loadSettings()).apiBase;
    await chrome.storage.local.set({ apiBase });
    // A token belongs to the API that issued it. It is never sent to a different address.
    if (session && previous !== apiBase) await endSession('The API address changed. Sign in again.');
    else setStatus('Address saved.');
  });
  signInForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void signIn();
  });
  $('sign-out').addEventListener('click', () => void endSession('Signed out.', ''));
  $('scan').addEventListener('click', () => {
    confirmed.clear();
    void run(true);
  });
  fillButton.addEventListener('click', () => void run(false));
  $('queue-start').addEventListener('click', () => {
    queueStatus.textContent = 'Starting…';
    void chrome.runtime.sendMessage({ type: 'OPENNJOB_QUEUE_START' });
  });
  // Per-site permission, asked one site at a time and only when the person presses this (OD-4).
  allowSiteButton.addEventListener('click', async () => {
    if (!siteToAllow) return;
    const granted = await chrome.permissions.request({ origins: [`https://${siteToAllow}/*`] });
    if (granted) {
      allowSiteButton.hidden = true;
      queueStatus.textContent = `OpennJob may now work on ${siteToAllow}. Start the queue again.`;
    }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.queueState) showQueueState(changes.queueState.newValue as QueueState | undefined);
  });
  confirmAllButton.addEventListener('click', () => {
    for (const box of Array.from(fieldsList.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))) {
      if (box.dataset.sensitive !== 'false') continue;
      box.checked = true;
      if (box.dataset.fieldId) confirmed.add(box.dataset.fieldId);
    }
  });
  markSubmittedButton.addEventListener('click', async () => {
    const application = selectedApplication();
    if (!application) return;
    await withSession(
      async () => {
        const confirmation = await readConfirmation().catch(() => undefined);
        if (!confirmation) {
          setStatus('No confirmation from the site is showing on this page. Open the page where the site confirms your application, then press this again.', 'warn');
          return;
        }
        await api(`/applications/${application.id}/submitted`, { method: 'POST', body: { pageUrl: confirmation.pageUrl, confirmationText: confirmation.text.slice(0, 2000) } });
        markSubmittedButton.hidden = true;
        setStatus('Marked as submitted in OpennJob, with the confirmation shown on this page.');
      },
      (message) => setStatus(`Could not update OpennJob: ${message}`, 'warn'),
    );
  });
}

void init();
