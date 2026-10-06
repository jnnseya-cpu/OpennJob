import { randomUUID } from 'node:crypto';
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

/** Injection token for the whole dependency bundle. */
export const DEPS = Symbol('OPENNJOB_DEPS');

/**
 * Single-user development identity. Every request is attributed to this user.
 * PLACEHOLDER: real authentication must replace this before there is more than one user.
 */
export const DEV_USER_ID = 'dev-user';

export interface OpennJobConfig {
  /** Bearer token required on every request. Requests are rejected when this is empty. */
  apiToken: string;
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

export const DEFAULT_APPLY_THRESHOLD = 80;

export function applyThresholdOf(config: OpennJobConfig): number {
  const t = config.applyThreshold;
  return typeof t === 'number' && Number.isFinite(t) && t >= 0 && t <= 100 ? t : DEFAULT_APPLY_THRESHOLD;
}

export interface OpennJobDeps {
  repository: Repository;
  /** undefined = no LLM configured; deterministic fallbacks are used everywhere. */
  llm?: LlmPort;
  usageMeter: UsageMeter;
  eventBus: EventBus;
  sources: JobSourceAdapter[];
  clock: Clock;
  newId: () => string;
  config: OpennJobConfig;
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

export function loadConfig(env: Env): OpennJobConfig {
  const max = Number.parseInt(env.OPENNJOB_LLM_CRITERIA_MAX_JOBS ?? '', 10);
  const config: OpennJobConfig = {
    apiToken: (env.OPENNJOB_API_TOKEN ?? '').trim(),
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

/** Production wiring: in-memory persistence, Anthropic LLM only when a key is present. */
export function createDefaultDeps(env: Env = process.env, fetchFn: FetchLike = fetch as unknown as FetchLike): OpennJobDeps {
  const deps: OpennJobDeps = {
    repository: new InMemoryRepository(),
    usageMeter: new InMemoryUsageMeter(),
    eventBus: new InProcessEventBus(),
    sources: buildSources(env, fetchFn),
    clock: systemClock,
    newId: randomUUID,
    config: loadConfig(env),
  };
  if ((env.ANTHROPIC_API_KEY ?? '').trim()) {
    deps.llm = new AnthropicLlm({ apiKey: env.ANTHROPIC_API_KEY as string, ...(env.OPENNJOB_MODEL ? { model: env.OPENNJOB_MODEL } : {}) });
  }
  return deps;
}
