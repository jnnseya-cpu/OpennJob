import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import { CV_TYPES, CvError } from './cv';
import { AccountService } from './account.service';
import { ApplyingService } from './applying.service';
import { AuthRateLimitGuard, CurrentUser, EmployerRoute, OperatorRoute, Public } from './auth.guard';
import { DEPS } from './deps';
import type { OpennJobDeps } from './deps';
import { OpennJobService } from './services';
import {
  ZodPipe,
  agentRunSchema,
  deleteAccountSchema,
  loginSchema,
  registerSchema,
  verifyEmailSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  confirmApplicationSchema,
  employerJobSchema,
  matchFilterSchema,
  createApplicationSchema,
  interviewFeedbackSchema,
  applicationInterviewFeedbackSchema,
  minScoreSchema,
  passportSchema,
  profileSchema,
  questionQuerySchema,
  statementSchema,
  applicationSystemSchema,
  authorisationSchema,
  pauseSchema,
  questionAnswerSchema,
  queueResultSchema,
  screeningSchema,
  submittedSchema,
  outcomeSchema,
  refreshSchema,
} from './schemas';
import type { ApplicationSystemInput, AuthorisationInput, PauseInput, QuestionAnswerInput, QueueResultInput, ScreeningInput, SubmittedInput, OutcomeInput } from './schemas';
import type { DeleteAccountInput, ForgotPasswordInput, LoginInput, RefreshInput, RegisterInput, ResetPasswordInput, VerifyEmailInput } from './schemas';
import type { AgentRunInput, ConfirmApplicationInput, CreateApplicationInput, EmployerJobInput, InterviewFeedbackInput, MatchFilterInput, PassportInput, ProfileInput, StatementInput } from './schemas';

// Note: every constructor parameter uses an explicit @Inject(...) so the app does not
// depend on emitDecoratorMetadata (the test runner's transpiler does not emit it).

@Controller('health')
export class HealthController {
  constructor(@Inject(DEPS) private readonly deps: OpennJobDeps) {}

  /** Liveness and database connectivity. 200 when the store answers, 503 when it does not. No auth. */
  @Public()
  @Get()
  async health(@Res({ passthrough: true }) res: { status(code: number): unknown }) {
    const database = await this.deps.repository.ping().then(
      () => 'up' as const,
      () => 'down' as const,
    );
    if (database === 'down') res.status(503);
    // The commit the server was started from (deploy/update.sh and auto-update set OPENNJOB_VERSION).
    const version = (process.env.OPENNJOB_VERSION ?? '').trim() || 'unknown';
    return { status: database === 'up' ? 'ok' : 'degraded', persistence: this.deps.persistence, database, version };
  }
}

@Controller('auth')
export class AuthController {
  constructor(@Inject(AccountService) private readonly accounts: AccountService) {}

  /** The versions of the terms and privacy notice that registration must accept. */
  @Public()
  @Get('versions')
  versions() {
    return this.accounts.versions();
  }

  // Only the routes that check credentials or create accounts are rate limited. Reading the
  // versions is not an attempt at anything, and must not lock a person out of signing in.
  @Public()
  @UseGuards(AuthRateLimitGuard)
  @Post('register')
  register(@Body(new ZodPipe(registerSchema)) body: RegisterInput) {
    return this.accounts.register(body);
  }

  @Public()
  @UseGuards(AuthRateLimitGuard)
  @Post('login')
  @HttpCode(200)
  login(@Body(new ZodPipe(loginSchema)) body: LoginInput) {
    return this.accounts.login(body);
  }

  /** "Keep me signed in": a refresh token for a new session (rotated on every use). */
  @Public()
  @UseGuards(AuthRateLimitGuard)
  @Post('refresh')
  @HttpCode(200)
  refresh(@Body(new ZodPipe(refreshSchema)) body: RefreshInput) {
    return this.accounts.refresh(body);
  }

  /** Signing out on a "keep me signed in" device: every refresh token of the account stops working. */
  @Public()
  @UseGuards(AuthRateLimitGuard)
  @Post('logout')
  @HttpCode(200)
  logout(@Body(new ZodPipe(refreshSchema)) body: RefreshInput) {
    return this.accounts.logout(body);
  }

