import { ConflictException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import {
  EMPTY_PASSPORT,
  checkTraining,
  collectJobs,
  credentialLabel,
  draftStatement,
  extractCriteria,
  SYSTEM_USER_ID,
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
  trainingWarnings,
} from '@opennjob/core';
import type { Application, HealthcareRole, Job, LlmPort, MatchResult, Mode, PackId, Passport, Profile, QuestionCategory } from '@opennjob/core';
import { DEPS, applyThresholdOf } from './deps';
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
} from './schemas';

/** zod leaves `undefined` on absent optional keys; drop them so stored objects are clean. */
function compact<T extends object>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

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

  async getProfile(userId: string): Promise<Profile> {
    const profile = await this.deps.repository.getProfile(userId);
    if (!profile) throw new NotFoundException('No profile saved yet. PUT /profile first.');
    return profile;
  }

  private passportView(passport: Passport) {
    return { passport, training: checkTraining(passport.training, this.deps.clock) };
  }

  async savePassport(userId: string, input: PassportInput) {
    const passport = compact(input) as Passport;
    await this.deps.repository.savePassport(userId, passport);
    await this.emit(userId, 'passport.updated', { trainingRecords: passport.training.length, referees: passport.referees.length, hasNmcPin: Boolean(nmcPinOf(passport)), credentials: Object.keys(passport.credentials ?? {}).length });
    return this.passportView(passport);
  }

  async getPassport(userId: string) {
    const passport = await this.deps.repository.getPassport(userId);
    if (!passport) throw new NotFoundException('No passport saved yet. PUT /passport first.');
    return this.passportView(passport);
  }

  // ----- jobs -----------------------------------------------------------------------

  async refreshJobs(userId: string) {
    const collected = await collectJobs(this.deps.sources);
    let jobs: Job[] = collected.jobs;
    let llmExtracted = 0;

    const llm = this.deps.config.llmCriteria ? this.llmFor(userId, 'criteria-extraction') : undefined;
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
        } else if (llmExtracted < this.deps.config.llmCriteriaMaxJobs) {
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
      sources: this.deps.sources.map((s) => s.label),
      fetched: collected.fetched,
      duplicatesRemoved: collected.duplicates,
      stored: jobs.length,
      new: added,
      criteriaFromLlm: llmExtracted,
      errors: collected.errors,
    };
    await this.emit(userId, 'jobs.refreshed', { fetched: summary.fetched, stored: summary.stored, new: added, sourceErrors: summary.errors.length });
    return summary;
  }

  private static matchView(job: Job, match: MatchResult) {
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
    const jobs = await this.deps.repository.listJobs();
    return jobs
      .filter((job) => inScope(job, preferences))
      .filter((job) => (!filters.pack || job.pack === filters.pack) && (!filters.region || job.region === filters.region) && (!filters.country || job.country === filters.country))
      .map((job) => OpennJobService.matchView(job, matchJob(job, profile.cvText, passport, preferences)))
      .filter((m) => m.score >= min)
      .sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.score - a.score || a.job.id.localeCompare(b.job.id));
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

  /** Drafts and stores one application. The caller has already checked eligibility. */
  private async draftFor(userId: string, job: Job, profile: Profile, passport: Passport, match: MatchResult, mode: Mode): Promise<Application> {
    const draft = await draftStatement({ job, cvText: profile.cvText, match }, this.llmFor(userId, 'supporting-statement'));
    const application: Application = {
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
    };
    await this.deps.repository.createApplication(application);
    await this.emit(userId, 'application.drafted', { applicationId: application.id, jobId: job.id, mode: application.mode, statementSource: draft.source, score: match.score, gaps: draft.gaps.length });
    return application;
  }

  async createApplication(userId: string, input: CreateApplicationInput): Promise<Application> {
    const profile = await this.getProfile(userId);
    const job = await this.deps.repository.getJob(input.jobId);
    if (!job) throw new NotFoundException(`Job ${input.jobId} not found. Run POST /jobs/refresh and use an id from GET /jobs/matches.`);
    const passport = (await this.deps.repository.getPassport(userId)) ?? EMPTY_PASSPORT;
    const match = matchJob(job, profile.cvText, passport, preferencesOf(profile));
    if (!match.eligible) throw new UnprocessableEntityException(OpennJobService.ineligibleMessage(match));
    return this.draftFor(userId, job, profile, passport, match, input.mode);
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
    const threshold = applyThresholdOf(this.deps.config);
    const already = new Set((await this.deps.repository.listApplications(userId)).map((a) => a.jobId));
    const jobs = await this.deps.repository.listJobs();

    const skipped = { outOfScope: 0, belowThreshold: 0, ineligible: 0, alreadyPrepared: 0 };
    const candidates: { job: Job; match: MatchResult }[] = [];
    for (const job of jobs) {
      if (!inScope(job, preferences)) {
        skipped.outOfScope += 1;
        continue;
      }
      const match = matchJob(job, profile.cvText, passport, preferences);
      if (match.score < threshold) skipped.belowThreshold += 1;
      else if (!match.eligible) skipped.ineligible += 1;
      else if (already.has(job.id)) skipped.alreadyPrepared += 1;
      else candidates.push({ job, match });
    }
    candidates.sort((a, b) => b.match.score - a.match.score || a.job.id.localeCompare(b.job.id));

    const prepared: Application[] = [];
    for (const { job, match } of candidates) prepared.push(await this.draftFor(userId, job, profile, passport, match, input.mode));

    await this.emit(userId, 'agent.run', { threshold, considered: jobs.length, prepared: prepared.length, ...skipped });
    return { threshold, mode: input.mode, considered: jobs.length, prepared, skipped };
  }

  private async mustGetApplication(userId: string, id: string): Promise<Application> {
    const application = await this.deps.repository.getApplication(userId, id);
    if (!application) throw new NotFoundException(`Application ${id} not found`);
    return application;
  }

  getApplication(userId: string, id: string): Promise<Application> {
    return this.mustGetApplication(userId, id);
  }

  /** Records which fields the user explicitly confirmed. This is the audit trail for sensitive fields. */
  async confirmApplication(userId: string, id: string, input: ConfirmApplicationInput): Promise<Application> {
    const application = await this.mustGetApplication(userId, id);
    if (application.status === 'submitted') throw new ConflictException('Application has already been submitted');
    const updated: Application = {
      ...application,
      status: 'confirmed',
      confirmedFields: [...new Set([...application.confirmedFields, ...input.confirmedFields])],
      confirmedAt: this.now(),
    };
    await this.deps.repository.updateApplication(updated);
    await this.emit(userId, 'application.confirmed', { applicationId: id, confirmedFieldCount: updated.confirmedFields.length });
    return updated;
  }

  /** Records that the form was submitted (by the user, or by the agent in auto mode on a form with no sensitive fields). */
  async markSubmitted(userId: string, id: string): Promise<Application> {
    const application = await this.mustGetApplication(userId, id);
    if (application.status === 'submitted') throw new ConflictException('Application has already been submitted');
    const updated: Application = { ...application, status: 'submitted', submittedAt: this.now() };
    await this.deps.repository.updateApplication(updated);
    await this.emit(userId, 'application.submitted', { applicationId: id, mode: application.mode, wasConfirmed: application.status === 'confirmed' });
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

  // ----- usage ----------------------------------------------------------------------

  async usage(userId: string) {
    return { totals: await this.deps.usageMeter.totals(userId), records: await this.deps.usageMeter.list(userId) };
  }
}
