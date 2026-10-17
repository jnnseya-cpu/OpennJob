import { detectSensitiveCategory, normaliseFieldText } from './fields';
import type { FillValues } from './fields';
import type { ScreeningAnswers } from './types';

/**
 * Ordinary screening answers (SCR-1 to SCR-3), stored once and reused.
 *
 * Only ordinary questions: notice period, salary, day rate, relocation, travel, years of
 * experience, driving licence, and other ordinary questions the person answered once
 * (`custom`). A declaration is never stored and never answered from storage (SCR-3):
 * a custom question whose wording the field classifier treats as sensitive is refused
 * here, and on the page a sensitive field is classified before any stored answer is
 * looked at, so it can never be filled from this store.
 */

export const EMPTY_SCREENING: ScreeningAnswers = { custom: {} };

/** How a question is keyed in `custom`: the same normalisation the field classifier uses. */
export function screeningKey(question: string): string {
  return normaliseFieldText(question).replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

/** Why a question may not be stored, or undefined when it may. */
export function screeningRefusal(question: string): string | undefined {
  const key = screeningKey(question);
  if (!key) return 'The question is empty.';
  const category = detectSensitiveCategory(normaliseFieldText(question));
  return category ? `This is a ${category} question. You answer it yourself on each form; OpennJob does not store the answer.` : undefined;
}

/** The fill values for the standard screening fields (see plainKey in fields.ts). */
export function screeningFillValues(answers: ScreeningAnswers | undefined): FillValues {
  const v: FillValues = {};
  if (!answers) return v;
  if (answers.noticePeriod?.trim()) v.noticePeriod = answers.noticePeriod.trim();
  if (answers.salaryExpectation?.trim()) v.salaryExpectation = answers.salaryExpectation.trim();
  if (answers.dayRate?.trim()) v.dayRate = answers.dayRate.trim();
  if (answers.yearsExperience?.trim()) v.yearsExperience = answers.yearsExperience.trim();
  if (typeof answers.relocation === 'boolean') v.relocation = answers.relocation;
  if (typeof answers.travel === 'boolean') v.travel = answers.travel;
  if (typeof answers.drivingLicence === 'boolean') v.drivingLicence = answers.drivingLicence;
  return v;
}

/** Custom answers keyed for the page, without any entry that has become a refused question. */
export function customAnswers(answers: ScreeningAnswers | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [question, answer] of Object.entries(answers?.custom ?? {})) {
    if (!screeningRefusal(question) && answer.trim()) out[screeningKey(question)] = answer.trim();
  }
  return out;
}
