import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  APPLICATION_SYSTEMS,
  EMPTY_PASSPORT,
  EMPTY_SCREENING,
  STANDING_SCOPE_TEXT,
  STANDING_SCOPE_VERSION,
  applicationSystemFor,
  buildFillValues,
  customAnswers,
  inferPlace,
  screeningFillValues,
  screeningKey,
  screeningRefusal,
  workRightsContext,
  zonedDate,
} from '@opennjob/core';
import type { Application, ApplicationSystemSetting, ScreeningAnswers, StandingAuthorisation } from '@opennjob/core';
import { DEPS } from './deps';
import type { OpennJobDeps } from './deps';
import type { ApplicationSystemInput, AuthorisationInput, PauseInput, QuestionAnswerInput, QueueResultInput, ScreeningInput } from './schemas';
import { OpennJobService, withHolds } from './services';

const OPERATOR_PAUSE = 'agent.paused';
const systemKey = (id: string) => `application-system.${id}`;

/** Why the queue has nothing to hand out right now. */
export type QueueWait = 'not-authorised' | 'paused' | 'operator-paused' | 'email-unverified' | 'daily-limit' | 'empty';

const WAIT_MESSAGE: Record<QueueWait, string> = {
  'not-authorised': 'Standing authorisation is off. Nothing is sent without you.',
  paused: 'You have paused the agent.',
  'operator-paused': 'The operator has paused the agent for everyone.',
  'email-unverified': 'Verify your email address before OpennJob sends anything for you.',
  'daily-limit': "Today's limit is reached. The queue starts again at midnight (London).",
  empty: 'Nothing is ready to send.',
};

/** Hold reasons the extension may report, and the prefixes that carry a detail. */
const QUESTION_PREFIX = 'question:';

/**
 * Applying on the person's behalf (APP-2, APP-3, APP-7, APP-9, APP-10, SCR-1 to SCR-3).
 *
 * The queue runs in the person's own browser (OD-4): the extension asks for the next
 * application, fills it there, asks again for the go just before pressing submit, and
 * reports what happened. The form rules are the policy's (packages/core/src/policy.ts),
 * unchanged: a form with any sensitive field or declaration is never submitted by the
 * agent, and is held for the person instead (OD-1).
 */
@Injectable()
export class ApplyingService {
  constructor(
    @Inject(DEPS) private readonly deps: OpennJobDeps,
    @Inject(OpennJobService) private readonly service: OpennJobService,
  ) {}

  private now(): string {
    return this.deps.clock().toISOString();
  }

  private async emit(userId: string, type: string, payload: Record<string, unknown>): Promise<void> {
    await this.deps.eventBus.publish({ id: this.deps.newId(), type, userId, occurredAt: this.now(), payload });
  }

  // ----- standing authorisation and pauses --------------------------------------------

  private async authorisationOf(userId: string): Promise<StandingAuthorisation> {
    return (await this.deps.repository.getAuthorisation(userId)) ?? { enabled: false, scopeVersion: STANDING_SCOPE_VERSION, paused: false };
  }

  async getAuthorisation(userId: string) {
    const a = await this.authorisationOf(userId);
    // Consent to an earlier wording is not consent to this one.
    const current = a.enabled && a.scopeVersion === STANDING_SCOPE_VERSION;
    return { ...a, enabled: current, scope: { version: STANDING_SCOPE_VERSION, text: STANDING_SCOPE_TEXT } };
  }

  /** APP-2: explicit and dated to turn on, to the current wording; one call to turn off. */
  async setAuthorisation(userId: string, input: AuthorisationInput) {
    const before = await this.authorisationOf(userId);
    const at = this.now();
    let next: StandingAuthorisation;
    if (input.enabled) {
      if (input.scopeVersion !== STANDING_SCOPE_VERSION) {
        throw new BadRequestException({ statusCode: 400, error: 'Bad Request', message: 'Turning on standing authorisation needs agreement to the current wording', scope: { version: STANDING_SCOPE_VERSION, text: STANDING_SCOPE_TEXT } });
      }
      next = { enabled: true, scopeVersion: STANDING_SCOPE_VERSION, consentAt: at, paused: before.paused };
    } else {
      next = { ...before, enabled: false, revokedAt: at };
    }
    await this.deps.repository.saveAuthorisation(userId, next);
    await this.emit(userId, input.enabled ? 'agent.authorised' : 'agent.authorisation_revoked', { scopeVersion: next.scopeVersion });
    return this.getAuthorisation(userId);
  }

  /** APP-10: the person's pause. */
  async setPause(userId: string, input: PauseInput) {
    const before = await this.authorisationOf(userId);
    await this.deps.repository.saveAuthorisation(userId, { ...before, paused: input.paused });
    await this.emit(userId, input.paused ? 'agent.paused' : 'agent.resumed', {});
    return this.getAuthorisation(userId);
  }

  /** APP-10: the operator's pause, for everyone. */
  async setOperatorPause(input: PauseInput) {
    await this.deps.repository.setPlatformSetting(OPERATOR_PAUSE, { paused: input.paused, at: this.now() });
    return this.operatorStatus();
  }

