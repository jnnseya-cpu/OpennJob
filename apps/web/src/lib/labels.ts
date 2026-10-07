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
};

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
export const ADZUNA_URL = 'https://www.adzuna.co.uk';
