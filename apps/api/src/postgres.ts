import { Pool } from 'pg';
import type { PoolConfig } from 'pg';
import { EmailTakenError, SYSTEM_USER_ID, dedupeKey } from '@opennjob/core';
import type { Application, AuthToken, DomainEvent, Job, Notification, NotificationDelivery, NotificationPreferences, Passport, Profile, Repository, ScreeningAnswers, StandingAuthorisation, UsageMeter, UsageRecord, UsageTotals, User } from '@opennjob/core';
import type { FieldCipher } from './crypto';
import { PlaintextCipher } from './crypto';

/** The part of pg's Pool this code uses, so a test can hand in a pool bound to its own schema. */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}

/**
 * DATABASE_URL is a normal PostgreSQL connection string. For Cloud SQL over a unix
 * socket: postgres://USER:PASSWORD@/DBNAME?host=/cloudsql/PROJECT:REGION:INSTANCE
 */
export function createPool(databaseUrl: string, extra: PoolConfig = {}): Pool {
  return new Pool({ connectionString: databaseUrl, max: 10, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000, ...extra });
}

type Row = Record<string, unknown>;
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const json = (v: unknown): string => JSON.stringify(v);
/** Builds an object without the keys whose value is null or undefined (absent optional fields stay absent). */
function present<T extends object>(value: { [K in keyof T]: T[K] | null | undefined }): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) if (v !== null && v !== undefined) out[k] = v;
  return out as T;
}

const userOf = (r: Row): User => ({
  id: r.id as string,
  email: r.email as string,
  passwordHash: r.password_hash as string,
  createdAt: iso(r.created_at),
  acceptedTermsVersion: r.accepted_terms_version as string,
  acceptedPrivacyVersion: r.accepted_privacy_version as string,
  consentAt: iso(r.consent_at),
  ...(r.email_verified_at ? { emailVerifiedAt: iso(r.email_verified_at) } : {}),
});

const jobOf = (r: Row): Job =>
  present<Job>({
    id: r.id as string,
    source: r.source as Job['source'],
    externalId: r.external_id as string,
    title: r.title as string,
    employer: r.employer as string,
    location: r.location as string,
    url: r.url as string,
    applyUrl: r.apply_url as string | null,
    description: r.description as string,
    salaryMin: r.salary_min as number | null,
    salaryMax: r.salary_max as number | null,
    employmentType: r.employment_type as string | null,
    postedAt: r.posted_at as string | null,
    criteria: r.criteria as Job['criteria'],
    criteriaSource: r.criteria_source as Job['criteriaSource'],
    requiresRegistration: r.requires_registration as boolean,
    requiredCredential: r.required_credential as string | null,
    pack: r.pack as Job['pack'] | null,
    country: r.country as string | null,
    city: r.city as string | null,
    region: r.region as Job['region'] | null,
    language: r.language as Job['language'] | null,
    origin: r.origin as Job['origin'] | null,
    contractType: r.contract_type as Job['contractType'] | null,
  });

const JOB_COLUMNS = [
  'id', 'source', 'external_id', 'title', 'employer', 'location', 'url', 'apply_url', 'description', 'salary_min', 'salary_max',
  'employment_type', 'posted_at', 'criteria', 'criteria_source', 'requires_registration', 'required_credential', 'pack', 'country',
  'city', 'region', 'language', 'origin', 'dedupe_key', 'contract_type',
] as const;

/**
 * PostgreSQL implementation of Repository, over the tables made by db/migrations.
 *
 * Encrypted with the given cipher before they reach the database: profiles.cv_text, the
 * whole passport (passports.data) and applications.statement. Every query that touches
 * personal data carries the user id in its WHERE clause.
 */
export class PostgresRepository implements Repository {
  constructor(
    private readonly db: Queryable,
    private readonly cipher: FieldCipher = new PlaintextCipher(),
  ) {}

  // ----- accounts -------------------------------------------------------------------

