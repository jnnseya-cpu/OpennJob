import jwt from 'jsonwebtoken';
import { afterEach, describe, expect, it } from 'vitest';
import { PASSWORD_MAX_BYTES, RateLimiter, hashPassword, passwordProblems, signAccessToken, verifyAccessToken, verifyPassword } from '../src/auth';
import { MIN_JWT_SECRET_LENGTH, createDefaultDeps, loadConfig, startupProblems } from '../src/deps';
import { memoryLogger } from '../src/logging';
import { JWT_SECRET, NOW, PROFILE, PWV, USER_EMAIL, USER_ID, USER_PASSWORD, createTestApp, testConfig } from './helpers';
import type { TestApp } from './helpers';

let t: TestApp;
afterEach(async () => {
  await t?.app.close();
});

/** Fictional. */
const EMAIL = 'bola.adeyemi@example.org';
const PASSWORD = 'seven green kettles on a shelf';
const CONSENT = { acceptedTermsVersion: 'terms-test-1', acceptedPrivacyVersion: 'privacy-test-1' };
const registration = (overrides: object = {}) => ({ email: EMAIL, password: PASSWORD, ...CONSENT, ...overrides });

describe('password rules', () => {
  it('accepts a long passphrase and names each problem with a weak one', () => {
    expect(passwordProblems(PASSWORD, EMAIL)).toEqual([]);
    expect(passwordProblems('Tr0ub4dor&3x!')).toEqual([]);
    expect(passwordProblems('short')).toEqual(['must be at least 12 characters']);
    expect(passwordProblems('aaaaaaaaaaaaaaaa')).toEqual(['must use at least 5 different characters']);
    expect(passwordProblems('Password1234')).toEqual(['is too common']);
    expect(passwordProblems('bola.adeyemi-2026', EMAIL)).toEqual(['must not contain your email address']);
    expect(passwordProblems(EMAIL.toUpperCase(), EMAIL)).toEqual(['must not contain your email address']);
    expect(passwordProblems('x'.repeat(PASSWORD_MAX_BYTES + 1) + 'abcde')).toContain('must be at most 72 bytes');
    // 72 bytes, not 72 characters: bcrypt would silently ignore the rest.
    expect(passwordProblems('é'.repeat(37) + 'abcd')).toContain('must be at most 72 bytes');
    expect(passwordProblems('abcdefghijk\u{1F642}')).toEqual([]); // 12 characters, one of them an emoji
  });

  it('hashes with bcrypt: salted, one-way, verifiable', async () => {
    const one = await hashPassword(PASSWORD, 4);
    const two = await hashPassword(PASSWORD, 4);
    expect(one).toMatch(/^\$2[aby]\$04\$/);
    expect(one).not.toBe(two);
    expect(one).not.toContain(PASSWORD);
    expect(await verifyPassword(PASSWORD, one)).toBe(true);
    expect(await verifyPassword(`${PASSWORD} `, one)).toBe(false);
    expect((await hashPassword(PASSWORD, 12)).startsWith('$2b$12$')).toBe(true);
  });
});

