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
  'llm-ceiling': 'The daily AI spending limit was reached, so this was drafted without AI. Read it before use.',
  'daily-limit': "Today's application limit was reached. It goes out tomorrow.",
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
