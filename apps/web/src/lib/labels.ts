import { credentialLabel, countryName, REGIONS } from './core';
import type { Region } from './core';
import type { Application } from './types';

export const STATUS_LABEL: Record<Application['status'], string> = {
  draft: 'Prepared',
  confirmed: 'Approved, not sent',
  needs_you: 'Needs you',
  submitted: 'Submitted',
  uncertain: 'Check: no confirmation seen',
  interview: 'Interview',
  closed: 'Closed',
};

/** Why an application is held (the same wording as HOLD_REASONS in packages/core/src/tailoring.ts). */
export const HOLD_LABEL: Record<string, string> = {
  'trace-check': 'A sentence in the documents could not be traced to your CV. Read it and correct it.',
  'llm-ceiling': 'OpennJob’s own daily AI limit (a setting on the server, not your Claude credit) was reached, so this was drafted without AI. It is rewritten with AI at the next agent run.',
  'daily-limit': "Today's application limit was reached. It goes out tomorrow.",
  'email-not-sent': 'The e-mail to the recruiter was not accepted by the mail server. It is not retried: send it yourself or open the advert.',
  'login-wall': 'The employer’s site asks you to sign in. Sign in once in the tab OpennJob left open (create the account there if you have none), then press Try again: the queue goes on from there next time.',
  captcha: 'The employer’s site shows a CAPTCHA. OpennJob never solves them: complete it yourself in the browser, then press Try again.',
  'step-waits': 'A step of the application waits for you. Open it and complete that step.',
  'step-refused': 'The employer’s site did not move to the next step. Open it, see what it asks for, then press Try again.',
  'too-many-steps': 'The application has more steps than OpennJob goes through. Finish it yourself.',
  'no-submit-button': 'OpennJob could not find a single submit button. Finish it yourself.',
  'form-changed': 'The form changed after it was filled. Check it and submit it yourself, or press Try again.',
  'no-form': 'No application form was found on the page. Open the advert and apply there.',
};

/** Holds the person clears on the employer's site, then "Try again" (the API's RETRYABLE_HOLD). */
export const RETRYABLE_HOLD = /^(login-wall|captcha|step-refused(:.*)?|step-waits|steps-saved:\d+|too-many-steps|no-submit-button|form-changed|no-form)$/;

export function placeOf(job: { city?: string; country?: string; location: string }): string {
  const country = countryName(job.country);
  return [job.city ?? job.location, country].filter(Boolean).join(', ');
}

export function regionLabel(region: Region | undefined): string {
  return region ? REGIONS[region] : 'Region unknown';
}

/** "registration number" style wording for a missing credential. */
export function needsLabel(credential: string | undefined): string {
  if (!credential || credential === 'pin') return 'professional registration number';
  return credentialLabel(credential).toLowerCase();
}

/** Adzuna's terms ask for "Jobs by Adzuna" wherever its adverts are shown (docs/sources.md). */
export const isAdzuna = (job: { source: string }): boolean => job.source === 'adzuna' || job.source.startsWith('adzuna:');
/** Matches and Home list only jobs scoring at least this (owner's request, 8 October 2026). */
export const SHOW_FROM = 70;

export const ADZUNA_URL = 'https://www.adzuna.co.uk';
