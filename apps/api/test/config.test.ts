import { describe, expect, it } from 'vitest';
import { InMemoryRepository } from '@opennjob/core';
import type { FetchLike } from '@opennjob/core';
import { silentLogger } from '../src/logging';
import { buildSources, createDefaultDeps, loadConfig } from '../src/deps';

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
    };
    expect(loadConfig({})).toEqual(defaults);
    expect(loadConfig({ OPENNJOB_JWT_SECRET: ' abc ', OPENNJOB_LLM_CRITERIA: 'true', OPENNJOB_LLM_CRITERIA_MAX_JOBS: '3' })).toEqual({ ...defaults, jwtSecret: 'abc', llmCriteria: true, llmCriteriaMaxJobs: 3 });
    expect(loadConfig({ OPENNJOB_LLM_CRITERIA: 'maybe', OPENNJOB_LLM_CRITERIA_MAX_JOBS: 'lots' })).toMatchObject({ llmCriteria: false, llmCriteriaMaxJobs: 25 });
  });

  it('reads the owner limits (APP-6, APP-8, NFR-5) and ignores values out of range', () => {
    expect(loadConfig({ OPENNJOB_DUPLICATE_DAYS: '14', OPENNJOB_DAILY_APPLICATION_LIMIT: '5', OPENNJOB_LLM_DAILY_ACU_PER_USER: '10', OPENNJOB_LLM_DAILY_ACU_TOTAL: '0' })).toMatchObject({ duplicateDays: 14, dailyApplicationLimit: 5, llmDailyAcuPerUser: 10, llmDailyAcuTotal: 0 });
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
        OPENNJOB_SEARCH_KEYWORDS: 'healthcare assistant',
        OPENNJOB_SEARCH_LOCATION: 'Leeds',
      },
      noFetch,
    );
    expect(sources.map((s) => s.label)).toEqual(['sample (fictional demo jobs)', 'greenhouse:boardone', 'greenhouse:boardtwo', 'lever:leverco', 'ashby:ashbyco', 'adzuna', 'reed']);
  });

  it('needs both Adzuna credentials', () => {
    expect(buildSources({ ADZUNA_APP_ID: 'id' }, noFetch)).toEqual([]);
  });

  it('passes search terms and employer names through to the adapters', async () => {
    const urls: string[] = [];
    const recording: FetchLike = async (url) => {
      urls.push(url);
      return { ok: true, status: 200, json: async () => ({ jobs: [{ id: 1, title: 'Nurse', absolute_url: 'u', location: { name: 'Leeds' }, content: '' }], results: [] }) };
    };
    const sources = buildSources({ OPENNJOB_GREENHOUSE_BOARDS: 'b1:Board One Ltd', REED_API_KEY: 'k', OPENNJOB_SEARCH_KEYWORDS: 'support worker', OPENNJOB_SEARCH_LOCATION: 'Leeds' }, recording);
    const jobs = (await Promise.all(sources.map((s) => s.fetchJobs()))).flat();
    expect(jobs[0]?.employer).toBe('Board One Ltd');
    expect(urls[1]).toBe('https://www.reed.co.uk/api/1.0/search?keywords=support+worker&locationName=Leeds');
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