  private async operatorPaused(): Promise<boolean> {
    return (await this.deps.repository.getPlatformSetting<{ paused: boolean }>(OPERATOR_PAUSE))?.paused === true;
  }

  // ----- application systems (APP-9) --------------------------------------------------

  private async systemSetting(id: string): Promise<ApplicationSystemSetting> {
    return (await this.deps.repository.getPlatformSetting<ApplicationSystemSetting>(systemKey(id))) ?? { enabled: false };
  }

  async systems() {
    return Promise.all(APPLICATION_SYSTEMS.filter((s) => !(s.testOnly && this.deps.config.production)).map(async (s) => ({ id: s.id, label: s.label, ...(await this.systemSetting(s.id)) })));
  }

  /** Enabling needs the evidence: the terms check and one supervised real submission. */
  async setSystem(id: string, input: ApplicationSystemInput) {
    const system = APPLICATION_SYSTEMS.find((s) => s.id === id);
    if (!system) throw new NotFoundException(`Application system ${id} not found`);
    if (system.testOnly && this.deps.config.production) throw new ForbiddenException('This application system exists for the tests only');
    if (input.enabled && (!input.termsCheckedAt || !input.supervisedSubmissionAt)) {
      throw new BadRequestException('Enabling an application system needs termsCheckedAt and supervisedSubmissionAt');
    }
    const setting: ApplicationSystemSetting = { enabled: input.enabled, ...(input.termsCheckedAt ? { termsCheckedAt: input.termsCheckedAt } : {}), ...(input.supervisedSubmissionAt ? { supervisedSubmissionAt: input.supervisedSubmissionAt } : {}), ...(input.note ? { note: input.note } : {}) };
    await this.deps.repository.setPlatformSetting(systemKey(id), setting);
    return { id, label: system.label, ...setting };
  }

  async operatorStatus() {
    return { paused: await this.operatorPaused(), systems: await this.systems() };
  }

  private async systemEnabledFor(url: string): Promise<boolean> {
    const system = applicationSystemFor(url);
    if (!system || (system.testOnly && this.deps.config.production)) return false;
    return (await this.systemSetting(system.id)).enabled;
  }

  // ----- the queue (APP-3) ------------------------------------------------------------

  /** The first reason nothing may be sent for this person now, or undefined. */
  private async blocked(userId: string): Promise<{ wait: QueueWait; resetsAt?: string } | undefined> {
    const a = await this.getAuthorisation(userId);
    if (!a.enabled) return { wait: 'not-authorised' };
    // ACC-2: nothing is submitted for an account whose e-mail address is not verified.
    if (!(await this.deps.repository.getUserById(userId))?.emailVerifiedAt) return { wait: 'email-unverified' };
    if (await this.operatorPaused()) return { wait: 'operator-paused' };
    if (a.paused) return { wait: 'paused' };
    const limit = await this.service.dailyLimit(userId);
    if (limit.remaining <= 0) return { wait: 'daily-limit', resetsAt: limit.resetsAt };
    return undefined;
  }

  private static queueable(a: Application): boolean {
    return a.mode === 'auto' && (a.status === 'draft' || a.status === 'confirmed') && !(a.holdReasons?.length) && !(a.traceFailures?.length) && a.attemptedAt === undefined;
  }

  private async ready(userId: string): Promise<{ ready: Application[]; systemOff: number }> {
    const ready: Application[] = [];
    let systemOff = 0;
    for (const a of await this.deps.repository.listApplications(userId)) {
      if (!ApplyingService.queueable(a)) continue;
      if (await this.systemEnabledFor(a.applyUrl)) ready.push(a);
      else systemOff += 1;
    }
    ready.sort((x, y) => y.score - x.score || x.createdAt.localeCompare(y.createdAt) || x.id.localeCompare(y.id));
    return { ready, systemOff };
  }

  async status(userId: string) {
    const all = await this.deps.repository.listApplications(userId);
    const { ready, systemOff } = await this.ready(userId);
    const block = await this.blocked(userId);
    return {
      authorisation: await this.getAuthorisation(userId),
      operatorPaused: await this.operatorPaused(),
      dailyLimit: await this.service.dailyLimit(userId),
      queue: { ready: ready.length, waitingForSystem: systemOff, needsYou: all.filter((a) => a.status === 'needs_you').length },
      ...(block ? { wait: block.wait, message: WAIT_MESSAGE[block.wait], ...(block.resetsAt ? { resetsAt: block.resetsAt } : {}) } : {}),
      systems: (await this.systems()).map((s) => ({ id: s.id, label: s.label, enabled: s.enabled })),
    };
  }

