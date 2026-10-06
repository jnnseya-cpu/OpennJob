import { randomBytes, randomUUID } from 'node:crypto';
import {
  AnthropicLlm,
  InMemoryRepository,
  InMemoryUsageMeter,
  InProcessEventBus,
  createAdzunaSource,
  createAshbySource,
  createGreenhouseSource,
  createLeverSource,
  createReedSource,
  createSampleSource,
  systemClock,
} from '@opennjob/core';
import type { Clock, EventBus, FetchLike, JobSourceAdapter, LlmPort, Repository, UsageMeter } from '@opennjob/core';
import { cipherFromEnv, parseDataKey } from './crypto';
import { consoleJsonLogger } from './logging';
import type { Logger } from './logging';
import { PostgresRepository, PostgresUsageMeter, createPool } from './postgres';

/** Injection token for the whole dependency bundle. */
export const DEPS = Symbol('OPENNJOB_DEPS');

export interface OpennJobConfig {
  /**
   * Secret that signs access tokens (OPENNJOB_JWT_SECRET). Every authenticated route
   * fails closed (HTTP 401) when this is empty.
   */
  jwtSecret: string;
  /** Lifetime of an access token in seconds (OPENNJOB_JWT_TTL_SECONDS, default 3600). */
  jwtTtlSeconds: number;
  /** bcrypt cost (OPENNJOB_BCRYPT_ROUNDS, default 12). */
  bcryptRounds: number;
  /** The versions of the terms and privacy notice a new account must accept. */
  termsVersion: string;
  privacyVersion: string;
  /** Attempts allowed per client address on /auth/* in one window. */
  authRateLimitMax: number;
  authRateLimitWindowMs: number;
  /** Browser origins allowed to call the API (OPENNJOB_CORS_ORIGINS). */
  corsOrigins: string[];
  /**
   * Invite-only registration (a private pilot). Lower-case email addresses allowed to register.
   * Empty means anyone may register. Existing accounts can always sign in.
   */
  registrationAllowlist: string[];
  /** Allow any chrome-extension:// origin. Default: true outside production, false in production. */
  corsAllowAnyExtension: boolean;
  /** Largest request body accepted, e.g. '256kb'. */
  bodyLimit: string;
  /** Use the LLM (when configured) to extract criteria during POST /jobs/refresh. Costs ACU per job. */
  llmCriteria: boolean;
  /** Upper bound on LLM criteria extractions per refresh. */
  llmCriteriaMaxJobs: number;
  /**
   * The "80% rule": POST /agent/run prepares a draft for every in-scope, eligible job
   * scoring at or above this (0 to 100). From OPENNJOB_APPLY_THRESHOLD; absent = DEFAULT_APPLY_THRESHOLD.
   */
  applyThreshold?: number;
  /**
   * Separate bearer key for POST /employer/jobs (OPENNJOB_EMPLOYER_KEY). Absent = the
   * route is closed. Employer posting is optional; nothing else depends on it.
   */
  employerKey?: string;
}

export const DEFAULT_TERMS_VERSION = 'draft-1';
export const DEFAULT_PRIVACY_VERSION = 'draft-1';

export const DEFAULT_APPLY_THRESHOLD = 80;

export function applyThresholdOf(config: OpennJobConfig): number {
  const t = config.applyThreshold;
  return typeof t === 'number' && Number.isFinite(t) && t >= 0 && t <= 100 ? t : DEFAULT_APPLY_THRESHOLD;
}

export interface OpennJobDeps {
  repository: Repository;
  /** 'postgres' when DATABASE_URL is set, otherwise 'memory'. Reported by GET /health. */
  persistence: 'memory' | 'postgres';
  /** undefined = no LLM configured; deterministic fallbacks are used everywhere. */
  llm?: LlmPort;
  usageMeter: UsageMeter;
  eventBus: EventBus;
  sources: JobSourceAdapter[];
  clock: Clock;
  newId: () => string;
  config: OpennJobConfig;
  /** Structured log sink. Never give it CV, passport or statement content. */
  logger: Logger;
  /** Releases what the bundle holds open (the database pool). Called on shutdown. */
  close?: () => Promise<void>;
}

type Env = Record<string, string | undefined>;

const list = (v: string | undefined): string[] => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const flag = (v: string | undefined): boolean => /^(1|true|yes|on)$/i.test((v ?? '').trim());

