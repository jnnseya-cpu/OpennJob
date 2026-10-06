import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { FakeLlm, InMemoryRepository, InMemoryUsageMeter, InProcessEventBus, createSampleSource } from '@opennjob/core';
import type { LlmRequest, User } from '@opennjob/core';
import { signAccessToken } from '../src/auth';
import type { OpennJobConfig, OpennJobDeps } from '../src/deps';
import { createApp } from '../src/http';
import { silentLogger } from '../src/logging';

export const NOW = '2026-10-06T09:00:00.000Z';
export const JWT_SECRET = 'test-signing-secret-not-a-real-secret-0123456789';
/** The id of the account every test app starts with. */
export const USER_ID = 'dev-user';
export const USER_EMAIL = 'amara.okafor@example.org';
export const USER_PASSWORD = 'a long fictional passphrase';
/** bcrypt (cost 4) of USER_PASSWORD. Not a secret: the password is one line up. */
export const USER_PASSWORD_HASH = '$2b$04$CcK3vJhnxdkC7Hi7//VxTudrz3LJpEk6emUyD7dZVwRkYzdZJh2ke';
/** A valid access token for USER_ID at NOW. */
export const TOKEN = signAccessToken(USER_ID, JWT_SECRET, 3600, new Date(NOW)).accessToken;

/** A complete configuration for tests; pass only what a test changes. */
export function testConfig(overrides: Partial<OpennJobConfig> = {}): OpennJobConfig {
  return {
    jwtSecret: JWT_SECRET,
    jwtTtlSeconds: 3600,
    bcryptRounds: 4, // the lowest cost bcrypt allows: tests hash many passwords
    termsVersion: 'terms-test-1',
    privacyVersion: 'privacy-test-1',
    authRateLimitMax: 1000,
    authRateLimitWindowMs: 60_000,
    corsOrigins: [],
    registrationAllowlist: [],
    corsAllowAnyExtension: true,
    bodyLimit: '256kb',
    llmCriteria: false,
    llmCriteriaMaxJobs: 25,
    ...overrides,
  };
}

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

type Client = {
  get: (url: string) => request.Test;
  post: (url: string) => request.Test;
  put: (url: string) => request.Test;
  delete: (url: string) => request.Test;
};

export interface TestApp {
  app: INestApplication;
  deps: OpennJobDeps;
  /** supertest client with USER_ID's access token already set. */
  api: Client;
  /** A client for any other bearer token (another account's, an expired one, ...). */
  as: (token: string) => Client;
  /** Creates another account straight in the repository and returns a client signed in as it. */
  addUser: (id: string, email?: string) => Promise<Client>;
  raw: () => ReturnType<typeof request>;
}

export const userRecord = (id: string, email: string): User => ({
  id,
  email,
  passwordHash: USER_PASSWORD_HASH,
  createdAt: NOW,
  acceptedTermsVersion: 'terms-test-1',
  acceptedPrivacyVersion: 'privacy-test-1',
  consentAt: NOW,
});

/**
 * The real HTTP application (createApp: helmet, CORS, body limit, request log, error
 * filter) over fakes, with one account (USER_ID) already in the repository. The account
 * is created directly rather than through POST /auth/register so that the id counter and
 * the event log start clean for the test.
 */
export async function createTestApp(overrides: Partial<OpennJobDeps> = {}): Promise<TestApp> {
  let n = 0;
  const deps: OpennJobDeps = {
    repository: new InMemoryRepository(),
    persistence: 'memory',
    usageMeter: new InMemoryUsageMeter(),
    eventBus: new InProcessEventBus(),
    sources: [createSampleSource()],
    clock: () => new Date(NOW),
    newId: () => `id-${++n}`,
    config: testConfig(),
    logger: silentLogger,
    ...overrides,
  };
  await deps.repository.createUser(userRecord(USER_ID, USER_EMAIL));
  const app = await createApp(deps);
  await app.init();
  const raw = () => request(app.getHttpServer());
  const as = (token: string): Client => {
    const auth = (t: request.Test) => t.set('Authorization', `Bearer ${token}`);
    return { get: (url) => auth(raw().get(url)), post: (url) => auth(raw().post(url)), put: (url) => auth(raw().put(url)), delete: (url) => auth(raw().delete(url)) };
  };
  const tokenFor = (id: string) => (deps.config.jwtSecret ? signAccessToken(id, deps.config.jwtSecret, deps.config.jwtTtlSeconds, deps.clock()).accessToken : 'no-secret-configured');
  return {
    app,
    deps,
    raw,
    as,
    api: as(tokenFor(USER_ID)),
    addUser: async (id, email = `${id}@example.org`) => {
      await deps.repository.createUser(userRecord(id, email));
      return as(tokenFor(id));
    },
  };
}
