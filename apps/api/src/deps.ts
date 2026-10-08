import { randomBytes, randomUUID } from 'node:crypto';
import type { Brand } from '@opennjob/core';
import { DEFAULT_BRAND, fileMailbox, resendEmail, smtpEmail } from './notifications';
import type { SmtpSettings } from './notifications';
import type { EmailSender, Notifier } from './notifications';
import {
  AnthropicLlm,
  OpenAiCompatibleLlm,
  InMemoryRepository,
  InMemoryUsageMeter,
  InProcessEventBus,
  createAdzunaSearch,
  createAshbySource,
  createGreenhouseSource,
  createLeverSource,
  createReedSearch,
  createReliefWebSearch,
  createJoobleSearch,
  createCareerSiteSearch,
  parseCareerSites,
  parseJoobleKeys,
  createSampleSource,
  systemClock,
} from '@opennjob/core';
import type { Clock, EventBus, FetchLike, JobSourceAdapter, LlmPort, Repository, SearchSource, UsageMeter } from '@opennjob/core';
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
  /**
   * Bearer key for the operator routes (OPENNJOB_OPERATOR_KEY): pause the agent for
   * everyone, enable an application system after its supervised test. Absent = closed.
   */
  operatorKey?: string;
  /** NODE_ENV=production. Test-only application systems cannot be enabled then. */
  production?: boolean;
  /** NFR-4: where operator alerts go (OPENNJOB_OPERATOR_EMAIL). Absent: alerts are logged only. */
  operatorEmail?: string;
  /** Development only: write e-mails as files here (OPENNJOB_DEV_MAILBOX_DIR). Refused in production. */
  devMailboxDir?: string;
  /** DP-5: delete application records, events and notifications older than this (OPENNJOB_RETENTION_DAYS). Absent: kept. */
  retentionDays?: number;
  /** Run the daily discovery and 09:00 report in this process (OPENNJOB_SCHEDULER=on). One instance only needs it; claims stop doubles. */
  scheduler?: boolean;
  /** APP-6: an application to the same employer, title and location within this many days is a duplicate (OPENNJOB_DUPLICATE_DAYS, default 30). */
  duplicateDays?: number;
  /** APP-8: automatic submissions per person per London day (OPENNJOB_DAILY_APPLICATION_LIMIT, default 20). */
  dailyApplicationLimit?: number;
  /** NFR-5: ACU of LLM use per person, and in total, per London day (OPENNJOB_LLM_DAILY_ACU_PER_USER, default 50; _TOTAL, default 500). */
  llmDailyAcuPerUser?: number;
  llmDailyAcuTotal?: number;
  /** Searches per person per refresh, built from their CV (OPENNJOB_SEARCH_MAX_QUERIES_PER_USER, default 6). */
  searchMaxQueriesPerUser?: number;
  /** Searches in one platform-wide refresh, all people together (OPENNJOB_SEARCH_MAX_QUERIES_PER_REFRESH, default 60). Protects the APIs' daily quotas. */
  searchMaxQueriesPerRefresh?: number;
  /** Branding on outbound e-mail (OPENNJOB_BRAND_NAME, _COLOUR, _FOOTER, OPENNJOB_APP_URL). Default: OpennJob. */
  brand?: Brand;
}

export const DEFAULT_TERMS_VERSION = 'draft-1';
export const DEFAULT_PRIVACY_VERSION = 'draft-1';

export const DEFAULT_APPLY_THRESHOLD = 80;

export function applyThresholdOf(config: OpennJobConfig): number {
  const t = config.applyThreshold;
  return typeof t === 'number' && Number.isFinite(t) && t >= 0 && t <= 100 ? t : DEFAULT_APPLY_THRESHOLD;
}

export const DEFAULT_DUPLICATE_DAYS = 30;
export const DEFAULT_DAILY_APPLICATION_LIMIT = 20;
export const DEFAULT_LLM_DAILY_ACU_PER_USER = 50;
export const DEFAULT_LLM_DAILY_ACU_TOTAL = 500;

/** The owner's limits, with defaults for anything not set. */
export function limitsOf(config: OpennJobConfig) {
  return {
    duplicateDays: config.duplicateDays ?? DEFAULT_DUPLICATE_DAYS,
    dailyApplicationLimit: config.dailyApplicationLimit ?? DEFAULT_DAILY_APPLICATION_LIMIT,
    llmDailyAcuPerUser: config.llmDailyAcuPerUser ?? DEFAULT_LLM_DAILY_ACU_PER_USER,
    llmDailyAcuTotal: config.llmDailyAcuTotal ?? DEFAULT_LLM_DAILY_ACU_TOTAL,
  };
}

