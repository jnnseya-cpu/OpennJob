import { expect, test } from '@playwright/test';
import { buildFillValues, workRightsContext } from '../../../../packages/core/src/browser';
import type { FillValues, Passport, WorkRightsContext } from '../../../../packages/core/src/browser';
import type { RunReport, SubmitReport } from '../../src/agent/types';
import { PASSPORT, PROFILE, STATEMENT, byId, formSnapshot, openFixture } from './helpers';

/**
 * OD-5 (owner decision, 6 October 2026), in the browser with the built content script: right to work
 * and sponsorship answered from the person's own record. A form whose only sensitive questions are
 * those two may be submitted by the queue; a form with any other declaration still waits.
 * Fictional applicant, employer and forms.
 */
const TODAY = '2026-10-06';
const WITH_RECORD: Passport = {
  ...PASSPORT,
  workRights: [{ country: 'GB', rightToWork: true, requiresSponsorship: false, basis: 'British or Irish passport', confirmedAt: '2026-10-06T09:00:00.000Z' }],
};

function queueRun(page: import('@playwright/test').Page, values: FillValues, workRights: WorkRightsContext | undefined): Promise<RunReport> {
  return page.evaluate(
    (request) => (window as unknown as { __opennjob: { run: (r: unknown) => RunReport } }).__opennjob.run(request),
    { mode: 'auto', values, confirmedFieldIds: [], holdSubmit: true, ...(workRights ? { workRights } : {}) },
  );
}
const submit = (page: import('@playwright/test').Page) => page.evaluate(() => (window as unknown as { __opennjob: { submit: () => SubmitReport } }).__opennjob.submit());

test('with a valid record, right to work and sponsorship are answered and the form is ready to submit', async ({ page }) => {
  await openFixture(page, 'queue-rtw.html');
  const values = buildFillValues(PROFILE, WITH_RECORD, STATEMENT, { jobCountry: 'GB', today: TODAY });
  const report = await queueRun(page, values, workRightsContext(WITH_RECORD, 'GB', TODAY));
  const f = byId(report);
  expect(f['radio:rtw']).toMatchObject({ sensitive: true, key: 'rightToWork', fromRecord: true, state: 'filled' });
  expect(f['radio:sponsorship']).toMatchObject({ sensitive: true, key: 'visaSponsorship', fromRecord: true, state: 'filled' });
  const form = await formSnapshot(page);
  expect(form['q-rtw-yes']).toBe(true);
  expect(form['q-sp-no']).toBe(true);
  expect(report.readyToSubmit).toBe(true);
  expect(report.submitted).toBe(false); // the queue asks the API for the go first
  expect((await submit(page)).submitted).toBe(true);
});

test('without a record the same form waits: right to work needs confirming and sponsorship has no answer', async ({ page }) => {
  await openFixture(page, 'queue-rtw.html');
  const values = buildFillValues(PROFILE, PASSPORT, STATEMENT, { jobCountry: 'GB', today: TODAY });
  const report = await queueRun(page, values, workRightsContext(PASSPORT, 'GB', TODAY));
  const f = byId(report);
  expect(f['radio:rtw']).toMatchObject({ state: 'awaiting-confirmation' });
  expect(f['radio:rtw']?.fromRecord).toBeUndefined();
  expect(f['radio:sponsorship']).toMatchObject({ state: 'answer-yourself' });
  expect(report.readyToSubmit).toBe(false);
  expect((await submit(page)).submitted).toBe(false);
});

test('with a valid record, a form that also asks about convictions still waits for the person', async ({ page }) => {
  await openFixture(page, 'queue-rtw-convictions.html');
  const values = buildFillValues(PROFILE, WITH_RECORD, STATEMENT, { jobCountry: 'GB', today: TODAY });
  const report = await queueRun(page, values, workRightsContext(WITH_RECORD, 'GB', TODAY));
  expect(byId(report)['radio:convictions']).toMatchObject({ sensitive: true, category: 'convictions', state: 'answer-yourself' });
  expect(report.readyToSubmit).toBe(false);
  expect((await submit(page)).submitted).toBe(false);
  expect((await formSnapshot(page))['q-conv-no']).toBe(false);
});

test('a record for another country answers nothing on a UK form', async ({ page }) => {
  await openFixture(page, 'queue-rtw.html');
  const irish: Passport = { ...PASSPORT, rightToWorkConfirmed: false, workRights: [{ country: 'IE', rightToWork: true, requiresSponsorship: false, basis: 'British or Irish passport', confirmedAt: '2026-10-06T09:00:00.000Z' }] };
  const values = buildFillValues(PROFILE, irish, STATEMENT, { jobCountry: 'GB', today: TODAY });
  const report = await queueRun(page, values, workRightsContext(irish, 'GB', TODAY));
  expect(byId(report)['radio:rtw']).toMatchObject({ state: 'answer-yourself' });
  expect(report.readyToSubmit).toBe(false);
});
