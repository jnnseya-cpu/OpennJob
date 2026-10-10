import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { freePort, startApi, startWeb } from './servers';
import type { ApiProcess, WebServer } from './servers';

/**
 * The candidate web app, built (`next build`, static export), in Chromium, against the
 * BUILT API running as a real process. Nothing is mocked: every click goes through the
 * real API, and the test reads the API back to check what was stored.
 *
 * Runs in memory by default, and on PostgreSQL (encryption on) when DATABASE_URL is set:
 *   npm run test:pg -- npm run test:e2e
 *
 * The person, CV and employers are fictional.
 */

const EMAIL = 'ngozi.bello@example.org';
const PASSWORD = 'a long fictional passphrase for tests';
const FIRST = 'Ngozi';
const LAST = 'Bello';
const PHONE = '07700 900456';
const ADDRESS = '7 Example Road';
const POSTCODE = 'B2 2BB';
const PIN = '21C3456E';
const CV_LINES = [
  'Healthcare assistant with four years of experience on elderly care wards and in a care home.',
  'I hold the Care Certificate and an NVQ Level 2 in Health and Social Care.',
  'I give personal care with dignity and I am trained in moving and handling.',
  'I support people living with dementia and I take clinical observations.',
  'I work well in a team and my communication with families is clear and kind.',
];
const CV = CV_LINES.join('\n');
const EDITED = 'My own words: I give personal care with dignity on a 28-bed elderly care ward. (fictional edit)';
/** Strings that must never reach the browser console or the API's log. */
const PERSONAL = [PASSWORD, FIRST, LAST, PHONE, ADDRESS, POSTCODE, PIN, EMAIL, ...CV_LINES, EDITED];

let api: ApiProcess;
let web: WebServer;
let browser: Browser;
let context: BrowserContext;
let page: Page;
const consoleLines: string[] = [];

async function call<T>(method: string, route: string, body?: unknown): Promise<T> {
  const token = await page.evaluate(() => JSON.parse(sessionStorage.getItem('opennjob.session') ?? '{}').accessToken as string | undefined);
  const res = await fetch(`${api.url}${route}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new Error(`${method} ${route} -> ${res.status}`);
  return (await res.json()) as T;
}

async function noSideScroll(): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser: b }) => {
  browser = b;
  const webPort = await freePort();
  api = await startApi(`http://127.0.0.1:${webPort}`);
  web = await startWeb(webPort, api.url);
  // Phone-first: a phone-sized viewport throughout.
  context = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
  page = await context.newPage();
  page.on('console', (m) => consoleLines.push(m.text()));
});

test.afterAll(async () => {
  await context?.close();
  await web?.close();
  await api?.stop();
});

test('the landing page is public, honest about the pilot, and leads to registration', async () => {
  await page.goto(`${web.url}/`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('The applications are drafted. The signature is yours.');
  await expect(page.getByText('Private pilot · by invitation')).toBeVisible();
  await page.locator('#limits').scrollIntoViewIfNeeded();
  await expect(page.locator('#limits h2')).toHaveText('The parts we decided to leave to you.');
  await expect(page.locator('#limits')).toContainText('Answer a declaration');
  await noSideScroll();
  await page.getByRole('link', { name: 'Request access' }).click();
  await expect(page).toHaveURL(/\/register\/$/);
});

test('a visitor is sent to sign-in; registering needs both consents, which start unticked', async () => {
  expect(((await (await fetch(`${api.url}/health`)).json()) as { persistence: string }).persistence).toBe(api.persistence);
  await page.goto(`${web.url}/matches/`);
  await expect(page).toHaveURL(/\/signin\/$/);
  await page.getByRole('link', { name: 'Create an account' }).click();
  await expect(page.getByRole('heading', { name: 'Create an account' })).toBeVisible();
  await expect(page.getByText('The terms and the privacy notice have not been written yet')).toBeVisible();

  const terms = page.getByRole('checkbox', { name: /I accept the terms of use \(version draft-1\)/ });
  const privacy = page.getByRole('checkbox', { name: /privacy notice \(version draft-1\)/ });
  await expect(terms).not.toBeChecked();
  await expect(privacy).not.toBeChecked();

  await page.getByLabel('Email address', { exact: true }).fill(EMAIL);
  await page.getByLabel('Password', { exact: true }).fill('short');
  const create = page.getByRole('button', { name: 'Create account' });
  await expect(create).toBeDisabled();
  await terms.check();
  await expect(create).toBeDisabled();
  await privacy.check();
  await expect(create).toBeEnabled();

  // The API's password rules are shown as the API words them.
  await page.getByLabel('Password', { exact: true }).fill('password1234');
  await create.click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page).toHaveURL(/\/register\/$/);

  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await create.click();
  await expect(page).toHaveURL(/\/profile\/$/);
  const me = await call<{ email: string; consent: { acceptedTermsVersion: string; acceptedPrivacyVersion: string } }>('GET', '/account');
  expect(me).toMatchObject({ email: EMAIL, consent: { acceptedTermsVersion: 'draft-1', acceptedPrivacyVersion: 'draft-1' } });
});

