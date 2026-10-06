import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import { AccountService } from './account.service';
import { AuthRateLimitGuard, CurrentUser, EmployerRoute, Public } from './auth.guard';
import { DEPS } from './deps';
import type { OpennJobDeps } from './deps';
import { OpennJobService } from './services';
import {
  ZodPipe,
  agentRunSchema,
  deleteAccountSchema,
  loginSchema,
  registerSchema,
  confirmApplicationSchema,
  employerJobSchema,
  matchFilterSchema,
  createApplicationSchema,
  interviewFeedbackSchema,
  minScoreSchema,
  passportSchema,
  profileSchema,
  questionQuerySchema,
  statementSchema,
} from './schemas';
import type { DeleteAccountInput, LoginInput, RegisterInput } from './schemas';
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
    return { status: database === 'up' ? 'ok' : 'degraded', persistence: this.deps.persistence, database };
  }
}

@Controller('auth')
@UseGuards(AuthRateLimitGuard)
export class AuthController {
  constructor(@Inject(AccountService) private readonly accounts: AccountService) {}

  /** The versions of the terms and privacy notice that registration must accept. */
  @Public()
  @Get('versions')
  versions() {
    return this.accounts.versions();
  }

  @Public()
  @Post('register')
  register(@Body(new ZodPipe(registerSchema)) body: RegisterInput) {
    return this.accounts.register(body);
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Body(new ZodPipe(loginSchema)) body: LoginInput) {
    return this.accounts.login(body);
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

  @Get('matches')
  matches(@CurrentUser() userId: string, @Query('min', new ZodPipe(minScoreSchema)) min: number, @Query(new ZodPipe(matchFilterSchema)) filters: MatchFilterInput) {
    return this.service.matches(userId, min, filters);
  }
}

@Controller('agent')
export class AgentController {
  constructor(@Inject(OpennJobService) private readonly service: OpennJobService) {}

  /** The 80% rule. Prepares drafts only; it never fills or submits a form. */
  @Post('run')
  @HttpCode(200)
  run(@CurrentUser() userId: string, @Body(new ZodPipe(agentRunSchema)) body: AgentRunInput) {
    return this.service.runAgent(userId, body);
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
  constructor(@Inject(OpennJobService) private readonly service: OpennJobService) {}

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

  @Post(':id/submitted')
  @HttpCode(200)
  submitted(@CurrentUser() userId: string, @Param('id') id: string) {
    return this.service.markSubmitted(userId, id);
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
