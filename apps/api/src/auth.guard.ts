import { createHash, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, SetMetadata, UnauthorizedException } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DEPS } from './deps';
import type { OpennJobDeps } from './deps';

const IS_PUBLIC = 'opennjob:public';
/** Marks a route as not needing the bearer token (only /health uses it). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

const IS_EMPLOYER = 'opennjob:employer';
/**
 * Marks a route as the employer's: it takes OPENNJOB_EMPLOYER_KEY as its bearer token
 * instead of the user's token. An employer never holds the candidate's token, and the
 * candidate's token does not open employer routes.
 */
export const EmployerRoute = () => SetMetadata(IS_EMPLOYER, true);

const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest();

/**
 * PLACEHOLDER AUTH. One shared bearer token (OPENNJOB_API_TOKEN) for one development user.
 * It is not real authentication: no accounts, no sessions, no rotation, no per-user data
 * separation. Replace before any real user's data is stored. Fails closed when the token
 * is not configured.
 */
@Injectable()
export class BearerAuthGuard implements CanActivate {
  constructor(
    @Inject(DEPS) private readonly deps: OpennJobDeps,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()])) return true;
    const employer = this.reflector.getAllAndOverride<boolean>(IS_EMPLOYER, [context.getHandler(), context.getClass()]) === true;
    const expected = employer ? (this.deps.config.employerKey ?? '') : this.deps.config.apiToken;
    if (!expected) throw new UnauthorizedException(`${employer ? 'OPENNJOB_EMPLOYER_KEY' : 'OPENNJOB_API_TOKEN'} is not configured on the server`);
    const header = context.switchToHttp().getRequest<{ headers: Record<string, string | string[] | undefined> }>().headers.authorization;
    const match = typeof header === 'string' ? /^Bearer\s+(.+)$/i.exec(header.trim()) : null;
    if (!match || !timingSafeEqual(digest(match[1] as string), digest(expected))) {
      throw new UnauthorizedException('Missing or invalid bearer token');
    }
    return true;
  }
}
