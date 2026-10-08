import { createHash } from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

// ----- passwords ---------------------------------------------------------------------

export const PASSWORD_MIN_LENGTH = 12;
/** bcrypt reads only the first 72 bytes of a password, so anything longer is refused rather than silently cut. */
export const PASSWORD_MAX_BYTES = 72;

/** A short list of passwords that pass the length rule and are still the first ones an attacker tries. */
const COMMON_PASSWORDS = new Set([
  'password1234', 'password12345', 'passwordpassword', '123456789012', '1234567890123', 'qwertyuiop12', 'qwertyuiopas',
  'letmein12345', 'iloveyou1234', 'administrator', 'welcome12345', 'changeme1234', 'opennjob1234', 'correcthorsebatterystaple',
]);

/**
 * Password rules: length first (12 characters or more, 72 bytes at most), then the
 * obvious bad choices. No "one capital, one symbol" rule: length does more.
 * Returns the list of problems; empty means acceptable.
 */
export function passwordProblems(password: string, email = ''): string[] {
  const problems: string[] = [];
  if ([...password].length < PASSWORD_MIN_LENGTH) problems.push(`must be at least ${PASSWORD_MIN_LENGTH} characters`);
  if (Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES) problems.push(`must be at most ${PASSWORD_MAX_BYTES} bytes`);
  const lower = password.toLowerCase();
  if (new Set(lower).size < 5) problems.push('must use at least 5 different characters');
  if (COMMON_PASSWORDS.has(lower)) problems.push('is too common');
  const local = email.toLowerCase().split('@')[0] ?? '';
  if (email && (lower === email.toLowerCase() || (local.length >= 4 && lower.includes(local)))) problems.push('must not contain your email address');
  return problems;
}

export const hashPassword = (password: string, rounds: number): Promise<string> => bcrypt.hash(password, rounds);
export const verifyPassword = (password: string, hash: string): Promise<boolean> => bcrypt.compare(password, hash);

// ----- access tokens -----------------------------------------------------------------

const ISSUER = 'opennjob';
const AUDIENCE = 'opennjob-api';

export interface AccessToken {
  accessToken: string;
  tokenType: 'Bearer';
  /** Seconds until it expires. */
  expiresIn: number;
  /** ISO time it expires at. */
  expiresAt: string;
}

/** Signs a short-lived access token (HS256). The only claim that matters is `sub`, the user id. */
/**
 * A short fingerprint of the password hash, carried in the token. Changing the password changes
 * it, so every token issued before a reset stops working at once (ACC-3).
 */
export function passwordVersion(passwordHash: string): string {
  return createHash('sha256').update(passwordHash).digest('hex').slice(0, 12);
}

export function signAccessToken(userId: string, secret: string, ttlSeconds: number, now: Date, pwv: string): AccessToken {
  if (!secret) throw new Error('OPENNJOB_JWT_SECRET is not configured on the server');
  const iat = Math.floor(now.getTime() / 1000);
  const accessToken = jwt.sign({ sub: userId, iat, exp: iat + ttlSeconds, pwv }, secret, { algorithm: 'HS256', issuer: ISSUER, audience: AUDIENCE });
  return { accessToken, tokenType: 'Bearer', expiresIn: ttlSeconds, expiresAt: new Date((iat + ttlSeconds) * 1000).toISOString() };
}

export type TokenCheck = { ok: true; userId: string; pwv?: string } | { ok: false; reason: 'expired' | 'invalid' };

/** Verifies signature, algorithm, issuer, audience and expiry. Only HS256 is accepted. */
export function verifyAccessToken(token: string, secret: string, now: Date): TokenCheck {
  try {
    const payload = jwt.verify(token, secret, { algorithms: ['HS256'], issuer: ISSUER, audience: AUDIENCE, clockTimestamp: Math.floor(now.getTime() / 1000) });
    if (typeof payload === 'string' || typeof payload.sub !== 'string' || !payload.sub) return { ok: false, reason: 'invalid' };
    return { ok: true, userId: payload.sub, ...(typeof payload.pwv === 'string' ? { pwv: payload.pwv } : {}) };
  } catch (err) {
    return { ok: false, reason: err instanceof jwt.TokenExpiredError ? 'expired' : 'invalid' };
  }
}

// ----- rate limiting -----------------------------------------------------------------

export interface Limiter {
  take(key: string): { allowed: boolean; retryAfterSeconds: number } | Promise<{ allowed: boolean; retryAfterSeconds: number }>;
}

/**
 * Fixed-window counter kept in the repository (rate_limit_windows in PostgreSQL), so every API
 * instance counts against the same limit (NFR-2).
 */
export class SharedRateLimiter implements Limiter {
  constructor(
    private readonly repository: { hitRateLimit(key: string, windowStart: string): Promise<number> },
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  async take(key: string): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
    const t = this.now();
    const start = Math.floor(t / this.windowMs) * this.windowMs;
    const hits = await this.repository.hitRateLimit(key, new Date(start).toISOString());
    return { allowed: hits <= this.max, retryAfterSeconds: Math.max(1, Math.ceil((start + this.windowMs - t) / 1000)) };
  }
}

/**
 * Fixed-window counter, in this process's memory. Enough to slow password guessing on
 * one instance. With more than one API instance each has its own counters: put a shared
 * limiter (or the load balancer's) in front before scaling out. See GO-LIVE.md.
 */
export class RateLimiter implements Limiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Counts one attempt. `allowed` is false once the key has used up its window. */
  take(key: string): { allowed: boolean; retryAfterSeconds: number } {
    const t = this.now();
    if (this.hits.size > 50_000) for (const [k, v] of this.hits) if (v.resetAt <= t) this.hits.delete(k);
    let entry = this.hits.get(key);
    if (!entry || entry.resetAt <= t) {
      entry = { count: 0, resetAt: t + this.windowMs };
      this.hits.set(key, entry);
    }
    entry.count += 1;
    return { allowed: entry.count <= this.max, retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - t) / 1000)) };
  }
}
