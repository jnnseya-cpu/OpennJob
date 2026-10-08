import { createHash } from 'node:crypto';
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import {
  EMPTY_PASSPORT,
  checkTraining,
  collectJobs,
  credentialLabel,
  dedupeKey,
  recruiterEmailIn,
  describeTraceFailure,
  draftStatement,
  draftStatementFallback,
  extractCriteria,
  SYSTEM_USER_ID,
  queryKey,
  searchPlan,
  targetEmployerOf,
  isEmployerLink,
  payExpectationOf,
  payFits,
  hasWayOut,
  COUNTRY_LANGUAGES,
  automaticBar,
  automaticOrder,
  interviewRates,
  interviewedEmployers,
  findPackQuestion,
  findQuestion,
  inScope,
  matchJob,
  meteredLlm,
  normaliseJob,
  nmcPinOf,
  preferencesOf,
  questionsFor,
  questionsForPack,
  requiredCredentialOf,
  scoreAnswer,
  interviewFromDocuments,
  tailorCv,
  tailorCvForJob,
  traceRewrittenCv,
  traceCheck,
  trainingWarnings,
  zonedDayStart,
  nextZonedDayStart,
} from '@opennjob/core';
import type { Application, HealthcareRole, Job, LlmPort, MatchResult, Mode, PackId, Passport, Preferences, Profile, QuestionCategory, SearchQuery, WorkRightsRecord } from '@opennjob/core';
import { DEPS, applyThresholdOf, limitsOf } from './deps';
import type { OpennJobDeps } from './deps';
import type {
  AgentRunInput,
  ConfirmApplicationInput,
  CreateApplicationInput,
  EmployerJobInput,
  InterviewFeedbackInput,
  MatchFilterInput,
  PassportInput,
  ProfileInput,
  StatementInput,
  SubmittedInput,
  OutcomeInput,
  FromLinkInput,
} from './schemas';

/** zod leaves `undefined` on absent optional keys; drop them so stored objects are clean. */
function compact<T extends object>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

const DAY_MS = 86_400_000;
/** How many unsent applications, at most, get their whole advert read in one agent run. */
export const ADVERTS_READ_PER_RUN = 40;
/** How long "Look for jobs now" waits before it answers that the search carries on in the background. */
export const REFRESH_WAIT_MS = 25_000;
/** How many applications written without AI are written again with AI in one agent run. */
export const REDRAFTS_PER_RUN = 20;
/** An approved application whose score falls under this is closed: it is neither shown nor sent. */
export const MIN_KEEP_SCORE = 70;

/** Adds and removes hold reasons, moving the status to needs_you and back to draft as they come and go. */
export function withHolds(application: Application, add: string[], remove: (h: string) => boolean = () => false): Application {
  const holds = [...new Set([...(application.holdReasons ?? []).filter((h) => !remove(h)), ...add])];
  const held = holds.length > 0;
  let status = application.status;
  if (held && (status === 'draft' || status === 'confirmed')) status = 'needs_you';
  if (!held && status === 'needs_you') status = 'draft';
  const next: Application = { ...application, status };
  if (held) next.holdReasons = holds;
  else delete next.holdReasons;
  return next;
}


/** Holds the person clears by acting on the employer's site, then "try again". */
export const RETRYABLE_HOLD = /^(login-wall|captcha|step-refused(:.*)?|step-waits|steps-saved:\d+|too-many-steps|no-submit-button|form-changed|no-form)$/;

@Injectable()
export class OpennJobService {
  constructor(@Inject(DEPS) private readonly deps: OpennJobDeps) {}

  // Every method that touches a person's data takes that person's user id first. It
  // comes from the verified access token (see auth.guard.ts), never from the request body.

  private now(): string {
    return this.deps.clock().toISOString();
  }

  /** Payloads carry ids and counts only: never CV text, declarations or contact details. */
  private async emit(userId: string, type: string, payload: Record<string, unknown>): Promise<void> {
    await this.deps.eventBus.publish({ id: this.deps.newId(), type, userId, occurredAt: this.now(), payload });
  }

  private llmFor(userId: string, purpose: string): LlmPort | undefined {
    return this.deps.llm ? meteredLlm(this.deps.llm, this.deps.usageMeter, { userId, purpose }, this.deps.clock) : undefined;
  }

  // ----- profile & passport ---------------------------------------------------------

  async saveProfile(userId: string, input: ProfileInput): Promise<Profile> {
    const profile = compact(input) as Profile;
    await this.deps.repository.saveProfile(userId, profile);
    const prefs = preferencesOf(profile);
    await this.emit(userId, 'profile.updated', {
      cvCharacters: profile.cvText.length,
      ...(profile.preferences ? { languages: prefs.languages.length, countries: prefs.countries.length, cities: prefs.cities.length } : {}),
    });
    return profile;
  }

  /** PRO-1: converts an uploaded CV to text. Counts only, never content, go to the event log. */
  async extractCv(userId: string, bytes: Buffer, contentType: string) {
    const { extractCv } = await import('./cv');
    const out = await extractCv(bytes, contentType);
    await this.emit(userId, 'profile.cv_extracted', { format: out.format, characters: out.text.length, pages: out.pages ?? null });
    return out;
  }

  async getProfile(userId: string): Promise<Profile> {
    const profile = await this.deps.repository.getProfile(userId);
    if (!profile) throw new NotFoundException('No profile saved yet. PUT /profile first.');
    return profile;
  }

  private passportView(passport: Passport) {
    return { passport, training: checkTraining(passport.training, this.deps.clock) };
  }

  async savePassport(userId: string, input: PassportInput) {
    const { workRights: rows, ...rest } = input;
    const passport = compact(rest) as Passport;
    if (rows && rows.length > 0) {
      // OD-5: the confirmation time is kept while a record is unchanged, and renewed when it changes.
      const before = (await this.deps.repository.getPassport(userId))?.workRights ?? [];
      passport.workRights = rows.map(({ confirmed: _confirmed, ...r }) => {
        const record: Omit<WorkRightsRecord, 'confirmedAt'> = { country: r.country, rightToWork: r.rightToWork, requiresSponsorship: r.requiresSponsorship, basis: r.basis, ...(r.documentExpires ? { documentExpires: r.documentExpires } : {}) };
        const same = before.find((b) => b.country === r.country && b.rightToWork === r.rightToWork && b.requiresSponsorship === r.requiresSponsorship && b.basis === r.basis && b.documentExpires === r.documentExpires);
        return { ...record, confirmedAt: same?.confirmedAt ?? this.now() };
      });
    }
    await this.deps.repository.savePassport(userId, passport);
    await this.emit(userId, 'passport.updated', { trainingRecords: passport.training.length, referees: passport.referees.length, hasNmcPin: Boolean(nmcPinOf(passport)), credentials: Object.keys(passport.credentials ?? {}).length, workRights: passport.workRights?.length ?? 0 });
    return this.passportView(passport);
  }

