import { expect, test } from '@playwright/test';
import type { RunReport, SubmitReport } from '../../src/agent/types';
import { VALUES, openFixture } from './helpers';

/**
 * Attaching the CV (files.ts), in the browser with the built content script. A field that asks for a
 * CV gets the tailored CV as a PDF; any other document field is left alone, and a required one keeps
 * the form waiting. Fictional applicant, employer and forms.
 */
const CV = { fileName: 'Amara_Okafor_CV.pdf', text: 'Amara Okafor (fictional)\nRegistered nurse with five years of experience on acute medical wards.' };

const LETTER = { fileName: 'Amara_Okafor_Cover_Letter.pdf', text: 'Amara Okafor\n\nDear Hiring Manager,\n\nI am a registered nurse (fictional).\n\nYours sincerely,\n\nAmara Okafor' };

const run = (page: import('@playwright/test').Page, withCv: boolean, withLetter = false) =>
  page.evaluate(
    (request) => (window as unknown as { __opennjob: { run: (r: unknown) => RunReport } }).__opennjob.run(request),
    { mode: 'auto', values: VALUES, confirmedFieldIds: [], holdSubmit: true, ...(withCv ? { cv: CV } : {}), ...(withLetter ? { coverLetter: LETTER } : {}) },
  );
const submit = (page: import('@playwright/test').Page) => page.evaluate(() => (window as unknown as { __opennjob: { submit: () => SubmitReport } }).__opennjob.submit());
const file = (page: import('@playwright/test').Page, id: string) =>
  page.evaluate(async (fieldId) => {
    const input = document.getElementById(fieldId) as HTMLInputElement;
    const f = input.files?.[0];
    if (!f) return null;
    const head = new TextDecoder().decode((await f.arrayBuffer()).slice(0, 8));
    return { name: f.name, type: f.type, head };
  }, id);

test('a required CV field gets the tailored CV as a PDF, and the form is ready to submit', async ({ page }) => {
  await openFixture(page, 'queue-cv.html');
  const report = await run(page, true);
  expect(report.cvAttached).toBe(1);
  expect(await file(page, 'q-cv')).toEqual({ name: 'Amara_Okafor_CV.pdf', type: 'application/pdf', head: '%PDF-1.4' });
  expect(report.fileInputs).toEqual({ required: 0, total: 1 });
  expect(report.readyToSubmit).toBe(true);
  expect((await submit(page)).submitted).toBe(true);
});

test('without the CV the same form waits', async ({ page }) => {
  await openFixture(page, 'queue-cv.html');
  const report = await run(page, false);
  expect(report.cvAttached).toBeUndefined();
  expect(report.fileInputs).toEqual({ required: 1, total: 1 });
  expect(report.readyToSubmit).toBe(false);
  expect((await submit(page)).submitted).toBe(false);
});

test('a required cover-letter file is never filled with the CV, and keeps the form waiting', async ({ page }) => {
  await openFixture(page, 'queue-cv-cover.html');
  const report = await run(page, true);
  expect(report.cvAttached).toBe(1);
  expect(await file(page, 'q-cover')).toBeNull();
  expect(report.fileInputs).toEqual({ required: 1, total: 2 });
  expect(report.readyToSubmit).toBe(false);
  expect((await submit(page)).submitted).toBe(false);
});

test('a required cover-letter field gets the cover letter, never the CV, and then the form is ready', async ({ page }) => {
  await openFixture(page, 'queue-cv-cover.html');
  const report = await run(page, true, true);
  expect(report).toMatchObject({ cvAttached: 1, coverLetterAttached: 1, fileInputs: { required: 0, total: 2 }, readyToSubmit: true });
  expect(await file(page, 'q-cv')).toMatchObject({ name: 'Amara_Okafor_CV.pdf' });
  expect(await file(page, 'q-cover')).toEqual({ name: 'Amara_Okafor_Cover_Letter.pdf', type: 'application/pdf', head: '%PDF-1.4' });
});

test('a preview attaches nothing', async ({ page }) => {
  await openFixture(page, 'queue-cv.html');
  await page.evaluate(
    (request) => (window as unknown as { __opennjob: { run: (r: unknown) => RunReport } }).__opennjob.run(request),
    { mode: 'auto', values: VALUES, confirmedFieldIds: [], dryRun: true, cv: CV },
  );
  expect(await file(page, 'q-cv')).toBeNull();
});
