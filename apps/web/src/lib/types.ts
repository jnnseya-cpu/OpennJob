import type { Application, JobLanguage, Mode, PackId, Passport, Profile, Region } from './core';

export type { Application, Mode, PackId, Passport, Profile };

/** One entry of GET /jobs/matches. See OpennJobService.matchView in apps/api/src/services.ts. */
export interface MatchView {
  job: {
    id: string;
    source: string;
    title: string;
    employer: string;
    location: string;
    url: string;
    applyUrl: string;
    salaryMin?: number;
    salaryMax?: number;
    requiresRegistration: boolean;
    requiredCredential?: string;
    criteriaSource: string;
    pack?: PackId;
    country?: string;
    city?: string;
    region?: Region;
    language: JobLanguage;
    origin: 'discovered' | 'employer';
  };
  score: number;
  eligible: boolean;
  missingCredential?: string;
  unmetEssential: string[];
  /** The advert names a recruiter's e-mail address, so the application can go by e-mail. */
  emailApply?: boolean;
  /** One of the companies the person asked to search for: the advertiser, or named in the advert. */
  targetEmployer?: { name: string; how: 'employer' | 'named' };
  /** The CV does not show this kind of post: the score is capped. */
  otherField?: { role: string; missing: string[] };
  /** The advert gave too few readable requirements: the score is capped. */
  thinEvidence?: boolean;
  hits: { label: string; essential: boolean; matched: boolean; evidence?: string; statedLanguage?: string }[];
}

export interface TrainingCheck {
  name: string;
  expiresOn?: string;
  status: 'valid' | 'expiring' | 'expired' | 'no-expiry' | 'invalid-date';
  daysRemaining?: number;
}

export interface PassportView {
  passport: Passport;
  training: TrainingCheck[];
}

export interface AgentRunResult {
  threshold: number;
  mode: Mode;
  considered: number;
  prepared: Application[];
  skipped: { outOfScope: number; belowThreshold: number; ineligible: number; alreadyPrepared: number };
}

export interface PublicUser {
  id: string;
  email: string;
  createdAt: string;
  consent: { acceptedTermsVersion: string; acceptedPrivacyVersion: string; acceptedAt: string };
  emailVerified: boolean;
  emailVerifiedAt?: string;
}

/** GET /agent/authorisation: standing authorisation to submit, to one named wording (APP-2). */
export interface Authorisation {
  enabled: boolean;
  scopeVersion?: string;
  consentAt?: string;
  revokedAt?: string;
  paused: boolean;
  scope: { version: string; text: string };
}

/** GET /agent/status */
export interface AgentStatus {
  authorisation: Authorisation;
  operatorPaused: boolean;
  dailyLimit: { limit: number; used: number; remaining: number; resetsAt: string };
  queue: { ready: number; waitingForSystem: number; needsYou: number };
  wait?: string;
  message?: string;
  systems: { id: string; label: string; enabled: boolean }[];
  /** For each application that would go out on its own: how it can ('none': the person applies on the site). */
  routes?: Record<string, 'email' | 'form' | 'none'>;
}

/** Ordinary screening answers, stored once and reused. Never declarations. */
export interface ScreeningAnswers {
  noticePeriod?: string;
  salaryExpectation?: string;
  dayRate?: string;
  yearsExperience?: string;
  relocation?: boolean;
  travel?: boolean;
  drivingLicence?: boolean;
  custom: Record<string, string>;
}

/** POST /profile/cv */
export interface CvExtraction {
  text: string;
  format: 'pdf' | 'docx';
  pages?: number;
  warnings: string[];
  suggestions: { firstName?: string; lastName?: string; email?: string; phone?: string; postcode?: string; city?: string };
}

/** GET /applications/:id/interview */
export interface DocumentInterview {
  applicationId: string;
  jobTitle: string;
  employer: string;
  documentsSha256: { statement: string; tailoredCv: string };
  questions: {
    id: string;
    criterion: string;
    essential: boolean;
    advertQuote?: string;
    documentQuote?: { document: 'statement' | 'tailoredCv'; text: string };
    question: string;
    lookFor: string[];
  }[];
  gaps: string[];
}

export interface AuthResult {
  user: PublicUser;
  accessToken: string;
  expiresAt: string;
}

export interface PackQuestion {
  id: string;
  pack: PackId;
  language: JobLanguage;
  text: string;
}

export interface InterviewFeedback {
  question: string;
  lookFor: string[];
  feedback: {
    scores: Record<'situation' | 'task' | 'action' | 'result', number>;
    total: number;
    strengths: string[];
    improvements: string[];
    source: 'llm' | 'heuristic';
  };
}

/** GET /jobs/search-plan: what the job-search APIs are asked for this person, from their CV and places. */
export interface SearchPlanView {
  hasProfile: boolean;
  titles: string[];
  places: { where?: string; country: string }[];
  queries: { what: string; where?: string; country: string }[];
  searchSources: { label: string; countries: string[] | null }[];
  boards: number;
  /** Per country: searches made and the job-search APIs that cover it. */
  coverage?: { country: string; searches: number; sources: string[] }[];
  /** Profile settings that hide jobs abroad: 'search-types-uk-only', 'french-not-selected'. */
  warnings?: string[];
}

/** GET /agent/interview-rates */
export interface InterviewRates {
  bands: { label: string; from: number; to: number; sent: number; outcomes: number; interviews: number; rate?: number }[];
  bar: { bar: number; base: number; target?: number; reason: 'no-target' | 'learning' | 'meets-target' | 'below-target'; outcomes: number; needed: number; rateAtBar?: number };
}