/** "token:Employer Name" -> { id: "token", employer: "Employer Name" } */
function boards(v: string | undefined): { id: string; employer?: string }[] {
  return list(v).map((entry) => {
    const i = entry.indexOf(':');
    if (i === -1) return { id: entry };
    const employer = entry.slice(i + 1).trim();
    return { id: entry.slice(0, i).trim(), ...(employer ? { employer } : {}) };
  });
}

const int = (v: string | undefined, fallback: number, min: number, max: number): number => {
  const raw = (v ?? '').trim();
  if (!/^\d{1,9}$/.test(raw)) return fallback;
  const n = Number(raw);
  return n >= min && n <= max ? n : fallback;
};

export const isProduction = (env: Env): boolean => (env.NODE_ENV ?? '').trim().toLowerCase() === 'production';

export function loadConfig(env: Env): OpennJobConfig {
  const max = Number.parseInt(env.OPENNJOB_LLM_CRITERIA_MAX_JOBS ?? '', 10);
  const allowAnyExtension = (env.OPENNJOB_CORS_ALLOW_ANY_EXTENSION ?? '').trim();
  const config: OpennJobConfig = {
    jwtSecret: (env.OPENNJOB_JWT_SECRET ?? '').trim(),
    jwtTtlSeconds: int(env.OPENNJOB_JWT_TTL_SECONDS, 3600, 60, 86_400),
    bcryptRounds: int(env.OPENNJOB_BCRYPT_ROUNDS, 12, 4, 15),
    termsVersion: (env.OPENNJOB_TERMS_VERSION ?? '').trim() || DEFAULT_TERMS_VERSION,
    privacyVersion: (env.OPENNJOB_PRIVACY_VERSION ?? '').trim() || DEFAULT_PRIVACY_VERSION,
    authRateLimitMax: int(env.OPENNJOB_AUTH_RATE_LIMIT_MAX, 10, 1, 100_000),
    authRateLimitWindowMs: int(env.OPENNJOB_AUTH_RATE_LIMIT_WINDOW_SECONDS, 900, 1, 86_400) * 1000,
    corsOrigins: list(env.OPENNJOB_CORS_ORIGINS).map((o) => o.replace(/\/+$/, '')),
    registrationAllowlist: list(env.OPENNJOB_REGISTRATION_ALLOWLIST).map((e) => e.toLowerCase()),
    corsAllowAnyExtension: allowAnyExtension ? flag(allowAnyExtension) : !isProduction(env),
    bodyLimit: /^\d{1,6}(b|kb|mb)$/i.test((env.OPENNJOB_BODY_LIMIT ?? '').trim()) ? (env.OPENNJOB_BODY_LIMIT as string).trim().toLowerCase() : '256kb',
    llmCriteria: flag(env.OPENNJOB_LLM_CRITERIA),
    llmCriteriaMaxJobs: Number.isFinite(max) && max >= 0 ? max : 25,
  };
  // Only a whole number from 0 to 100 is accepted; anything else leaves the default (80) in force.
  const rawThreshold = (env.OPENNJOB_APPLY_THRESHOLD ?? '').trim();
  if (/^\d{1,3}$/.test(rawThreshold) && Number(rawThreshold) <= 100) config.applyThreshold = Number(rawThreshold);
  const employerKey = (env.OPENNJOB_EMPLOYER_KEY ?? '').trim();
  if (employerKey) config.employerKey = employerKey;
  return config;
}

export const MIN_JWT_SECRET_LENGTH = 32;

/**
 * What must be true before the API may start. Returns the list of problems; the caller
 * prints them and exits when it is not empty.
 *
 * In production (NODE_ENV=production) the API refuses to start without a signing secret
 * and without a data-encryption key. A key that is set but malformed is refused always.
 */
export function startupProblems(env: Env): string[] {
  const problems: string[] = [];
  const production = isProduction(env);
  const secret = (env.OPENNJOB_JWT_SECRET ?? '').trim();
  if (production && !secret) problems.push('OPENNJOB_JWT_SECRET is not set. It is required when NODE_ENV=production.');
  else if (secret && secret.length < MIN_JWT_SECRET_LENGTH) problems.push(`OPENNJOB_JWT_SECRET is too short: use at least ${MIN_JWT_SECRET_LENGTH} random characters.`);
  let key: Buffer | undefined;
  try {
    key = parseDataKey(env.OPENNJOB_DATA_KEY);
  } catch (err) {
    problems.push(`${err instanceof Error ? err.message : String(err)}.`);
    return problems;
  }
  if (production && !key) problems.push('OPENNJOB_DATA_KEY is not set. It is required when NODE_ENV=production (32 random bytes, base64).');
  return problems;
}

