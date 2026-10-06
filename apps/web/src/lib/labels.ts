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
