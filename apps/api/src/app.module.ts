import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { AccountService } from './account.service';
import { RateLimiter } from './auth';
import { AUTH_RATE_LIMITER, AccessTokenGuard, AuthRateLimitGuard } from './auth.guard';
import {
  AccountController,
  AgentController,
  ApplicationsController,
  AuthController,
  EmployerController,
  HealthController,
  InterviewController,
  JobsController,
  PassportController,
  ProfileController,
  UsageController,
} from './controllers';
import { DEPS } from './deps';
import type { OpennJobDeps } from './deps';
import { SafeExceptionFilter } from './logging';
import { OpennJobService } from './services';

@Module({})
export class AppModule {
  /** All collaborators come in through `deps`, so tests swap in fakes without touching Nest internals. */
  static register(deps: OpennJobDeps): DynamicModule {
    // Every domain event is also written to the repository's event log (the `events` table).
    deps.eventBus.subscribe('*', (event) => deps.repository.appendEvent(event));
    return {
      module: AppModule,
      controllers: [HealthController, AuthController, AccountController, ProfileController, PassportController, JobsController, AgentController, EmployerController, ApplicationsController, InterviewController, UsageController],
      providers: [
        { provide: DEPS, useValue: deps },
        { provide: AUTH_RATE_LIMITER, useValue: new RateLimiter(deps.config.authRateLimitMax, deps.config.authRateLimitWindowMs, () => deps.clock().getTime()) },
        OpennJobService,
        AccountService,
        AuthRateLimitGuard,
        { provide: APP_GUARD, useClass: AccessTokenGuard },
        { provide: APP_FILTER, useValue: new SafeExceptionFilter(deps.logger) },
      ],
    };
  }
}
