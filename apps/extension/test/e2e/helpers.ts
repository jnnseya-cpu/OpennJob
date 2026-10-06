import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Page } from '@playwright/test';
import { buildFillValues } from '../../../../packages/core/src/browser';
import type { FillValues, Mode, Passport, Profile } from '../../../../packages/core/src/browser';
import type { RunReport } from '../../src/agent/types';

export const EXTENSION_ROOT = path.resolve(__dirname, '../..');
export const DIST = path.join(EXTENSION_ROOT, 'dist');
export const FIXTURES = path.join(EXTENSION_ROOT, 'test/fixtures');
export const fixtureUrl = (name: string): string => pathToFileURL(path.join(FIXTURES, name)).href;

/** Entirely fictional applicant. */
export const PROFILE: Profile = {
  firstName: 'Amara',
  lastName: 'Okafor',
  email: 'amara.okafor@example.org',
  phone: '07700 900123',
  addressLine1: '12 Example Street',
  addressLine2: 'Flat 3',
  city: 'Birmingham',
  postcode: 'B1 1AA',
  cvText: 'Registered nurse with five years of experience on acute medical wards.',
};

export const PASSPORT: Passport = {
  nmcPin: '18A1234E',
  dbs: { certificateNumber: '001234567890', issueDate: '2025-03-01', onUpdateService: true },
  rightToWorkConfirmed: true,
  training: [],
  referees: [{ name: 'Priya Shah', relationship: 'Ward Manager', organisation: 'Northfield General Hospital (example)', email: 'priya.shah@example.org', phone: '07700 900456' }],
};

export const STATEMENT =
  'I am a registered nurse with five years of experience on acute medical wards.\nI complete medication rounds safely and escalate deteriorating patients using NEWS2.';

export const VALUES: FillValues = buildFillValues(PROFILE, PASSPORT, STATEMENT);

/** Loads a fixture and injects the BUILT content script (apps/extension/dist/content.js) into it. */
export async function openFixture(page: Page, name: string): Promise<void> {
  await page.goto(fixtureUrl(name));
  await page.addScriptTag({ path: path.join(DIST, 'content.js') });
  await page.waitForFunction(() => Boolean((window as unknown as { __opennjob?: unknown }).__opennjob));
}

export function runAgent(
  page: Page,
  mode: Mode,
  confirmedFieldIds: string[] = [],
  options: { values?: FillValues; dryRun?: boolean } = {},
): Promise<RunReport> {
  return page.evaluate(
    (request) => (window as unknown as { __opennjob: { run: (r: unknown) => RunReport } }).__opennjob.run(request),
    { mode, confirmedFieldIds, values: options.values ?? VALUES, dryRun: options.dryRun ?? false },
  );
}

export interface FixtureLog {
  submitCount: number;
  submitClicks: number;
  inputEvents: Record<string, number>;
  changeEvents: Record<string, number>;
}

export const fixtureLog = (page: Page): Promise<FixtureLog> =>
  page.evaluate(() => (window as unknown as { __fixture: FixtureLog }).__fixture);

/** Current value of every control in the form, keyed by element id. Radios/checkboxes report `checked`. */
export const formSnapshot = (page: Page): Promise<Record<string, string | boolean>> =>
  page.evaluate(() => {
    const out: Record<string, string | boolean> = {};
    for (const el of Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input, textarea, select'))) {
      if (!el.id) continue;
      out[el.id] = el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio') ? el.checked : el.value;
    }
    return out;
  });

export const byId = (report: RunReport) => Object.fromEntries(report.fields.map((f) => [f.id, f]));
