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
