import { afterEach, describe, expect, it } from 'vitest';
import { STANDING_SCOPE_VERSION, createSampleSource } from '@opennjob/core';
import type { Application } from '@opennjob/core';
import { signAccessToken } from '../src/auth';
import {
  JWT_SECRET,
  NOW,
  PASSPORT,
  PROFILE,
  PWV,
  USER_EMAIL,
  USER_ID,
  USER_PASSWORD,
  createTestApp,
  scriptedLlm,
  testConfig,
} from './helpers';
import type { TestApp } from './helpers';

/**
 * ADVERSARIAL / LAUNCH AUDIT.
 *
 * Executes attack cases against the real HTTP app (createApp): authentication bypass,
 * authorisation / IDOR between two accounts, input fuzzing on the key POST routes, the
 * "no 2xx for a failed business operation" rule, and the auth rate limiter. Read-only in
 * intent: it proves the defences hold, it does not weaken anything. Fictional data only.
 */

/** Every user-scoped route (method, concrete path) that must refuse an anonymous caller. */
const PROTECTED: [string, string][] = [
  ['DELETE', '/account'],
  ['GET', '/account'],
  ['GET', '/account/export'],
  ['GET', '/agent/authorisation'],
  ['GET', '/agent/interview-rates'],
  ['GET', '/agent/queue/next'],
  ['GET', '/agent/status'],
  ['GET', '/applications'],
  ['GET', '/applications/SOME_ID'],
  ['GET', '/applications/SOME_ID/interview'],
  ['GET', '/health/version'],
  ['GET', '/interview/questions'],
  ['GET', '/jobs/matches'],
  ['GET', '/jobs/search-plan'],
  ['GET', '/notifications'],
  ['GET', '/notifications/catalogue'],
  ['GET', '/notifications/deliveries'],
  ['GET', '/notifications/preferences'],
  ['GET', '/notifications/preview'],
  ['GET', '/passport'],
  ['GET', '/profile'],
  ['GET', '/screening'],
  ['GET', '/usage'],
  ['POST', '/account/email'],
  ['POST', '/account/password'],
  ['POST', '/account/verification'],
  ['POST', '/agent/queue/SOME_ID/go'],
  ['POST', '/agent/queue/SOME_ID/result'],
  ['POST', '/agent/run'],
  ['POST', '/applications'],
  ['POST', '/applications/SOME_ID/answer'],
  ['POST', '/applications/SOME_ID/confirm'],
  ['POST', '/applications/SOME_ID/interview/feedback'],
  ['POST', '/applications/SOME_ID/outcome'],
  ['POST', '/applications/SOME_ID/apply-url'],
  ['POST', '/applications/from-link'],
  ['POST', '/applications/SOME_ID/retry'],
  ['POST', '/applications/SOME_ID/skip'],
  ['POST', '/applications/SOME_ID/submitted'],
  ['POST', '/interview/feedback'],
  ['POST', '/jobs/refresh'],
  ['POST', '/notifications/read'],
  ['POST', '/notifications/test'],
  ['POST', '/profile/cv'],
  ['PUT', '/agent/authorisation'],
  ['PUT', '/agent/pause'],
  ['PUT', '/applications/SOME_ID/statement'],
  ['PUT', '/notifications/preferences'],
  ['PUT', '/passport'],
  ['PUT', '/screening'],
];

const sendOf = (t: TestApp, method: string, url: string) => {
  const r = t.raw();
  return method === 'GET' ? r.get(url) : method === 'PUT' ? r.put(url) : method === 'DELETE' ? r.delete(url) : r.post(url);
};

/** Fictional person B, distinct from the helper's A (a nurse). */
const B_ID = 'user-b';
const B_PROFILE = {
  firstName: 'Bola',
  lastName: 'Adeyemi',
  email: 'bola.adeyemi@example.org',
  phone: '07700 900777',
  addressLine1: '4 Sample Road',
  city: 'Leeds',
  postcode: 'LS1 1AA',
  cvText: 'Healthcare assistant with four years of experience in a care home.\nI hold the Care Certificate and give personal care with dignity.\nTrained in moving and handling.',
};
/** Strings that only exist in A's data: none may ever appear in a response to B. */
const A_SECRETS = ['Registered nurse with five years', 'Okafor', '18A1234E', '001234567890', 'Priya Shah', '12 Example Street', 'amara.okafor@example.org'];

