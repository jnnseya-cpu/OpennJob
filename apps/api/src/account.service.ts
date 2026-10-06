import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { EmailTakenError, SYSTEM_USER_ID } from '@opennjob/core';
import type { User } from '@opennjob/core';
import { createHash, randomBytes } from 'node:crypto';
import { hashPassword, passwordProblems, passwordVersion, signAccessToken, verifyPassword } from './auth';
import { DEPS } from './deps';
import type { OpennJobDeps } from './deps';
import type { DeleteAccountInput, ForgotPasswordInput, LoginInput, RegisterInput, ResetPasswordInput, VerifyEmailInput } from './schemas';

const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;
const tokenHash = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');

/** What the API says about an account. Never the password hash. */
function publicUser(user: User) {
  return {
    id: user.id,
    email: user.email,
    createdAt: user.createdAt,
    emailVerified: Boolean(user.emailVerifiedAt),
    ...(user.emailVerifiedAt ? { emailVerifiedAt: user.emailVerifiedAt } : {}),
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

  private token(user: User) {
    return signAccessToken(user.id, this.deps.config.jwtSecret, this.deps.config.jwtTtlSeconds, this.deps.clock(), passwordVersion(user.passwordHash));
  }

  /** The address a one-time link points at: the web app when its address is known, otherwise the token alone. */
  private link(path: string, token: string): string | undefined {
    const base = this.deps.config.brand?.appUrl;
    return base ? `${base.replace(/\/+$/, '')}/${path}/?token=${token}` : undefined;
  }

  /** A fresh one-time token: only its SHA-256 is stored. The token itself goes into one e-mail and nowhere else. */
  private async newToken(userId: string, kind: 'verify-email' | 'reset-password', ttlMs: number): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    const at = this.deps.clock();
    await this.deps.repository.saveAuthToken({ id: this.deps.newId(), userId, kind, tokenHash: tokenHash(token), expiresAt: new Date(at.getTime() + ttlMs).toISOString(), createdAt: at.toISOString() });
    return token;
  }

  private async sendVerification(user: User): Promise<void> {
    const token = await this.newToken(user.id, 'verify-email', VERIFY_TTL_MS);
    const link = this.link('verify-email', token);
    await this.deps.notifier?.sendDirect(user.id, 'account.email_verification_required', {
      text: link ? 'Confirm your address:' : `Your confirmation code: ${token}\nEnter it on the Verify e-mail page.`,
      html: link ? '<p>Confirm your address:</p>' : `<p>Your confirmation code:</p><p style="font-family:monospace;font-size:15px">${token}</p><p>Enter it on the Verify e-mail page.</p>`,
      ...(link ? { linkUrl: link } : {}),
    });
    await this.deps.eventBus.publish({ id: this.deps.newId(), type: 'auth.verification_sent', userId: user.id, occurredAt: this.now(), payload: {} });
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
    await this.sendVerification(user);
    return { user: publicUser(user), ...this.token(user) };
  }

  async login(input: LoginInput) {
    const user = await this.deps.repository.getUserByEmail(input.email);
    this.dummyHash ??= hashPassword('not-a-real-password', this.deps.config.bcryptRounds);
    const ok = await verifyPassword(input.password, user?.passwordHash ?? (await this.dummyHash));
    // One message for "no such account" and "wrong password".
    if (!user || !ok) throw new UnauthorizedException('Email address or password is incorrect');
    await this.deps.eventBus.publish({ id: this.deps.newId(), type: 'account.signed_in', userId: user.id, occurredAt: this.now(), payload: {} });
    return { user: publicUser(user), ...this.token(user) };
  }

  /** ACC-2: the link from the e-mail confirms the address. A used or expired link does nothing. */
  async verifyEmail(input: VerifyEmailInput) {
    const userId = await this.deps.repository.consumeAuthToken('verify-email', tokenHash(input.token), this.now());
    if (!userId) throw new BadRequestException('This link has expired or has already been used. Ask for a new one from Account.');
    await this.deps.repository.markEmailVerified(userId, this.now());
    await this.deps.eventBus.publish({ id: this.deps.newId(), type: 'account.email_verified', userId, occurredAt: this.now(), payload: {} });
    return { verified: true };
  }

  async resendVerification(userId: string) {
    const user = await this.mustGetUser(userId);
    if (user.emailVerifiedAt) return { verified: true, sent: false };
    const minute = Math.floor(this.deps.clock().getTime() / 60_000);
    if ((await this.deps.repository.hitRateLimit(`verify:${userId}`, new Date(minute * 60_000).toISOString())) > 1) throw new ConflictException('A link was sent less than a minute ago');
    await this.sendVerification(user);
    return { verified: false, sent: true };
  }

  /** ACC-3: always the same reply, so the answer never says whether an address has an account. */
  async forgotPassword(input: ForgotPasswordInput) {
    const user = await this.deps.repository.getUserByEmail(input.email);
    if (user) {
      const token = await this.newToken(user.id, 'reset-password', RESET_TTL_MS);
      const link = this.link('reset-password', token);
      await this.deps.notifier?.sendDirect(user.id, 'security.password_reset_link', {
        text: link ? 'Choose a new password:' : `Your reset code: ${token}\nEnter it on the Reset password page.`,
        html: link ? '<p>Choose a new password:</p>' : `<p>Your reset code:</p><p style="font-family:monospace;font-size:15px">${token}</p>`,
        ...(link ? { linkUrl: link } : {}),
      });
      await this.deps.eventBus.publish({ id: this.deps.newId(), type: 'auth.password_reset_requested', userId: user.id, occurredAt: this.now(), payload: {} });
    }
    return { sent: true };
  }

  async resetPassword(input: ResetPasswordInput) {
    const refuse = (problems: string[]) =>
      new BadRequestException({ statusCode: 400, error: 'Bad Request', message: 'Validation failed', issues: problems.map((message) => ({ path: 'password', message })) });
    // The rules that need no account are checked first, so a weak password does not use up the link.
    const early = passwordProblems(input.password);
    if (early.length > 0) throw refuse(early);
    const userId = await this.deps.repository.consumeAuthToken('reset-password', tokenHash(input.token), this.now());
    if (!userId) throw new BadRequestException('This link has expired or has already been used. Ask for a new one.');
    const user = await this.mustGetUser(userId);
    const problems = passwordProblems(input.password, user.email);
    if (problems.length > 0) throw refuse(problems);
    const hash = await hashPassword(input.password, this.deps.config.bcryptRounds);
    await this.deps.repository.updatePasswordHash(userId, hash);
    // Following the link proves the address too.
    if (!user.emailVerifiedAt) await this.deps.repository.markEmailVerified(userId, this.now());
    await this.deps.eventBus.publish({ id: this.deps.newId(), type: 'account.password_changed', userId, occurredAt: this.now(), payload: {} });
    return { reset: true };
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
