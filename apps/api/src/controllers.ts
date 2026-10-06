import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { EmployerRoute, Public } from './auth.guard';
import { OpennJobService } from './services';
import {
  ZodPipe,
  agentRunSchema,
  confirmApplicationSchema,
  employerJobSchema,
  matchFilterSchema,
  createApplicationSchema,
  interviewFeedbackSchema,
  minScoreSchema,
  passportSchema,
  profileSchema,
  questionQuerySchema,
} from './schemas';
import type { AgentRunInput, ConfirmApplicationInput, CreateApplicationInput, EmployerJobInput, InterviewFeedbackInput, MatchFilterInput, PassportInput, ProfileInput } from './schemas';

// Note: every constructor parameter uses an explicit @Inject(...) so the app does not
// depend on emitDecoratorMetadata (the test runner's transpiler does not emit it).

@Controller('health')
export class HealthController {
  @Public()
  @Get()
  health() {
    return { status: 'ok' };
  }
}

@Controller('profile')
export class ProfileController {
  constructor(@Inject(OpennJobService) private readonly service: OpennJobService) {}

  @Put()
  put(@Body(new ZodPipe(profileSchema)) body: ProfileInput) {
    return this.service.saveProfile(body);
  }

  @Get()
  get() {
    return this.service.getProfile();
  }
}

@Controller('passport')
export class PassportController {
  constructor(@Inject(OpennJobService) private readonly service: OpennJobService) {}

  @Put()
  put(@Body(new ZodPipe(passportSchema)) body: PassportInput) {
    return this.service.savePassport(body);
  }

  @Get()
  get() {
    return this.service.getPassport();
  }
}

@Controller('jobs')
export class JobsController {
  constructor(@Inject(OpennJobService) private readonly service: OpennJobService) {}

  @Post('refresh')
  @HttpCode(200)
  refresh() {
    return this.service.refreshJobs();
  }

  @Get('matches')
  matches(@Query('min', new ZodPipe(minScoreSchema)) min: number, @Query(new ZodPipe(matchFilterSchema)) filters: MatchFilterInput) {
    return this.service.matches(min, filters);
  }
}

@Controller('agent')
export class AgentController {
  constructor(@Inject(OpennJobService) private readonly service: OpennJobService) {}

  /** The 80% rule. Prepares drafts only; it never fills or submits a form. */
  @Post('run')
  @HttpCode(200)
  run(@Body(new ZodPipe(agentRunSchema)) body: AgentRunInput) {
    return this.service.runAgent(body);
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
  create(@Body(new ZodPipe(createApplicationSchema)) body: CreateApplicationInput) {
    return this.service.createApplication(body);
  }

  @Get()
  list() {
    return this.service.listApplications();
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.service.getApplication(id);
  }

  @Post(':id/confirm')
  @HttpCode(200)
  confirm(@Param('id') id: string, @Body(new ZodPipe(confirmApplicationSchema)) body: ConfirmApplicationInput) {
    return this.service.confirmApplication(id, body);
  }

  @Post(':id/submitted')
  @HttpCode(200)
  submitted(@Param('id') id: string) {
    return this.service.markSubmitted(id);
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
  feedback(@Body(new ZodPipe(interviewFeedbackSchema)) body: InterviewFeedbackInput) {
    return this.service.interviewFeedback(body);
  }
}

@Controller('usage')
export class UsageController {
  constructor(@Inject(OpennJobService) private readonly service: OpennJobService) {}

  @Get()
  usage() {
    return this.service.usage();
  }
}
