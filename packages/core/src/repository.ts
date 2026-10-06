import type { Application, DomainEvent, Job, Notification, NotificationDelivery, Passport, Profile, ScreeningAnswers, StandingAuthorisation, User } from './types';
import type { NotificationPreferences } from './notifications';

/** Thrown by createUser when the email address already has an account. */
export class EmailTakenError extends Error {
  constructor() {
    super('An account with this email address already exists');
    this.name = 'EmailTakenError';
  }
}

/**
 * Persistence port. Two implementations: InMemoryRepository below (the default without
 * DATABASE_URL, and what most tests use) and PostgresRepository in
 * apps/api/src/postgres.repository.ts. Both are held to the same contract by
 * apps/api/test/repository.contract.ts.
 *
 * Everything keyed by userId belongs to that account alone. Jobs are a shared catalogue.
 */
export interface Repository {
  /** Rejects with EmailTakenError when the email is already registered. */
  createUser(user: User): Promise<void>;
  getUserById(id: string): Promise<User | undefined>;
  /** `email` is matched exactly; callers lower-case it first. */
  getUserByEmail(email: string): Promise<User | undefined>;
  /**
   * Removes the account and everything stored for it: profile, passport, applications
   * and events. Returns false when there was no such account. Jobs are not personal data
   * and stay.
   */
  deleteUser(userId: string): Promise<boolean>;
  /** Resolves when the store can be reached; rejects otherwise. Used by GET /health. */
  ping(): Promise<void>;

  getProfile(userId: string): Promise<Profile | undefined>;
  saveProfile(userId: string, profile: Profile): Promise<void>;
  getPassport(userId: string): Promise<Passport | undefined>;
  savePassport(userId: string, passport: Passport): Promise<void>;
  /** Inserts or replaces by job id. Returns how many were new. */
  upsertJobs(jobs: Job[]): Promise<number>;
  listJobs(): Promise<Job[]>;
  getJob(id: string): Promise<Job | undefined>;
  createApplication(application: Application): Promise<void>;
  getApplication(userId: string, id: string): Promise<Application | undefined>;
  updateApplication(application: Application): Promise<void>;
  listApplications(userId: string): Promise<Application[]>;
  appendEvent(event: DomainEvent): Promise<void>;
  listEvents(userId: string): Promise<DomainEvent[]>;

  // ----- notifications (all per user; removed with the account) -----
  saveNotification(notification: Notification): Promise<void>;
  /** Newest first. */
  listNotifications(userId: string, limit?: number): Promise<Notification[]>;
  /** Marks the given ids (or every unread one when ids is undefined) read. Returns how many changed. */
  markNotificationsRead(userId: string, ids: string[] | undefined, at: string): Promise<number>;
  appendDelivery(delivery: NotificationDelivery): Promise<void>;
  /** Newest first. */
  listDeliveries(userId: string, limit?: number): Promise<NotificationDelivery[]>;
  getNotificationPreferences(userId: string): Promise<NotificationPreferences | undefined>;
  saveNotificationPreferences(userId: string, preferences: NotificationPreferences): Promise<void>;

  // ----- accounts: verification, reset, listing -----
  markEmailVerified(userId: string, at: string): Promise<void>;
  updatePasswordHash(userId: string, passwordHash: string): Promise<void>;
  /** Every account id, oldest first. For the scheduler. */
  listUserIds(): Promise<string[]>;
  /** Stores a one-time token. Only its SHA-256 is ever stored. */
  saveAuthToken(token: AuthToken): Promise<void>;
  /** Marks an unused, unexpired token of this kind used, atomically. Returns its owner, or undefined. */
  consumeAuthToken(kind: AuthToken['kind'], tokenHash: string, at: string): Promise<string | undefined>;

  // ----- applying -----
  deleteApplication(userId: string, id: string): Promise<boolean>;
  getScreeningAnswers(userId: string): Promise<ScreeningAnswers | undefined>;
  saveScreeningAnswers(userId: string, answers: ScreeningAnswers): Promise<void>;
  getAuthorisation(userId: string): Promise<StandingAuthorisation | undefined>;
  saveAuthorisation(userId: string, authorisation: StandingAuthorisation): Promise<void>;

  // ----- platform (not personal) -----
  getPlatformSetting<T>(key: string): Promise<T | undefined>;
  setPlatformSetting(key: string, value: unknown): Promise<void>;
  /** Records `key` once. true for the first caller, false for every later one (scheduler runs, across instances). */
  claimOnce(key: string, at: string): Promise<boolean>;
  /** Adds one hit to a fixed window and returns the window's count (shared rate limit, NFR-2). */
  hitRateLimit(key: string, windowStart: string): Promise<number>;
  /**
   * DP-5: deletes application records, events, notifications, delivery records, used or expired
   * one-time tokens and rate-limit windows from before the cutoff, for every account. Returns counts.
   */
  purgeBefore(cutoff: string): Promise<Record<string, number>>;
}