test('profile: details, CV, preferences and the credential passport are saved through the API', async () => {
  await expect(page.getByLabel('Email for applications')).toHaveValue(EMAIL);
  // Upload takes PDF or Word (exercised in account-flows.spec.ts); pasting text still works.
  await expect(page.locator('#cv-file')).toHaveAttribute('accept', /\.pdf.*\.docx/);
  await expect(page.getByText('The file is read and not kept.')).toBeVisible();

  await page.getByLabel('First name', { exact: true }).fill(FIRST);
  await page.getByLabel('Last name', { exact: true }).fill(LAST);
  await page.getByLabel('Phone', { exact: true }).fill(PHONE);
  await page.getByLabel('Address line 1').fill(ADDRESS);
  await page.getByLabel('Town or city').fill('Birmingham');
  await page.getByLabel('Postcode').fill(POSTCODE);
  await page.getByLabel('CV', { exact: true }).fill(CV);

  // Nothing selected means everything; choose English, then two countries and a city.
  await page.getByRole('group', { name: 'Languages you speak' }).getByRole('button', { name: 'English' }).click();
  await page.getByLabel('Add a country').selectOption('GB');
  await page.getByLabel('Add a country').selectOption('IE');
  await page.getByRole('group', { name: 'Cities' }).getByRole('button', { name: 'Birmingham' }).click();
  await page.getByLabel('Another city').fill('Atlantis');
  await page.getByRole('button', { name: 'Add city' }).click();
  await expect(page.getByText('Write the city with its country code')).toBeVisible();
  // A company typed by hand, then a ready-made list added in one click (no duplicates).
  await page.getByLabel('Companies to search for').fill('National Grid\nExample Build (fictional)');
  await page.getByRole('button', { name: /Add: National Grid and contractors/ }).click();
  await page.getByLabel('Target interview rate').selectOption('80');
  await page.getByRole('button', { name: 'Save profile' }).click();
  await expect(page.getByText('Profile saved.')).toBeVisible();

  const profile = await call<{ firstName: string; cvText: string; preferences: unknown }>('GET', '/profile');
  expect(profile.firstName).toBe(FIRST);
  expect(profile.cvText).toBe(CV);
  const { targetEmployers, targetInterviewRate, ...prefs } = profile.preferences as { targetEmployers: string[]; targetInterviewRate: number };
  expect(targetInterviewRate).toBe(80);
  expect(prefs).toEqual({ languages: ['English'], countries: ['GB', 'IE'], cities: ['Birmingham'] });
  expect(targetEmployers.slice(0, 3)).toEqual(['National Grid', 'Example Build (fictional)', "Laing O'Rourke"]);
  expect(targetEmployers.filter((n) => n === 'National Grid')).toHaveLength(1);

  // Passport: the healthcare pack's lines. Right to work starts unticked.
  await page.getByLabel('Industry pack').selectOption('hc');
  const passport = page.getByRole('form', { name: 'Credential passport' });
  await expect(passport.getByRole('checkbox', { name: /I have the right to work in the UK/ })).not.toBeChecked();
  await passport.getByLabel('Certificate number (12 digits)').fill('12345');
  await passport.getByRole('button', { name: 'Add training' }).click();
  await passport.getByLabel('Training', { exact: true }).fill('Basic life support');
  await passport.getByLabel('Expires on', { exact: true }).fill('2030-01-31');
  await passport.getByRole('button', { name: 'Save passport' }).click();
  await expect(passport.getByRole('alert')).toContainText('must be 12 digits'); // the API's rule, naming the field, not the value
  await passport.getByLabel('Certificate number (12 digits)').fill('');
  await passport.getByRole('button', { name: 'Save passport' }).click();
  await expect(passport.getByText('Credential passport saved.')).toBeVisible();
  await expect(passport.getByText('In date')).toBeVisible();

  const stored = await call<{ passport: { credentials: Record<string, string>; rightToWorkConfirmed: boolean; training: unknown[] } }>('GET', '/passport');
  expect(stored.passport).not.toHaveProperty('credentials');
  expect(stored.passport).toMatchObject({ rightToWorkConfirmed: false, training: [{ name: 'Basic life support', expiresOn: '2030-01-31' }] });

  // It all comes back after a reload.
  await page.reload();
  await expect(page.getByLabel('CV', { exact: true })).toHaveValue(CV);
  await expect(page.getByRole('group', { name: 'Cities' }).getByRole('button', { name: 'Birmingham' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('Training', { exact: true })).toHaveValue('Basic life support');
  await expect(page.getByLabel('Target interview rate')).toHaveValue('80');
  await expect(page.getByLabel('Companies to search for')).toHaveValue(/^National Grid\nExample Build \(fictional\)\nLaing O'Rourke/);
  await noSideScroll();
});

test('matches: the catalogue is fetched, scored against the CV, and filtered by pack, region and preferences', async () => {
  await page.getByRole('link', { name: 'Matches' }).click();
  await expect(page).toHaveURL(/\/matches\/$/);
  // A fresh API has an empty catalogue until someone looks for jobs.
  await page.getByRole('button', { name: 'Look for jobs now' }).click();
  // Matches under 70% are hidden unless asked for (owner's request); this test looks at all of them.
  await page.getByLabel(/Show matches under 70%/).check();
  const cards = page.getByTestId('match');
  await expect(cards.first()).toBeVisible();
  await expect(page.getByText('Sample jobs.')).toBeVisible();

  // Healthcare pack (chosen on the Profile page) and the preferences: UK (Birmingham only) and Ireland.
  await expect(cards.filter({ hasText: 'Staff Nurse - Medical Ward' })).toHaveCount(1); // listed once the box is ticked
  const titles = await cards.locator('h3').allTextContents();
  expect(titles).toContain('Healthcare Assistant - Elderly Care');
  expect(titles).toContain('Staff Nurse - Medical Ward'); // Dublin, Ireland
  expect(titles).not.toContain('Support Worker - Learning Disabilities'); // Coventry: outside the chosen city
  expect(titles).not.toContain('Registered Nurse - Private Hospital'); // Dubai: outside the chosen countries

  const hca = cards.filter({ hasText: 'Healthcare Assistant - Elderly Care' });
  await expect(hca.locator('.score')).toHaveText(/^\d+%$/);
  const apiMatch = (await call<{ job: { id: string }; score: number }[]>('GET', '/jobs/matches?min=0&pack=hc')).find((m) => m.job.id === 'sample:hca-elderly-care');
  await expect(hca.locator('.score')).toHaveText(`${apiMatch?.score}%`);

  await page.getByRole('group', { name: 'Region' }).getByRole('button', { name: 'Europe' }).click();
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText('Dublin, Ireland');
  await page.getByRole('group', { name: 'Region' }).getByRole('button', { name: 'All regions' }).click();

  // A missing credential is shown, not hidden: the nurse posts need a registration number.
  const nurse = cards.filter({ hasText: 'Staff Nurse - Medical Ward' });
  await expect(nurse.getByText('Needs professional registration number')).toBeVisible();
  await page.getByRole('link', { name: 'Change' }).click();
  await expect(page).toHaveURL(/\/profile\/$/);
  await page.getByLabel('Professional registration number (NMC PIN)').fill(PIN);
  await page.getByRole('button', { name: 'Save passport' }).click();
  await expect(page.getByText('Credential passport saved.')).toBeVisible();
  expect((await call<{ passport: { credentials: Record<string, string> } }>('GET', '/passport')).passport.credentials).toEqual({ pin: PIN });
  await page.getByRole('link', { name: 'Matches' }).click();
  await page.getByLabel(/Show matches under 70%/).check(); // the box starts unticked on each visit
  await expect(nurse.getByText('Needs professional registration number')).toHaveCount(0);
  await expect(nurse.getByText(/essential gap/)).toBeVisible();
  await expect(hca.getByText('Agent prepares')).toBeVisible();

  // Another pack.
  await page.getByLabel('Industry pack').selectOption('con');
  await expect(cards.locator('h3')).toContainText(['Senior Construction Manager - Hospital New Build']);
  await expect(cards.filter({ hasText: 'Dublin' })).toHaveCount(1);
  await page.getByLabel('Industry pack').selectOption('hc');
  await noSideScroll();
});

test('agent run in auto mode prepares drafts only: nothing is approved or submitted for the user', async () => {
  await page.getByRole('link', { name: 'Matches' }).click();
  await page.getByRole('group', { name: 'How much the agent does alone' }).getByRole('button', { name: 'Auto' }).click();
  await expect(page.getByTestId('mode-help')).toContainText('ready-to-submit pack to send from your phone');
  await page.getByLabel('Industry pack').selectOption('all');
  const before = new Set((await call<{ id: string }[]>('GET', '/applications')).map((a) => a.id));
  await page.getByRole('button', { name: 'Run agent' }).click();

  await expect(page).toHaveURL(/\/tracker\/$/);
  await expect(page.getByRole('status')).toContainText('Nothing has been sent to any employer');
  const apps = await call<{ id: string; status: string; mode: string; jobId: string }[]>('GET', '/applications');
  const prepared = apps.filter((a) => !before.has(a.id));
  expect(prepared.map((a) => a.jobId)).toContain('sample:hca-elderly-care');
  expect(prepared.length).toBeGreaterThan(0);
  for (const a of prepared) expect(a).toMatchObject({ status: 'draft', mode: 'auto' });
  await expect(page.getByTestId('application')).toHaveCount(apps.length);
  await expect(page.getByRole('link', { name: /Tracker/ }).locator('.count')).toHaveText(String(prepared.length));

  // An auto-mode application still waits for every declaration, and says so.
  await page.getByTestId('application').filter({ hasText: 'Healthcare Assistant - Elderly Care' }).getByRole('link', { name: 'Review and approve' }).click();
  const checklist = page.getByTestId('auto-checklist');
  await expect(checklist).toContainText('A form with any of them waits for you.');
  await expect(checklist).toContainText('Automatic applications are off.');
  await expect(checklist).toContainText('No employer application system is enabled yet');
  const boxes = page.getByRole('region', { name: 'Only you confirm these' }).getByRole('checkbox');
  expect(await boxes.count()).toBeGreaterThan(0);
  for (const box of await boxes.all()) await expect(box).not.toBeChecked();
  await expect(page.getByRole('button', { name: 'Approve' })).toBeDisabled();
});

test('apply to a job you found: the pasted link is prepared in auto mode with a tailored CV, a job board link is refused', async () => {
  await page.getByRole('link', { name: /Tracker/ }).click();
  const box = page.getByRole('region', { name: 'Apply to this link' });
  await box.getByLabel('Application page').fill('https://www.reed.co.uk/jobs/care-assistant/123');
  await box.getByLabel('Job title').fill('Care Assistant (fictional)');
  await box.getByLabel('Employer').fill('Example Care Homes (fictional)');
  await box.getByLabel(/The advert/).fill('A fictional vacancy for a care assistant. Personal care, moving and handling, medication rounds and supporting residents with daily living.');
  await box.getByRole('button', { name: 'Prepare and apply' }).click();
  await expect(page.getByRole('alert').filter({ hasText: "job board's or an aggregator's page" })).toBeVisible();

  await box.getByLabel('Application page').fill('https://example.wd3.myworkdayjobs.com/en-GB/careers/job/Leeds/Care-Assistant_R77');
  await box.getByRole('button', { name: 'Prepare and apply' }).click();
  await expect(page.getByTestId('from-link-result')).toContainText('Prepared at');
  // Workday is not switched on in this test server: it says why it cannot go out on its own.
  await expect(page.getByTestId('from-link-result')).toContainText('Workday is not switched on yet');
  const made = (await call<{ jobTitle: string; mode: string; status: string; applyUrl: string; tailoredCv?: string }[]>('GET', '/applications')).find((a) => a.jobTitle === 'Care Assistant (fictional)');
  expect(made).toMatchObject({ mode: 'auto', applyUrl: 'https://example.wd3.myworkdayjobs.com/en-GB/careers/job/Leeds/Care-Assistant_R77' });
  expect(made?.tailoredCv).toBeTruthy();
  await expect(box.getByLabel('Job title')).toHaveValue('');
});

test('review: requirements with evidence, editable statement, every declaration confirmed by hand before approve', async () => {
  // The draft the agent prepared in the previous test.
  await page.getByRole('link', { name: 'Matches' }).click();
  await page.getByTestId('match').filter({ hasText: 'Healthcare Assistant - Elderly Care' }).click();
  await expect(page).toHaveURL(/\/review\/\?job=sample%3Ahca-elderly-care$/);
  await expect(page.getByText('“I hold the Care Certificate and an NVQ Level 2 in Health and Social Care.”')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Prepare application' })).toHaveCount(0);

  // ATS-readiness card (from the competitive brief): score, checks and the truthful improvement note.
  await expect(page.getByTestId('ats')).toBeVisible();
  await expect(page.getByTestId('ats-score')).toContainText('/100');
  await expect(page.getByRole('region', { name: 'ATS readiness' }).getByText(/applicant-tracking system/)).toBeVisible();
  // The truth-check badge is shown as a feature, not a side effect.
  await expect(page.getByTestId('truth-badge')).toContainText('checked against your own CV');

  const statement = page.getByLabel(/^Supporting statement/);
  await expect(statement).not.toHaveValue('');
  await expect(page.getByText('Built from your CV without AI.')).toBeVisible();
  await statement.fill(EDITED);
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Statement saved.')).toBeVisible();
  // The CV and cover letter that would be sent, as PDFs made in the browser.
  for (const [button, ending] of [['download-cv', '_CV.pdf'], ['download-letter', '.pdf']] as const) {
    const [file] = await Promise.all([page.waitForEvent('download'), page.getByTestId(button).click()]);
    expect(file.suggestedFilename().endsWith(ending)).toBe(true);
    expect(readFileSync((await file.path()) as string).subarray(0, 5).toString()).toBe('%PDF-');
  }
  const draft = (await call<{ id: string; jobId: string; statement: string; status: string }[]>('GET', '/applications')).find((a) => a.jobId === 'sample:hca-elderly-care');
  // TAI-3: "28-bed" is not in this CV, so the edit is held for the person; approving below is them taking it as theirs.
  expect(draft).toMatchObject({ statement: EDITED, status: 'needs_you', holdReasons: ['trace-check'] });
  const held = page.getByRole('region', { name: 'Held for you' });
  await expect(held.getByText('A sentence in the documents could not be traced to your CV. Read it and correct it.')).toBeVisible();
  await expect(held.getByText(/28-bed elderly care ward\." mentions 28, which your CV does not contain/)).toBeVisible();

  // Healthcare declarations. A healthcare assistant post asks for no registration, so the
  // registration-dependent declarations are not listed. None starts ticked.
  const declarations = page.getByRole('region', { name: 'Only you confirm these' }).getByRole('checkbox');
  await expect(declarations).toHaveCount(4);
  for (const label of ['Right to work or visa status for this country', 'DBS or police check details', 'Criminal convictions and cautions declaration', 'Any other declaration']) {
    await expect(page.getByRole('checkbox', { name: new RegExp(label) })).not.toBeChecked();
  }
  await expect(page.getByRole('checkbox', { name: /Fitness to practise/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /tick all/i })).toHaveCount(0);

  const approve = page.getByRole('button', { name: 'Approve' });
  await expect(approve).toBeDisabled();
  for (let i = 0; i < 3; i++) await declarations.nth(i).check();
  await expect(approve).toBeDisabled(); // one still unticked
  await declarations.nth(3).check();
  await expect(approve).toBeEnabled();
  await approve.click();

  await expect(page.getByText('Approved, not sent yet.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open the employer’s form' })).toHaveAttribute('href', 'https://example.org/jobs/hca-elderly-care');
  // Phone-first ready-to-submit pack: your details to paste, and a copy button, with no extension.
  const details = page.getByRole('region', { name: 'Your details for the form' });
  await expect(details.getByText(/Full name:/)).toBeVisible();
  await expect(details.getByText(/Email:/)).toBeVisible();
  await expect(page.getByTestId('copy-statement')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download CV (PDF)' }).first()).toBeVisible();
  await expect(statement).toHaveAttribute('readonly', '');
  const confirmed = await call<{ status: string; confirmedFields: string[] }>('GET', `/applications/${draft?.id}`);
  expect(confirmed.status).toBe('confirmed');
  expect(confirmed.confirmedFields.sort()).toEqual(['declaration:conv', 'declaration:dbs', 'declaration:declare', 'declaration:rtw', 'statement']);

  // APP-7: recorded as sent only with the site's confirmation page and text.
  const sentButton = page.getByRole('button', { name: 'I have submitted it' });
  await expect(sentButton).toBeDisabled();
  await page.getByLabel('Address of the confirmation page').fill('https://example.org/jobs/hca-elderly-care/thanks');
  await expect(sentButton).toBeDisabled();
  await page.getByLabel('What the site said when you submitted').fill('Thank you, your application has been received. (fictional)');
  await sentButton.click();
  await expect(page.getByText('You recorded this application as sent')).toBeVisible();
  const sent = await call<{ status: string; receipt: { pageUrl: string; confirmationText: string; automatic: boolean } }>('GET', `/applications/${draft?.id}`);
  expect(sent).toMatchObject({ status: 'submitted', receipt: { pageUrl: 'https://example.org/jobs/hca-elderly-care/thanks', confirmationText: 'Thank you, your application has been received. (fictional)', automatic: false } });
  await noSideScroll();
});

test('review all mode also needs "I have checked every field"; a credential-dependent declaration appears when the job needs it', async () => {
  await page.getByRole('link', { name: 'Matches' }).click();
  await page.getByRole('group', { name: 'How much the agent does alone' }).getByRole('button', { name: 'Review all' }).click();
  await expect(page.getByTestId('mode-help')).toHaveText('You see and confirm every field before anything is filled.');
  await page.getByLabel(/Show matches under 70%/).check(); // this nurse post scores under 70%
  await page.getByTestId('match').filter({ hasText: 'Staff Nurse - Medical Ward' }).click();
  await page.getByRole('button', { name: 'Prepare application' }).click();

  const declarations = page.getByRole('region', { name: 'Only you confirm these' }).getByRole('checkbox');
  await expect(page.getByRole('checkbox', { name: /Fitness to practise declaration/ })).not.toBeChecked();
  await expect(page.getByRole('checkbox', { name: /Professional registration number/ })).not.toBeChecked();
  const count = await declarations.count();
  for (let i = 0; i < count; i++) await declarations.nth(i).check();
  const approve = page.getByRole('button', { name: 'Approve' });
  await expect(approve).toBeDisabled();
  await page.getByRole('checkbox', { name: 'I have checked every field above.' }).check();
  // This CV evidences nothing for this post, so the draft is empty and says so. Approve waits for a statement.
  await expect(page.getByText('No evidence for any criterion was found in the CV')).toBeVisible();
  await expect(page.getByText('Write a supporting statement first.')).toBeVisible();
  await expect(approve).toBeDisabled();
  await page.getByLabel(/^Supporting statement/).fill('I am working towards registration with the NMBI. (fictional)');
  await expect(approve).toBeEnabled();
  await approve.click();
  await expect(page.getByText('Approved, not sent yet.')).toBeVisible();
  const app = (await call<{ jobId: string; mode: string; confirmedFields: string[] }[]>('GET', '/applications')).find((a) => a.jobId === 'sample:h7');
  expect(app?.mode).toBe('review');
  expect(app?.confirmedFields).toEqual(expect.arrayContaining(['review:all-fields-checked', 'declaration:ftp', 'declaration:pin']));
});

test('dashboard charts and notifications: inbox from real events, settings, e-mail preview, test send', async () => {
  await page.getByRole('link', { name: 'Home' }).click();
  await expect(page).toHaveURL(/\/dashboard\/$/);
  const apps = await call<{ status: string }[]>('GET', '/applications');
  await expect(page.getByTestId('stat-submitted').locator('strong')).toHaveText(String(apps.filter((a) => a.status === 'submitted').length));
  await expect(page.getByRole('figure', { name: 'How your matches score' })).toBeVisible();
  await expect(page.getByRole('figure', { name: 'Application pipeline' }).getByText(/Submitted · \d+/)).toBeVisible();
  // Every chart has a table view.
  await page.getByRole('figure', { name: 'Application pipeline' }).getByText('Show as table').click();
  await expect(page.getByRole('figure', { name: 'Application pipeline' }).getByRole('cell', { name: 'Waiting for you' })).toBeVisible();
  await noSideScroll();

  const inbox = await call<{ unread: number; items: { subject: string }[] }>('GET', '/notifications');
  expect(inbox.items.map((n) => n.subject)).toEqual(expect.arrayContaining(['Welcome to OpennJob', 'Profile saved', 'Recorded as submitted: Healthcare Assistant - Elderly Care', 'Action needed: review Healthcare Assistant - Elderly Care']));
  await page.goto(`${web.url}/notifications/`);
  await expect(page.getByRole('link', { name: `Notifications, ${inbox.unread} unread` })).toBeVisible();
  await expect(page.getByTestId('notification').filter({ hasText: 'Recorded as submitted: Healthcare Assistant - Elderly Care' })).toBeVisible();
  await page.getByRole('button', { name: 'Mark all read' }).click();
  await expect(page.getByRole('link', { name: 'Notifications', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('checkbox', { name: /^SMS/ })).toBeDisabled(); // not connected: cannot be switched on
  await page.getByRole('checkbox', { name: /^Email Sandbox/ }).uncheck();
  await expect(page.getByText('Settings saved.')).toBeVisible();
  expect((await call<{ email: boolean }>('GET', '/notifications/preferences')).email).toBe(false);
  await page.getByRole('checkbox', { name: /^Email Sandbox/ }).check();
  await expect.poll(async () => (await call<{ email: boolean }>('GET', '/notifications/preferences')).email).toBe(true);
  await expect(page.getByRole('checkbox', { name: 'Account deleted' })).toBeDisabled(); // a service notice cannot be muted

  await page.getByRole('button', { name: 'Catalogue and delivery' }).click();
  await expect(page.getByTestId('stat-events').locator('strong')).not.toHaveText('0');
  await page.getByLabel('Event to preview').selectOption('agent.run_completed');
  await page.getByRole('button', { name: 'Preview e-mail' }).click();
  await expect(page.frameLocator('iframe[title^="E-mail preview"]').getByText('Agent run finished: 3 applications prepared')).toBeVisible();
  await page.getByRole('button', { name: 'Send test to me' }).click();
  await expect(page.getByText(/^Test sent: /)).toHaveText('Test sent: Email logged, In-app delivered, Push skipped.'); // e-mail sandboxed; push off by default
  await expect(page.getByTestId('delivery').first()).toContainText('agent.run_completed');
});

test('interview practice: questions for the pack and STAR feedback from the API', async () => {
  await page.getByRole('link', { name: 'Interview' }).click();
  await page.getByLabel('Practising for').selectOption('hc');
  await expect(page.getByRole('heading', { name: /deteriorating/ })).toBeVisible();
  await page.getByLabel('Your answer').fill(
    'On a night shift a patient became drowsy. My role was to check observations. I checked the NEWS2 score, escalated to the nurse in charge using SBAR and stayed with the patient. As a result the outreach team came quickly and the patient recovered.',
  );
  await page.getByRole('button', { name: 'Get feedback' }).click();
  const feedback = page.locator('[aria-label="Feedback"]');
  await expect(feedback).toContainText('Built-in check (no AI)');
  await expect(feedback).toContainText(/Total\s*\d+\/20/);
});

test('account: export downloads everything held; delete needs the password and removes the account', async () => {
  await page.getByRole('link', { name: 'Account' }).click();
  await expect(page.getByText(EMAIL)).toBeVisible();

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download my data' }).click()]);
  const exported = JSON.parse(readFileSync((await download.path()) as string, 'utf8')) as { user: { email: string }; profile: { cvText: string }; applications: unknown[] };
  expect(exported.user.email).toBe(EMAIL);
  expect(exported.profile.cvText).toBe(CV);
  expect(exported.applications).toEqual(expect.arrayContaining((await call<unknown[]>('GET', '/applications')).map((a) => expect.objectContaining(a as Record<string, unknown>))));
  expect(exported.applications).toHaveLength(3);

  const form = page.getByRole('form', { name: 'Delete account' });
  const remove = form.getByRole('button', { name: 'Delete my account' });
  await form.getByLabel('Your password').fill('not the right passphrase');
  await expect(remove).toBeDisabled();
  await form.getByRole('checkbox', { name: /cannot be recovered/ }).check();
  await remove.click();
  await expect(form.getByRole('alert')).toHaveText('Password is incorrect');

  await form.getByLabel('Your password').fill(PASSWORD);
  await remove.click();
  await expect(page).toHaveURL(/\/signin\/\?notice=deleted$/);
  await expect(page.getByText('Your account and everything stored for it were deleted.')).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('opennjob.session'))).toBeNull();

  const login = await fetch(`${api.url}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
  expect(login.status).toBe(401);
  if (api.persistence === 'postgres') {
    for (const table of ['users', 'profiles', 'passports', 'applications']) {
      expect(await api.query(`SELECT count(*)::int AS n FROM {schema}.${table}`), table).toEqual([{ n: 0 }]);
    }
  }
});

test('an expired session sends the user back to sign in; sign-in works and is refused with a wrong password', async () => {
  // A second, fictional account made through the API.
  const versions = (await (await fetch(`${api.url}/auth/versions`)).json()) as { termsVersion: string; privacyVersion: string };
  const other = { email: 'tomasz.nowak@example.org', password: 'seven green kettles on a shelf' };
  expect((await fetch(`${api.url}/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...other, acceptedTermsVersion: versions.termsVersion, acceptedPrivacyVersion: versions.privacyVersion }) })).status).toBe(201);

  await page.goto(`${web.url}/signin/`);
  await page.getByLabel('Email address', { exact: true }).fill(other.email);
  await page.getByLabel('Password', { exact: true }).fill('a wrong passphrase 123');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Forgot your password?' })).toHaveAttribute('href', '/forgot-password/');

  await page.getByLabel('Password', { exact: true }).fill(other.password);
  await page.getByTestId('keep-signed-in').uncheck(); // this test is about a session that is not kept
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard\/$/);
  await expect(page.getByText('Add your CV first')).toBeVisible(); // no profile yet: nothing of the deleted account shows
  await expect(page.getByTestId('stat-waiting').locator('strong')).toHaveText('0');

  await page.evaluate(() => {
    const s = JSON.parse(sessionStorage.getItem('opennjob.session') ?? '{}') as Record<string, string>;
    sessionStorage.setItem('opennjob.session', JSON.stringify({ ...s, expiresAt: new Date(Date.now() - 1000).toISOString() }));
  });
  await page.goto(`${web.url}/tracker/`);
  await expect(page).toHaveURL(/\/signin\/\?notice=expired$/);
  await expect(page.getByText('Your session ended. Sign in again.')).toBeVisible();

  // A token the API no longer accepts (here: altered) ends the session at the next call.
  await page.getByLabel('Email address', { exact: true }).fill(other.email);
  await page.getByLabel('Password', { exact: true }).fill(other.password);
  await page.getByTestId('keep-signed-in').uncheck(); // this test is about a session that is not kept
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard\/$/);
  await page.evaluate(() => {
    const s = JSON.parse(sessionStorage.getItem('opennjob.session') ?? '{}') as Record<string, string>;
    sessionStorage.setItem('opennjob.session', JSON.stringify({ ...s, accessToken: `${s.accessToken}x` }));
  });
  await page.getByRole('link', { name: 'Account' }).click();
  await expect(page).toHaveURL(/\/signin\/\?notice=expired$/);

  // Sign out from the Account page.
  await page.getByLabel('Email address', { exact: true }).fill(other.email);
  await page.getByLabel('Password', { exact: true }).fill(other.password);
  await page.getByTestId('keep-signed-in').uncheck(); // this test is about a session that is not kept
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('link', { name: 'Account' }).click();
  await page.getByRole('button', { name: 'Sign out on this device' }).click();
  await expect(page).toHaveURL(/\/signin\/\?notice=signedout$/);
  expect(await page.evaluate(() => sessionStorage.getItem('opennjob.session'))).toBeNull();
});