describe('access tokens', () => {
  const now = new Date(NOW);

  it('signs an HS256 token for one user that verifies until it expires', () => {
    const token = signAccessToken('user-1', JWT_SECRET, 600, now, PWV);
    expect(token).toMatchObject({ tokenType: 'Bearer', expiresIn: 600, expiresAt: '2026-10-06T09:10:00.000Z' });
    expect(jwt.decode(token.accessToken, { complete: true })).toMatchObject({ header: { alg: 'HS256' }, payload: { sub: 'user-1', iss: 'opennjob', aud: 'opennjob-api' } });
    expect(verifyAccessToken(token.accessToken, JWT_SECRET, now)).toEqual({ ok: true, userId: 'user-1', pwv: PWV });
    expect(verifyAccessToken(token.accessToken, JWT_SECRET, new Date(now.getTime() + 599_000))).toEqual({ ok: true, userId: 'user-1', pwv: PWV });
    expect(verifyAccessToken(token.accessToken, JWT_SECRET, new Date(now.getTime() + 601_000))).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects a token signed with another secret, altered, unsigned, or made for something else', () => {
    const at = Math.floor(now.getTime() / 1000);
    const good = signAccessToken('user-1', JWT_SECRET, 600, now, PWV).accessToken;
    const [h, p, s] = good.split('.') as [string, string, string];
    const forgedPayload = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url').toString()), sub: 'user-2' })).toString('base64url');
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${p}.`;
    const bad = [
      signAccessToken('user-1', 'another-secret-another-secret-another', 600, now, PWV).accessToken,
      `${h}.${forgedPayload}.${s}`,
      none,
      jwt.sign({ sub: 'user-1', iat: at, exp: at + 600 }, JWT_SECRET, { algorithm: 'HS256' }), // no issuer or audience
      jwt.sign({ sub: 'user-1', iat: at, exp: at + 600 }, JWT_SECRET, { algorithm: 'HS256', issuer: 'opennjob', audience: 'something-else' }),
      jwt.sign({ iat: at, exp: at + 600 }, JWT_SECRET, { algorithm: 'HS256', issuer: 'opennjob', audience: 'opennjob-api' }), // no subject
      jwt.sign({ sub: 'user-1', iat: at, exp: at + 600 }, JWT_SECRET, { algorithm: 'HS512', issuer: 'opennjob', audience: 'opennjob-api' }),
      'not-a-token',
      '',
    ];
    for (const token of bad) expect(verifyAccessToken(token, JWT_SECRET, now), token.slice(0, 30)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('cannot be signed without a secret', () => {
    expect(() => signAccessToken('user-1', '', 600, now, PWV)).toThrow(/OPENNJOB_JWT_SECRET is not configured/);
  });
});

describe('RateLimiter', () => {
  it('allows max attempts per key per window, then blocks until the window ends', () => {
    let now = 1_000_000;
    const limiter = new RateLimiter(3, 60_000, () => now);
    expect([1, 2, 3].map(() => limiter.take('a').allowed)).toEqual([true, true, true]);
    expect(limiter.take('a')).toEqual({ allowed: false, retryAfterSeconds: 60 });
    expect(limiter.take('b').allowed).toBe(true); // another key is unaffected
    now += 59_000;
    expect(limiter.take('a')).toEqual({ allowed: false, retryAfterSeconds: 1 });
    now += 1_000;
    expect(limiter.take('a').allowed).toBe(true);
  });
});

describe('POST /auth/register', () => {
  it('creates an account, records consent with a timestamp, and returns a working token', async () => {
    t = await createTestApp();
    await t.raw().get('/auth/versions').expect(200, { termsVersion: 'terms-test-1', privacyVersion: 'privacy-test-1', registration: 'open' });
    const res = await t.raw().post('/auth/register').send(registration({ email: '  Bola.Adeyemi@Example.org ' })).expect(201);
    expect(res.body).toEqual({
      user: { id: 'id-1', email: EMAIL, createdAt: NOW, emailVerified: false, consent: { acceptedTermsVersion: 'terms-test-1', acceptedPrivacyVersion: 'privacy-test-1', acceptedAt: NOW } },
      accessToken: expect.any(String),
      tokenType: 'Bearer',
      expiresIn: 3600,
      expiresAt: '2026-10-06T10:00:00.000Z',
    });
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|\$2b\$/);

    const stored = await t.deps.repository.getUserById('id-1');
    expect(stored).toMatchObject({ email: EMAIL, acceptedTermsVersion: 'terms-test-1', acceptedPrivacyVersion: 'privacy-test-1', consentAt: NOW });
    expect(stored?.passwordHash).toMatch(/^\$2b\$04\$/);
    expect(await verifyPassword(PASSWORD, stored?.passwordHash as string)).toBe(true);

    const mine = t.as(res.body.accessToken);
    await mine.get('/account').expect(200, res.body.user);
    await mine.get('/profile').expect(404); // a new account starts empty: it does not see the first user's data
    // ACC-2: registration sends the verification e-mail. The event carries no token.
    expect((await t.deps.repository.listEvents('id-1')).map((e) => [e.type, e.payload])).toEqual([['account.registered', { termsVersion: 'terms-test-1', privacyVersion: 'privacy-test-1' }], ['auth.verification_sent', {}]]);
  });

  it('invite-only pilot: only listed addresses may register; others get 403 and no account; sign-in is unaffected', async () => {
    t = await createTestApp({ config: testConfig({ registrationAllowlist: ['bola.adeyemi@example.org'] }) });
    await t.raw().get('/auth/versions').expect(200, { termsVersion: 'terms-test-1', privacyVersion: 'privacy-test-1', registration: 'invite' });
    const refused = await t.raw().post('/auth/register').send(registration({ email: 'chidi.eze@example.org' })).expect(403);
    expect(refused.body.message).toBe('Registration is by invitation only during the pilot');
    expect(await t.deps.repository.getUserByEmail('chidi.eze@example.org')).toBeUndefined();
    // The invited address, in any case and with spaces, is accepted.
    await t.raw().post('/auth/register').send(registration({ email: '  Bola.Adeyemi@Example.org ' })).expect(201);
    // The existing account (made before the allow-list) still signs in.
    await t.raw().post('/auth/login').send({ email: USER_EMAIL, password: USER_PASSWORD }).expect(200);
  });

  it('reading the versions does not count towards the sign-in rate limit', async () => {
    t = await createTestApp({ config: testConfig({ authRateLimitMax: 2 }) });
    for (let i = 0; i < 10; i += 1) await t.raw().get('/auth/versions').expect(200);
    await t.raw().post('/auth/login').send({ email: USER_EMAIL, password: USER_PASSWORD }).expect(200);
    await t.raw().post('/auth/login').send({ email: USER_EMAIL, password: USER_PASSWORD }).expect(200);
    await t.raw().post('/auth/login').send({ email: USER_EMAIL, password: USER_PASSWORD }).expect(429);
  });

  it('reads OPENNJOB_REGISTRATION_ALLOWLIST as lower-case addresses; empty means open', () => {
    expect(loadConfig({ OPENNJOB_REGISTRATION_ALLOWLIST: ' Bola.Adeyemi@Example.org , x@example.org ' }).registrationAllowlist).toEqual(['bola.adeyemi@example.org', 'x@example.org']);
    expect(loadConfig({}).registrationAllowlist).toEqual([]);
  });

  it('requires acceptedTermsVersion and acceptedPrivacyVersion, and they must be the current versions', async () => {
    t = await createTestApp();
    for (const missing of ['acceptedTermsVersion', 'acceptedPrivacyVersion']) {
      const body: Record<string, unknown> = registration();
      delete body[missing];
      const res = await t.raw().post('/auth/register').send(body).expect(400);
      expect(res.body.issues.map((i: { path: string }) => i.path)).toEqual([missing]);
    }
    await t.raw().post('/auth/register').send(registration({ acceptedTermsVersion: '' })).expect(400);
    await t.raw().post('/auth/register').send(registration({ acceptedPrivacyVersion: true })).expect(400);
    const old = await t.raw().post('/auth/register').send(registration({ acceptedTermsVersion: 'terms-test-0' })).expect(400);
    expect(old.body).toMatchObject({ message: expect.stringMatching(/current terms and privacy notice/), current: { termsVersion: 'terms-test-1', privacyVersion: 'privacy-test-1' } });
    await t.raw().post('/auth/register').send(registration({ acceptedPrivacyVersion: 'privacy-test-9' })).expect(400);
    expect(await t.deps.repository.getUserByEmail(EMAIL)).toBeUndefined();
  });

  it('enforces the password rules and validates the rest of the body', async () => {
    t = await createTestApp();
    const weak = await t.raw().post('/auth/register').send(registration({ password: 'short' })).expect(400);
    expect(weak.body.issues).toEqual([{ path: 'password', message: 'must be at least 12 characters' }]);
    await t.raw().post('/auth/register').send(registration({ password: 'Password1234' })).expect(400);
    await t.raw().post('/auth/register').send(registration({ password: 'bola.adeyemi-2026' })).expect(400);
    await t.raw().post('/auth/register').send(registration({ email: 'not-an-email' })).expect(400);
    await t.raw().post('/auth/register').send(registration({ isAdmin: true })).expect(400);
    await t.raw().post('/auth/register').send(registration({ id: 'chosen-id' })).expect(400);
    await t.raw().post('/auth/register').send({}).expect(400);
    expect(await t.deps.repository.getUserByEmail(EMAIL)).toBeUndefined();
  });

  it('refuses a second account for the same email address, whatever its case', async () => {
    t = await createTestApp();
    await t.raw().post('/auth/register').send(registration()).expect(201);
    await t.raw().post('/auth/register').send(registration({ email: EMAIL.toUpperCase(), password: 'another long passphrase here' })).expect(409);
    await t.raw().post('/auth/login').send({ email: EMAIL, password: 'another long passphrase here' }).expect(401);
  });
});

describe('POST /auth/login', () => {
  it('returns a token for the right password and the same 401 for a wrong password and an unknown email', async () => {
    t = await createTestApp();
    const ok = await t.raw().post('/auth/login').send({ email: ` ${USER_EMAIL.toUpperCase()} `, password: USER_PASSWORD }).expect(200);
    expect(ok.body).toMatchObject({ user: { id: USER_ID, email: USER_EMAIL }, tokenType: 'Bearer', expiresIn: 3600 });
    expect(JSON.stringify(ok.body)).not.toMatch(/passwordHash|\$2b\$/);
    await t.as(ok.body.accessToken).get('/applications').expect(200, []);

    const wrong = await t.raw().post('/auth/login').send({ email: USER_EMAIL, password: 'the wrong passphrase' }).expect(401);
    const unknown = await t.raw().post('/auth/login').send({ email: 'nobody@example.org', password: USER_PASSWORD }).expect(401);
    expect(wrong.body).toEqual(unknown.body);
    expect(wrong.body.message).toBe('Email address or password is incorrect');
    await t.raw().post('/auth/login').send({ email: USER_EMAIL }).expect(400);
    await t.raw().post('/auth/login').send({ email: USER_EMAIL, password: USER_PASSWORD, isAdmin: true }).expect(400); // unknown keys are refused
  });
});

describe('access token on protected routes', () => {
  it('rejects an expired token with code token_expired, and other bad tokens with token_invalid', async () => {
    let now = new Date(NOW);
    t = await createTestApp({ clock: () => now, config: testConfig({ jwtTtlSeconds: 120 }) });
    const token = (await t.raw().post('/auth/login').send({ email: USER_EMAIL, password: USER_PASSWORD }).expect(200)).body.accessToken as string;
    await t.as(token).get('/applications').expect(200);
    now = new Date(now.getTime() + 119_000);
    await t.as(token).get('/applications').expect(200);
    now = new Date(now.getTime() + 2_000);
    const expired = await t.as(token).get('/applications').expect(401);
    expect(expired.body).toMatchObject({ code: 'token_expired', message: 'Access token has expired' });
    const invalid = await t.as(`${token}x`).get('/applications').expect(401);
    expect(invalid.body.code).toBe('token_invalid');
    await t.as(signAccessToken(USER_ID, 'some-other-secret-some-other-secret', 120, now, PWV).accessToken).get('/applications').expect(401);
  });

  it('rejects a well-signed token whose account does not exist', async () => {
    t = await createTestApp();
    const ghost = signAccessToken('no-such-user', JWT_SECRET, 3600, new Date(NOW), PWV).accessToken;
    const res = await t.as(ghost).get('/profile').expect(401);
    expect(res.body.code).toBe('token_invalid');
    await t.as(ghost).put('/profile').send(PROFILE).expect(401);
    expect(await t.deps.repository.getProfile('no-such-user')).toBeUndefined();
  });

  it('rejects a well-signed token without the password-version claim, or with an old one', async () => {
    t = await createTestApp();
    const jwt = (await import('jsonwebtoken')).default;
    const iat = Math.floor(new Date(NOW).getTime() / 1000);
    const bare = jwt.sign({ sub: USER_ID, iat, exp: iat + 600 }, JWT_SECRET, { algorithm: 'HS256', issuer: 'opennjob', audience: 'opennjob-api' });
    expect((await t.as(bare).get('/profile').expect(401)).body.code).toBe('token_invalid');
    await t.as(signAccessToken(USER_ID, JWT_SECRET, 600, new Date(NOW), 'oldpassword0').accessToken).get('/profile').expect(401);
  });

  it('the employer key is not a user token and a user token is not the employer key', async () => {
    t = await createTestApp({ config: testConfig({ employerKey: 'employer-key-for-tests' }) });
    await t.as('employer-key-for-tests').get('/profile').expect(401);
    await t.as('employer-key-for-tests').get('/account/export').expect(401);
  });
});

describe('rate limiting on /auth', () => {
  it('blocks an address after the allowed attempts, with Retry-After, and leaves other routes alone', async () => {
    t = await createTestApp({ config: testConfig({ authRateLimitMax: 3, authRateLimitWindowMs: 60_000 }) });
    for (let i = 0; i < 3; i += 1) await t.raw().post('/auth/login').send({ email: `guess${i}@example.org`, password: 'a wrong passphrase' }).expect(401);
    const blocked = await t.raw().post('/auth/login').send({ email: USER_EMAIL, password: USER_PASSWORD }).expect(429);
    expect(blocked.body).toMatchObject({ statusCode: 429, message: 'Too many attempts. Try again later.', retryAfterSeconds: 60 });
    expect(blocked.headers['retry-after']).toBe('60');
    await t.raw().post('/auth/register').send(registration()).expect(429);
    expect(await t.deps.repository.getUserByEmail(EMAIL)).toBeUndefined();
    await t.raw().get('/health').expect(200);
    await t.api.get('/applications').expect(200);
  });

  it('opens again when the window has passed', async () => {
    let now = new Date(NOW);
    t = await createTestApp({ clock: () => now, config: testConfig({ authRateLimitMax: 1, authRateLimitWindowMs: 60_000 }) });
    await t.raw().post('/auth/login').send({ email: USER_EMAIL, password: 'a wrong passphrase' }).expect(401);
    await t.raw().post('/auth/login').send({ email: USER_EMAIL, password: USER_PASSWORD }).expect(429);
    now = new Date(now.getTime() + 60_000);
    await t.raw().post('/auth/login').send({ email: USER_EMAIL, password: USER_PASSWORD }).expect(200);
  });

  it('also counts per account, so guesses from many addresses at one account are limited', async () => {
    t = await createTestApp({ config: testConfig({ authRateLimitMax: 2, authRateLimitWindowMs: 60_000 }) });
    t.app.getHttpAdapter().getInstance().set('trust proxy', true);
    const from = (ip: string, email: string) => t.raw().post('/auth/login').set('X-Forwarded-For', ip).send({ email, password: 'a wrong passphrase' });
    await from('203.0.113.1', USER_EMAIL).expect(401);
    await from('203.0.113.2', USER_EMAIL).expect(401);
    await from('203.0.113.3', USER_EMAIL).expect(429); // a third address, same account
    await from('203.0.113.4', 'someone.else@example.org').expect(401); // another account, fresh address
  });
});

describe('configuration that guards start-up', () => {
  const key = Buffer.alloc(32, 7).toString('base64');
  const secret = 's'.repeat(MIN_JWT_SECRET_LENGTH);

  it('production refuses to start without OPENNJOB_JWT_SECRET', () => {
    expect(startupProblems({ NODE_ENV: 'production', OPENNJOB_DATA_KEY: key })).toEqual(['OPENNJOB_JWT_SECRET is not set. It is required when NODE_ENV=production.']);
    expect(startupProblems({ NODE_ENV: ' Production ', OPENNJOB_JWT_SECRET: '   ', OPENNJOB_DATA_KEY: key })).toHaveLength(1);
  });

  it('production refuses to start without OPENNJOB_DATA_KEY', () => {
    expect(startupProblems({ NODE_ENV: 'production', OPENNJOB_JWT_SECRET: secret })).toEqual(['OPENNJOB_DATA_KEY is not set. It is required when NODE_ENV=production (32 random bytes, base64).']);
    expect(startupProblems({ NODE_ENV: 'production' })).toHaveLength(2);
  });

  it('production starts with both; development needs neither', () => {
    expect(startupProblems({ NODE_ENV: 'production', OPENNJOB_JWT_SECRET: secret, OPENNJOB_DATA_KEY: key })).toEqual([]);
    expect(startupProblems({})).toEqual([]);
    expect(startupProblems({ NODE_ENV: 'development' })).toEqual([]);
  });

  it('a short secret or a malformed data key is refused everywhere, not only in production', () => {
    expect(startupProblems({ OPENNJOB_JWT_SECRET: 'too-short' })).toEqual(['OPENNJOB_JWT_SECRET is too short: use at least 32 random characters.']);
    expect(startupProblems({ OPENNJOB_DATA_KEY: Buffer.alloc(16).toString('base64') })).toEqual(['OPENNJOB_DATA_KEY must decode to exactly 32 bytes (got 16).']);
    expect(startupProblems({ NODE_ENV: 'production', OPENNJOB_JWT_SECRET: secret, OPENNJOB_DATA_KEY: 'nonsense!' })).toEqual(['OPENNJOB_DATA_KEY must be base64.']);
  });

  it('outside production a missing secret becomes a random one for the process, with a warning; in production it stays empty', () => {
    const logger = memoryLogger();
    const one = createDefaultDeps({}, undefined, logger).config.jwtSecret;
    const two = createDefaultDeps({}, undefined, logger).config.jwtSecret;
    expect(one.length).toBeGreaterThanOrEqual(MIN_JWT_SECRET_LENGTH);
    expect(one).not.toBe(two);
    expect(logger.lines.filter((l) => l.level === 'warn')).toHaveLength(2);
    expect(JSON.stringify(logger.lines)).not.toContain(one);
    expect(createDefaultDeps({ NODE_ENV: 'production' }, undefined, logger).config.jwtSecret).toBe('');
  });

  it('reads the account settings from the environment, with bounds', () => {
    expect(loadConfig({ OPENNJOB_JWT_TTL_SECONDS: '900', OPENNJOB_BCRYPT_ROUNDS: '13', OPENNJOB_TERMS_VERSION: ' 2026-11 ', OPENNJOB_PRIVACY_VERSION: 'p3', OPENNJOB_AUTH_RATE_LIMIT_MAX: '5', OPENNJOB_AUTH_RATE_LIMIT_WINDOW_SECONDS: '60', OPENNJOB_BODY_LIMIT: '1MB' })).toMatchObject({
      jwtTtlSeconds: 900,
      bcryptRounds: 13,
      termsVersion: '2026-11',
      privacyVersion: 'p3',
      authRateLimitMax: 5,
      authRateLimitWindowMs: 60_000,
      bodyLimit: '1mb',
    });
    // Out of range or unreadable: the default stays.
    expect(loadConfig({ OPENNJOB_JWT_TTL_SECONDS: '5', OPENNJOB_BCRYPT_ROUNDS: '2', OPENNJOB_AUTH_RATE_LIMIT_MAX: '0', OPENNJOB_BODY_LIMIT: 'huge' })).toMatchObject({ jwtTtlSeconds: 3600, bcryptRounds: 12, authRateLimitMax: 10, bodyLimit: '256kb' });
    expect(loadConfig({ OPENNJOB_JWT_TTL_SECONDS: '99999999' }).jwtTtlSeconds).toBe(3600);
  });

  it('CORS: an allow-list from the environment; any extension origin only outside production unless asked for', () => {
    expect(loadConfig({ OPENNJOB_CORS_ORIGINS: ' https://app.example.org/ , chrome-extension://abcdefghijklmnop ' }).corsOrigins).toEqual(['https://app.example.org', 'chrome-extension://abcdefghijklmnop']);
    expect(loadConfig({}).corsAllowAnyExtension).toBe(true);
    expect(loadConfig({ NODE_ENV: 'production' }).corsAllowAnyExtension).toBe(false);
    expect(loadConfig({ NODE_ENV: 'production', OPENNJOB_CORS_ALLOW_ANY_EXTENSION: 'true' }).corsAllowAnyExtension).toBe(true);
    expect(loadConfig({ OPENNJOB_CORS_ALLOW_ANY_EXTENSION: 'false' }).corsAllowAnyExtension).toBe(false);
  });
});