  async getPassport(userId: string) {
    const passport = await this.deps.repository.getPassport(userId);
    if (!passport) throw new NotFoundException('No passport saved yet. PUT /passport first.');
    return this.passportView(passport);
  }

  // ----- jobs -----------------------------------------------------------------------

  /**
   * What the job-search APIs are asked for one person: job titles from their CV, places from their
   * preferences (packages/core/src/search.ts). No server setting decides it.
   */
  async searchPlan(userId: string) {
    const profile = await this.deps.repository.getProfile(userId);
    const plan = profile ? searchPlan(profile, this.deps.config.searchMaxQueriesPerUser ?? 6) : { titles: [], places: [], employers: [], queries: [] };
    const sources = this.deps.searchSources ?? [];
    const prefs = preferencesOf(profile);
    const countries = [...new Set(plan.places.map((p) => p.country))];
    // Per country: how many searches it gets, and which job-search APIs cover it at all.
    const coverage = countries.map((country) => ({
      country,
      searches: plan.queries.filter((q) => q.country === country).length,
      sources: sources.filter((s) => !s.countries || s.countries.includes(country)).map((s) => s.label),
    }));
    // Settings that hide jobs abroad even when they are found.
    const warnings: string[] = [];
    const abroad = countries.filter((c) => c !== 'GB');
    if (abroad.length && prefs.searchTypes?.length && !prefs.searchTypes.includes('international')) warnings.push('search-types-uk-only');
    const francophone = abroad.some((c) => (COUNTRY_LANGUAGES[c] ?? []).includes('fr'));
    if (francophone && prefs.languages.length && !prefs.languages.some((l) => l.toLowerCase() === 'french')) warnings.push('french-not-selected');
    return {
      ...plan,
      coverage,
      warnings,
      hasProfile: Boolean(profile),
      searchSources: sources.map((s) => ({ label: s.label, countries: s.countries ?? null })),
      boards: this.deps.sources.length,
    };
  }

  /** The searches for this refresh: the person's own, or every person's for the platform-wide run, each asked once. */
  private async refreshQueries(userId: string): Promise<SearchQuery[]> {
    const perUser = this.deps.config.searchMaxQueriesPerUser ?? 6;
    const cap = this.deps.config.searchMaxQueriesPerRefresh ?? 60;
    const userIds = userId === SYSTEM_USER_ID ? await this.deps.repository.listUserIds() : [userId];
    const seen = new Map<string, SearchQuery>();
    for (const id of userIds) {
      const profile = await this.deps.repository.getProfile(id);
      if (!profile) continue;
      for (const q of searchPlan(profile, perUser).queries) if (!seen.has(queryKey(q)) && seen.size < cap) seen.set(queryKey(q), q);
    }
    return [...seen.values()];
  }

  /**
   * "Look for jobs now": the search, answered within REFRESH_WAIT_MS. A search that takes longer
   * (dozens of searches, whole adverts, AI reading requirements) carries on in the background and
   * the answer says so; pressing again meanwhile joins the same search instead of starting another.
   */
  async refreshJobsNow(userId: string, waitMs = REFRESH_WAIT_MS) {
    let running = this.refreshing.get(userId);
    if (!running) {
      running = this.refreshJobs(userId).finally(() => this.refreshing.delete(userId));
      this.refreshing.set(userId, running);
      running.catch(() => undefined); // a search that fails in the background is recorded by its own errors
    }
    let timer: NodeJS.Timeout | undefined;
    const later = new Promise<'running'>((resolve) => {
      timer = setTimeout(() => resolve('running'), waitMs);
    });
    try {
      const first = await Promise.race([running, later]);
      return first === 'running' ? { running: true as const } : { running: false as const, ...first };
    } finally {
      clearTimeout(timer);
    }
  }

  private readonly refreshing = new Map<string, ReturnType<OpennJobService['refreshJobs']>>();

  async refreshJobs(userId: string) {
    const queries = (this.deps.searchSources ?? []).length > 0 ? await this.refreshQueries(userId) : [];
    const searches = queries.flatMap((q) =>
      (this.deps.searchSources ?? [])
        .filter((src) => !src.countries || src.countries.includes(q.country.toUpperCase()))
        .map((src) => ({ label: src.label, fetchJobs: () => src.search(q) })),
    );
    const collected = await collectJobs([...this.deps.sources, ...searches]);
    let jobs: Job[] = collected.jobs;
    let llmExtracted = 0;

    const llm = this.deps.config.llmCriteria ? this.llmFor(userId, 'criteria-extraction') : undefined;
    // AI reads the requirements only of jobs inside someone's preferences (countries, cities,
    // languages, search types): the rest are never shown or applied for, and reading them made the
    // morning run take hours.
    const scopes: Preferences[] = [];
    for (const id of userId === SYSTEM_USER_ID ? await this.deps.repository.listUserIds() : [userId]) {
      const profile = await this.deps.repository.getProfile(id);
      if (profile) scopes.push(preferencesOf(profile));
    }
    const wanted = (job: Job) => scopes.length === 0 || scopes.some((p) => inScope(job, p));
    if (llm) {
      const enriched: Job[] = [];
      for (const job of jobs) {
        const existing = await this.deps.repository.getJob(job.id);
        if (job.criteriaSource === 'provided') {
          // Criteria that came with the job (demo data, an employer's posting) are kept as they are.
          enriched.push(job);
        } else if (existing?.criteriaSource === 'llm' && existing.description === job.description) {
          enriched.push({
            ...job,
            criteria: existing.criteria,
            criteriaSource: 'llm',
            requiresRegistration: existing.requiresRegistration,
            ...(existing.requiredCredential ? { requiredCredential: existing.requiredCredential } : {}),
          });
        } else if (llmExtracted < this.deps.config.llmCriteriaMaxJobs && wanted(job)) {
          const extracted = await extractCriteria(job.description, llm, job.title);
          if (extracted.source === 'llm') llmExtracted += 1;
          const requiredCredential = job.requiredCredential ?? extracted.requiredCredential;
          enriched.push({
            ...job,
            criteria: extracted.criteria,
            criteriaSource: extracted.source,
            requiresRegistration: extracted.requiresRegistration || requiredCredential === 'pin',
            ...(requiredCredential ? { requiredCredential } : {}),
          });
        } else {
          enriched.push(job);
        }
      }
      jobs = enriched;
    }

    const added = await this.deps.repository.upsertJobs(jobs);
    const summary = {
      sources: [...this.deps.sources.map((s) => s.label), ...(this.deps.searchSources ?? []).map((s) => s.label)],
      searches: searches.length,
      fetched: collected.fetched,
      duplicatesRemoved: collected.duplicates,
      stored: jobs.length,
      new: added,
      criteriaFromLlm: llmExtracted,
      errors: collected.errors,
    };
    await this.emit(userId, 'jobs.refreshed', { fetched: summary.fetched, stored: summary.stored, new: added, sourceErrors: summary.errors.length, searches: searches.length });
    return summary;
  }