test('no personal data reached the browser console or the API log', async () => {
  const consoleText = consoleLines.join('\n');
  const apiLog = api.output();
  for (const value of PERSONAL) {
    expect(consoleText, `console: ${value.slice(0, 24)}`).not.toContain(value);
    expect(apiLog, `API log: ${value.slice(0, 24)}`).not.toContain(value);
  }
});

test('every page carries a hash-only script policy, and the browser blocked nothing on any screen', async () => {
  // The policy is checked on the built files, then in the browser: a script it did not allow
  // would have been reported on the console during the tests above.
  const { readdirSync, readFileSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');
  const out = join(__dirname, '..', '..', 'out');
  const pages = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? pages(join(dir, n)) : n.endsWith('.html') ? [join(dir, n)] : []));
  for (const file of pages(out)) {
    const policy = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(readFileSync(file, 'utf8'))?.[1];
    expect(policy, file).toMatch(/^script-src 'self'( 'sha256-[A-Za-z0-9+/=]+')*; object-src 'none'; base-uri 'self'$/);
  }
  expect(consoleLines.filter((l) => /Content Security Policy/i.test(l))).toEqual([]);
  // And it is enforced: a script injected into the page does not run.
  await page.goto(`${web.url}/signin/`);
  const ran = await page.evaluate(() => {
    const s = document.createElement('script');
    s.textContent = 'window.__injected = true;';
    document.head.appendChild(s);
    return (window as unknown as { __injected?: boolean }).__injected === true;
  });
  expect(ran).toBe(false);
});
