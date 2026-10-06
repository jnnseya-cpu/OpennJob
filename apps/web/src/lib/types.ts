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