export interface OpennJobDeps {
  repository: Repository;
  /** 'postgres' when DATABASE_URL is set, otherwise 'memory'. Reported by GET /health. */
  persistence: 'memory' | 'postgres';
  /** undefined = no LLM configured; deterministic fallbacks are used everywhere. */
  llm?: LlmPort;
  usageMeter: UsageMeter;
  eventBus: EventBus;
  /** Sources that list everything they have (demo jobs, employers' boards). */
  sources: JobSourceAdapter[];
  /** Job-search APIs asked per person, with searches built from their CV and preferences (search.ts). */
  searchSources?: SearchSource[];
  clock: Clock;
  newId: () => string;
  config: OpennJobConfig;
  /** Structured log sink. Never give it CV, passport or statement content. */
  logger: Logger;
  /** Outbound e-mail. Undefined: sandbox (recorded, never sent). See notifications.ts. */
  emailSender?: EmailSender;
  /** Set by AppModule.register: the notification engine. */
  notifier?: Notifier;
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

/** "unlimited" (or "off", "none") means no ceiling: the owner's choice (6 October 2026). Anthropic still bills every call. */
const UNLIMITED = /^(unlimited|off|none|no limit)$/i;
const ceiling = (v: string | undefined, fallback: number, min: number, max: number): number => (UNLIMITED.test((v ?? '').trim()) ? Number.POSITIVE_INFINITY : int(v, fallback, min, max));

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
    llmCriteriaMaxJobs: UNLIMITED.test((env.OPENNJOB_LLM_CRITERIA_MAX_JOBS ?? '').trim()) ? Number.POSITIVE_INFINITY : Number.isFinite(max) && max >= 0 ? max : 25,
  };
  // Only a whole number from 0 to 100 is accepted; anything else leaves the default (80) in force.
  const rawThreshold = (env.OPENNJOB_APPLY_THRESHOLD ?? '').trim();
  if (/^\d{1,3}$/.test(rawThreshold) && Number(rawThreshold) <= 100) config.applyThreshold = Number(rawThreshold);
  const brandName = (env.OPENNJOB_BRAND_NAME ?? '').trim();
  const brandColour = (env.OPENNJOB_BRAND_COLOUR ?? '').trim();
  const brandFooter = (env.OPENNJOB_BRAND_FOOTER ?? '').trim();
  const appUrl = (env.OPENNJOB_APP_URL ?? '').trim();
  // The logo in e-mails: OPENNJOB_BRAND_LOGO_URL, else the copy the web app serves. https only.
  const logoCandidate = (env.OPENNJOB_BRAND_LOGO_URL ?? '').trim() || (/^https:\/\//.test(appUrl) ? `${appUrl.replace(/\/+$/, '')}/brand/opennjob-logo-192.png` : '');
  const logoUrl = /^https:\/\//.test(logoCandidate) ? logoCandidate : '';
  if (brandName || brandColour || brandFooter || appUrl || logoUrl) {
    config.brand = {
      name: brandName || DEFAULT_BRAND.name,
      colour: /^#[0-9a-fA-F]{6}$/.test(brandColour) ? brandColour : DEFAULT_BRAND.colour,
      footer: brandFooter || DEFAULT_BRAND.footer,
      ...(/^https?:\/\//.test(appUrl) ? { appUrl } : {}),
      ...(logoUrl ? { logoUrl } : {}),
    };
  }
  config.duplicateDays = int(env.OPENNJOB_DUPLICATE_DAYS, DEFAULT_DUPLICATE_DAYS, 1, 3650);
  config.searchMaxQueriesPerUser = int(env.OPENNJOB_SEARCH_MAX_QUERIES_PER_USER, 6, 1, 60);
  config.searchMaxQueriesPerRefresh = int(env.OPENNJOB_SEARCH_MAX_QUERIES_PER_REFRESH, 60, 1, 1000);
  config.dailyApplicationLimit = int(env.OPENNJOB_DAILY_APPLICATION_LIMIT, DEFAULT_DAILY_APPLICATION_LIMIT, 0, 1000);
  config.llmDailyAcuPerUser = ceiling(env.OPENNJOB_LLM_DAILY_ACU_PER_USER, DEFAULT_LLM_DAILY_ACU_PER_USER, 0, 1_000_000);
  config.llmDailyAcuTotal = ceiling(env.OPENNJOB_LLM_DAILY_ACU_TOTAL, DEFAULT_LLM_DAILY_ACU_TOTAL, 0, 100_000_000);
  const operatorEmail = (env.OPENNJOB_OPERATOR_EMAIL ?? '').trim().toLowerCase();
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(operatorEmail)) config.operatorEmail = operatorEmail;
  const mailbox = (env.OPENNJOB_DEV_MAILBOX_DIR ?? '').trim();
  if (mailbox) config.devMailboxDir = mailbox;
  const retention = (env.OPENNJOB_RETENTION_DAYS ?? '').trim();
  if (/^\d{1,5}$/.test(retention) && Number(retention) >= 30) config.retentionDays = Number(retention);
  if (flag(env.OPENNJOB_SCHEDULER)) config.scheduler = true;
  const operatorKey = (env.OPENNJOB_OPERATOR_KEY ?? '').trim();
  if (operatorKey) config.operatorKey = operatorKey;
  if (isProduction(env)) config.production = true;
  const employerKey = (env.OPENNJOB_EMPLOYER_KEY ?? '').trim();
  if (employerKey) config.employerKey = employerKey;
  return config;
}

