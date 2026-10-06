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
  /** Permanent or contract, when the source says or the advert makes it clear. Absent = not known. */
  contractType?: ContractType;
}

export type ContractType = 'permanent' | 'contract';
/** What the candidate is looking for. Nothing selected means all three. */
export type SearchType = 'uk-permanent' | 'uk-contract' | 'international';
export const SEARCH_TYPES: readonly SearchType[] = ['uk-permanent', 'uk-contract', 'international'];

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
  /** UK permanent, UK contract, international. Empty or absent means all three. */
  searchTypes?: SearchType[];
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

/**
 * draft      prepared by the agent, waiting for the person (or for the queue)
 * confirmed  approved by the person, not yet sent
 * needs_you  held: a declaration to answer, a question with no stored answer, a failed truth
 *            check, a CAPTCHA or login wall, the daily limit... (holdReasons says which)
 * submitted  sent, with a receipt
 * uncertain  submit was pressed but no confirmation was seen; never retried automatically
 * interview  the person recorded an interview invitation
 * closed     finished (rejected, withdrawn, filled)
 */
export type ApplicationStatus = 'draft' | 'confirmed' | 'needs_you' | 'submitted' | 'uncertain' | 'interview' | 'closed';
export const APPLICATION_STATUSES: readonly ApplicationStatus[] = ['draft', 'confirmed', 'needs_you', 'submitted', 'uncertain', 'interview', 'closed'];

/** Proof that an application was sent (APP-7). Encrypted at rest. */
export interface ApplicationReceipt {
  at: string;
  pageUrl: string;
  /** The site's own confirmation text, as shown after submitting. */
  confirmationText: string;
  /** SHA-256 of each document sent, as computed where it was sent. */
  documentsSha256: Record<string, string>;
  /** true when sent by the agent under standing authorisation. */
  automatic: boolean;
}

/** The exact documents an application used (TAI-6). Encrypted at rest. */
export interface SentDocuments {
  statement: string;
  tailoredCv: string;
  sha256: { statement: string; tailoredCv: string };
}

/** Ordinary screening answers, stored once and reused (SCR-1). Never declarations (SCR-3). Encrypted at rest. */
export interface ScreeningAnswers {
  noticePeriod?: string;
  salaryExpectation?: string;
  dayRate?: string;
  relocation?: boolean;
  travel?: boolean;
  yearsExperience?: string;
  drivingLicence?: boolean;
  /** Answers the person gave to other ordinary questions, keyed by the normalised question. */
  custom: Record<string, string>;
}

/** Standing authorisation (APP-2): explicit, dated, revocable. Scope per OD-1. */
export interface StandingAuthorisation {
  enabled: boolean;
  /** The wording the person agreed to (versioned), and when. */
  scopeVersion: string;
  consentAt?: string;
  revokedAt?: string;
  /** The person's pause (APP-10). */
  paused: boolean;
}

/** One in-app notification. Subject and body name at most a job title, an employer and counts. */
export interface Notification {
  id: string;
  userId: string;
  eventKey: string;
  category: string;
  severity: 'info' | 'success' | 'warning' | 'critical';
  subject: string;
  body: string;
  createdAt: string;
  readAt?: string;
}

/** One attempt to deliver one event on one channel. No content and no address are kept. */
export interface NotificationDelivery {
  id: string;
  userId: string;
  eventKey: string;
  channel: 'email' | 'inapp' | 'sms' | 'push' | 'whatsapp';
  /** delivered (in-app), sent (provider accepted), logged (sandbox: no provider), skipped (opted out), failed */
  status: 'delivered' | 'sent' | 'logged' | 'skipped' | 'failed';
  provider: string;
  at: string;
}

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
  /** Why the application is held for the person (status needs_you). */
  holdReasons?: string[];
  /** employer|title|location, normalised: the duplicate check (APP-6). */
  dedupeKey?: string;
  /** Sent by the agent under standing authorisation. */
  automatic?: boolean;
  /** When the queue was given the go to submit it (counts towards the daily limit). */
  attemptedAt?: string;
  /** The tailored CV (TAI-2). Encrypted at rest. */
  tailoredCv?: string;
  /** Sentences of the tailored documents that could not be traced to the source (TAI-3). */
  traceFailures?: string[];
  sentDocuments?: SentDocuments;
  receipt?: ApplicationReceipt;
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
  /** When the address was verified (ACC-2). Absent: not verified. */
  emailVerifiedAt?: string;
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