  async createUser(user: User): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO users (id, email, password_hash, created_at, accepted_terms_version, accepted_privacy_version, consent_at, email_verified_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [user.id, user.email, user.passwordHash, user.createdAt, user.acceptedTermsVersion, user.acceptedPrivacyVersion, user.consentAt, user.emailVerifiedAt ?? null],
      );
    } catch (err) {
      const e = err as { code?: string; constraint?: string };
      if (e.code === '23505' && e.constraint === 'users_email_key') throw new EmailTakenError();
      if (e.code === '23505') throw new Error(`User ${user.id} already exists`);
      throw err;
    }
  }

  async getUserById(id: string): Promise<User | undefined> {
    const { rows } = await this.db.query('SELECT * FROM users WHERE id = $1', [id]);
    return rows[0] ? userOf(rows[0]) : undefined;
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    const { rows } = await this.db.query('SELECT * FROM users WHERE email = $1', [email]);
    return rows[0] ? userOf(rows[0]) : undefined;
  }

  /** profiles, passports, applications, events and usage_records all reference users ON DELETE CASCADE. */
  async deleteUser(userId: string): Promise<boolean> {
    const res = await this.db.query('DELETE FROM users WHERE id = $1', [userId]);
    return (res.rowCount ?? 0) > 0;
  }

  async ping(): Promise<void> {
    await this.db.query('SELECT 1');
  }

  // ----- profile and passport -------------------------------------------------------

  async getProfile(userId: string): Promise<Profile | undefined> {
    const { rows } = await this.db.query('SELECT * FROM profiles WHERE user_id = $1', [userId]);
    const r = rows[0];
    if (!r) return undefined;
    return present<Profile>({
      firstName: r.first_name as string,
      lastName: r.last_name as string,
      email: r.email as string,
      phone: r.phone as string,
      addressLine1: r.address_line1 as string,
      addressLine2: r.address_line2 as string | null,
      city: r.city as string,
      postcode: r.postcode as string,
      cvText: this.cipher.decrypt(r.cv_text as string, `profile.cv:${userId}`),
      preferences: r.preferences as Profile['preferences'] | null,
    });
  }

  async saveProfile(userId: string, p: Profile): Promise<void> {
    await this.db.query(
      `INSERT INTO profiles (user_id, first_name, last_name, email, phone, address_line1, address_line2, city, postcode, cv_text, preferences, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
       ON CONFLICT (user_id) DO UPDATE SET first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name, email = EXCLUDED.email,
         phone = EXCLUDED.phone, address_line1 = EXCLUDED.address_line1, address_line2 = EXCLUDED.address_line2, city = EXCLUDED.city,
         postcode = EXCLUDED.postcode, cv_text = EXCLUDED.cv_text, preferences = EXCLUDED.preferences, updated_at = now()`,
      [
        userId, p.firstName, p.lastName, p.email, p.phone, p.addressLine1, p.addressLine2 ?? null, p.city, p.postcode,
        this.cipher.encrypt(p.cvText, `profile.cv:${userId}`),
        p.preferences ? json(p.preferences) : null,
      ],
    );
  }

  async getPassport(userId: string): Promise<Passport | undefined> {
    const { rows } = await this.db.query('SELECT data FROM passports WHERE user_id = $1', [userId]);
    return rows[0] ? (JSON.parse(this.cipher.decrypt(rows[0].data as string, `passport:${userId}`)) as Passport) : undefined;
  }

  async savePassport(userId: string, passport: Passport): Promise<void> {
    await this.db.query(
      `INSERT INTO passports (user_id, data, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [userId, this.cipher.encrypt(json(passport), `passport:${userId}`)],
    );
  }

  // ----- jobs (shared catalogue, not personal data) ---------------------------------

  async upsertJobs(jobs: Job[]): Promise<number> {
    let added = 0;
    const updates = JOB_COLUMNS.filter((c) => c !== 'id').map((c) => `${c} = EXCLUDED.${c}`).join(', ');
    const sql = `INSERT INTO jobs (${JOB_COLUMNS.join(', ')}) VALUES (${JOB_COLUMNS.map((_, i) => `$${i + 1}`).join(', ')})
      ON CONFLICT (id) DO UPDATE SET ${updates}, fetched_at = now() RETURNING (xmax = 0) AS inserted`;
    for (const j of jobs) {
      const { rows } = await this.db.query(sql, [
        j.id, j.source, j.externalId, j.title, j.employer, j.location, j.url, j.applyUrl ?? null, j.description, j.salaryMin ?? null,
        j.salaryMax ?? null, j.employmentType ?? null, j.postedAt ?? null, json(j.criteria), j.criteriaSource, j.requiresRegistration,
        j.requiredCredential ?? null, j.pack ?? null, j.country ?? null, j.city ?? null, j.region ?? null, j.language ?? null,
        j.origin ?? null, dedupeKey(j), j.contractType ?? null,
      ]);
      if (rows[0]?.inserted === true) added += 1;
    }
    return added;
  }

  async listJobs(): Promise<Job[]> {
    const { rows } = await this.db.query('SELECT * FROM jobs ORDER BY id');
    return rows.map(jobOf);
  }

  async getJob(id: string): Promise<Job | undefined> {
    const { rows } = await this.db.query('SELECT * FROM jobs WHERE id = $1', [id]);
    return rows[0] ? jobOf(rows[0]) : undefined;
  }

  // ----- applications ---------------------------------------------------------------

  private applicationOf(r: Row): Application {
    const userId = r.user_id as string;
    const id = r.id as string;
    return present<Application>({
      id,
      userId,
      jobId: r.job_id as string,
      jobTitle: r.job_title as string,
      employer: r.employer as string,
      applyUrl: r.apply_url as string,
      mode: r.mode as Application['mode'],
      status: r.status as Application['status'],
      statement: this.cipher.decrypt(r.statement as string, `application.statement:${userId}:${id}`),
      statementSource: r.statement_source as Application['statementSource'],
      gaps: r.gaps as string[],
      warnings: r.warnings as string[],
      score: r.score as number,
      confirmedFields: r.confirmed_fields as string[],
      createdAt: iso(r.created_at),
      confirmedAt: r.confirmed_at === null ? null : iso(r.confirmed_at),
      submittedAt: r.submitted_at === null ? null : iso(r.submitted_at),
      holdReasons: (r.hold_reasons as string[] | null)?.length ? (r.hold_reasons as string[]) : null,
      dedupeKey: r.dedupe_key as string | null,
      automatic: r.automatic === true ? true : null,
      ...(r.private_data ? (JSON.parse(this.cipher.decrypt(r.private_data as string, `application.private:${userId}:${id}`)) as Partial<Application>) : {}),
    });
  }

  private applicationValues(a: Application): unknown[] {
    return [
      a.id, a.userId, a.jobId, a.jobTitle, a.employer, a.applyUrl, a.mode, a.status,
      this.cipher.encrypt(a.statement, `application.statement:${a.userId}:${a.id}`),
      a.statementSource, json(a.gaps), json(a.warnings), a.score, json(a.confirmedFields), a.createdAt, a.confirmedAt ?? null, a.submittedAt ?? null,
      json(a.holdReasons ?? []), a.dedupeKey ?? null, a.automatic === true, this.privateDataOf(a),
    ];
  }

  /** The tailored CV, trace failures, sent documents, receipt, attempt time, outcome and skip: one encrypted value. */
  private privateDataOf(a: Application): string | null {
    const p: Partial<Application> = {};
    if (a.tailoredCv !== undefined) p.tailoredCv = a.tailoredCv;
    if (a.tailoredCvSource !== undefined) p.tailoredCvSource = a.tailoredCvSource;
    if (a.traceFailures !== undefined) p.traceFailures = a.traceFailures;
    if (a.sentDocuments !== undefined) p.sentDocuments = a.sentDocuments;
    if (a.receipt !== undefined) p.receipt = a.receipt;
    if (a.attemptedAt !== undefined) p.attemptedAt = a.attemptedAt;
    if (a.outcome !== undefined) p.outcome = a.outcome;
    if (a.outcomeAt !== undefined) p.outcomeAt = a.outcomeAt;
    if (a.skippedAt !== undefined) p.skippedAt = a.skippedAt;
    return Object.keys(p).length ? this.cipher.encrypt(JSON.stringify(p), `application.private:${a.userId}:${a.id}`) : null;
  }

  async createApplication(a: Application): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO applications (id, user_id, job_id, job_title, employer, apply_url, mode, status, statement, statement_source, gaps,
           warnings, score, confirmed_fields, created_at, confirmed_at, submitted_at, hold_reasons, dedupe_key, automatic, private_data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)`,
        this.applicationValues(a),
      );
    } catch (err) {
      if ((err as { code?: string; constraint?: string }).code === '23505') throw new Error(`Application ${a.id} already exists`);
      throw err;
    }
  }

  async getApplication(userId: string, id: string): Promise<Application | undefined> {
    const { rows } = await this.db.query('SELECT * FROM applications WHERE id = $1 AND user_id = $2', [id, userId]);
    return rows[0] ? this.applicationOf(rows[0]) : undefined;
  }

  async updateApplication(a: Application): Promise<void> {
    // The owner is part of the key: one account can never overwrite another's application.
    const res = await this.db.query(
      `UPDATE applications SET job_id = $3, job_title = $4, employer = $5, apply_url = $6, mode = $7, status = $8, statement = $9,
         statement_source = $10, gaps = $11, warnings = $12, score = $13, confirmed_fields = $14, created_at = $15, confirmed_at = $16,
         submitted_at = $17, hold_reasons = $18, dedupe_key = $19, automatic = $20, private_data = $21
       WHERE id = $1 AND user_id = $2`,
      this.applicationValues(a),
    );
    if ((res.rowCount ?? 0) === 0) throw new Error(`Application ${a.id} not found`);
  }

  async listApplications(userId: string): Promise<Application[]> {
    const { rows } = await this.db.query('SELECT * FROM applications WHERE user_id = $1 ORDER BY seq', [userId]);
    return rows.map((r) => this.applicationOf(r));
  }

  // ----- events ---------------------------------------------------------------------

  async appendEvent(e: DomainEvent): Promise<void> {
    await this.db.query('INSERT INTO events (id, type, user_id, occurred_at, payload) VALUES ($1, $2, $3, $4, $5)', [
      e.id, e.type, e.userId === SYSTEM_USER_ID ? null : e.userId, e.occurredAt, json(e.payload),
    ]);
  }

  async listEvents(userId: string): Promise<DomainEvent[]> {
    const { rows } =
      userId === SYSTEM_USER_ID
        ? await this.db.query('SELECT * FROM events WHERE user_id IS NULL ORDER BY seq')
        : await this.db.query('SELECT * FROM events WHERE user_id = $1 ORDER BY seq', [userId]);
    return rows.map((r) => ({
      id: r.id as string,
      type: r.type as string,
      userId: (r.user_id as string | null) ?? SYSTEM_USER_ID,
      occurredAt: iso(r.occurred_at),
      payload: r.payload as Record<string, unknown>,
    }));
  }

  // ----- accounts: verification, reset, listing -------------------------------------

  async markEmailVerified(userId: string, at: string): Promise<void> {
    await this.db.query('UPDATE users SET email_verified_at = COALESCE(email_verified_at, $2) WHERE id = $1', [userId, at]);
  }

  async updatePasswordHash(userId: string, passwordHash: string): Promise<void> {
    await this.db.query('UPDATE users SET password_hash = $2 WHERE id = $1', [userId, passwordHash]);
  }

  async listUserIds(): Promise<string[]> {
    const { rows } = await this.db.query('SELECT id FROM users ORDER BY created_at, id');
    return rows.map((r) => r.id as string);
  }

  async saveAuthToken(t: AuthToken): Promise<void> {
    await this.db.query('INSERT INTO auth_tokens (id, user_id, kind, token_hash, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, $6)', [
      t.id, t.userId, t.kind, t.tokenHash, t.expiresAt, t.createdAt,
    ]);
  }

  async consumeAuthToken(kind: AuthToken['kind'], tokenHash: string, at: string): Promise<string | undefined> {
    const { rows } = await this.db.query(
      'UPDATE auth_tokens SET used_at = $3 WHERE kind = $1 AND token_hash = $2 AND used_at IS NULL AND expires_at > $3 RETURNING user_id',
      [kind, tokenHash, at],
    );
    return rows[0] ? (rows[0].user_id as string) : undefined;
  }

  async revokeAuthTokens(userId: string, kind: AuthToken['kind'], at: string): Promise<number> {
    const res = await this.db.query('UPDATE auth_tokens SET used_at = $3 WHERE user_id = $1 AND kind = $2 AND used_at IS NULL', [userId, kind, at]);
    return res.rowCount ?? 0;
  }

  // ----- applying -------------------------------------------------------------------

  async deleteApplication(userId: string, id: string): Promise<boolean> {
    const res = await this.db.query('DELETE FROM applications WHERE id = $1 AND user_id = $2', [id, userId]);
    return (res.rowCount ?? 0) > 0;
  }

  async getScreeningAnswers(userId: string): Promise<ScreeningAnswers | undefined> {
    const { rows } = await this.db.query('SELECT data FROM screening_answers WHERE user_id = $1', [userId]);
    return rows[0] ? (JSON.parse(this.cipher.decrypt(rows[0].data as string, `screening:${userId}`)) as ScreeningAnswers) : undefined;
  }

  async saveScreeningAnswers(userId: string, answers: ScreeningAnswers): Promise<void> {
    await this.db.query(
      'INSERT INTO screening_answers (user_id, data, updated_at) VALUES ($1, $2, now()) ON CONFLICT (user_id) DO UPDATE SET data = excluded.data, updated_at = now()',
      [userId, this.cipher.encrypt(JSON.stringify(answers), `screening:${userId}`)],
    );
  }

  async getAuthorisation(userId: string): Promise<StandingAuthorisation | undefined> {
    const { rows } = await this.db.query('SELECT data FROM standing_authorisations WHERE user_id = $1', [userId]);
    return rows[0] ? (rows[0].data as StandingAuthorisation) : undefined;
  }

  async saveAuthorisation(userId: string, a: StandingAuthorisation): Promise<void> {
    await this.db.query(
      'INSERT INTO standing_authorisations (user_id, data, updated_at) VALUES ($1, $2, now()) ON CONFLICT (user_id) DO UPDATE SET data = excluded.data, updated_at = now()',
      [userId, json(a)],
    );
  }

  // ----- platform -------------------------------------------------------------------

  async getPlatformSetting<T>(key: string): Promise<T | undefined> {
    const { rows } = await this.db.query('SELECT value FROM platform_settings WHERE key = $1', [key]);
    return rows[0] ? (rows[0].value as T) : undefined;
  }

  async setPlatformSetting(key: string, value: unknown): Promise<void> {
    await this.db.query(
      'INSERT INTO platform_settings (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()',
      [key, json(value)],
    );
  }

  async claimOnce(key: string, at: string): Promise<boolean> {
    const res = await this.db.query('INSERT INTO platform_claims (key, claimed_at) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', [key, at]);
    return (res.rowCount ?? 0) > 0;
  }

  async purgeBefore(cutoff: string): Promise<Record<string, number>> {
    const count = async (sql: string) => (await this.db.query(sql, [cutoff])).rowCount ?? 0;
    return {
      applications: await count('DELETE FROM applications WHERE created_at < $1'),
      events: await count('DELETE FROM events WHERE occurred_at < $1'),
      notifications: await count('DELETE FROM notifications WHERE created_at < $1'),
      deliveries: await count('DELETE FROM notification_deliveries WHERE at < $1'),
      tokens: await count('DELETE FROM auth_tokens WHERE expires_at < $1'),
    };
  }

  async hitRateLimit(key: string, windowStart: string): Promise<number> {
    const { rows } = await this.db.query(
      `INSERT INTO rate_limit_windows (key, window_start, hits) VALUES ($1, $2, 1)
       ON CONFLICT (key, window_start) DO UPDATE SET hits = rate_limit_windows.hits + 1 RETURNING hits`,
      [key, windowStart],
    );
    return rows[0]?.hits as number;
  }

  // ----- notifications --------------------------------------------------------------

  async saveNotification(n: Notification): Promise<void> {
    await this.db.query(
      'INSERT INTO notifications (id, user_id, event_key, category, severity, subject, body, created_at, read_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
      [n.id, n.userId, n.eventKey, n.category, n.severity, n.subject, n.body, n.createdAt, n.readAt ?? null],
    );
  }

  async listNotifications(userId: string, limit = 200): Promise<Notification[]> {
    const { rows } = await this.db.query('SELECT * FROM notifications WHERE user_id = $1 ORDER BY seq DESC LIMIT $2', [userId, limit]);
    return rows.map((r) =>
      present<Notification>({
        id: r.id as string,
        userId: r.user_id as string,
        eventKey: r.event_key as string,
        category: r.category as string,
        severity: r.severity as Notification['severity'],
        subject: r.subject as string,
        body: r.body as string,
        createdAt: iso(r.created_at),
        readAt: r.read_at ? iso(r.read_at) : null,
      }),
    );
  }

  async markNotificationsRead(userId: string, ids: string[] | undefined, at: string): Promise<number> {
    const res = ids
      ? await this.db.query('UPDATE notifications SET read_at = $3 WHERE user_id = $1 AND read_at IS NULL AND id = ANY($2)', [userId, ids, at])
      : await this.db.query('UPDATE notifications SET read_at = $2 WHERE user_id = $1 AND read_at IS NULL', [userId, at]);
    return res.rowCount ?? 0;
  }

  async appendDelivery(d: NotificationDelivery): Promise<void> {
    await this.db.query('INSERT INTO notification_deliveries (id, user_id, event_key, channel, status, provider, at) VALUES ($1, $2, $3, $4, $5, $6, $7)', [
      d.id, d.userId, d.eventKey, d.channel, d.status, d.provider, d.at,
    ]);
  }

  async listDeliveries(userId: string, limit = 200): Promise<NotificationDelivery[]> {
    const { rows } = await this.db.query('SELECT * FROM notification_deliveries WHERE user_id = $1 ORDER BY seq DESC LIMIT $2', [userId, limit]);
    return rows.map((r) => ({
      id: r.id as string,
      userId: r.user_id as string,
      eventKey: r.event_key as string,
      channel: r.channel as NotificationDelivery['channel'],
      status: r.status as NotificationDelivery['status'],
      provider: r.provider as string,
      at: iso(r.at),
    }));
  }

  async getNotificationPreferences(userId: string): Promise<NotificationPreferences | undefined> {
    const { rows } = await this.db.query('SELECT data FROM notification_preferences WHERE user_id = $1', [userId]);
    return rows[0] ? (rows[0].data as NotificationPreferences) : undefined;
  }

  async saveNotificationPreferences(userId: string, preferences: NotificationPreferences): Promise<void> {
    await this.db.query(
      'INSERT INTO notification_preferences (user_id, data, updated_at) VALUES ($1, $2, now()) ON CONFLICT (user_id) DO UPDATE SET data = excluded.data, updated_at = now()',
      [userId, json(preferences)],
    );
  }
}

