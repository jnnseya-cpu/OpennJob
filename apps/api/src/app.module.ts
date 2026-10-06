import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { BearerAuthGuard } from './auth.guard';
import {
  AgentController,
  ApplicationsController,
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
import { OpennJobService } from './services';

@Module({})
export class AppModule {
  /** All collaborators come in through `deps`, so tests swap in fakes without touching Nest internals. */
  static register(deps: OpennJobDeps): DynamicModule {
    // Every domain event is also written to the repository's event log (the `events` table in db/schema.sql).
    deps.eventBus.subscribe('*', (event) => deps.repository.appendEvent(event));
    return {
      module: AppModule,
      controllers: [HealthController, ProfileController, PassportController, JobsController, AgentController, EmployerController, ApplicationsController, InterviewController, UsageController],
      providers: [{ provide: DEPS, useValue: deps }, OpennJobService, { provide: APP_GUARD, useClass: BearerAuthGuard }],
    };
  }
}
