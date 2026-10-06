import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { FakeLlm, InMemoryRepository, InMemoryUsageMeter, InProcessEventBus, createSampleSource } from '@opennjob/core';
import type { LlmRequest } from '@opennjob/core';
import { AppModule } from '../src/app.module';
import type { OpennJobDeps } from '../src/deps';

export const TOKEN = 'test-token-not-a-secret';
export const NOW = '2026-10-06T09:00:00.000Z';

/** Fictional person. */
export const CV_TEXT = [
  'Registered nurse with five years of experience on acute medical wards.',
  'Completed medication rounds for 28 patients and acted as second checker for controlled drugs.',
  'Escalated deteriorating patients using NEWS2 observations and SBAR handover.',
  'Wrote and reviewed care plans and kept accurate records.',
  'Raised two safeguarding concerns through the trust procedure.',
  'Provided personal care to residents living with dementia.',
].join('\n');

export const PROFILE = {
  firstName: 'Amara',
  lastName: 'Okafor',
  email: 'amara.okafor@example.org',
  phone: '07700 900123',
  addressLine1: '12 Example Street',
  city: 'Birmingham',
  postcode: 'B1 1AA',
  cvText: CV_TEXT,
};

export const PASSPORT = {
  nmcPin: '18A1234E',
  dbs: { certificateNumber: '001234567890', issueDate: '2025-03-01', onUpdateService: true },
  rightToWorkConfirmed: true,
  training: [
    { name: 'Basic life support', completedOn: '2025-10-20', expiresOn: '2026-10-20' },
    { name: 'Moving and handling', completedOn: '2025-01-10', expiresOn: '2026-01-10' },
    { name: 'Fire safety', completedOn: '2026-06-01', expiresOn: '2027-06-01' },
  ],
  referees: [{ name: 'Priya Shah', relationship: 'Ward Manager', organisation: 'Northfield General Hospital (example)', email: 'priya.shah@example.org', phone: '07700 900456' }],
};

/** A FakeLlm that answers each of OpennJob's three prompt types with a canned, well-formed reply. */
export function scriptedLlm(): FakeLlm {
  return new FakeLlm((req: LlmRequest) => {
    if (req.system.includes('extract person-specification criteria')) {
      return '{"criteria":[{"label":"LLM criterion: medication","essential":true,"keywords":["medication"]},{"label":"LLM criterion: tracheostomy","essential":false,"keywords":["tracheostomy"]}],"requiresRegistration":false}';
    }
    if (req.system.includes('interviewer')) {
      return '{"situation":4,"task":3,"action":5,"result":2,"strengths":["Clear actions."],"improvements":["Say what happened in the end."]}';
    }
    return 'I am a registered nurse and have completed medication rounds for 28 patients.\n\nGAPS:\n- none';
  });
}

export interface TestApp {
  app: INestApplication;
  deps: OpennJobDeps;
  /** supertest agent factory with the bearer token already set. */
  api: {
    get: (url: string) => request.Test;
    post: (url: string) => request.Test;
    put: (url: string) => request.Test;
  };
  raw: () => ReturnType<typeof request>;
}

export async function createTestApp(overrides: Partial<OpennJobDeps> = {}): Promise<TestApp> {
  let n = 0;
  const deps: OpennJobDeps = {
    repository: new InMemoryRepository(),
    usageMeter: new InMemoryUsageMeter(),
    eventBus: new InProcessEventBus(),
    sources: [createSampleSource()],
    clock: () => new Date(NOW),
    newId: () => `id-${++n}`,
    config: { apiToken: TOKEN, llmCriteria: false, llmCriteriaMaxJobs: 25 },
    ...overrides,
  };
  const app = await NestFactory.create(AppModule.register(deps), { logger: false });
  await app.init();
  const raw = () => request(app.getHttpServer());
  const auth = (t: request.Test) => t.set('Authorization', `Bearer ${TOKEN}`);
  return {
    app,
    deps,
    raw,
    api: { get: (url) => auth(raw().get(url)), post: (url) => auth(raw().post(url)), put: (url) => auth(raw().put(url)) },
  };
}
