import { afterEach, describe, expect, it } from 'vitest';
import { originAllowed } from '../src/http';
import { memoryLogger } from '../src/logging';
import { CV_TEXT, PASSPORT, PROFILE, USER_EMAIL, USER_ID, USER_PASSWORD, createTestApp, scriptedLlm, testConfig } from './helpers';
import type { TestApp } from './helpers';

let t: TestApp;
afterEach(async () => {
  await t?.app.close();
});

describe('security headers (helmet)', () => {
  it('are on every response, including errors, and the framework does not announce itself', async () => {
    t = await createTestApp();
    for (const res of [await t.raw().get('/health').expect(200), await t.raw().get('/profile').expect(401), await t.api.get('/profile').expect(404), await t.raw().get('/no-such-route').expect(404)]) {
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
      expect(res.headers['strict-transport-security']).toMatch(/max-age=\d+/);
      expect(res.headers['content-security-policy']).toBe("default-src 'none';frame-ancestors 'none'");
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['x-powered-by']).toBeUndefined();
      expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    }
  });
});

describe('CORS allow-list', () => {
  const preflight = (origin: string, method = 'PUT') => t.raw().options('/profile').set('Origin', origin).set('Access-Control-Request-Method', method).set('Access-Control-Request-Headers', 'authorization,content-type');

  it('answers a listed origin and no other', async () => {
    t = await createTestApp({ config: testConfig({ corsOrigins: ['https://app.example.org', 'chrome-extension://aaaabbbbccccddddeeeeffffgggghhhh'], corsAllowAnyExtension: false }) });
    const ok = await preflight('https://app.example.org').expect(204);
    expect(ok.headers['access-control-allow-origin']).toBe('https://app.example.org');
    expect(ok.headers['access-control-allow-methods']).toBe('GET,PUT,POST,DELETE');
    expect(ok.headers['access-control-allow-headers']).toBe('Authorization,Content-Type');
    expect(ok.headers['access-control-allow-credentials']).toBeUndefined();
    expect((await preflight('chrome-extension://aaaabbbbccccddddeeeeffffgggghhhh', 'DELETE')).headers['access-control-allow-origin']).toBe('chrome-extension://aaaabbbbccccddddeeeeffffgggghhhh');
    for (const origin of ['https://evil.example.com', 'https://app.example.org.evil.example.com', 'http://app.example.org', 'chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz', 'null']) {
      expect((await preflight(origin)).headers['access-control-allow-origin'], origin).toBeUndefined();
    }
    const get = await t.api.get('/applications').set('Origin', 'https://evil.example.com').expect(200);
    expect(get.headers['access-control-allow-origin']).toBeUndefined(); // the browser will not hand the reply to that page
    expect((await t.api.get('/applications').set('Origin', 'https://app.example.org')).headers['access-control-allow-origin']).toBe('https://app.example.org');
  });

  it('allows any extension origin only when configured to', async () => {
    t = await createTestApp({ config: testConfig({ corsAllowAnyExtension: true }) });
    expect((await preflight('chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz')).headers['access-control-allow-origin']).toBe('chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz');
    expect((await preflight('https://chrome-extension.example.com')).headers['access-control-allow-origin']).toBeUndefined();
  });

  it('originAllowed is the whole rule', () => {
    const strict = { corsOrigins: ['https://app.example.org'], corsAllowAnyExtension: false };
    expect(originAllowed(undefined, strict)).toBe(true); // not a browser cross-origin request
    expect(originAllowed('https://app.example.org', strict)).toBe(true);
    expect(originAllowed('https://app.example.org/', strict)).toBe(true);
    expect(originAllowed('https://other.example.org', strict)).toBe(false);
    expect(originAllowed('chrome-extension://abc', strict)).toBe(false);
    expect(originAllowed('chrome-extension://abc', { corsOrigins: [], corsAllowAnyExtension: true })).toBe(true);
  });
});

