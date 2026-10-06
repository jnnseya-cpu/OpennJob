/**
 * Popup UI. Everything the agent does starts from a button press here.
 * Page-derived text (field labels) is only ever written with textContent.
 */
import { buildFillValues } from '@opennjob/core/browser';
import type { Application, FillValues, Mode, Passport, Profile } from '@opennjob/core/browser';
import type { FieldReport, RunReport, RunRequest } from '../agent/types';

interface Settings {
  apiBase: string;
  token: string;
  mode: Mode;
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const modeSelect = $<HTMLSelectElement>('mode');
const apiBaseInput = $<HTMLInputElement>('apiBase');
const tokenInput = $<HTMLInputElement>('token');
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
const confirmed = new Set<string>();

function setStatus(text: string, kind: '' | 'blocked' | 'warn' = ''): void {
  statusEl.textContent = text;
  statusEl.className = kind;
}

async function loadSettings(): Promise<Settings> {
  const s = await chrome.storage.local.get(['apiBase', 'token', 'mode']);
  const mode: Mode = s.mode === 'review' || s.mode === 'auto' ? s.mode : 'hybrid';
  return { apiBase: typeof s.apiBase === 'string' && s.apiBase ? s.apiBase : 'http://127.0.0.1:3000', token: typeof s.token === 'string' ? s.token : '', mode };
}

function currentSettings(): Settings {
  return { apiBase: apiBaseInput.value.trim().replace(/\/+$/, ''), token: tokenInput.value.trim(), mode: modeSelect.value as Mode };
}

async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T | undefined> {
  const { apiBase, token } = currentSettings();
  const res = await fetch(`${apiBase}${path}`, {
    method: init.method ?? 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(res.status === 401 ? 'The API rejected the token.' : `The API replied ${res.status}.`);
  return (await res.json()) as T;
}

async function loadData(): Promise<void> {
  try {
    profile = await api<Profile>('/profile');
    passport = (await api<{ passport: Passport }>('/passport'))?.passport;
    applications = ((await api<Application[]>('/applications')) ?? []).filter((a) => a.status !== 'submitted');
  } catch (err) {
    profile = undefined;
    setStatus(`Could not reach OpennJob: ${err instanceof Error ? err.message : String(err)}`, 'blocked');
    return;
  }
  applicationSelect.replaceChildren(new Option('No statement (profile details only)', ''));
  for (const a of applications) applicationSelect.add(new Option(`${a.jobTitle} - ${a.employer}`, a.id));
  if (applications[0]) applicationSelect.value = applications[0].id;
  setStatus(profile ? `Loaded details for ${profile.firstName} ${profile.lastName}.` : 'No profile is saved in OpennJob yet.', profile ? '' : 'warn');
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
    setStatus('Load your details from OpennJob first (open Connection).', 'warn');
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
  try {
    if (confirmedSensitive.length > 0) await api(`/applications/${application.id}/confirm`, { method: 'POST', body: { confirmedFields: confirmedSensitive } });
    if (report.submitted) {
      await api(`/applications/${application.id}/submitted`, { method: 'POST' });
      markSubmittedButton.hidden = true;
    }
  } catch (err) {
    setStatus(`${report.message} (Could not update OpennJob: ${err instanceof Error ? err.message : String(err)})`, 'warn');
  }
}

async function init(): Promise<void> {
  const settings = await loadSettings();
  apiBaseInput.value = settings.apiBase;
  tokenInput.value = settings.token;
  modeSelect.value = settings.mode;
  $('mode-help').textContent = MODE_HELP[settings.mode];
  if (!settings.token) $<HTMLDetailsElement>('settings').open = true;
  else await loadData();

  modeSelect.addEventListener('change', async () => {
    const mode = modeSelect.value as Mode;
    $('mode-help').textContent = MODE_HELP[mode];
    await chrome.storage.local.set({ mode });
    confirmed.clear();
    if (lastReport) await run(true);
  });
  $('save').addEventListener('click', async () => {
    const s = currentSettings();
    await chrome.storage.local.set({ apiBase: s.apiBase, token: s.token });
    await loadData();
  });
  $('scan').addEventListener('click', () => {
    confirmed.clear();
    void run(true);
  });
  fillButton.addEventListener('click', () => void run(false));
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
    try {
      await api(`/applications/${application.id}/submitted`, { method: 'POST' });
      markSubmittedButton.hidden = true;
      setStatus('Marked as submitted in OpennJob.');
    } catch (err) {
      setStatus(`Could not update OpennJob: ${err instanceof Error ? err.message : String(err)}`, 'warn');
    }
  });
}

void init();