export const MIN_JWT_SECRET_LENGTH = 32;

/** SMTP settings from the environment, or undefined when SMTP is not configured. */
export function smtpSettings(env: Env): SmtpSettings | undefined {
  const host = (env.SMTP_HOST ?? '').trim();
  const user = (env.SMTP_USER ?? '').trim();
  const password = env.SMTP_PASSWORD ?? '';
  if (!host || !user || !password.trim()) return undefined;
  const port = Number.parseInt((env.SMTP_PORT ?? '465').trim(), 10);
  const from = (env.OPENNJOB_EMAIL_FROM ?? '').trim() || user;
  return { host, port, user, password, from, secure: port === 465 };
}

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
  if (production && (env.OPENNJOB_DEV_MAILBOX_DIR ?? '').trim()) problems.push('OPENNJOB_DEV_MAILBOX_DIR writes e-mails to files and is for development only. Unset it in production.');
  const smtpParts = [env.SMTP_HOST, env.SMTP_USER, env.SMTP_PASSWORD].map((v) => (v ?? '').trim() !== '');
  if (smtpParts.some(Boolean) && !smtpParts.every(Boolean)) problems.push('SMTP needs SMTP_HOST, SMTP_USER and SMTP_PASSWORD together (one or two of them are set).');
  const smtpPort = (env.SMTP_PORT ?? '').trim();
  if (smtpPort && !(/^\d{1,5}$/.test(smtpPort) && Number(smtpPort) > 0 && Number(smtpPort) < 65536)) problems.push('SMTP_PORT must be a port number, for example 465.');
  const retention = (env.OPENNJOB_RETENTION_DAYS ?? '').trim();
  if (retention && !(/^\d{1,5}$/.test(retention) && Number(retention) >= 30)) problems.push('OPENNJOB_RETENTION_DAYS must be a whole number of days, 30 or more.');
  return problems;
}

/** Builds the list of job sources from environment variables. Unconfigured sources are simply absent. */
export function buildSources(env: Env, fetchFn: FetchLike): JobSourceAdapter[] {
  const sources: JobSourceAdapter[] = [];
  if (flag(env.OPENNJOB_DEMO_JOBS)) sources.push(createSampleSource({ allPacks: true }));
  for (const b of boards(env.OPENNJOB_GREENHOUSE_BOARDS)) sources.push(createGreenhouseSource({ boardToken: b.id, ...(b.employer ? { employer: b.employer } : {}), fetch: fetchFn }));
  for (const b of boards(env.OPENNJOB_LEVER_COMPANIES)) sources.push(createLeverSource({ company: b.id, ...(b.employer ? { employer: b.employer } : {}), fetch: fetchFn }));
  for (const b of boards(env.OPENNJOB_ASHBY_BOARDS)) sources.push(createAshbySource({ boardName: b.id, ...(b.employer ? { employer: b.employer } : {}), fetch: fetchFn }));
  return sources;
}

/**
 * Builds the job-search APIs from environment variables: only the keys. What they are asked comes
 * from each person's CV and preferences (packages/core/src/search.ts), never from a server setting.
 */