  /** The next application for the extension to work on, with everything it may fill. */
  async next(userId: string) {
    const block = await this.blocked(userId);
    if (block) return { wait: block.wait, message: WAIT_MESSAGE[block.wait], ...(block.resetsAt ? { resetsAt: block.resetsAt } : {}) };
    const [application] = (await this.ready(userId)).ready;
    if (!application) return { wait: 'empty' as const, message: WAIT_MESSAGE.empty };
    const profile = await this.service.getProfile(userId);
    const passport = (await this.deps.repository.getPassport(userId)) ?? EMPTY_PASSPORT;
    const screening = (await this.deps.repository.getScreeningAnswers(userId)) ?? EMPTY_SCREENING;
    // The job's country, for right to work and sponsorship from the person's own record (OD-5).
    const job = await this.deps.repository.getJob(application.jobId);
    const jobCountry = job?.country ?? inferPlace(job?.location).country;
    const today = zonedDate(this.deps.clock());
    const workRights = workRightsContext(passport, jobCountry, today);
    return {
      application: { id: application.id, jobTitle: application.jobTitle, employer: application.employer, applyUrl: application.applyUrl, score: application.score },
      values: { ...buildFillValues(profile, passport, application.statement, { ...(jobCountry ? { jobCountry } : {}), today }), ...screeningFillValues(screening) },
      custom: customAnswers(screening),
      ...(workRights ? { workRights } : {}),
    };
  }

  /**
   * Asked immediately before pressing submit. Everything is checked again, so revoking,
   * pausing (by the person or the operator) or reaching the limit stops a submission
   * that was already being filled (T-09, T-22). The go is given once per application.
   */
  async go(userId: string, id: string) {
    const application = await this.service.getApplication(userId, id);
    const block = await this.blocked(userId);
    if (block) return { go: false, reason: block.wait, message: WAIT_MESSAGE[block.wait] };
    if (!ApplyingService.queueable(application)) return { go: false, reason: 'not-queued', message: 'This application is not waiting in the queue.' };
    if (!(await this.systemEnabledFor(application.applyUrl))) return { go: false, reason: 'system-not-enabled', message: 'This application system has not been enabled.' };
    if (!(await this.deps.repository.claimOnce(`submit:${userId}:${id}`, this.now()))) return { go: false, reason: 'already-attempted', message: 'This application was already attempted.' };
    await this.deps.repository.updateApplication({ ...application, automatic: true, attemptedAt: this.now() });
    await this.emit(userId, 'agent.submitting', { applicationId: id });
    return { go: true };
  }

  /** What happened on the page. "submitted" needs the go first and a receipt (APP-7, T-11). */
  async result(userId: string, id: string, input: QueueResultInput) {
    const application = await this.service.getApplication(userId, id);
    if (application.status === 'submitted') throw new ConflictException('Application has already been submitted');
    if (input.outcome === 'held') {
      const updated = withHolds(application, input.reasons);
      await this.deps.repository.updateApplication(updated);
      await this.emit(userId, 'application.needs_you', { applicationId: id, reasons: input.reasons.length });
      return updated;
    }
    if (application.automatic !== true || application.attemptedAt === undefined) throw new ConflictException('The agent did not have the go for this application');
    if (input.outcome === 'uncertain') {
      const updated: Application = { ...application, status: 'uncertain' };
      await this.deps.repository.updateApplication(updated);
      await this.emit(userId, 'application.uncertain', { applicationId: id });
      return updated;
    }
    return this.service.recordSubmission(application, input.receipt, true);
  }

  // ----- screening answers (SCR-1 to SCR-3) -------------------------------------------

  async getScreening(userId: string): Promise<ScreeningAnswers> {
    return (await this.deps.repository.getScreeningAnswers(userId)) ?? { custom: {} };
  }

  async saveScreening(userId: string, input: ScreeningInput): Promise<ScreeningAnswers> {
    const refused = Object.keys(input.custom).map((q) => ({ q, why: screeningRefusal(q) })).filter((r) => r.why);
    if (refused.length > 0) {
      throw new BadRequestException({ statusCode: 400, error: 'Bad Request', message: 'Declarations and other sensitive questions are not stored', issues: refused.map((r) => ({ path: `custom.${r.q}`, message: r.why })) });
    }
    const answers = JSON.parse(JSON.stringify(input)) as ScreeningAnswers;
    await this.deps.repository.saveScreeningAnswers(userId, answers);
    await this.emit(userId, 'screening.saved', { custom: Object.keys(answers.custom).length });
    return answers;
  }

  /**
   * SCR-2: the person answers a question that held an application. The answer is saved
   * for next time and the hold for that question is lifted.
   */
  async answerQuestion(userId: string, id: string, input: QuestionAnswerInput): Promise<Application> {
    const application = await this.service.getApplication(userId, id);
    const why = screeningRefusal(input.question);
    if (why) throw new BadRequestException(why);
    const screening = await this.getScreening(userId);
    await this.deps.repository.saveScreeningAnswers(userId, { ...screening, custom: { ...screening.custom, [input.question]: input.answer } });
    const key = screeningKey(input.question);
    const updated = withHolds(application, [], (h) => h.startsWith(QUESTION_PREFIX) && screeningKey(h.slice(QUESTION_PREFIX.length)) === key);
    await this.deps.repository.updateApplication(updated);
    await this.emit(userId, 'screening.saved', { custom: Object.keys(screening.custom).length + 1 });
    return updated;
  }
}