  /** ACC-2: the link from the verification e-mail. */
  @Public()
  @UseGuards(AuthRateLimitGuard)
  @Post('verify-email')
  @HttpCode(200)
  verifyEmail(@Body(new ZodPipe(verifyEmailSchema)) body: VerifyEmailInput) {
    return this.accounts.verifyEmail(body);
  }

  /** ACC-3: always 200, whether or not the address has an account. */
  @Public()
  @UseGuards(AuthRateLimitGuard)
  @Post('password/forgot')
  @HttpCode(200)
  forgot(@Body(new ZodPipe(forgotPasswordSchema)) body: ForgotPasswordInput) {
    return this.accounts.forgotPassword(body);
  }

  @Public()
  @UseGuards(AuthRateLimitGuard)
  @Post('password/reset')
  @HttpCode(200)
  reset(@Body(new ZodPipe(resetPasswordSchema)) body: ResetPasswordInput) {
    return this.accounts.resetPassword(body);
  }
}

@Controller('account')
export class AccountController {
  constructor(@Inject(AccountService) private readonly accounts: AccountService) {}

  @Get()
  me(@CurrentUser() userId: string) {
    return this.accounts.me(userId);
  }

  @Get('export')
  export(@CurrentUser() userId: string) {
    return this.accounts.exportAccount(userId);
  }

  @Post('verification')
  @HttpCode(200)
  resendVerification(@CurrentUser() userId: string) {
    return this.accounts.resendVerification(userId);
  }

  @Delete()
  @HttpCode(200)
  remove(@CurrentUser() userId: string, @Body(new ZodPipe(deleteAccountSchema)) body: DeleteAccountInput) {
    return this.accounts.deleteAccount(userId, body);
  }
}

@Controller('profile')
export class ProfileController {
  constructor(@Inject(OpennJobService) private readonly service: OpennJobService) {}

  @Put()
  put(@CurrentUser() userId: string, @Body(new ZodPipe(profileSchema)) body: ProfileInput) {
    return this.service.saveProfile(userId, body);
  }

  @Get()
  get(@CurrentUser() userId: string) {
    return this.service.getProfile(userId);
  }

  /** PRO-1: a PDF or Word CV as text, for the person to check and edit. Nothing is saved here. */
  @Post('cv')
  @HttpCode(200)
  async cv(@CurrentUser() userId: string, @Req() req: { body?: unknown; headers: Record<string, string | string[] | undefined> }) {
    const type = String(req.headers['content-type'] ?? '').split(';')[0]?.trim() ?? '';
    if (!Buffer.isBuffer(req.body) || (type !== CV_TYPES.pdf && type !== CV_TYPES.docx)) {
      throw new BadRequestException('Send the file as application/pdf or the Word .docx type');
    }
    try {
      return await this.service.extractCv(userId, req.body, type);
    } catch (err) {
      if (err instanceof CvError) throw new BadRequestException(err.message);
      throw err;
    }
  }
}

@Controller('passport')
export class PassportController {
  constructor(@Inject(OpennJobService) private readonly service: OpennJobService) {}

  @Put()
  put(@CurrentUser() userId: string, @Body(new ZodPipe(passportSchema)) body: PassportInput) {
    return this.service.savePassport(userId, body);
  }

  @Get()
  get(@CurrentUser() userId: string) {
    return this.service.getPassport(userId);
  }
}

@Controller('jobs')
export class JobsController {
  constructor(@Inject(OpennJobService) private readonly service: OpennJobService) {}

  @Post('refresh')
  @HttpCode(200)
  refresh(@CurrentUser() userId: string) {
    return this.service.refreshJobs(userId);
  }

  /** What the job-search APIs are asked for this person: titles from the CV, places from the preferences. */
  @Get('search-plan')
  searchPlan(@CurrentUser() userId: string) {
    return this.service.searchPlan(userId);
  }

  @Get('matches')
  matches(@CurrentUser() userId: string, @Query('min', new ZodPipe(minScoreSchema)) min: number, @Query(new ZodPipe(matchFilterSchema)) filters: MatchFilterInput) {
    return this.service.matches(userId, min, filters);
  }
}

@Controller('agent')
export class AgentController {
  constructor(
    @Inject(OpennJobService) private readonly service: OpennJobService,
    @Inject(ApplyingService) private readonly applying: ApplyingService,
  ) {}

