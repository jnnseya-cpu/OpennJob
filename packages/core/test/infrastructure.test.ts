import { describe, expect, it, vi } from 'vitest';
import {
  FakeLlm,
  InMemoryRepository,
  InMemoryUsageMeter,
  InProcessEventBus,
  computeAcu,
  meteredLlm,
} from '../src';
import type { Application, DomainEvent, Job } from '../src';
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