const noStack = (body: unknown) => {
  const s = JSON.stringify(body ?? {});
  expect(s).not.toMatch(/at \w+ \(|\.ts:\d+|\.js:\d+|node_modules|TypeError|ReferenceError|ECONNREFUSED|stack/i);
};

let t: TestApp;
afterEach(async () => {
  await t?.app.close();
});

/** Build A with a profile, passport and one application, plus a signed-in B with nothing. */
async function withTwoUsers(configOverrides = {}) {
  t = await createTestApp({ llm: scriptedLlm(), sources: [createSampleSource()], config: testConfig(configOverrides) });
  await t.api.put('/profile').send(PROFILE).expect(200);
  await t.api.put('/passport').send(PASSPORT).expect(200);
  await t.api.post('/jobs/refresh').expect(200);
  const aApp = (await t.api.post('/applications').send({ jobId: 'sample:staff-nurse-medical', mode: 'hybrid' }).expect(201)).body as Application;
  const b = await t.addUser(B_ID, B_PROFILE.email);
  return { aApp, b };
}

describe('AuthN: every protected route refuses anonymous and malformed tokens', () => {
  it('no token -> 401 on every user-scoped route', async () => {
    t = await createTestApp();
    for (const [method, url] of PROTECTED) {
      const res = await sendOf(t, method, url).send(method === 'GET' || method === 'DELETE' ? undefined : {});
      expect([401], `${method} ${url} => ${res.status}`).toContain(res.status);
    }
  });

  it('garbage, tampered, alg=none and wrong-secret tokens -> 401', async () => {
    t = await createTestApp();
    const good = signAccessToken(USER_ID, JWT_SECRET, 3600, new Date(NOW), PWV).accessToken;
    const [h, p, s] = good.split('.') as [string, string, string];
    const forgedPayload = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url').toString()), sub: 'someone-else' })).toString('base64url');
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${p}.`;
    const tokens = [
      'not-a-token',
      '',
      `${good}x`,
      `${h}.${forgedPayload}.${s}`,
      none,
      signAccessToken(USER_ID, 'another-secret-another-secret-another', 3600, new Date(NOW), PWV).accessToken,
      signAccessToken(USER_ID, JWT_SECRET, 3600, new Date(NOW), 'wrongpwv00000').accessToken,
    ];
    for (const token of tokens) {
      const res = await t.as(token).get('/profile');
      expect([401], `token "${token.slice(0, 16)}" => ${res.status}`).toContain(res.status);
      // when a code is present it must mark the token bad (not, say, leak internals)
      if (res.body.code !== undefined) expect(['token_invalid', 'token_expired']).toContain(res.body.code);
      noStack(res.body);
    }
  });

  it('expired token -> 401 token_expired', async () => {
    let now = new Date(NOW);
    t = await createTestApp({ clock: () => now, config: testConfig({ jwtTtlSeconds: 60 }) });
    const token = signAccessToken(USER_ID, JWT_SECRET, 60, now, PWV).accessToken;
    await t.as(token).get('/profile').expect(404); // account alive (no profile saved), token accepted
    now = new Date(now.getTime() + 61_000);
    const res = await t.as(token).get('/profile').expect(401);
    expect(res.body.code).toBe('token_expired');
  });

  it("a deleted account's still-valid token -> 401 immediately", async () => {
    t = await createTestApp();
    const token = signAccessToken(USER_ID, JWT_SECRET, 3600, new Date(NOW), PWV).accessToken;
    await t.as(token).get('/profile').expect(404); // alive, just empty
    expect(await t.deps.repository.deleteUser(USER_ID)).toBe(true);
    const res = await t.as(token).get('/profile').expect(401);
    expect(res.body.code).toBe('token_invalid');
  });
});

describe('AuthZ / IDOR: user B cannot touch user A by putting A ids anywhere', () => {
  it("B gets 404 (not 403-with-leak) on every one of A's application routes, and A is unchanged", async () => {
    const { aApp, b } = await withTwoUsers();
    const before = (await t.api.get(`/applications/${aApp.id}`).expect(200)).body;
    const cases: [string, string, object | undefined][] = [
      ['GET', `/applications/${aApp.id}`, undefined],
      ['GET', `/applications/${aApp.id}/interview`, undefined],
      ['POST', `/applications/${aApp.id}/confirm`, { confirmedFields: ['nmcPin'] }],
      ['POST', `/applications/${aApp.id}/submitted`, { pageUrl: 'https://example.org/thanks', confirmationText: 'Received (fictional)' }],
      ['POST', `/applications/${aApp.id}/answer`, { question: 'Can you work nights?', answer: 'No' }],
      ['POST', `/applications/${aApp.id}/outcome`, { outcome: 'rejected' }],
      ['POST', `/applications/${aApp.id}/skip`, {}],
      ['POST', `/applications/${aApp.id}/retry`, {}],
      ['POST', `/applications/${aApp.id}/apply-url`, { url: 'https://example.wd3.myworkdayjobs.com/job/1' }],
      ['POST', `/applications/${aApp.id}/interview/feedback`, { questionId: 'doc-1', answer: 'By B.' }],
      ['PUT', `/applications/${aApp.id}/statement`, { statement: 'Overwritten by B.' }],
      ['POST', `/agent/queue/${aApp.id}/go`, {}],
      ['POST', `/agent/queue/${aApp.id}/result`, { outcome: 'held', reasons: ['captcha'] }],
    ];
    for (const [method, url, body] of cases) {
      const req = method === 'GET' ? b.get(url) : method === 'PUT' ? b.put(url) : b.post(url);
      const res = await (body ? req.send(body) : req.send());
      expect(res.status, `${method} ${url} => ${res.status}`).toBe(404);
      noStack(res.body);
      for (const secret of A_SECRETS) expect(JSON.stringify(res.body), `${method} ${url} leaked ${secret}`).not.toContain(secret);
    }
    expect((await t.api.get(`/applications/${aApp.id}`).expect(200)).body).toEqual(before);
  });

  it("A's id in body / query / header does not re-scope the request to A", async () => {
    const { aApp, b } = await withTwoUsers();
    await b.put('/profile').send(B_PROFILE).expect(200);
    // body injection is rejected by .strict(), not silently honoured
    await b.put('/profile').send({ ...B_PROFILE, userId: USER_ID }).expect(400);
    await b.post('/applications').send({ jobId: 'sample:hca-elderly-care', mode: 'hybrid', userId: USER_ID }).expect(400);
    await b.post('/agent/run').send({ mode: 'hybrid', userId: USER_ID }).expect(400);
    // query / header injection is ignored: the result is B's own data, never A's
    const viaQuery = await b.get(`/applications?userId=${USER_ID}`).set('X-User-Id', USER_ID).expect(200);
    expect(viaQuery.body).toEqual([]);
    const prof = await b.get(`/profile?userId=${USER_ID}`).set('X-User-Id', USER_ID).expect(200);
    expect(prof.body.email).toBe(B_PROFILE.email);
    for (const secret of A_SECRETS) expect(JSON.stringify(prof.body)).not.toContain(secret);
    const exp = await b.get(`/account/export?userId=${USER_ID}`).expect(200);
    expect(exp.body.user.id).toBe(B_ID);
    expect(JSON.stringify(exp.body)).not.toContain(aApp.id);
  });

  it("B cannot read A's profile, passport, screening, usage, notifications or authorisation", async () => {
    const { b } = await withTwoUsers();
    await t.api.put('/screening').send({ noticePeriod: '4 weeks', custom: { 'A private question': 'A private answer (fictional)' } }).expect(200);
    await t.api.put('/agent/authorisation').send({ enabled: true, scopeVersion: STANDING_SCOPE_VERSION }).expect(200);
    await b.get('/profile').expect(404);
    await b.get('/passport').expect(404);
    expect((await b.get('/screening').expect(200)).body).toEqual({ custom: {} });
    expect((await b.get('/usage').expect(200)).body.totals.calls).toBe(0);
    expect((await b.get('/notifications').expect(200)).body).toEqual({ unread: 0, items: [] });
    expect((await b.get('/agent/authorisation').expect(200)).body.enabled).toBe(false);
    for (const path of ['/profile', '/passport', '/screening', '/usage', '/account/export', '/agent/status']) {
      const res = await b.get(path);
      for (const secret of A_SECRETS) expect(JSON.stringify(res.body), `${path} leaked ${secret}`).not.toContain(secret);
    }
  });

  it("B cannot delete A's account with A's own password", async () => {
    const { b } = await withTwoUsers();
    await b.delete('/account').send({ password: USER_PASSWORD }).expect(200, { deleted: true }); // deletes B, not A
    expect(await t.deps.repository.getUserById(USER_ID)).toBeDefined();
    expect(await t.deps.repository.getUserById(B_ID)).toBeUndefined();
  });
});

describe('input fuzzing on key POST routes: 400 (or safe), never 5xx or a stack trace', () => {
  const CONSENT = { acceptedTermsVersion: 'terms-test-1', acceptedPrivacyVersion: 'privacy-test-1' };
  const INJECTION = ["'; DROP TABLE users;--", '{"$ne":null}', '<script>alert(1)</script>', '../../etc/passwd', '\u0000\u0007\u001b[31m', '${jndi:ldap://x}'];

  it('POST /auth/register: missing, null, wrong-type and extra keys -> 400, never 201', async () => {
    t = await createTestApp();
    const bad: unknown[] = [
      {},
      { email: 'a@example.org' },
      { ...CONSENT, email: 'a@example.org' },
      { ...CONSENT, email: 'not-an-email', password: 'a long fictional passphrase' },
      { ...CONSENT, email: null, password: 'a long fictional passphrase' },
      { ...CONSENT, email: 123, password: 'a long fictional passphrase' },
      { ...CONSENT, email: 'c@example.org', password: 'short' },
      { ...CONSENT, email: 'c@example.org', password: 'a long fictional passphrase', isAdmin: true },
      { ...CONSENT, email: 'c@example.org', password: 'a long fictional passphrase', id: 'chosen-id' },
      { ...CONSENT, email: 'c@example.org', password: 'a long fictional passphrase', emailVerifiedAt: NOW },
    ];
    for (const body of bad) {
      const res = await t.raw().post('/auth/register').send(body as object);
      expect([400, 403], `register ${JSON.stringify(body)} => ${res.status}`).toContain(res.status);
      noStack(res.body);
    }
    expect(await t.deps.repository.getUserByEmail('c@example.org')).toBeUndefined();
  });

  it('POST /auth/login: injection strings in email/password -> 400/401, never 200 or 5xx', async () => {
    t = await createTestApp();
    for (const payload of INJECTION) {
      const res = await t.raw().post('/auth/login').send({ email: payload, password: payload });
      expect([400, 401, 429], `login ${payload} => ${res.status}`).toContain(res.status);
      noStack(res.body);
    }
    // a wrong-type password must not throw
    const wt = await t.raw().post('/auth/login').send({ email: USER_EMAIL, password: { $ne: '' } });
    expect([400, 401]).toContain(wt.status);
    noStack(wt.body);
  });

  it('PUT /profile: injection strings are stored and returned verbatim (no XSS execution, no 5xx)', async () => {
    t = await createTestApp();
    const payloadCv = `Registered nurse. ${INJECTION.join(' ')} Five years on acute wards doing medication rounds.`;
    const saved = await t.api.put('/profile').send({ ...PROFILE, firstName: '<script>alert(1)</script>', cvText: payloadCv });
    expect(saved.status, `profile => ${saved.status}`).toBe(200);
    // stored as data, round-trips unchanged (API serves JSON; no HTML interpolation)
    expect(saved.body.firstName).toBe('<script>alert(1)</script>');
    const got = await t.api.get('/profile').expect(200);
    expect(got.body.firstName).toBe('<script>alert(1)</script>');
    noStack(got.body);
    // wrong types and oversized fields are refused, not crashed
    await t.api.put('/profile').send({ ...PROFILE, firstName: 123 }).expect(400);
    await t.api.put('/profile').send({ ...PROFILE, cvText: 'x'.repeat(50_001) }).expect(400);
    await t.api.put('/profile').send({ ...PROFILE, cvText: 'short' }).expect(400);
  });

  it('POST /applications: missing/unknown jobId and bad mode -> 400/404/422, never 201 or 5xx', async () => {
    t = await createTestApp();
    await t.api.put('/profile').send(PROFILE).expect(200);
    await t.api.put('/passport').send(PASSPORT).expect(200);
    await t.api.post('/jobs/refresh').expect(200);
    const cases: [object, number[]][] = [
      [{}, [400]],
      [{ jobId: '' }, [400]],
      [{ jobId: 'x'.repeat(201) }, [400]],
      [{ jobId: 'sample:staff-nurse-medical', mode: 'destroy' }, [400]],
      [{ jobId: 'sample:staff-nurse-medical', extra: true }, [400]],
      [{ jobId: 'no-such-job-at-all' }, [404, 422]],
      [{ jobId: "'; DROP TABLE applications;--" }, [404, 422]],
    ];
    for (const [body, allowed] of cases) {
      const res = await t.api.post('/applications').send(body);
      expect(allowed, `apply ${JSON.stringify(body)} => ${res.status}`).toContain(res.status);
      noStack(res.body);
    }
  });

  it('oversized JSON body -> 413, not 500', async () => {
    t = await createTestApp({ config: testConfig({ bodyLimit: '16kb' }) });
    const huge = { ...PROFILE, cvText: 'medication '.repeat(5000) };
    const res = await t.api.put('/profile').send(huge);
    expect([413], `oversized => ${res.status}`).toContain(res.status);
    noStack(res.body);
  });

  it('malformed JSON body -> 400, not 500', async () => {
    t = await createTestApp();
    const res = await t.api.post('/auth/logout').set('Content-Type', 'application/json').send('{ "refreshToken": ');
    expect([400]).toContain(res.status);
    noStack(res.body);
  });
});

describe('no 2xx for a failed business operation', () => {
  it("confirming / submitting a non-existent application id -> 404, not 200", async () => {
    t = await createTestApp();
    await t.api.put('/profile').send(PROFILE).expect(200);
    await t.api.post(`/applications/id-does-not-exist/confirm`).send({ confirmedFields: ['x'] }).expect(404);
    await t.api.post(`/applications/id-does-not-exist/submitted`).send({ pageUrl: 'https://example.org/t', confirmationText: 'Received (fictional)' }).expect(404);
    await t.api.put(`/applications/id-does-not-exist/statement`).send({ statement: 'hi' }).expect(404);
  });

  it("applying to a job the person is not eligible for -> 4xx, not 201", async () => {
    t = await createTestApp({ llm: scriptedLlm(), sources: [createSampleSource()] });
    await t.api.put('/profile').send(B_PROFILE).expect(200); // HCA CV, no NMC PIN
    await t.api.put('/passport').send({ rightToWorkConfirmed: false, training: [], referees: [] }).expect(200);
    await t.api.post('/jobs/refresh').expect(200);
    const res = await t.api.post('/applications').send({ jobId: 'sample:staff-nurse-medical', mode: 'hybrid' });
    expect(res.status).toBe(422);
    noStack(res.body);
  });
});

describe('auth rate limiting triggers (AuthRateLimitGuard)', () => {
  it('blocks after the configured number of attempts with 429 + Retry-After', async () => {
    t = await createTestApp({ config: testConfig({ authRateLimitMax: 3, authRateLimitWindowMs: 60_000 }) });
    for (let i = 0; i < 3; i += 1) await t.raw().post('/auth/login').send({ email: `guess${i}@example.org`, password: 'a wrong passphrase' }).expect(401);
    const blocked = await t.raw().post('/auth/login').send({ email: USER_EMAIL, password: USER_PASSWORD }).expect(429);
    expect(blocked.body).toMatchObject({ statusCode: 429, retryAfterSeconds: 60 });
    expect(blocked.headers['retry-after']).toBe('60');
    // register shares the limiter; non-auth and authenticated routes are unaffected
    await t.raw().post('/auth/register').send({ email: 'z@example.org', password: 'a long fictional passphrase', acceptedTermsVersion: 'terms-test-1', acceptedPrivacyVersion: 'privacy-test-1' }).expect(429);
    await t.raw().get('/health').expect(200);
    await t.api.get('/applications').expect(200);
  });
});