export interface AuthToken {
  id: string;
  userId: string;
  kind: 'verify-email' | 'reset-password';
  /** SHA-256 hex of the token sent by e-mail. */
  tokenHash: string;
  expiresAt: string;
  createdAt: string;
}

const clone = <T>(value: T): T => structuredClone(value);

export class InMemoryRepository implements Repository {
  private readonly users = new Map<string, User>();
  private readonly profiles = new Map<string, Profile>();
  private readonly passports = new Map<string, Passport>();
  private readonly jobs = new Map<string, Job>();
  private readonly applications = new Map<string, Application>();
  private readonly events: DomainEvent[] = [];
  private readonly notifications: Notification[] = [];
  private readonly deliveries: NotificationDelivery[] = [];
  private readonly notificationPrefs = new Map<string, NotificationPreferences>();
  private readonly tokens: (AuthToken & { usedAt?: string })[] = [];
  private readonly screening = new Map<string, ScreeningAnswers>();
  private readonly authorisations = new Map<string, StandingAuthorisation>();
  private readonly platform = new Map<string, unknown>();
  private readonly claims = new Set<string>();
  private readonly rateWindows = new Map<string, number>();

  async createUser(user: User) {
    if (this.users.has(user.id)) throw new Error(`User ${user.id} already exists`);
    for (const existing of this.users.values()) if (existing.email === user.email) throw new EmailTakenError();
    this.users.set(user.id, clone(user));
  }
  async getUserById(id: string) {
    const u = this.users.get(id);
    return u ? clone(u) : undefined;
  }
  async getUserByEmail(email: string) {
    for (const u of this.users.values()) if (u.email === email) return clone(u);
    return undefined;
  }
  async deleteUser(userId: string) {
    const existed = this.users.delete(userId);
    this.profiles.delete(userId);
    this.passports.delete(userId);
    for (const [id, a] of this.applications) if (a.userId === userId) this.applications.delete(id);
    for (let i = this.events.length - 1; i >= 0; i -= 1) if (this.events[i]?.userId === userId) this.events.splice(i, 1);
    for (let i = this.notifications.length - 1; i >= 0; i -= 1) if (this.notifications[i]?.userId === userId) this.notifications.splice(i, 1);
    for (let i = this.deliveries.length - 1; i >= 0; i -= 1) if (this.deliveries[i]?.userId === userId) this.deliveries.splice(i, 1);
    this.notificationPrefs.delete(userId);
    for (let i = this.tokens.length - 1; i >= 0; i -= 1) if (this.tokens[i]?.userId === userId) this.tokens.splice(i, 1);
    this.screening.delete(userId);
    this.authorisations.delete(userId);
    return existed;
  }
  async ping() {
    /* always reachable */
  }
  async getProfile(userId: string) {
    const p = this.profiles.get(userId);
    return p ? clone(p) : undefined;
  }
  async saveProfile(userId: string, profile: Profile) {
    this.profiles.set(userId, clone(profile));
  }
  async getPassport(userId: string) {
    const p = this.passports.get(userId);
    return p ? clone(p) : undefined;
  }
  async savePassport(userId: string, passport: Passport) {
    this.passports.set(userId, clone(passport));
  }
  async upsertJobs(jobs: Job[]) {
    let added = 0;
    for (const job of jobs) {
      if (!this.jobs.has(job.id)) added += 1;
      this.jobs.set(job.id, clone(job));
    }
    return added;
  }
  async listJobs() {
    return [...this.jobs.values()].map(clone);
  }
  async getJob(id: string) {
    const j = this.jobs.get(id);
    return j ? clone(j) : undefined;
  }
  async createApplication(application: Application) {
    if (this.applications.has(application.id)) throw new Error(`Application ${application.id} already exists`);
    this.applications.set(application.id, clone(application));
  }
  async getApplication(userId: string, id: string) {
    const a = this.applications.get(id);
    return a && a.userId === userId ? clone(a) : undefined;
  }
  async updateApplication(application: Application) {
    // The owner is part of the key: one account can never overwrite another's application.
    if (this.applications.get(application.id)?.userId !== application.userId) throw new Error(`Application ${application.id} not found`);
    this.applications.set(application.id, clone(application));
  }
  async listApplications(userId: string) {
    return [...this.applications.values()].filter((a) => a.userId === userId).map(clone);
  }
  async appendEvent(event: DomainEvent) {
    this.events.push(clone(event));
  }
  async listEvents(userId: string) {
    return this.events.filter((e) => e.userId === userId).map(clone);
  }
  async saveNotification(n: Notification) {
    this.notifications.push(clone(n));
  }
  async listNotifications(userId: string, limit = 200) {
    return this.notifications.filter((n) => n.userId === userId).reverse().slice(0, limit).map(clone);
  }
  async markNotificationsRead(userId: string, ids: string[] | undefined, at: string) {
    let changed = 0;
    for (const n of this.notifications) {
      if (n.userId !== userId || n.readAt || (ids && !ids.includes(n.id))) continue;
      n.readAt = at;
      changed += 1;
    }
    return changed;
  }
  async appendDelivery(d: NotificationDelivery) {
    this.deliveries.push(clone(d));
  }
  async listDeliveries(userId: string, limit = 200) {
    return this.deliveries.filter((d) => d.userId === userId).reverse().slice(0, limit).map(clone);
  }
  async getNotificationPreferences(userId: string) {
    const p = this.notificationPrefs.get(userId);
    return p ? clone(p) : undefined;
  }
  async saveNotificationPreferences(userId: string, preferences: NotificationPreferences) {
    this.notificationPrefs.set(userId, clone(preferences));
  }
  async markEmailVerified(userId: string, at: string) {
    const u = this.users.get(userId);
    if (u) this.users.set(userId, { ...u, emailVerifiedAt: u.emailVerifiedAt ?? at });
  }
  async updatePasswordHash(userId: string, passwordHash: string) {
    const u = this.users.get(userId);
    if (u) this.users.set(userId, { ...u, passwordHash });
  }
  async listUserIds() {
    return [...this.users.values()].sort((x, y) => x.createdAt.localeCompare(y.createdAt) || x.id.localeCompare(y.id)).map((u) => u.id);
  }
  async saveAuthToken(token: AuthToken) {
    this.tokens.push(clone(token));
  }
  async consumeAuthToken(kind: AuthToken['kind'], tokenHash: string, at: string) {
    const t = this.tokens.find((x) => x.kind === kind && x.tokenHash === tokenHash && !x.usedAt && x.expiresAt > at);
    if (!t) return undefined;
    t.usedAt = at;
    return t.userId;
  }
  async deleteApplication(userId: string, id: string) {
    const a = this.applications.get(id);
    if (!a || a.userId !== userId) return false;
    return this.applications.delete(id);
  }
  async getScreeningAnswers(userId: string) {
    const a = this.screening.get(userId);
    return a ? clone(a) : undefined;
  }
  async saveScreeningAnswers(userId: string, answers: ScreeningAnswers) {
    this.screening.set(userId, clone(answers));
  }
  async getAuthorisation(userId: string) {
    const a = this.authorisations.get(userId);
    return a ? clone(a) : undefined;
  }
  async saveAuthorisation(userId: string, authorisation: StandingAuthorisation) {
    this.authorisations.set(userId, clone(authorisation));
  }
  async getPlatformSetting<T>(key: string) {
    return this.platform.has(key) ? clone(this.platform.get(key) as T) : undefined;
  }
  async setPlatformSetting(key: string, value: unknown) {
    this.platform.set(key, clone(value));
  }
  async claimOnce(key: string) {
    if (this.claims.has(key)) return false;
    this.claims.add(key);
    return true;
  }
  async hitRateLimit(key: string, windowStart: string) {
    const k = `${key}|${windowStart}`;
    const n = (this.rateWindows.get(k) ?? 0) + 1;
    this.rateWindows.set(k, n);
    return n;
  }
  async purgeBefore(cutoff: string) {
    const out = { applications: 0, events: 0, notifications: 0, deliveries: 0, tokens: 0 };
    for (const [id, a] of this.applications) if (a.createdAt < cutoff) (this.applications.delete(id), (out.applications += 1));
    const drop = <T>(list: T[], old: (x: T) => boolean) => {
      let n = 0;
      for (let i = list.length - 1; i >= 0; i -= 1) if (old(list[i] as T)) (list.splice(i, 1), (n += 1));
      return n;
    };
    out.events = drop(this.events, (e) => e.occurredAt < cutoff);
    out.notifications = drop(this.notifications, (n) => n.createdAt < cutoff);
    out.deliveries = drop(this.deliveries, (d) => d.at < cutoff);
    out.tokens = drop(this.tokens, (t) => t.expiresAt < cutoff);
    return out;
  }
}
