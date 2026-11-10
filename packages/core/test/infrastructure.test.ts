import { describe, expect, it, vi } from 'vitest';
import {
  AnthropicLlm,
  FakeLlm,
  InMemoryRepository,
  InMemoryUsageMeter,
  InProcessEventBus,
  DEFAULT_MODEL,
  LlmRefusalError,
  THINKING_HEADROOM_TOKENS,
  computeAcu,
  meteredLlm,
} from '../src';
import type { AnthropicMessagesClient, Application, DomainEvent, Job } from '../src';
import { PASSPORT, PROFILE } from './fixtures/cv';

describe('FakeLlm', () => {
  it('is deterministic and records calls', async () => {
    const llm = new FakeLlm((r) => `reply to ${r.prompt}`);
    const a = await llm.complete({ system: 'sys', prompt: 'hello', maxTokens: 10 });
    const b = await llm.complete({ system: 'sys', prompt: 'hello', maxTokens: 10 });
    expect(a).toEqual(b);
    expect(a).toEqual({ text: 'reply to hello', inputTokens: 2, outputTokens: 4 });
    expect(llm.calls).toHaveLength(2);
  });
});

describe('AnthropicLlm (stub client, no network)', () => {
  const stub = (reply: { stop_reason?: string } = {}) => {
    const create = vi.fn(async () => ({
      content: [{ type: 'thinking' }, { type: 'text', text: 'Hello ' }, { type: 'tool_use' }, { type: 'text', text: 'world' }],
      stop_reason: reply.stop_reason ?? 'end_turn',
      usage: { input_tokens: 12, output_tokens: 3 },
    }));
    return { client: { beta: { messages: { create } } } as unknown as AnthropicMessagesClient, create };
  };

  it('sends the prompt with room for thinking, an explicit effort and the refusal fallback; returns only the text', async () => {
    const { client, create } = stub();
    const llm = new AnthropicLlm({ client, model: 'claude-opus-5-5' });
    const res = await llm.complete({ system: 'SYS', prompt: 'PROMPT', maxTokens: 900 });
    expect(create).toHaveBeenCalledWith({
      model: 'claude-opus-5-5',
      max_tokens: 900 + THINKING_HEADROOM_TOKENS,
      system: 'SYS',
      messages: [{ role: 'user', content: 'PROMPT' }],
      output_config: { effort: 'medium' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
    expect(res).toEqual({ text: 'Hello world', inputTokens: 12, outputTokens: 3 });
  });

  it('sends no fallback for a model that does not take it', async () => {
    const { client, create } = stub();
    await new AnthropicLlm({ client, model: 'claude-haiku-4-5', effort: 'low' }).complete({ system: 'S', prompt: 'P', maxTokens: 10 });
    const body = (create.mock.calls[0] as unknown[] | undefined)?.[0] as Record<string, unknown>;
    expect(body).toMatchObject({ model: 'claude-haiku-4-5', output_config: { effort: 'low' } });
    expect(body).not.toHaveProperty('fallbacks');
    expect(body).not.toHaveProperty('betas');
  });

  it('a refusal is an error with no content in it, so callers use the no-AI path', async () => {
    const { client } = stub({ stop_reason: 'refusal' });
    const err = await new AnthropicLlm({ client }).complete({ system: 'S', prompt: 'P', maxTokens: 10 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmRefusalError);
    expect((err as Error).message).toBe('The AI model declined this request');
  });

  it('reads the model and effort from OPENNJOB_MODEL and OPENNJOB_LLM_EFFORT', () => {
    vi.stubEnv('OPENNJOB_MODEL', 'model-from-env');
    vi.stubEnv('OPENNJOB_LLM_EFFORT', 'high');
    try {
      const llm = new AnthropicLlm({ client: stub().client });
      expect(llm.model).toBe('model-from-env');
      expect(llm.effort).toBe('high');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('defaults to Claude Opus 5.5 at medium effort; a bad effort value warns and uses medium', () => {
    vi.stubEnv('OPENNJOB_MODEL', '');
    vi.stubEnv('OPENNJOB_LLM_EFFORT', 'extreme');
    try {
      const warn = vi.fn();
      const llm = new AnthropicLlm({ client: stub().client, warn });
      expect(DEFAULT_MODEL).toBe('claude-opus-5-5');
      expect(llm.model).toBe(DEFAULT_MODEL);
      expect(llm.effort).toBe('medium');
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('usage metering', () => {
  it('computes ACU as tokens / 1000', () => {
    expect(computeAcu(0, 0)).toBe(0);
    expect(computeAcu(1500, 500)).toBe(2);
    expect(computeAcu(1234, 1)).toBe(1.235);
  });

  it('records one entry per LLM call with user, purpose, tokens and ACU', async () => {
    const meter = new InMemoryUsageMeter();
    const clock = () => new Date('2026-10-06T09:00:00Z');
    const llm = meteredLlm(new FakeLlm(() => 'x'.repeat(400)), meter, { userId: 'u1', purpose: 'statement' }, clock);
    await llm.complete({ system: 's'.repeat(400), prompt: 'p'.repeat(3600), maxTokens: 100 });
    await llm.complete({ system: '', prompt: 'p'.repeat(4000), maxTokens: 100 });
    expect(await meter.list('u1')).toEqual([
      { userId: 'u1', purpose: 'statement', inputTokens: 1000, outputTokens: 100, acu: 1.1, at: '2026-10-06T09:00:00.000Z' },
      { userId: 'u1', purpose: 'statement', inputTokens: 1000, outputTokens: 100, acu: 1.1, at: '2026-10-06T09:00:00.000Z' },
    ]);
    expect(await meter.totals('u1')).toEqual({ calls: 2, inputTokens: 2000, outputTokens: 200, acu: 2.2 });
    expect(await meter.totals('someone-else')).toEqual({ calls: 0, inputTokens: 0, outputTokens: 0, acu: 0 });
  });

  it('does not record usage when the LLM call fails', async () => {
    const meter = new InMemoryUsageMeter();
    const llm = meteredLlm({ complete: async () => { throw new Error('down'); } }, meter, { userId: 'u1', purpose: 'x' });
    await expect(llm.complete({ system: '', prompt: '', maxTokens: 1 })).rejects.toThrow('down');
    expect((await meter.totals('u1')).calls).toBe(0);
  });
});

describe('InProcessEventBus', () => {
  const event = (type: string): DomainEvent => ({ id: '1', type, userId: 'u', occurredAt: '2026-10-06T00:00:00.000Z', payload: {} });

  it('delivers to type subscribers and wildcard subscribers, in order, and supports unsubscribe', async () => {
    const bus = new InProcessEventBus();
    const seen: string[] = [];
    const off = bus.subscribe('application.drafted', (e) => { seen.push(`typed:${e.type}`); });
    bus.subscribe('*', async (e) => { seen.push(`all:${e.type}`); });
    await bus.publish(event('application.drafted'));
    await bus.publish(event('profile.updated'));
    off();
    await bus.publish(event('application.drafted'));
    expect(seen).toEqual(['typed:application.drafted', 'all:application.drafted', 'all:profile.updated', 'all:application.drafted']);
  });
});

describe('InMemoryRepository', () => {
  const job: Job = { id: 'sample:1', source: 'sample', externalId: '1', title: 'Nurse', employer: 'E', location: 'L', url: 'u', description: 'd', criteria: [], criteriaSource: 'fallback', requiresRegistration: false };
  const app: Application = { id: 'a1', userId: 'u1', jobId: 'sample:1', jobTitle: 'Nurse', employer: 'E', applyUrl: 'u', mode: 'hybrid', status: 'draft', statement: 's', statementSource: 'fallback', gaps: [], warnings: [], score: 50, confirmedFields: [], createdAt: '2026-10-06T00:00:00.000Z' };

  it('stores profiles and passports per user and returns copies', async () => {
    const repo = new InMemoryRepository();
    expect(await repo.getProfile('u1')).toBeUndefined();
    await repo.saveProfile('u1', PROFILE);
    await repo.savePassport('u1', PASSPORT);
    const p = await repo.getProfile('u1');
    expect(p).toEqual(PROFILE);
    (p as { firstName: string }).firstName = 'Mutated';
    expect((await repo.getProfile('u1'))?.firstName).toBe('Amara');
    expect(await repo.getPassport('u1')).toEqual(PASSPORT);
    expect(await repo.getPassport('u2')).toBeUndefined();
  });

  it('upserts jobs by id and counts only new ones', async () => {
    const repo = new InMemoryRepository();
    expect(await repo.upsertJobs([job, { ...job, id: 'sample:2' }])).toBe(2);
    expect(await repo.upsertJobs([{ ...job, title: 'Senior Nurse' }])).toBe(0);
    expect(await repo.listJobs()).toHaveLength(2);
    expect((await repo.getJob('sample:1'))?.title).toBe('Senior Nurse');
  });

  it('scopes applications and events to their user', async () => {
    const repo = new InMemoryRepository();
    await repo.createApplication(app);
    await expect(repo.createApplication(app)).rejects.toThrow(/already exists/);
    expect(await repo.getApplication('u1', 'a1')).toEqual(app);
    expect(await repo.getApplication('u2', 'a1')).toBeUndefined();
    await repo.updateApplication({ ...app, status: 'submitted' });
    expect((await repo.listApplications('u1'))[0]?.status).toBe('submitted');
    expect(await repo.listApplications('u2')).toEqual([]);
    await expect(repo.updateApplication({ ...app, id: 'missing' })).rejects.toThrow(/not found/);
    await repo.appendEvent({ id: 'e1', type: 't', userId: 'u1', occurredAt: 'now', payload: {} });
    expect(await repo.listEvents('u1')).toHaveLength(1);
    expect(await repo.listEvents('u2')).toHaveLength(0);
  });
});