export function buildSearchSources(env: Env, fetchFn: FetchLike): SearchSource[] {
  const out: SearchSource[] = [];
  if (env.ADZUNA_APP_ID && env.ADZUNA_APP_KEY) {
    const perPage = Number.parseInt((env.ADZUNA_RESULTS_PER_PAGE ?? '').trim(), 10);
    out.push(createAdzunaSearch({ appId: env.ADZUNA_APP_ID, appKey: env.ADZUNA_APP_KEY, ...(Number.isFinite(perPage) ? { resultsPerPage: perPage } : {}), fetch: fetchFn }));
  }
  if (env.REED_API_KEY) out.push(createReedSearch({ apiKey: env.REED_API_KEY, fetch: fetchFn }));
  // ReliefWeb (UN OCHA): humanitarian and development jobs, e.g. DR Congo. Needs an appname ReliefWeb approved.
  if (env.OPENNJOB_RELIEFWEB_APPNAME?.trim()) out.push(createReliefWebSearch({ appName: env.OPENNJOB_RELIEFWEB_APPNAME.trim(), fetch: fetchFn }));
  // Jooble: one key per country site ("AE:key,SA:key"), for countries Adzuna and Reed do not cover.
  const joobleKeys = parseJoobleKeys(env.JOOBLE_API_KEYS);
  if (Object.keys(joobleKeys).length) out.push(createJoobleSearch({ keys: joobleKeys, fetch: fetchFn }));
  // Employers' own careers sites (Workday, SuccessFactors), each listed by the operator after its
  // terms were checked (deploy/add-career-site.sh). Every job comes with the employer's own page.
  const careerSites = parseCareerSites(env.OPENNJOB_CAREER_SITES);
  for (const kind of ['workday', 'successfactors'] as const) {
    if (careerSites.some((c) => c.kind === kind)) out.push(createCareerSiteSearch({ kind, sites: careerSites, fetch: fetchFn }));
  }
  return out;
}

/**
 * Default wiring. PostgreSQL when DATABASE_URL is set, in-memory otherwise. The Anthropic
 * LLM only when a key is present. Outside production a missing OPENNJOB_JWT_SECRET is
 * replaced by a random one for this process (every token dies with the process).
 */
/** How long one call to a job source may take before it counts as not answering. */
export const SOURCE_TIMEOUT_MS = 20_000;

/** fetch with a time limit: a source that never answers cannot hold up a search. */
export const timedFetch: FetchLike = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS) }) as unknown as ReturnType<FetchLike>;

export function createDefaultDeps(env: Env = process.env, fetchFn: FetchLike = timedFetch, logger: Logger = consoleJsonLogger): OpennJobDeps {
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
    searchSources: buildSearchSources(env, fetchFn),
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
  const resendKey = (env.RESEND_API_KEY ?? '').trim();
  const emailFrom = (env.OPENNJOB_EMAIL_FROM ?? '').trim();
  const smtp = smtpSettings(env);
  if (resendKey && emailFrom) deps.emailSender = resendEmail(resendKey, emailFrom);
  else if (smtp) deps.emailSender = smtpEmail(smtp);
  else if (config.devMailboxDir && !isProduction(env)) deps.emailSender = fileMailbox(config.devMailboxDir);
  const llm = buildLlm(env);
  if (llm) deps.llm = llm;
  return deps;
}

/**
 * The AI the API uses: OPENNJOB_LLM_PROVIDER picks gemini (GEMINI_API_KEY), openai (OPENAI_API_KEY)
 * or anthropic (ANTHROPIC_API_KEY, the default when it is set). OPENNJOB_LLM_MODEL chooses the
 * model for Gemini or OpenAI; OPENNJOB_MODEL stays Claude's. No key for the chosen provider: no AI,
 * and the no-AI drafts are used.
 */
export function buildLlm(env: Env): LlmPort | undefined {
  const provider = (env.OPENNJOB_LLM_PROVIDER ?? '').trim().toLowerCase();
  const model = (env.OPENNJOB_LLM_MODEL ?? '').trim();
  if (provider === 'gemini' || provider === 'openai') {
    const key = (provider === 'gemini' ? env.GEMINI_API_KEY : env.OPENAI_API_KEY ?? '')?.trim() ?? '';
    return key ? new OpenAiCompatibleLlm({ provider, apiKey: key, ...(model ? { model } : {}) }) : undefined;
  }
  if ((env.ANTHROPIC_API_KEY ?? '').trim()) {
    return new AnthropicLlm({ apiKey: env.ANTHROPIC_API_KEY as string, ...(env.OPENNJOB_MODEL ? { model: env.OPENNJOB_MODEL } : {}) });
  }
  return undefined;
}