/** UsageMeter over the usage_records table. */
export class PostgresUsageMeter implements UsageMeter {
  constructor(private readonly db: Queryable) {}

  async record(entry: UsageRecord): Promise<void> {
    await this.db.query('INSERT INTO usage_records (user_id, purpose, input_tokens, output_tokens, acu, at) VALUES ($1, $2, $3, $4, $5, $6)', [
      entry.userId, entry.purpose, entry.inputTokens, entry.outputTokens, entry.acu, entry.at,
    ]);
  }

  async list(userId: string): Promise<UsageRecord[]> {
    const { rows } = await this.db.query('SELECT * FROM usage_records WHERE user_id = $1 ORDER BY id', [userId]);
    return rows.map((r) => ({
      userId: r.user_id as string,
      purpose: r.purpose as string,
      inputTokens: r.input_tokens as number,
      outputTokens: r.output_tokens as number,
      acu: r.acu as number,
      at: iso(r.at),
    }));
  }

  async totals(userId: string): Promise<UsageTotals> {
    const mine = await this.list(userId);
    const sum = (f: (r: UsageRecord) => number) => mine.reduce((a, r) => a + f(r), 0);
    return { calls: mine.length, inputTokens: sum((r) => r.inputTokens), outputTokens: sum((r) => r.outputTokens), acu: Math.round(sum((r) => r.acu) * 1000) / 1000 };
  }

  async deleteForUser(userId: string): Promise<void> {
    await this.db.query('DELETE FROM usage_records WHERE user_id = $1', [userId]);
  }

  async acuSince(userId: string | null, since: string): Promise<number> {
    const { rows } = userId === null
      ? await this.db.query('SELECT COALESCE(SUM(acu), 0)::float AS s FROM usage_records WHERE at >= $1', [since])
      : await this.db.query('SELECT COALESCE(SUM(acu), 0)::float AS s FROM usage_records WHERE user_id = $1 AND at >= $2', [userId, since]);
    return Math.round(Number(rows[0]?.s ?? 0) * 1000) / 1000;
  }
}