  /** Standing authorisation (APP-2): the wording, whether it is on, since when. */
  @Get('authorisation')
  authorisation(@CurrentUser() userId: string) {
    return this.applying.getAuthorisation(userId);
  }

  @Put('authorisation')
  setAuthorisation(@CurrentUser() userId: string, @Body(new ZodPipe(authorisationSchema)) body: AuthorisationInput) {
    return this.applying.setAuthorisation(userId, body);
  }

  /** The person's pause (APP-10). */
  @Put('pause')
  pause(@CurrentUser() userId: string, @Body(new ZodPipe(pauseSchema)) body: PauseInput) {
    return this.applying.setPause(userId, body);
  }

  @Get('status')
  status(@CurrentUser() userId: string) {
    return this.applying.status(userId);
  }

  /** Interviews out of recorded outcomes by match score, and the bar for automatic applications. */
  @Get('interview-rates')
  interviewRates(@CurrentUser() userId: string) {
    return this.service.interviewRates(userId);
  }

  /** The queue in the person's browser (APP-3, OD-4). */
  @Get('queue/next')
  next(@CurrentUser() userId: string) {
    return this.applying.next(userId);
  }

  @Post('queue/:id/go')
  @HttpCode(200)
  go(@CurrentUser() userId: string, @Param('id') id: string) {
    return this.applying.go(userId, id);
  }

  @Post('queue/:id/result')
  @HttpCode(200)
  result(@CurrentUser() userId: string, @Param('id') id: string, @Body(new ZodPipe(queueResultSchema)) body: QueueResultInput) {
    return this.applying.result(userId, id, body);
  }

  /**
   * The 80% rule: prepares drafts; it never fills or submits a form. In auto mode it then sends,
   * by e-mail, the applications whose advert names a recruiter's address, but only under standing
   * authorisation and the same checks as the queue (ApplyingService.sendByEmail).
   */
  @Post('run')
  @HttpCode(200)
  async run(@CurrentUser() userId: string, @Body(new ZodPipe(agentRunSchema)) body: AgentRunInput) {
    const result = await this.service.runAgent(userId, body);
    if (body.mode !== 'auto') return result;
    return { ...result, emailed: await this.applying.sendByEmail(userId) };
  }
}

/** OPTIONAL. Jobs are discovered by the system; an employer may also post one here. */
@Controller('employer')
export class EmployerController {
  constructor(@Inject(OpennJobService) private readonly service: OpennJobService) {}

  @EmployerRoute()
  @Post('jobs')
  postJob(@Body(new ZodPipe(employerJobSchema)) body: EmployerJobInput) {
    return this.service.postEmployerJob(body);
  }
}

@Controller('applications')
export class ApplicationsController {
  constructor(
    @Inject(OpennJobService) private readonly service: OpennJobService,
    @Inject(ApplyingService) private readonly applying: ApplyingService,
  ) {}

  @Post()
  create(@CurrentUser() userId: string, @Body(new ZodPipe(createApplicationSchema)) body: CreateApplicationInput) {
    return this.service.createApplication(userId, body);
  }

  @Get()
  list(@CurrentUser() userId: string) {
    return this.service.listApplications(userId);
  }

  @Get(':id')
  get(@CurrentUser() userId: string, @Param('id') id: string) {
    return this.service.getApplication(userId, id);
  }

  /** Interview questions quoting the advert and the documents this application sent (INT-1). */
  @Get(':id/interview')
  interview(@CurrentUser() userId: string, @Param('id') id: string) {
    return this.service.interviewForApplication(userId, id);
  }

  @Post(':id/interview/feedback')
  @HttpCode(200)
  interviewFeedback(@CurrentUser() userId: string, @Param('id') id: string, @Body(new ZodPipe(applicationInterviewFeedbackSchema)) body: { questionId: string; answer: string }) {
    return this.service.interviewFeedbackForApplication(userId, id, body);
  }

  /** The user's edit of the drafted statement. The extension fills the saved text. */
  @Put(':id/statement')
  statement(@CurrentUser() userId: string, @Param('id') id: string, @Body(new ZodPipe(statementSchema)) body: StatementInput) {
    return this.service.editStatement(userId, id, body);
  }

