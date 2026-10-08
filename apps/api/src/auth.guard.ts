import { createHash, timingSafeEqual } from 'node:crypto';
import { HttpException, Inject, Injectable, SetMetadata, UnauthorizedException, createParamDecorator } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { passwordVersion, verifyAccessToken } from './auth';
import type { Limiter } from './auth';
import { DEPS } from './deps';
import type { OpennJobDeps } from './deps';

const IS_PUBLIC = 'opennjob:public';
/** Marks a route as needing no access token: /health, /auth/register, /auth/login, /auth/versions. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

const IS_EMPLOYER = 'opennjob:employer';
/**
 * Marks a route as the employer's: it takes OPENNJOB_EMPLOYER_KEY as its bearer token
 * instead of a user's access token. An employer never holds a candidate's token, and a
 * candidate's token does not open employer routes.
 */
export const EmployerRoute = () => SetMetadata(IS_EMPLOYER, true);

const IS_OPERATOR = 'opennjob:operator';
/** Opened by OPENNJOB_OPERATOR_KEY only. No user token opens it, and the operator key opens no user route. */
export const OperatorRoute = () => SetMetadata(IS_OPERATOR, true);

interface AuthedRequest {
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
  body?: unknown;
  opennjobUserId?: string;
}

/**
 * The authenticated user's id, as put on the request by AccessTokenGuard. This is the
 * ONLY source of a user id in the controllers: no route reads one from a body, a query
 * or a path.
 */
export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext): string => {
  const id = context.switchToHttp().getRequest<AuthedRequest>().opennjobUserId;
  if (!id) throw new UnauthorizedException('Missing or invalid bearer token');
  return id;
});

const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest();

function bearer(request: AuthedRequest): string | undefined {
  const header = request.headers.authorization;
  const match = typeof header === 'string' ? /^Bearer\s+(.+)$/i.exec(header.trim()) : null;
  return match ? (match[1] as string) : undefined;
}

/**
 * Global guard. Every route needs a signed, unexpired access token whose account still
 * exists, unless it is marked @Public() or @EmployerRoute(). Fails closed when no signing
 * secret is configured.
 */
@Injectable()
export class AccessTokenGuard implements CanActivate {
  constructor(
    @Inject(DEPS) private readonly deps: OpennJobDeps,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const token = bearer(request);

    if (this.reflector.getAllAndOverride<boolean>(IS_EMPLOYER, targets) === true) {
      const expected = this.deps.config.employerKey ?? '';
      if (!expected) throw new UnauthorizedException('OPENNJOB_EMPLOYER_KEY is not configured on the server');
      if (!token || !timingSafeEqual(digest(token), digest(expected))) throw new UnauthorizedException('Missing or invalid bearer token');
      return true;
    }

    if (this.reflector.getAllAndOverride<boolean>(IS_OPERATOR, targets) === true) {
      const expected = this.deps.config.operatorKey ?? '';
      if (!expected) throw new UnauthorizedException('OPENNJOB_OPERATOR_KEY is not configured on the server');
      if (!token || !timingSafeEqual(digest(token), digest(expected))) throw new UnauthorizedException('Missing or invalid bearer token');
      return true;
    }

    const secret = this.deps.config.jwtSecret;
    if (!secret) throw new UnauthorizedException('OPENNJOB_JWT_SECRET is not configured on the server');
    if (!token) throw new UnauthorizedException('Missing or invalid bearer token');
    const check = verifyAccessToken(token, secret, this.deps.clock());
    if (!check.ok) {
      // `code` lets the extension tell "sign in again" from "this was never a token".
      throw new UnauthorizedException({ statusCode: 401, error: 'Unauthorized', message: check.reason === 'expired' ? 'Access token has expired' : 'Missing or invalid bearer token', code: check.reason === 'expired' ? 'token_expired' : 'token_invalid' });
    }
    // A deleted account's tokens stop working at once, not when they expire.
    const user = await this.deps.repository.getUserById(check.userId);
    if (!user) throw new UnauthorizedException({ statusCode: 401, error: 'Unauthorized', message: 'Missing or invalid bearer token', code: 'token_invalid' });
    // A token issued before the password was last changed no longer works (ACC-3).
    // A token without the claim was not issued by this API's sign-in and is refused.
    if (check.pwv !== passwordVersion(user.passwordHash)) {
      throw new UnauthorizedException({ statusCode: 401, error: 'Unauthorized', message: 'Missing or invalid bearer token', code: 'token_invalid' });
    }
    request.opennjobUserId = user.id;
    return true;
  }
}

export const AUTH_RATE_LIMITER = Symbol('OPENNJOB_AUTH_RATE_LIMITER');

/**
 * Rate limit for /auth/*. Counts attempts per client address, and per email address
 * when the body names one, so one address cannot hammer many accounts and many addresses
 * cannot hammer one account. Replies 429 with Retry-After.
 */
@Injectable()
export class AuthRateLimitGuard implements CanActivate {
  constructor(@Inject(AUTH_RATE_LIMITER) private readonly limiter: Limiter) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest<AuthedRequest>();
    const keys = [`ip:${request.ip ?? 'unknown'}`];
    const email = (request.body as { email?: unknown } | undefined)?.email;
    if (typeof email === 'string' && email.length <= 254) keys.push(`email:${email.trim().toLowerCase()}`);
    const results = await Promise.all(keys.map((k) => this.limiter.take(k)));
    const blocked = results.filter((r) => !r.allowed);
    if (blocked.length > 0) {
      const retryAfter = Math.max(...blocked.map((r) => r.retryAfterSeconds));
      http.getResponse<{ setHeader(name: string, value: string): void }>().setHeader('Retry-After', String(retryAfter));
      throw new HttpException({ statusCode: 429, error: 'Too Many Requests', message: 'Too many attempts. Try again later.', retryAfterSeconds: retryAfter }, 429);
    }
    return true;
  }
}
