import type { Application, DomainEvent, Job, Passport, Profile } from './types';

/**
 * Persistence port. The in-memory implementation below is the default and is what the
 * tests use. db/schema.sql holds the matching PostgreSQL tables; a PostgresRepository
 * implementing this interface is NOT written yet (see README, "What is stubbed").
 */
export interface Repository {
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
}

const clone = <T>(value: T): T => structuredClone(value);

export class InMemoryRepository implements Repository {
  private readonly profiles = new Map<string, Profile>();
  private readonly passports = new Map<string, Passport>();
  private readonly jobs = new Map<string, Job>();
  private readonly applications = new Map<string, Application>();
  private readonly events: DomainEvent[] = [];

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
    if (!this.applications.has(application.id)) throw new Error(`Application ${application.id} not found`);
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
}