  @Post(':id/confirm')
  @HttpCode(200)
  confirm(@CurrentUser() userId: string, @Param('id') id: string, @Body(new ZodPipe(confirmApplicationSchema)) body: ConfirmApplicationInput) {
    return this.service.confirmApplication(userId, id, body);
  }

  /** "I have submitted it": needs the confirmation page's address and text (APP-7). */
  @Post(':id/submitted')
  @HttpCode(200)
  submitted(@CurrentUser() userId: string, @Param('id') id: string, @Body(new ZodPipe(submittedSchema)) body: SubmittedInput) {
    return this.service.markSubmitted(userId, id, body);
  }

  /**
   * "I have signed in" / "try again": clears the holds the person resolves on the employer's site
   * (a sign-in, a CAPTCHA they completed, a step the site refused). Never a declaration or a question.
   */
  @Post(':id/retry')
  @HttpCode(200)
  retry(@CurrentUser() userId: string, @Param('id') id: string) {
    return this.service.retryApplication(userId, id);
  }

  /** The daily review: "skip" keeps an application from going out automatically (it is closed). */
  @Post(':id/skip')
  @HttpCode(200)
  skip(@CurrentUser() userId: string, @Param('id') id: string) {
    return this.service.skipApplication(userId, id);
  }

  /** What came of a sent application: an interview, a rejection or no reply. Measures replies per route. */
  @Post(':id/outcome')
  @HttpCode(200)
  outcome(@CurrentUser() userId: string, @Param('id') id: string, @Body(new ZodPipe(outcomeSchema)) body: OutcomeInput) {
    return this.service.recordOutcome(userId, id, body);
  }

  /** SCR-2: answer the question that held this application; the answer is kept for next time. */
  @Post(':id/answer')
  @HttpCode(200)
  answer(@CurrentUser() userId: string, @Param('id') id: string, @Body(new ZodPipe(questionAnswerSchema)) body: QuestionAnswerInput) {
    return this.applying.answerQuestion(userId, id, body);
  }
}

/** Ordinary screening answers, stored once and reused (SCR-1). Never declarations (SCR-3). */
@Controller('screening')
export class ScreeningController {
  constructor(@Inject(ApplyingService) private readonly applying: ApplyingService) {}

  @Get()
  get(@CurrentUser() userId: string) {
    return this.applying.getScreening(userId);
  }

  @Put()
  save(@CurrentUser() userId: string, @Body(new ZodPipe(screeningSchema)) body: ScreeningInput) {
    return this.applying.saveScreening(userId, body);
  }
}

/** The operator's controls. Opened only by OPENNJOB_OPERATOR_KEY; they hold no user data. */
@Controller('operator')
export class OperatorController {
  constructor(@Inject(ApplyingService) private readonly applying: ApplyingService) {}

  @OperatorRoute()
  @Get('status')
  status() {
    return this.applying.operatorStatus();
  }

  @OperatorRoute()
  @Put('pause')
  pause(@Body(new ZodPipe(pauseSchema)) body: PauseInput) {
    return this.applying.setOperatorPause(body);
  }

  @OperatorRoute()
  @Put('systems/:id')
  system(@Param('id') id: string, @Body(new ZodPipe(applicationSystemSchema)) body: ApplicationSystemInput) {
    return this.applying.setSystem(id, body);
  }
}

@Controller('interview')
export class InterviewController {
  constructor(@Inject(OpennJobService) private readonly service: OpennJobService) {}

  @Get('questions')
  questions(@Query(new ZodPipe(questionQuerySchema)) query: { role?: 'nurse' | 'hca' | 'support-worker'; category?: 'values' | 'clinical'; pack?: string }) {
    if (query.pack) return this.service.packQuestions(query.pack);
    return this.service.questions(query.role, query.category);
  }

  @Post('feedback')
  @HttpCode(200)
  feedback(@CurrentUser() userId: string, @Body(new ZodPipe(interviewFeedbackSchema)) body: InterviewFeedbackInput) {
    return this.service.interviewFeedback(userId, body);
  }
}

@Controller('usage')
export class UsageController {
  constructor(@Inject(OpennJobService) private readonly service: OpennJobService) {}

  @Get()
  usage(@CurrentUser() userId: string) {
    return this.service.usage(userId);
  }
}
