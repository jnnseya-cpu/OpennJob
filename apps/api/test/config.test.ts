import { describe, expect, it } from 'vitest';
import { InMemoryRepository } from '@opennjob/core';
import type { FetchLike } from '@opennjob/core';
import { silentLogger } from '../src/logging';
import { buildSearchSources, buildSources, createDefaultDeps, loadConfig } from '../src/deps';

const noFetch: FetchLike = async () => { throw new Error('tests must not make live calls'); };

describe('loadConfig', () => {
  it('reads the signing secret and flags, with safe defaults', () => {
    const defaults = {
      jwtSecret: '',
      jwtTtlSeconds: 3600,
      bcryptRounds: 12,
      termsVersion: 'draft-1',
      privacyVersion: 'draft-1',
      authRateLimitMax: 10,
      authRateLimitWindowMs: 900_000,
      corsOrigins: [],
      registrationAllowlist: [],
      corsAllowAnyExtension: true,
      bodyLimit: '256kb',
      llmCriteria: false,
      llmCriteriaMaxJobs: 25,
      duplicateDays: 30,
      dailyApplicationLimit: 20,
      llmDailyAcuPerUser: 50,
      llmDailyAcuTotal: 500,
      searchMaxQueriesPerUser: 6,
      searchMaxQueriesPerRefresh: 60,
    };
    expect(loadConfig({})).toEqual(defaults);
    expect(loadConfig({ OPENNJOB_JWT_SECRET: ' abc ', OPENNJOB_LLM_CRITERIA: 'true', OPENNJOB_LLM_CRITERIA_MAX_JOBS: '3' })).toEqual({ ...defaults, jwtSecret: 'abc', llmCriteria: true, llmCriteriaMaxJobs: 3 });
    expect(loadConfig({ OPENNJOB_LLM_CRITERIA: 'maybe', OPENNJOB_LLM_CRITERIA_MAX_JOBS: 'lots' })).toMatchObject({ llmCriteria: false, llmCriteriaMaxJobs: 25 });
  });

  it('reads the owner limits (APP-6, APP-8, NFR-5) and ignores values out of range', () => {
    expect(loadConfig({ OPENNJOB_DUPLICATE_DAYS: '14', OPENNJOB_DAILY_APPLICATION_LIMIT: '5', OPENNJOB_LLM_DAILY_ACU_PER_USER: '10', OPENNJOB_LLM_DAILY_ACU_TOTAL: '0' })).toMatchObject({ duplicateDays: 14, dailyApplicationLimit: 5, llmDailyAcuPerUser: 10, llmDailyAcuTotal: 0 });
    // "unlimited" removes the AI ceiling and the per-refresh cap on AI-read adverts (owner's choice).
    expect(loadConfig({ OPENNJOB_LLM_DAILY_ACU_PER_USER: 'unlimited', OPENNJOB_LLM_DAILY_ACU_TOTAL: 'off', OPENNJOB_LLM_CRITERIA_MAX_JOBS: 'unlimited' })).toMatchObject({
      llmDailyAcuPerUser: Number.POSITIVE_INFINITY,
      llmDailyAcuTotal: Number.POSITIVE_INFINITY,
      llmCriteriaMaxJobs: Number.POSITIVE_INFINITY,
    });
    expect(loadConfig({ OPENNJOB_DUPLICATE_DAYS: '0', OPENNJOB_DAILY_APPLICATION_LIMIT: 'many', OPENNJOB_LLM_DAILY_ACU_PER_USER: '-1' })).toMatchObject({ duplicateDays: 30, dailyApplicationLimit: 20, llmDailyAcuPerUser: 50 });
  });
});