describe('request body size limit', () => {
  it('refuses a body over the limit with 413 and stores nothing', async () => {
    t = await createTestApp({ config: testConfig({ bodyLimit: '2kb' }) });
    await t.api.put('/profile').send(PROFILE).expect(200);
    const res = await t.api.put('/profile').send({ ...PROFILE, cvText: 'x'.repeat(5000) }).expect(413);
    expect(res.body).toEqual({ statusCode: 413, message: 'Request body is too large' });
    expect((await t.api.get('/profile').expect(200)).body.cvText).toBe(CV_TEXT);
    await t.raw().post('/auth/login').send({ email: USER_EMAIL, password: 'p'.repeat(5000) }).expect(413);
  });

  it('the default limit takes the largest CV the API accepts and refuses much more', async () => {
    t = await createTestApp();
    await t.api.put('/profile').send({ ...PROFILE, cvText: 'é'.repeat(50_000) }).expect(200);
    await t.api.put('/profile').send({ ...PROFILE, cvText: 'x'.repeat(300_000) }).expect(413);
  });

  it('replies 400, not 500, to a body that is not JSON, and stores nothing', async () => {
    t = await createTestApp();
    const res = await t.api.put('/profile').set('Content-Type', 'application/json').send('{"firstName": "Amara", "cvText": "Registered nurse').expect(400);
    expect(res.body.statusCode).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain('Registered nurse');
    await t.api.get('/profile').expect(404); // nothing was stored
  });
});

