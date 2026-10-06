import type { Clock, Job, Passport, TrainingRecord } from './types';
import { systemClock } from './types';

export type TrainingStatus = 'valid' | 'expiring' | 'expired' | 'no-expiry' | 'invalid-date';

export interface TrainingCheck {
  name: string;
  expiresOn?: string;
  status: TrainingStatus;
  /** Whole days from today to the expiry date. Negative when expired. */
  daysRemaining?: number;
}

export const EXPIRING_WITHIN_DAYS = 30;
const DAY_MS = 86_400_000;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parses YYYY-MM-DD to a UTC day number, rejecting impossible dates such as 2026-02-31. */
export function isoDateToUtcDay(iso: string): number | undefined {
  const m = ISO_DATE.exec(iso);
  if (!m) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return undefined;
  return Math.floor(t / DAY_MS);
}

/**
 * Rules (calendar days, UTC):
 *  - expired:  the expiry date is before today
 *  - expiring: the expiry date is today or within the next 30 days (inclusive)
 *  - valid:    the expiry date is more than 30 days away
 * A certificate is treated as usable on its expiry date itself.
 */
export function checkTraining(training: readonly TrainingRecord[], clock: Clock = systemClock): TrainingCheck[] {
  const now = clock();
  const today = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / DAY_MS);
  return training.map((t) => {
    if (!t.expiresOn) return { name: t.name, status: 'no-expiry' as const };
    const day = isoDateToUtcDay(t.expiresOn);
    if (day === undefined) return { name: t.name, expiresOn: t.expiresOn, status: 'invalid-date' as const };
    const daysRemaining = day - today;
    const status: TrainingStatus =
      daysRemaining < 0 ? 'expired' : daysRemaining <= EXPIRING_WITHIN_DAYS ? 'expiring' : 'valid';
    return { name: t.name, expiresOn: t.expiresOn, status, daysRemaining };
  });
}

export function trainingWarnings(training: readonly TrainingRecord[], clock: Clock = systemClock): string[] {
  return checkTraining(training, clock).flatMap((c) => {
    if (c.status === 'expired') return [`${c.name} expired on ${c.expiresOn}`];
    if (c.status === 'expiring') return [`${c.name} expires on ${c.expiresOn} (${c.daysRemaining} day(s) left)`];
    if (c.status === 'invalid-date') return [`${c.name} has an unreadable expiry date "${c.expiresOn}"`];
    return [];
  });
}

/**
 * Reads one credential from the passport. The NMC PIN lives under 'pin'; a passport saved
 * by v1 (or by a client still sending `nmcPin`) is read through the same accessor.
 * Returns '' when nothing usable is stored.
 */
export function credentialOf(passport: Pick<Passport, 'nmcPin' | 'credentials'> | undefined, id: string): string {
  const fromMap = passport?.credentials?.[id];
  if (typeof fromMap === 'string' && fromMap.trim()) return fromMap.trim();
  if (id === 'pin' && typeof passport?.nmcPin === 'string') return passport.nmcPin.trim();
  return '';
}

/** The existing NMC PIN accessor: works for both the v1 `nmcPin` field and `credentials.pin`. */
export function nmcPinOf(passport: Pick<Passport, 'nmcPin' | 'credentials'> | undefined): string {
  return credentialOf(passport, 'pin');
}

/** The credential a job needs. `requiresRegistration: true` means 'pin'. */
export function requiredCredentialOf(job: Pick<Job, 'requiresRegistration'> & Partial<Pick<Job, 'requiredCredential'>>): string | undefined {
  const explicit = job.requiredCredential?.trim();
  if (explicit) return explicit;
  return job.requiresRegistration ? 'pin' : undefined;
}