describe('buildSources', () => {
  it('configures nothing by default', () => {
    expect(buildSources({}, noFetch)).toEqual([]);
  });

  it('builds one adapter per configured board or key', () => {
    const sources = buildSources(
      {
        OPENNJOB_DEMO_JOBS: 'true',
        OPENNJOB_GREENHOUSE_BOARDS: 'boardone:Board One Ltd, boardtwo',
        OPENNJOB_LEVER_COMPANIES: 'leverco',
        OPENNJOB_ASHBY_BOARDS: 'ashbyco:Ashby Co',
        ADZUNA_APP_ID: 'id',
        ADZUNA_APP_KEY: 'key',
        REED_API_KEY: 'reed',
      },
      noFetch,
    );
    // Adzuna and Reed are asked per person (buildSearchSources), not listed here.
    expect(sources.map((s) => s.label)).toEqual(['sample (fictional demo jobs)', 'greenhouse:boardone', 'greenhouse:boardtwo', 'lever:leverco', 'ashby:ashbyco']);
  });

  it('passes employer names through to the board adapters', async () => {
    const recording: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({ jobs: [{ id: 1, title: 'Nurse', absolute_url: 'u', location: { name: 'Leeds' }, content: '' }] }) });
    const jobs = (await Promise.all(buildSources({ OPENNJOB_GREENHOUSE_BOARDS: 'b1:Board One Ltd' }, recording).map((s) => s.fetchJobs()))).flat();
    expect(jobs[0]?.employer).toBe('Board One Ltd');
  });
});

describe('buildSearchSources: the job-search APIs take only keys; what they are asked comes from each person', () => {
  it('needs both Adzuna credentials; Reed needs its key', () => {
    expect(buildSearchSources({}, noFetch)).toEqual([]);
    expect(buildSearchSources({ ADZUNA_APP_ID: 'id' }, noFetch)).toEqual([]);
    expect(buildSearchSources({ ADZUNA_APP_ID: 'id', ADZUNA_APP_KEY: 'key', REED_API_KEY: 'k' }, noFetch).map((s) => s.label)).toEqual(['adzuna', 'reed']);
    // ReliefWeb and Jooble only when configured.
    expect(buildSearchSources({ OPENNJOB_RELIEFWEB_APPNAME: 'approved-name', JOOBLE_API_KEY: 'k' }, noFetch).map((s) => s.label)).toEqual(['reliefweb', 'jooble']);
    expect(buildSearchSources({ OPENNJOB_RELIEFWEB_APPNAME: '  ', JOOBLE_API_KEY: '' }, noFetch)).toEqual([]);
  });

  it('ignores the old server-wide search settings: the query is the one it is given', async () => {
    const urls: string[] = [];
    const recording: FetchLike = async (url) => (urls.push(url), { ok: true, status: 200, json: async () => ({ results: [] }) });
    const [adzuna, reed] = buildSearchSources({ ADZUNA_APP_ID: 'id', ADZUNA_APP_KEY: 'key', REED_API_KEY: 'k', OPENNJOB_SEARCH_KEYWORDS: 'nurse', OPENNJOB_SEARCH_LOCATION: 'Leeds' }, recording);
    await adzuna?.search({ what: 'site manager', where: 'Lyon', country: 'FR' });
    await reed?.search({ what: 'site manager', where: 'London', country: 'GB' });
    await reed?.search({ what: 'site manager', country: 'FR' }); // Reed is UK only: not asked
    expect(urls).toEqual([
      'https://api.adzuna.com/v1/api/jobs/fr/search/1?app_id=id&app_key=key&results_per_page=50&what_phrase=site+manager&where=Lyon',
      'https://www.reed.co.uk/api/1.0/search?keywords=site+manager&resultsToTake=100&locationName=London',
    ]);
  });
});

describe('createDefaultDeps', () => {
  it('has no LLM without an API key and uses in-memory persistence', () => {
    const deps = createDefaultDeps({ OPENNJOB_JWT_SECRET: 't' }, noFetch, silentLogger);
    expect(deps.llm).toBeUndefined();
    expect(deps.config.jwtSecret).toBe('t');
    expect(deps.persistence).toBe('memory');
    expect(deps.repository).toBeInstanceOf(InMemoryRepository);
    expect(deps.sources).toEqual([]);
  });

  it('configures the Anthropic LLM when a key and model are present (no call is made)', () => {
    const deps = createDefaultDeps({ OPENNJOB_JWT_SECRET: 't', ANTHROPIC_API_KEY: 'sk-test-not-real', OPENNJOB_MODEL: 'some-model' }, noFetch, silentLogger);
    expect((deps.llm as { model?: string } | undefined)?.model).toBe('some-model');
  });
});