  private static matchView(job: Job, match: MatchResult, targetEmployers?: string[]) {
    const target = targetEmployerOf(job, targetEmployers);
    return {
      job: {
        id: job.id,
        source: job.source,
        title: job.title,
        employer: job.employer,
        location: job.location,
        url: job.url,
        applyUrl: job.applyUrl ?? job.url,
        salaryMin: job.salaryMin,
        salaryMax: job.salaryMax,
        requiresRegistration: job.requiresRegistration,
        requiredCredential: requiredCredentialOf(job),
        criteriaSource: job.criteriaSource,
        pack: job.pack,
        country: job.country,
        city: job.city,
        region: job.region,
        language: job.language ?? 'en',
        origin: job.origin ?? 'discovered',
      },
      score: match.score,
      eligible: match.eligible,
      missingCredential: match.missingCredential,
      unmetEssential: match.unmetEssential,
      // The advert names a recruiter's e-mail address: the application can be sent by e-mail (no form).
      emailApply: recruiterEmailIn(job.description) !== undefined,
      // One of the companies the person asked to search for: the advertiser, or named in the advert.
      ...(target ? { targetEmployer: target } : {}),
      // The job title checked against the CV: otherField means the CV does not show this kind of post.
      ...(match.role && !match.role.fits ? { otherField: { role: match.role.role, missing: match.role.missing } } : {}),
      // The advert gave too few readable requirements for a full score (capped).
      ...(match.thinEvidence ? { thinEvidence: true } : {}),
      hits: match.hits.map((h) => ({ label: h.criterion.label, essential: h.criterion.essential, matched: h.matched, evidence: h.evidence, statedLanguage: h.statedLanguage })),
    };
  }

