import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ApplyingService } from './applying.service';
import { Scheduler } from './scheduler';
import { AccountService } from './account.service';
import { SharedRateLimiter } from './auth';
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
  OperatorController,
  ScreeningController,
  UsageController,
} from './controllers';
import { DEPS } from './deps';
import type { OpennJobDeps } from './deps';
import { SafeExceptionFilter } from './logging';
import { OpennJobService } from './services';
import { Notifier } from './notifications';
import { NotificationsController } from './notifications.controller';

@Module({})
export class AppModule {
  /** All collaborators come in through `deps`, so tests swap in fakes without touching Nest internals. */
  static register(deps: OpennJobDeps): DynamicModule {
    // Every domain event is also written to the repository's event log (the `events` table).
    deps.eventBus.subscribe('*', (event) => deps.repository.appendEvent(event));
    // ...and fans out to the notification catalogue (in-app, e-mail, SMS, push, WhatsApp).
    deps.notifier = new Notifier(deps);
    deps.notifier.start();
    return {
      module: AppModule,
      controllers: [HealthController, AuthController, AccountController, ProfileController, PassportController, JobsController, AgentController, EmployerController, ApplicationsController, ScreeningController, OperatorController, InterviewController, UsageController, NotificationsController],
      providers: [
        { provide: DEPS, useValue: deps },
        { provide: AUTH_RATE_LIMITER, useValue: new SharedRateLimiter(deps.repository, deps.config.authRateLimitMax, deps.config.authRateLimitWindowMs, () => deps.clock().getTime()) },
        OpennJobService,
        ApplyingService,
        Scheduler,
        AccountService,
        AuthRateLimitGuard,
        { provide: APP_GUARD, useClass: AccessTokenGuard },
        { provide: APP_FILTER, useValue: new SafeExceptionFilter(deps.logger) },
      ],
    };
  }
}