/** Builds the list of job sources from environment variables. Unconfigured sources are simply absent. */
export function buildSources(env: Env, fetchFn: FetchLike): JobSourceAdapter[] {
  const sources: JobSourceAdapter[] = [];
  if (flag(env.OPENNJOB_DEMO_JOBS)) sources.push(createSampleSource({ allPacks: true }));
  for (const b of boards(env.OPENNJOB_GREENHOUSE_BOARDS)) sources.push(createGreenhouseSource({ boardToken: b.id, ...(b.employer ? { employer: b.employer } : {}), fetch: fetchFn }));
  for (const b of boards(env.OPENNJOB_LEVER_COMPANIES)) sources.push(createLeverSource({ company: b.id, ...(b.employer ? { employer: b.employer } : {}), fetch: fetchFn }));
  for (const b of boards(env.OPENNJOB_ASHBY_BOARDS)) sources.push(createAshbySource({ boardName: b.id, ...(b.employer ? { employer: b.employer } : {}), fetch: fetchFn }));
  const keywords = (env.OPENNJOB_SEARCH_KEYWORDS ?? '').trim() || 'nurse';
  const location = (env.OPENNJOB_SEARCH_LOCATION ?? '').trim();
  if (env.ADZUNA_APP_ID && env.ADZUNA_APP_KEY) {
    // One adapter per country code in ADZUNA_COUNTRIES (default gb). Entries that are not two letters are ignored.
    const countries = list(env.ADZUNA_COUNTRIES).map((c) => c.toLowerCase()).filter((c) => /^[a-z]{2}$/.test(c));
    for (const country of countries.length ? [...new Set(countries)] : ['gb']) {
      sources.push(createAdzunaSource({ appId: env.ADZUNA_APP_ID, appKey: env.ADZUNA_APP_KEY, country, what: keywords, ...(location ? { where: location } : {}), fetch: fetchFn }));
    }
  }
  if (env.REED_API_KEY) {
    sources.push(createReedSource({ apiKey: env.REED_API_KEY, keywords, ...(location ? { locationName: location } : {}), fetch: fetchFn }));
  }
  return sources;
}

/**
 * Default wiring. PostgreSQL when DATABASE_URL is set, in-memory otherwise. The Anthropic
 * LLM only when a key is present. Outside production a missing OPENNJOB_JWT_SECRET is
 * replaced by a random one for this process (every token dies with the process).
 */
export function createDefaultDeps(env: Env = process.env, fetchFn: FetchLike = fetch as unknown as FetchLike, logger: Logger = consoleJsonLogger): OpennJobDeps {
  const config = loadConfig(env);
  if (!config.jwtSecret && !isProduction(env)) {
    config.jwtSecret = randomBytes(48).toString('base64url');
    logger.warn({ msg: 'OPENNJOB_JWT_SECRET is not set: using a random secret for this process. Everyone is signed out when it restarts.' });
  }
  const databaseUrl = (env.DATABASE_URL ?? '').trim();
  const cipher = cipherFromEnv(env.OPENNJOB_DATA_KEY);
  const deps: OpennJobDeps = {
    repository: new InMemoryRepository(),
    persistence: 'memory',
    usageMeter: new InMemoryUsageMeter(),
    eventBus: new InProcessEventBus(),
    sources: buildSources(env, fetchFn),
    clock: systemClock,
    newId: randomUUID,
    config,
    logger,
  };
  if (databaseUrl) {
    const pool = createPool(databaseUrl);
    // A broken idle connection must not crash the process; the next query reconnects.
    pool.on('error', (err) => logger.error({ msg: 'database pool error', errorName: err.name }));
    deps.repository = new PostgresRepository(pool, cipher);
    deps.usageMeter = new PostgresUsageMeter(pool);
    deps.persistence = 'postgres';
    deps.close = () => pool.end();
  }
  if ((env.ANTHROPIC_API_KEY ?? '').trim()) {
    deps.llm = new AnthropicLlm({ apiKey: env.ANTHROPIC_API_KEY as string, ...(env.OPENNJOB_MODEL ? { model: env.OPENNJOB_MODEL } : {}) });
  }
  return deps;
}
