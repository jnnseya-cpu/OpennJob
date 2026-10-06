import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { EmailTakenError, SYSTEM_USER_ID } from '@opennjob/core';
import type { User } from '@opennjob/core';
import { hashPassword, passwordProblems, signAccessToken, verifyPassword } from './auth';
import { DEPS } from './deps';
import type { OpennJobDeps } from './deps';
import type { DeleteAccountInput, LoginInput, RegisterInput } from './schemas';

/** What the API says about an account. Never the password hash. */
function publicUser(user: User) {
  return {
    id: user.id,
    email: user.email,
    createdAt: user.createdAt,
    consent: { acceptedTermsVersion: user.acceptedTermsVersion, acceptedPrivacyVersion: user.acceptedPrivacyVersion, acceptedAt: user.consentAt },
  };
}

@Injectable()
export class AccountService {
  /** Compared against when the email has no account, so a miss costs the same time as a wrong password. */
  private dummyHash: Promise<string> | undefined;

  constructor(@Inject(DEPS) private readonly deps: OpennJobDeps) {}

  private now(): string {
    return this.deps.clock().toISOString();
  }

  private token(userId: string) {
    return signAccessToken(userId, this.deps.config.jwtSecret, this.deps.config.jwtTtlSeconds, this.deps.clock());
  }

  versions() {
    return {
      termsVersion: this.deps.config.termsVersion,
      privacyVersion: this.deps.config.privacyVersion,
      registration: this.deps.config.registrationAllowlist.length > 0 ? ('invite' as const) : ('open' as const),
    };
  }

  async register(input: RegisterInput) {
    const { termsVersion, privacyVersion, registrationAllowlist } = this.deps.config;
    // Private pilot: only invited addresses may create an account. The email schema has already lower-cased it.
    if (registrationAllowlist.length > 0 && !registrationAllowlist.includes(input.email)) {
      throw new ForbiddenException('Registration is by invitation only during the pilot');
    }
    // Consent is to a named version. Accepting some other version is not accepting this one.
    if (input.acceptedTermsVersion !== termsVersion || input.acceptedPrivacyVersion !== privacyVersion) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Registration needs acceptance of the current terms and privacy notice',
        current: { termsVersion, privacyVersion },
      });
    }
    const problems = passwordProblems(input.password, input.email);
    if (problems.length > 0) {
      throw new BadRequestException({ statusCode: 400, error: 'Bad Request', message: 'Validation failed', issues: problems.map((message) => ({ path: 'password', message })) });
    }
    const at = this.now();
    const user: User = {
      id: this.deps.newId(),
      email: input.email,
      passwordHash: await hashPassword(input.password, this.deps.config.bcryptRounds),
      createdAt: at,
      acceptedTermsVersion: input.acceptedTermsVersion,
      acceptedPrivacyVersion: input.acceptedPrivacyVersion,
      consentAt: at,
    };
    try {
      await this.deps.repository.createUser(user);
    } catch (err) {
      if (err instanceof EmailTakenError) throw new ConflictException('An account with this email address already exists');
      throw err;
    }
    await this.deps.eventBus.publish({ id: this.deps.newId(), type: 'account.registered', userId: user.id, occurredAt: at, payload: { termsVersion: user.acceptedTermsVersion, privacyVersion: user.acceptedPrivacyVersion } });
    return { user: publicUser(user), ...this.token(user.id) };
  }

  async login(input: LoginInput) {
    const user = await this.deps.repository.getUserByEmail(input.email);
    this.dummyHash ??= hashPassword('not-a-real-password', this.deps.config.bcryptRounds);
    const ok = await verifyPassword(input.password, user?.passwordHash ?? (await this.dummyHash));
    // One message for "no such account" and "wrong password".
    if (!user || !ok) throw new UnauthorizedException('Email address or password is incorrect');
    await this.deps.eventBus.publish({ id: this.deps.newId(), type: 'account.signed_in', userId: user.id, occurredAt: this.now(), payload: {} });
    return { user: publicUser(user), ...this.token(user.id) };
  }

  private async mustGetUser(userId: string): Promise<User> {
    const user = await this.deps.repository.getUserById(userId);
    if (!user) throw new UnauthorizedException('Missing or invalid bearer token');
    return user;
  }

  async me(userId: string) {
    return publicUser(await this.mustGetUser(userId));
  }

  /** Everything held about one account, as JSON (UK GDPR right of access / portability). */
  async exportAccount(userId: string) {
    const user = await this.mustGetUser(userId);
    const { repository, usageMeter } = this.deps;
    const data = {
      exportedAt: this.now(),
      user: publicUser(user),
      profile: (await repository.getProfile(userId)) ?? null,
      passport: (await repository.getPassport(userId)) ?? null,
      applications: await repository.listApplications(userId),
      events: await repository.listEvents(userId),
      usage: await usageMeter.list(userId),
      notifications: await repository.listNotifications(userId, 100_000),
      notificationDeliveries: await repository.listDeliveries(userId, 100_000),
      notificationPreferences: (await repository.getNotificationPreferences(userId)) ?? null,
    };
    await this.deps.eventBus.publish({ id: this.deps.newId(), type: 'account.exported', userId, occurredAt: this.now(), payload: {} });
    return data;
  }

  /**
   * Deletes the account and everything stored for it. Needs the password again, so a
   * borrowed or stolen access token alone cannot destroy someone's data.
   */
  async deleteAccount(userId: string, input: DeleteAccountInput) {
    const user = await this.mustGetUser(userId);
    if (!(await verifyPassword(input.password, user.passwordHash))) throw new UnauthorizedException('Password is incorrect');
    await this.deps.usageMeter.deleteForUser(userId);
    await this.deps.repository.deleteUser(userId);
    // Logged against no account: the id of a deleted account is not kept.
    await this.deps.eventBus.publish({ id: this.deps.newId(), type: 'account.deleted', userId: SYSTEM_USER_ID, occurredAt: this.now(), payload: {} });
    // Mandatory notice to the address the account had. Nothing about it is stored.
    await this.deps.notifier?.accountDeleted(user.email);
    return { deleted: true };
  }
}