describe('structured request logging', () => {
  it('writes one line per request: id, method, path, status, duration, user id', async () => {
    const logger = memoryLogger();
    t = await createTestApp({ logger });
    await t.api.get('/applications?userId=someone&note=Registered%20nurse').expect(200);
    await t.raw().get('/profile').expect(401);
    await t.raw().get('/health').expect(200);
    expect(logger.lines).toHaveLength(3);
    expect(logger.lines[0]).toEqual({ level: 'info', msg: 'request', requestId: expect.stringMatching(/^[0-9a-f-]{36}$/), method: 'GET', path: '/applications', status: 200, durationMs: expect.any(Number), userId: USER_ID });
    expect(logger.lines[1]).toMatchObject({ method: 'GET', path: '/profile', status: 401, userId: null });
    expect(logger.lines[2]).toMatchObject({ path: '/health', status: 200, userId: null });
  });

  it('never logs CV text, passport values, statements, passwords, tokens or email addresses', async () => {
    const logger = memoryLogger();
    t = await createTestApp({ logger, llm: scriptedLlm() });
    const login = await t.raw().post('/auth/login').send({ email: USER_EMAIL, password: USER_PASSWORD }).expect(200);
    const token = login.body.accessToken as string;
    await t.raw().post('/auth/login').send({ email: USER_EMAIL, password: 'a wrong passphrase 123' }).expect(401);
    await t.raw().post('/auth/register').send({ email: 'bola.adeyemi@example.org', password: 'seven green kettles on a shelf', acceptedTermsVersion: 'terms-test-1', acceptedPrivacyVersion: 'privacy-test-1' }).expect(201);
    await t.api.put('/profile').send(PROFILE).expect(200);
    await t.api.put('/profile').send({ ...PROFILE, cvText: 'short', email: 'broken' }).expect(400); // a validation failure
    await t.api.get('/profile').expect(200);
    await t.api.put('/passport').send(PASSPORT).expect(200);
    await t.api.put('/passport').send({ ...PASSPORT, nmcPin: '18A1234E-not-valid' }).expect(400);
    await t.api.get('/passport').expect(200);
    await t.api.post('/jobs/refresh').expect(200);
    await t.api.get('/jobs/matches').expect(200);
    const application = (await t.api.post('/applications').send({ jobId: 'sample:staff-nurse-medical', mode: 'hybrid' }).expect(201)).body;
    await t.api.post('/agent/run').send({}).expect(200);
    await t.api.get('/applications').expect(200);
    await t.api.get(`/applications/${application.id}`).expect(200);
    await t.api.put(`/applications/${application.id}/statement`).send({ statement: 'My edited statement about medication rounds and SBAR handovers.' }).expect(200);
    await t.api.post(`/applications/${application.id}/confirm`).send({ confirmedFields: ['nmcPin'] }).expect(200);
    await t.api.post(`/applications/${application.id}/submitted`).expect(200);
    await t.api.post('/interview/feedback').send({ question: 'Tell me about a time you escalated a concern.', answer: 'A patient deteriorated and I escalated using NEWS2 and SBAR.' }).expect(200);
    await t.api.get('/usage').expect(200);
    await t.api.get('/account/export').expect(200);
    await t.api.put('/profile').set('Content-Type', 'application/json').send('{"cvText": "Registered nurse with five years').expect(400);
    await t.api.delete('/account').send({ password: USER_PASSWORD }).expect(200);

    expect(logger.lines.length).toBeGreaterThanOrEqual(23);
    const everything = JSON.stringify(logger.lines);
    const forbidden = [
      ...CV_TEXT.split('\n'),
      'Registered nurse',
      'medication rounds',
      'SBAR handovers',
      application.statement as string,
      'Okafor',
      'Amara',
      '12 Example Street',
      'B1 1AA',
      '07700 900123',
      '18A1234E',
      '001234567890',
      'Priya Shah',
      'priya.shah@example.org',
      'Basic life support',
      'Northfield',
      USER_EMAIL,
      'bola.adeyemi@example.org',
      USER_PASSWORD,
      'a wrong passphrase 123',
      'seven green kettles',
      token,
      token.split('.')[2] as string,
      'Bearer',
      'escalated using NEWS2',
    ];
    for (const secret of forbidden) expect(everything, secret.slice(0, 40)).not.toContain(secret);
    // Only these fields are ever written. event and channel come from the notification engine (catalogue key and channel name).
    const keys = new Set(logger.lines.flatMap((l) => Object.keys(l)));
    expect([...keys].sort()).toEqual(['channel', 'durationMs', 'event', 'level', 'method', 'msg', 'path', 'requestId', 'status', 'userId']);
  });

  it('logs an unexpected error by type and code only, and replies 500 without detail', async () => {
    const logger = memoryLogger();
    t = await createTestApp({ logger });
    await t.api.put('/profile').send(PROFILE).expect(200);
    // A database failure whose message quotes personal data, as real driver errors can.
    t.deps.repository.getProfile = async () => {
      throw Object.assign(new Error(`invalid input syntax: "${CV_TEXT}" for amara.okafor@example.org`), { name: 'DatabaseError', code: '22P02' });
    };
    const res = await t.api.get('/profile').expect(500);
    expect(res.body).toEqual({ statusCode: 500, message: 'Internal server error' });
    const errors = logger.lines.filter((l) => l.level === 'error');
    expect(errors).toEqual([{ level: 'error', msg: 'unhandled error', requestId: expect.any(String), errorName: 'DatabaseError', errorCode: '22P02' }]);
    expect(JSON.stringify(logger.lines)).not.toContain('Registered nurse');
    expect(JSON.stringify(logger.lines)).not.toContain('amara.okafor');
    expect(logger.lines.find((l) => l.msg === 'request' && l.status === 500)).toMatchObject({ path: '/profile', requestId: errors[0]?.requestId });
  });
});

describe('GET /health', () => {
  it('reports the store and its connectivity, and 503 when the store cannot be reached', async () => {
    t = await createTestApp();
    await t.raw().get('/health').expect(200, { status: 'ok', persistence: 'memory', database: 'up' });
    t.deps.repository.ping = async () => {
      throw new Error('connection refused');
    };
    await t.raw().get('/health').expect(503, { status: 'degraded', persistence: 'memory', database: 'down' });
  });
});
