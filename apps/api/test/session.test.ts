import { afterEach, describe, expect, it } from 'vitest';
import { USER_EMAIL, USER_ID, USER_PASSWORD, createTestApp } from './helpers';
import type { TestApp } from './helpers';

/**
 * "Keep me signed in": a refresh token issued at sign-in, rotated on every use, revoked on sign-out
 * and on a password reset. Fictional account only.
 */
let t: TestApp;
afterEach(async () => {
  await t?.app.close();
});

const login = (remember?: boolean) => t.raw().post('/auth/login').send({ email: USER_EMAIL, password: USER_PASSWORD, ...(remember === undefined ? {} : { remember }) });

describe('keep me signed in', () => {
  it('a refresh token is issued only when asked for', async () => {
    t = await createTestApp();
    expect((await login().expect(200)).body.refreshToken).toBeUndefined();
    expect((await login(false).expect(200)).body.refreshToken).toBeUndefined();
    const body = (await login(true).expect(200)).body;
    expect(body.refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.accessToken).toEqual(expect.any(String));
  });

  it('a refresh gives a new session and a new refresh token; the old one works only once', async () => {
    t = await createTestApp();
    const first = (await login(true).expect(200)).body.refreshToken as string;
    const next = (await t.raw().post('/auth/refresh').send({ refreshToken: first }).expect(200)).body;
    expect(next.accessToken).toEqual(expect.any(String));
    expect(next.refreshToken).not.toBe(first);
    expect(next.user.id).toBe(USER_ID);
    await t.as(next.accessToken).get('/account').expect(200);
    await t.raw().post('/auth/refresh').send({ refreshToken: first }).expect(401); // used up
    await t.raw().post('/auth/refresh').send({ refreshToken: next.refreshToken }).expect(200);
  });

  it('signing out revokes every refresh token of the account', async () => {
    t = await createTestApp();
    const phone = (await login(true).expect(200)).body.refreshToken as string;
    const laptop = (await login(true).expect(200)).body.refreshToken as string;
    expect((await t.raw().post('/auth/logout').send({ refreshToken: phone }).expect(200)).body).toEqual({ signedOut: true });
    await t.raw().post('/auth/refresh').send({ refreshToken: laptop }).expect(401);
    // Signing out with an unknown token still answers the same, and says nothing about accounts.
    expect((await t.raw().post('/auth/logout').send({ refreshToken: 'x'.repeat(43) }).expect(200)).body).toEqual({ signedOut: true });
  });

  it('rejects malformed input and unknown keys', async () => {
    t = await createTestApp();
    await t.raw().post('/auth/refresh').send({ refreshToken: 'short' }).expect(400);
    await t.raw().post('/auth/refresh').send({ refreshToken: 'x'.repeat(43), userId: USER_ID }).expect(400);
    await t.raw().post('/auth/refresh').send({ refreshToken: 'x'.repeat(43) }).expect(401);
  });

  it('a deleted account cannot be refreshed', async () => {
    t = await createTestApp();
    const body = (await login(true).expect(200)).body;
    await t.as(body.accessToken).delete('/account').send({ password: USER_PASSWORD }).expect(200);
    await t.raw().post('/auth/refresh').send({ refreshToken: body.refreshToken }).expect(401);
  });
});

describe('a password reset signs out every kept device', () => {
  it('revokes refresh tokens when the password is reset', async () => {
    t = await createTestApp();
    const kept = (await login(true).expect(200)).body.refreshToken as string;
    await t.raw().post('/auth/password/forgot').send({ email: USER_EMAIL }).expect(200);
    // The reset token is only in the e-mail; take it from the repository through a fresh one-time token instead.
    const { createHash, randomBytes } = await import('node:crypto');
    const token = randomBytes(32).toString('base64url');
    await t.deps.repository.saveAuthToken({ id: 'reset-test', userId: USER_ID, kind: 'reset-password', tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt: '2030-01-01T00:00:00.000Z', createdAt: '2026-10-06T09:00:00.000Z' });
    await t.raw().post('/auth/password/reset').send({ token, password: 'another long fictional passphrase 42' }).expect(200);
    await t.raw().post('/auth/refresh').send({ refreshToken: kept }).expect(401);
  });
});
