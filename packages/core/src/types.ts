/** Shared domain types. No framework imports anywhere in packages/core. */
import type { Region } from './geo';

export type Mode = 'review' | 'hybrid' | 'auto';
export const MODES: readonly Mode[] = ['review', 'hybrid', 'auto'];

export interface Criterion {
  label: string;
  /** Essential criteria carry weight 2, desirable carry weight 1. */
  essential: boolean;
  /** A criterion is met when any keyword appears in the CV. */
  keywords: string[];
}

export type JobSource = 'greenhouse' | 'lever' | 'ashby' | 'adzuna' | 'reed' | 'sample' | 'employer';

/** Industry packs. See packs.ts. */
export type PackId = 'con' | 'dc' | 'en' | 'rail' | 'fr' | 'hc';
/** The language an application is written in. */
export type JobLanguage = 'en' | 'fr';
/** How the job reached OpennJob: found by the system from its sources, or posted by an employer (optional). */
export type JobOrigin = 'discovered' | 'employer';

export interface Job {
  /** `${source}:${externalId}` */
  id: string;
  source: JobSource;
  externalId: string;
  title: string;
  employer: string;
  location: string;
  url: string;
  applyUrl?: string;
  description: string;
  salaryMin?: number;
  salaryMax?: number;
  employmentType?: string;
  postedAt?: string;
  criteria: Criterion[];
  criteriaSource: 'llm' | 'fallback' | 'provided';
  /** Kept from v1. true means the same as requiredCredential: 'pin'. */
  requiresRegistration: boolean;
  /** Passport credential the applicant must hold to be eligible, e.g. 'pin' or 'sc'. */
  requiredCredential?: string;
  /** Industry pack. Absent when the job could not be classified. */
  pack?: PackId;
  /** ISO 3166-1 alpha-2, upper case. Absent when the source did not say and it could not be inferred. */
  country?: string;
  city?: string;
  /** Derived from country by regionOf() in geo.ts. */
  region?: Region;
  /** Absent means 'en'. */
  language?: JobLanguage;
  /** Absent means 'discovered'. Matching treats both origins alike. */
  origin?: JobOrigin;
}

/**
 * What the candidate asked to see. IF NOTHING IS SELECTED, EVERYTHING IS AVAILABLE:
 * every empty list means "no restriction". See inScope() in preferences.ts.
 */
export interface Preferences {
  /** Names from LANGUAGES, e.g. "French". Also evidence for a criterion asking for that language. */
  languages: string[];
  /** ISO 3166-1 alpha-2 codes. */
  countries: string[];
  /** City names; a city only narrows the country it belongs to. */
  cities: string[];
}

export interface Profile {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  addressLine1: string;
  addressLine2?: string;
  city: string;
  postcode: string;
  /** Plain-text CV. */
  cvText: string;
  /** Absent means no preferences: everything is available. */
  preferences?: Preferences;
}

export interface TrainingRecord {
  name: string;
  /** ISO date, YYYY-MM-DD */
  completedOn?: string;
  /** ISO date, YYYY-MM-DD. Omit when the training does not expire. */
  expiresOn?: string;
}

export interface Referee {
  name: string;
  relationship: string;
  organisation: string;
  email: string;
  phone: string;
}

export interface DbsDetails {
  certificateNumber?: string;
  /** ISO date, YYYY-MM-DD */
  issueDate?: string;
  onUpdateService?: boolean;
}

/** The "credential passport". Everything in here is treated as sensitive when filling forms. */
export interface Passport {
  /** v1 field, still accepted. Read it through credentialOf(passport, 'pin') / nmcPinOf(passport). */
  nmcPin?: string;
  /**
   * Credential id -> what the user typed, e.g. { prof: 'MCIOB 1234567', sc: 'SC, expires 2028-01' }.
   * Ids come from the pack registry (packs.ts). OpennJob stores these; it verifies none of them.
   */
  credentials?: Record<string, string>;
  dbs?: DbsDetails;
  /** The user's own confirmation that they have the right to work in the UK. Not a verification. */
  rightToWorkConfirmed: boolean;
  training: TrainingRecord[];
  referees: Referee[];
}

export const EMPTY_PASSPORT: Passport = { rightToWorkConfirmed: false, training: [], referees: [] };

export type ApplicationStatus = 'draft' | 'confirmed' | 'submitted';

export interface Application {
  id: string;
  userId: string;
  jobId: string;
  jobTitle: string;
  employer: string;
  applyUrl: string;
  mode: Mode;
  status: ApplicationStatus;
  statement: string;
  statementSource: 'llm' | 'fallback';
  /** Essential criteria with no evidence in the CV. Shown to the user, never hidden. */
  gaps: string[];
  warnings: string[];
  score: number;
  /** Field ids / categories the user explicitly confirmed (audit trail). */
  confirmedFields: string[];
  createdAt: string;
  confirmedAt?: string;
  submittedAt?: string;
}

/**
 * An account. `passwordHash` is a one-way hash (bcrypt); it never leaves the API.
 * The consent fields record which versions of the terms and the privacy notice the
 * person accepted when they registered, and when.
 */
export interface User {
  id: string;
  /** Lower case, unique. */
  email: string;
  passwordHash: string;
  createdAt: string;
  acceptedTermsVersion: string;
  acceptedPrivacyVersion: string;
  /** When the two versions above were accepted. */
  consentAt: string;
}

/** Events that belong to no account (an employer's posting, an account deletion) carry this user id. */
export const SYSTEM_USER_ID = 'system';

export interface DomainEvent {
  id: string;
  type: string;
  userId: string;
  occurredAt: string;
  /** Ids and counters only. Never put CV text or declaration answers in an event payload. */
  payload: Record<string, unknown>;
}

/** Injectable clock so time-dependent rules are testable. */
export type Clock = () => Date;
export const systemClock: Clock = () => new Date();
