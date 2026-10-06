import type { Application, DomainEvent, Job, Notification, NotificationDelivery, Passport, Profile, User } from './types';
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
}