  /**
   * Jobs scored against the CV. Only jobs inside the candidate's preferences are returned
   * (if nothing is selected, everything is available). Discovered and employer-posted
   * jobs are treated exactly alike. `pack`, `region` and `country` narrow the list further.
   */
  async matches(userId: string, min: number, filters: MatchFilterInput = {}) {
    const profile = await this.getProfile(userId);
    const preferences = preferencesOf(profile);
    const passport = await this.deps.repository.getPassport(userId);
    const pay = payExpectationOf(await this.deps.repository.getScreeningAnswers(userId));
    const jobs = await this.deps.repository.listJobs();
    return jobs
      .filter((job) => inScope(job, preferences) && payFits(job, pay))
      .filter((job) => (!filters.pack || job.pack === filters.pack) && (!filters.region || job.region === filters.region) && (!filters.country || job.country === filters.country))
      .map((job) => OpennJobService.matchView(job, matchJob(job, profile.cvText, passport, preferences), preferences.targetEmployers))
      .filter((m) => m.score >= min)
      .sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.score - a.score || a.job.id.localeCompare(b.job.id))
      // The same vacancy from two sources is listed once (the first, best-scored copy).
      .filter(
        (
          (seen) => (m: { job: Pick<Job, 'title' | 'employer' | 'location'> }) =>
            !seen.has(dedupeKey(m.job)) && Boolean(seen.add(dedupeKey(m.job)))
        )(new Set<string>()),
      );
  }

  // ----- employer postings (optional) -----------------------------------------------

  /**
   * Stores a job posted by an employer, with origin 'employer'. This is an extra way in,
   * not the main one: jobs are discovered by the system from its sources, and everything
   * works with no employer job at all. Once stored it is matched like any other job.
   */
  async postEmployerJob(input: EmployerJobInput): Promise<Job> {
    const body = compact(input);
    const job = normaliseJob({
      source: 'employer',
      externalId: this.deps.newId(),
      title: body.title,
      employer: body.employer,
      location: body.city,
      city: body.city,
      country: body.country,
      url: body.applyUrl,
      applyUrl: body.applyUrl,
      description: body.description,
      origin: 'employer',
      postedAt: this.now(),
      ...(body.language ? { language: body.language } : {}),
      ...(body.pack ? { pack: body.pack as PackId } : {}),
      ...(body.requiredCredential ? { requiredCredential: body.requiredCredential } : {}),
      ...(body.criteria ? { criteria: body.criteria } : {}),
      ...(body.salaryMin !== undefined ? { salaryMin: body.salaryMin } : {}),
      ...(body.salaryMax !== undefined ? { salaryMax: body.salaryMax } : {}),
      ...(body.employmentType ? { employmentType: body.employmentType } : {}),
    }) as Job;
    await this.deps.repository.upsertJobs([job]);
    await this.emit(SYSTEM_USER_ID, 'employer.job.posted', { jobId: job.id, pack: job.pack ?? null, country: job.country ?? null });
    return job;
  }

  // ----- applications ---------------------------------------------------------------

  private static ineligibleMessage(match: MatchResult): string {
    return match.missingCredential === 'pin' || match.missingCredential === undefined
      ? 'This role requires professional registration and no NMC PIN is stored in the passport.'
      : `This role requires a credential that is not stored in the passport: ${credentialLabel(match.missingCredential)}.`;
  }

  /**
   * NFR-5: the daily LLM ceiling, per person and in total, counted over the London day.
   * Returns true when either is reached. A ceiling of 0 means no LLM use at all.
   */
  private async llmCeilingReached(userId: string): Promise<boolean> {
    if (!this.deps.llm) return false;
    const { llmDailyAcuPerUser, llmDailyAcuTotal } = limitsOf(this.deps.config);
    const since = zonedDayStart(this.deps.clock()).toISOString();
    const mine = await this.deps.usageMeter.acuSince(userId, since);
    const everyone = await this.deps.usageMeter.acuSince(null, since);
    return mine >= llmDailyAcuPerUser || everyone >= llmDailyAcuTotal;
  }

  /** TAI-3: runs the trace check and returns the failures as the person will read them. */
  private static traceOf(statement: string, tailoredCv: string, job: Pick<Job, 'title' | 'employer' | 'location'>, profile: Profile, passport: Passport): string[] {
    const sources = { cvText: profile.cvText, passport, languages: preferencesOf(profile).languages, job, personName: `${profile.firstName} ${profile.lastName}` };
    // The statement and the CV at fact level: a CV rewritten for the advert may reword, never add a fact.
    const failures = [...traceCheck({ statement }, sources), ...traceRewrittenCv(tailoredCv, sources)];
    return failures.map(describeTraceFailure);
  }

  /**
   * Drafts and stores one application. The caller has already checked eligibility and
   * duplicates. The statement and the tailored CV are traced to the source before the
   * application is stored; anything that does not trace holds it for the person.
   */
  private async draftFor(userId: string, job: Job, profile: Profile, passport: Passport, match: MatchResult, mode: Mode): Promise<Application> {
    const ceiling = await this.llmCeilingReached(userId);
    const input = { job, cvText: profile.cvText, match };
    const draft = ceiling ? draftStatementFallback(input) : await draftStatement(input, this.llmFor(userId, 'supporting-statement'));
    // The CV rewritten for this advert, traced to the CV at fact level; the reordered CV if it does not trace.
    const sources = { cvText: profile.cvText, passport, languages: preferencesOf(profile).languages, personName: `${profile.firstName} ${profile.lastName}` };
    const tailored = await tailorCvForJob({ cvText: profile.cvText, job, match }, ceiling ? undefined : this.llmFor(userId, 'cv-tailoring'), sources);
    const tailoredCv = tailored.text;
    const traceFailures = OpennJobService.traceOf(draft.statement, tailoredCv, job, profile, passport);
    const holds: string[] = [];
    if (ceiling) holds.push('llm-ceiling');
    if (traceFailures.length > 0) holds.push('trace-check');
    const base: Application = {
      id: this.deps.newId(),
      userId,
      jobId: job.id,
      jobTitle: job.title,
      employer: job.employer,
      applyUrl: job.applyUrl ?? job.url,
      mode,
      status: 'draft',
      statement: draft.statement,
      statementSource: draft.source,
      gaps: draft.gaps,
      warnings: [...draft.warnings, ...trainingWarnings(passport.training, this.deps.clock)],
      score: match.score,
      confirmedFields: [],
      createdAt: this.now(),
      dedupeKey: dedupeKey(job),
      tailoredCv,
      tailoredCvSource: tailored.source,
      ...(traceFailures.length > 0 ? { traceFailures } : {}),
    };
    const application = withHolds(base, holds);
    await this.deps.repository.createApplication(application);
    await this.emit(userId, 'application.drafted', { applicationId: application.id, jobId: job.id, mode: application.mode, statementSource: draft.source, cvSource: tailored.source, score: match.score, gaps: draft.gaps.length, traceFailures: traceFailures.length, held: holds.length > 0 });
    if (ceiling) await this.emit(userId, 'agent.llm_ceiling', { applicationId: application.id });
    return application;
  }

  /**
   * APP-6: an existing application for this job, or for the same employer, title and
   * location within the duplicate period. Every status counts, closed included.
   */
  /**
   * APP-6. An application's own key is compared, and also the key of its job as it is now, so
   * applications made before the key changed are still recognised (`jobs`, when given).
   */
  private duplicateOf(existing: readonly Application[], job: Job, jobs?: ReadonlyMap<string, Job>): Application | undefined {
    const key = dedupeKey(job);
    const since = this.deps.clock().getTime() - limitsOf(this.deps.config).duplicateDays * DAY_MS;
    const keyOf = (a: Application) => {
      const own = jobs?.get(a.jobId);
      return own ? dedupeKey(own) : a.dedupeKey ?? '';
    };
    return (
      existing.find((a) => a.jobId === job.id) ??
      existing.find((a) => (a.dedupeKey === key || keyOf(a) === key) && Date.parse(a.createdAt) >= since)
    );
  }

  /**
   * APP-8: automatic submission attempts today (London) against the owner's daily limit. The
   * queue asks this before handing out the next application; at the limit it waits for
   * the next London day.
   */
  async dailyLimit(userId: string) {
    const now = this.deps.clock();
    const since = zonedDayStart(now).getTime();
    const limit = limitsOf(this.deps.config).dailyApplicationLimit;
    // Every attempt counts, including one whose confirmation was never seen (uncertain).
    const used = (await this.deps.repository.listApplications(userId)).filter((a) => a.automatic === true && a.attemptedAt !== undefined && Date.parse(a.attemptedAt) >= since).length;
    return { limit, used, remaining: Math.max(0, limit - used), resetsAt: nextZonedDayStart(now).toISOString() };
  }

  async createApplication(userId: string, input: CreateApplicationInput): Promise<Application> {
    const profile = await this.getProfile(userId);
    const job = await this.deps.repository.getJob(input.jobId);
    if (!job) throw new NotFoundException(`Job ${input.jobId} not found. Run POST /jobs/refresh and use an id from GET /jobs/matches.`);
    const passport = (await this.deps.repository.getPassport(userId)) ?? EMPTY_PASSPORT;
    const match = matchJob(job, profile.cvText, passport, preferencesOf(profile));
    if (!match.eligible) throw new UnprocessableEntityException(OpennJobService.ineligibleMessage(match));
    // Never two applications for one vacancy: the existing one is returned.
    const duplicate = this.duplicateOf(await this.deps.repository.listApplications(userId), job);
    if (duplicate) return duplicate;
    return this.draftFor(userId, job, profile, passport, match, input.mode);
  }

  /**
   * "Apply to this link": a job the person found on an employer's site, with the advert text they
   * copied. It is scored, and a tailored CV and cover letter are prepared in auto mode, so the
   * queue applies on that page (when its application system is switched on) under the same policy
   * as every other form. Kept whatever its score: the person chose it, and the agent does not close it.
   * OpennJob does not open the page itself to read it.
   */
  async applyFromLink(userId: string, input: FromLinkInput): Promise<Application> {
    const profile = await this.getProfile(userId);
    if (!isEmployerLink(input.url)) throw new BadRequestException("That is a job board's or an aggregator's page. Give the employer's own application page.");
    const externalId = sha256(`${userId}|${input.url}`).slice(0, 24);
    const job = normaliseJob({ source: 'link', externalId, title: input.title, employer: input.employer, location: input.location ?? '', url: input.url, applyUrl: input.url, description: input.description });
    if (!job) throw new BadRequestException('The job could not be read');
    await this.deps.repository.upsertJobs([job]);
    const passport = (await this.deps.repository.getPassport(userId)) ?? EMPTY_PASSPORT;
    const match = matchJob(job, profile.cvText, passport, preferencesOf(profile));
    if (!match.eligible) throw new UnprocessableEntityException(OpennJobService.ineligibleMessage(match));
    const existing = await this.deps.repository.listApplications(userId);
    const duplicate = this.duplicateOf(existing, job);
    if (duplicate && duplicate.status !== 'closed') throw new ConflictException(`You already have an application for this job (${duplicate.jobTitle}, ${duplicate.employer}).`);
    const application = await this.draftFor(userId, job, profile, passport, match, 'auto');
    await this.emit(userId, 'application.from_link', { applicationId: application.id, score: match.score });
    return application;
  }

  /**
   * THE 80% RULE. Takes every job that is (a) inside the candidate's preferences,
   * (b) one they are eligible for and (c) scoring at or above the threshold
   * (OPENNJOB_APPLY_THRESHOLD, default 80), and prepares an application DRAFT for it.
   * Jobs below the threshold are left alone. A job that already has an application is
   * not drafted twice.
   *
   * This only prepares drafts. It does not open, fill or submit any form: that happens in
   * the extension, under the mode rules in packages/core/src/policy.ts, which are
   * unchanged. The user still confirms every sensitive field, and in auto mode a form
   * containing any sensitive field still waits for the user.
   */
  async runAgent(userId: string, input: AgentRunInput) {
    const profile = await this.getProfile(userId);
    const preferences = preferencesOf(profile);
    const passport = (await this.deps.repository.getPassport(userId)) ?? EMPTY_PASSPORT;
    // The higher of the platform's threshold and the person's own bar (Profile), raised further
    // toward the person's target interview rate once their recorded outcomes show where it is met.
    const existing = await this.deps.repository.listApplications(userId);
    const threshold = automaticBar(existing, Math.max(applyThresholdOf(this.deps.config), preferences.minScore ?? 0), preferences.targetInterviewRate).bar;
    const jobs = await this.deps.repository.listJobs();

    const jobsById = new Map(jobs.map((j) => [j.id, j]));
    // A job that states pay under the person's expectation (Profile) is not applied for: unsent
    // applications to one are closed, the person's own picks ("Apply to this link") excepted.
    const pay = payExpectationOf(await this.deps.repository.getScreeningAnswers(userId));
    let closedBelowPay = 0;
    for (const a of [...existing]) {
      if ((a.status !== 'draft' && a.status !== 'needs_you' && a.status !== 'confirmed') || a.attemptedAt !== undefined) continue;
      const job = jobsById.get(a.jobId);
      if (!job || job.source === 'link' || payFits(job, pay)) continue;
      const closed: Application = { ...a, status: 'closed' };
      await this.deps.repository.updateApplication(closed);
      existing.splice(existing.indexOf(a), 1, closed);
      closedBelowPay += 1;
    }
    // Unsent drafts for posts the CV does not show (scored before the title was checked) are closed.
    let closedOtherField = 0;
    for (const a of existing) {
      if ((a.status !== 'draft' && a.status !== 'needs_you') || a.attemptedAt !== undefined) continue;
      const job = jobs.find((j) => j.id === a.jobId);
      // A job the person chose themselves ("Apply to this link") is theirs to skip, not the agent's.
      if (!job || job.source === 'link' || matchJob(job, profile.cvText, passport, preferences).role?.fits !== false) continue;
      const closed: Application = { ...a, status: 'closed' };
      await this.deps.repository.updateApplication(closed);
      existing.splice(existing.indexOf(a), 1, closed);
      closedOtherField += 1;
    }

    // The same vacancy prepared twice from two sources (before duplicates were matched on the
    // employer's first word): the unsent copy made later is closed; the first one stays.
    let closedDuplicates = 0;
    const firstByKey = new Map<string, Application>();
    for (const a of [...existing].sort((x, y) => x.createdAt.localeCompare(y.createdAt) || x.id.localeCompare(y.id))) {
      const job = jobsById.get(a.jobId);
      if (!job || a.status === 'closed') continue;
      const key = dedupeKey(job);
      const first = firstByKey.get(key);
      if (!first) {
        firstByKey.set(key, a);
        continue;
      }
      if ((a.status !== 'draft' && a.status !== 'needs_you') || a.attemptedAt !== undefined) continue;
      const closed: Application = { ...a, status: 'closed' };
      await this.deps.repository.updateApplication(closed);
      existing.splice(existing.indexOf(a), 1, closed);
      closedDuplicates += 1;
    }

    // Run in Auto: the person's unsent applications prepared in Review all or Hybrid follow the
    // mode they now chose, so they can go out on their own (they were otherwise skipped for good).
    if (input.mode === 'auto') {
      for (const a of [...existing]) {
        if (a.mode === 'auto' || (a.status !== 'draft' && a.status !== 'needs_you' && a.status !== 'confirmed') || a.attemptedAt !== undefined) continue;
        const moved: Application = { ...a, mode: 'auto' };
        await this.deps.repository.updateApplication(moved);
        existing.splice(existing.indexOf(a), 1, moved);
      }
    }

    // An unsent application with no way out yet (no recruiter e-mail in the advert, no employer
    // link) whose advert was read only in part (a search reads the whole advert for its first
    // results only): its source is asked for the whole advert, which can name the recruiter's
    // address or the employer's own application page. A few per run.
    let advertsRead = 0;
    for (const a of existing) {
      if (advertsRead >= ADVERTS_READ_PER_RUN) break;
      if ((a.status !== 'draft' && a.status !== 'needs_you' && a.status !== 'confirmed') || a.attemptedAt !== undefined || isEmployerLink(a.applyUrl)) continue;
      const job = jobsById.get(a.jobId);
      if (!job || recruiterEmailIn(job.description)) continue;
      const source = (this.deps.searchSources ?? []).find((s) => s.name === job.source && s.details);
      if (!source?.details) continue;
      advertsRead += 1;
      const d = await source.details(job).catch(() => ({}) as { description?: string; applyUrl?: string });
      const longer = d.description && d.description.length > job.description.length ? d.description : undefined;
      const link = d.applyUrl && isEmployerLink(d.applyUrl) && d.applyUrl !== job.applyUrl ? d.applyUrl : undefined;
      if (!longer && !link) continue;
      const fuller: Job = { ...job, ...(longer ? { description: longer } : {}), ...(link ? { applyUrl: link } : {}) };
      await this.deps.repository.upsertJobs([fuller]);
      jobsById.set(fuller.id, fuller);
      jobs.splice(jobs.indexOf(job), 1, fuller);
    }

    // The same vacancy found on another source (Adzuna and Reed, Reed and Jooble) whose copy names
    // the recruiter's address or the employer's own page, when the application's copy has neither:
    // the application moves to that copy, so it can go out without the person finding the link.
    const wayOutByKey = new Map<string, Job>();
    for (const j of jobs) if (hasWayOut(j) && !wayOutByKey.has(dedupeKey(j))) wayOutByKey.set(dedupeKey(j), j);
    for (const a of [...existing]) {
      if ((a.status !== 'draft' && a.status !== 'needs_you' && a.status !== 'confirmed') || a.attemptedAt !== undefined || isEmployerLink(a.applyUrl)) continue;
      const job = jobsById.get(a.jobId);
      if (!job || recruiterEmailIn(job.description)) continue;
      const other = wayOutByKey.get(dedupeKey(job));
      if (!other || other.id === job.id) continue;
      const otherLink = other.applyUrl ?? other.url;
      const moved: Application = { ...a, jobId: other.id, ...(isEmployerLink(otherLink) ? { applyUrl: otherLink } : {}) };
      await this.deps.repository.updateApplication(moved);
      existing.splice(existing.indexOf(a), 1, moved);
    }

    // A job first seen with a job board's link may later give the employer's own (Reed's externalUrl):
    // an unsent application still on the board's link takes the employer's.
    for (const a of [...existing]) {
      if ((a.status !== 'draft' && a.status !== 'needs_you' && a.status !== 'confirmed') || a.attemptedAt !== undefined) continue;
      const job = jobsById.get(a.jobId);
      const jobLink = job?.applyUrl;
      if (!jobLink || jobLink === a.applyUrl || isEmployerLink(a.applyUrl) || !isEmployerLink(jobLink)) continue;
      const linked: Application = { ...a, applyUrl: jobLink };
      await this.deps.repository.updateApplication(linked);
      existing.splice(existing.indexOf(a), 1, linked);
    }

    // Unsent drafts are scored again with today's matcher: one that no longer reaches the bar is
    // closed (it was prepared under an older, looser score). The person's approved ones are left alone.
    let closedBelowBar = 0;
    for (const a of [...existing]) {
      if ((a.status !== 'draft' && a.status !== 'needs_you' && a.status !== 'confirmed') || a.attemptedAt !== undefined) continue;
      const job = jobsById.get(a.jobId);
      if (!job) continue;
      const now = matchJob(job, profile.cvText, passport, preferences);
      // Approved applications and jobs the person chose stay open, but show today's score, the
      // same one the review page shows; an approved one under MIN_KEEP_SCORE is closed (owner's
      // request, 8 October 2026: nothing under 70% is shown or sent).
      const keep = job.source === 'link' || now.score >= threshold || (a.status === 'confirmed' && now.score >= MIN_KEEP_SCORE);
      if (keep) {
        if (now.score !== a.score) {
          const rescored: Application = { ...a, score: now.score };
          await this.deps.repository.updateApplication(rescored);
          existing.splice(existing.indexOf(a), 1, rescored);
        }
        continue;
      }
      const closed: Application = { ...a, status: 'closed', score: now.score };
      await this.deps.repository.updateApplication(closed);
      existing.splice(existing.indexOf(a), 1, closed);
      closedBelowBar += 1;
    }

    // Drafts written without AI because the daily AI budget was used up are written again with AI
    // once it is available: the old draft is closed and a new one takes its place.
    // Also any unsent one written without AI before AI was set up (approved ones too: the new draft
    // goes the same way), unless the person edited its statement: their words are kept.
    let redrafted = 0;
    const edited = this.deps.llm
      ? new Set((await this.deps.repository.listEvents(userId)).filter((e) => e.type === 'application.statement.edited').map((e) => String(e.payload.applicationId)))
      : new Set<string>();
    for (const a of [...existing]) {
      if (redrafted >= REDRAFTS_PER_RUN) break;
      if ((a.status !== 'draft' && a.status !== 'needs_you' && a.status !== 'confirmed') || a.attemptedAt !== undefined) continue;
      const withoutAi = a.holdReasons?.includes('llm-ceiling') || (a.statementSource === 'fallback' && !edited.has(a.id));
      if (!withoutAi) continue;
      if (!this.deps.llm || (await this.llmCeilingReached(userId))) break;
      const job = jobsById.get(a.jobId);
      if (!job) continue;
      const match = matchJob(job, profile.cvText, passport, preferences);
      if (!match.eligible) continue;
      const closed: Application = { ...a, status: 'closed' };
      await this.deps.repository.updateApplication(closed);
      existing.splice(existing.indexOf(a), 1, closed);
      existing.push(await this.draftFor(userId, job, profile, passport, match, a.mode));
      redrafted += 1;
    }

    const skipped = { outOfScope: 0, belowThreshold: 0, ineligible: 0, alreadyPrepared: 0 };
    const candidates: { job: Job; match: MatchResult }[] = [];
    for (const job of jobs) {
      if (!inScope(job, preferences) || !payFits(job, pay)) {
        skipped.outOfScope += 1;
        continue;
      }
      const match = matchJob(job, profile.cvText, passport, preferences);
      if (match.score < threshold) skipped.belowThreshold += 1;
      else if (!match.eligible) skipped.ineligible += 1;
      else if (this.duplicateOf(existing, job, jobsById)) skipped.alreadyPrepared += 1;
      else candidates.push({ job, match });
    }
    candidates.sort((a, b) => b.match.score - a.match.score || a.job.id.localeCompare(b.job.id));

    const prepared: Application[] = [];
    for (const { job, match } of candidates) {
      // The same vacancy can arrive twice in one run (two sources): the second is a duplicate.
      if (this.duplicateOf([...existing, ...prepared], job, jobsById)) {
        skipped.alreadyPrepared += 1;
        continue;
      }
      prepared.push(await this.draftFor(userId, job, profile, passport, match, input.mode));
    }

    await this.emit(userId, 'agent.run', { threshold, considered: jobs.length, prepared: prepared.length, ...skipped, closedOtherField, closedDuplicates, closedBelowBar, closedBelowPay, redrafted, advertsRead });
    return { threshold, mode: input.mode, considered: jobs.length, prepared, skipped, closedOtherField, closedDuplicates, closedBelowBar, closedBelowPay, redrafted, advertsRead };
  }

  /** The score the agent needs before it prepares or sends an application on its own, and why. */
  async automaticBar(userId: string) {
    const preferences = preferencesOf(await this.deps.repository.getProfile(userId));
    const applications = await this.deps.repository.listApplications(userId);
    return automaticBar(applications, Math.max(applyThresholdOf(this.deps.config), preferences.minScore ?? 0), preferences.targetInterviewRate);
  }

  /** Interviews out of recorded outcomes, by match-score band, with the automatic bar. */
  async interviewRates(userId: string) {
    const applications = await this.deps.repository.listApplications(userId);
    return { bands: interviewRates(applications), bar: await this.automaticBar(userId) };
  }

  /** Ready applications in the order the agent sends them (employers that interviewed the person first). */
  async automaticOrder(userId: string) {
    const preferences = preferencesOf(await this.deps.repository.getProfile(userId));
    const interviewed = interviewedEmployers(await this.deps.repository.listApplications(userId));
    return automaticOrder(interviewed, (a) => targetEmployerOf({ employer: a.employer, description: '' }, preferences.targetEmployers) !== undefined);
  }

  private async mustGetApplication(userId: string, id: string): Promise<Application> {
    const application = await this.deps.repository.getApplication(userId, id);
    if (!application) throw new NotFoundException(`Application ${id} not found`);
    return application;
  }

  getApplication(userId: string, id: string): Promise<Application> {
    return this.mustGetApplication(userId, id);
  }

  /** Replaces the statement with the user's own edit. Not allowed once the application is submitted. */
  async editStatement(userId: string, id: string, input: StatementInput): Promise<Application> {
    const application = await this.mustGetApplication(userId, id);
    if (application.status === 'submitted') throw new ConflictException('Application has already been submitted');
    // The edit is traced like a draft: the agent never sends a sentence the CV cannot support.
    const profile = await this.getProfile(userId);
    const passport = (await this.deps.repository.getPassport(userId)) ?? EMPTY_PASSPORT;
    const job = (await this.deps.repository.getJob(application.jobId)) ?? { title: application.jobTitle, employer: application.employer, location: '' };
    const traceFailures = OpennJobService.traceOf(input.statement, application.tailoredCv ?? '', job, profile, passport);
    const edited: Application = { ...application, statement: input.statement };
    if (traceFailures.length > 0) edited.traceFailures = traceFailures;
    else delete edited.traceFailures;
    const updated = traceFailures.length > 0 ? withHolds(edited, ['trace-check']) : withHolds(edited, [], (h) => h === 'trace-check');
    await this.deps.repository.updateApplication(updated);
    await this.emit(userId, 'application.statement.edited', { applicationId: id, statementCharacters: input.statement.length });
    return updated;
  }

  /** Records which fields the user explicitly confirmed. This is the audit trail for sensitive fields. */
  async confirmApplication(userId: string, id: string, input: ConfirmApplicationInput): Promise<Application> {
    const application = await this.mustGetApplication(userId, id);
    if (application.status === 'submitted') throw new ConflictException('Application has already been submitted');
    // Confirming is the person reading the documents and taking them as their own, so the
    // truth-check and AI-ceiling holds end here. The failures stay recorded on the application.
    const updated: Application = withHolds(
      { ...application, status: 'confirmed', confirmedFields: [...new Set([...application.confirmedFields, ...input.confirmedFields])], confirmedAt: this.now() },
      [],
      (h) => h === 'trace-check' || h === 'llm-ceiling',
    );
    if (updated.status === 'draft') updated.status = 'confirmed';
    await this.deps.repository.updateApplication(updated);
    await this.emit(userId, 'application.confirmed', { applicationId: id, confirmedFieldCount: updated.confirmedFields.length });
    return updated;
  }

  /** Records that the form was submitted (by the user, or by the agent in auto mode on a form with no sensitive fields). */
  /**
   * The person dealt with something on the employer's site (signed in once, completed a CAPTCHA
   * themselves, fixed a step it refused) and asks the queue to try again. Only those holds are
   * cleared; a declaration, a question, the truth check and the AI hold stay until their own steps.
   * Only before anything was submitted.
   */
  /**
   * The person gives the employer's own application link for a job found on a job board or an
   * aggregator, so the queue can apply there (on a switched-on application system). Only before
   * anything was attempted; https only; never a job board's own page.
   */
  async setApplyUrl(userId: string, id: string, input: { url: string }): Promise<Application> {
    const application = await this.mustGetApplication(userId, id);
    if (application.status === 'submitted' || application.status === 'closed' || application.attemptedAt !== undefined) throw new ConflictException('This application can no longer be changed');
    if (!isEmployerLink(input.url)) throw new BadRequestException("That is a job board's or an aggregator's page. Give the employer's own application page.");
    const updated: Application = { ...application, applyUrl: input.url };
    await this.deps.repository.updateApplication(updated);
    await this.emit(userId, 'application.apply_url', { applicationId: id });
    return updated;
  }

  async retryApplication(userId: string, id: string): Promise<Application> {
    const application = await this.mustGetApplication(userId, id);
    if (application.status === 'submitted' || application.status === 'closed' || application.attemptedAt !== undefined) throw new ConflictException('This application can no longer be retried');
    const retryable = (h: string) => RETRYABLE_HOLD.test(h);
    const updated = withHolds(application, [], retryable);
    await this.deps.repository.updateApplication(updated);
    await this.emit(userId, 'application.retry', { applicationId: id, holdsLeft: updated.holdReasons?.length ?? 0 });
    return updated;
  }

  /**
   * The daily review: the person skips an application so that it never goes out automatically.
   * Only before anything was attempted; it is closed and stays in the Tracker under "closed".
   */
  async skipApplication(userId: string, id: string): Promise<Application> {
    const application = await this.mustGetApplication(userId, id);
    if (!['draft', 'needs_you', 'confirmed'].includes(application.status) || application.attemptedAt !== undefined) {
      throw new ConflictException('Only an application that has not been sent or attempted can be skipped');
    }
    const updated: Application = { ...application, status: 'closed', skippedAt: this.now() };
    await this.deps.repository.updateApplication(updated);
    await this.emit(userId, 'application.skipped', { applicationId: id });
    return updated;
  }

  /** What came of a sent application, as the person records it: interview, rejected or no reply. */
  async recordOutcome(userId: string, id: string, input: OutcomeInput): Promise<Application> {
    const application = await this.mustGetApplication(userId, id);
    if (!application.submittedAt) throw new ConflictException('Record an outcome only for an application that was sent');
    const updated: Application = { ...application, outcome: input.outcome, outcomeAt: this.now(), status: input.outcome === 'interview' ? 'interview' : 'closed' };
    await this.deps.repository.updateApplication(updated);
    await this.emit(userId, 'application.outcome', { applicationId: id, outcome: input.outcome });
    return updated;
  }

  async markSubmitted(userId: string, id: string, input: SubmittedInput): Promise<Application> {
    const application = await this.mustGetApplication(userId, id);
    if (application.status === 'submitted') throw new ConflictException('Application has already been submitted');
    return this.recordSubmission(application, { ...input, documentsSha256: {} }, false);
  }

  /**
   * APP-7: an application becomes submitted only with a receipt: when, the page address,
   * the site's own confirmation text, and the documents sent (TAI-6).
   */
  async recordSubmission(application: Application, input: { pageUrl: string; confirmationText: string; documentsSha256: Record<string, string> }, automatic: boolean): Promise<Application> {
    const userId = application.userId;
    const id = application.id;
    // TAI-6: the exact documents, as they stand at submission, kept with the application (encrypted at rest).
    const tailoredCv = application.tailoredCv ?? '';
    const sentDocuments = { statement: application.statement, tailoredCv, sha256: { statement: sha256(application.statement), tailoredCv: sha256(tailoredCv) } };
    const at = this.now();
    const receipt = { at, pageUrl: input.pageUrl, confirmationText: input.confirmationText, documentsSha256: Object.keys(input.documentsSha256).length > 0 ? input.documentsSha256 : sentDocuments.sha256, automatic };
    const updated: Application = { ...application, status: 'submitted', submittedAt: at, sentDocuments, receipt, ...(automatic ? { automatic: true } : {}) };
    delete updated.holdReasons;
    await this.deps.repository.updateApplication(updated);
    await this.emit(userId, 'application.submitted', { applicationId: id, mode: application.mode, wasConfirmed: application.status === 'confirmed', automatic });
    return updated;
  }

  async listApplications(userId: string): Promise<Application[]> {
    const all = await this.deps.repository.listApplications(userId);
    return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  // ----- interview practice ---------------------------------------------------------

  questions(role?: HealthcareRole, category?: QuestionCategory) {
    return questionsFor(role, category);
  }

  /** The question bank of one industry pack (French questions included for the francophone pack). */
  packQuestions(pack: string) {
    return questionsForPack(pack as PackId);
  }

  async interviewFeedback(userId: string, input: InterviewFeedbackInput) {
    const bankQuestion = input.questionId ? findQuestion(input.questionId) : undefined;
    const packQuestion = input.questionId && !bankQuestion ? findPackQuestion(input.questionId) : undefined;
    if (input.questionId && !bankQuestion && !packQuestion) throw new NotFoundException(`Question ${input.questionId} not found. See GET /interview/questions.`);
    const question = bankQuestion?.text ?? packQuestion?.text ?? (input.question as string);
    const feedback = await scoreAnswer(
      { question, answer: input.answer, ...(bankQuestion ? { lookFor: bankQuestion.lookFor } : {}) },
      this.llmFor(userId, 'interview-feedback'),
    );
    await this.emit(userId, 'interview.feedback', { questionId: bankQuestion?.id ?? packQuestion?.id ?? 'custom', total: feedback.total, source: feedback.source });
    return { question, lookFor: bankQuestion?.lookFor ?? [], feedback };
  }

  /** Questions built from the advert and the documents this application actually sent (INT-1). */
  async interviewForApplication(userId: string, id: string) {
    const application = await this.mustGetApplication(userId, id);
    if (!application.sentDocuments) throw new ConflictException('This application has no sent documents yet. Interview preparation uses what was sent.');
    const job = await this.deps.repository.getJob(application.jobId);
    const advert = job ?? { title: application.jobTitle, description: '', criteria: [] };
    const interview = interviewFromDocuments(application.id, advert, application.sentDocuments);
    await this.emit(userId, 'interview.prepared', { applicationId: id, questions: interview.questions.length, gaps: interview.gaps.length });
    return { jobTitle: application.jobTitle, employer: application.employer, ...interview };
  }

  async interviewFeedbackForApplication(userId: string, id: string, input: { questionId: string; answer: string }) {
    const prepared = await this.interviewForApplication(userId, id);
    const q = prepared.questions.find((x) => x.id === input.questionId);
    if (!q) throw new NotFoundException(`Question ${input.questionId} not found for this application`);
    const feedback = await scoreAnswer({ question: q.question, answer: input.answer, lookFor: q.lookFor }, this.llmFor(userId, 'interview-feedback'));
    await this.emit(userId, 'interview.feedback', { questionId: q.id, applicationId: id, total: feedback.total, source: feedback.source });
    return { question: q.question, lookFor: q.lookFor, feedback };
  }

  // ----- usage ----------------------------------------------------------------------

  async usage(userId: string) {
    return { totals: await this.deps.usageMeter.totals(userId), records: await this.deps.usageMeter.list(userId) };
  }
}
