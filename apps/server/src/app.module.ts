import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';
import { MessagesController } from './messages.controller.js';
import { ProjectsController } from './projects.controller.js';
import { TasksController } from './tasks.controller.js';
import { EventsGateway } from './events.gateway.js';
import {
  MESSAGE_APPLICATION,
  MessageApplicationService,
  OrchestrationModule,
  PROJECT_APPLICATION,
  ProjectApplicationService,
  TASK_APPLICATION,
  TaskApplicationService,
} from './orchestration.module.js';
import {
  DEFAULT_HEALTH_DEPENDENCIES,
  HEALTH_DEPENDENCIES,
  HealthService,
} from './health.service.js';
import {
  PHASE8_RUNTIME,
  PHASE9_RUNTIME_CONFIG,
  phase9RuntimeConfigFromEnvironment,
  phase9RuntimeFromConfig,
} from './runtime-composition.js';

@Module({
  imports: [OrchestrationModule],
  controllers: [HealthController, ProjectsController, TasksController, MessagesController],
  providers: [
    EventsGateway,
    { provide: HEALTH_DEPENDENCIES, useValue: DEFAULT_HEALTH_DEPENDENCIES },
    HealthService,
    { provide: PROJECT_APPLICATION, useExisting: ProjectApplicationService },
    { provide: TASK_APPLICATION, useExisting: TaskApplicationService },
    { provide: MESSAGE_APPLICATION, useExisting: MessageApplicationService },
    { provide: PHASE9_RUNTIME_CONFIG, useFactory: phase9RuntimeConfigFromEnvironment },
    {
      provide: PHASE8_RUNTIME,
      inject: [PHASE9_RUNTIME_CONFIG],
      useFactory: phase9RuntimeFromConfig,
    },
  ],
})
export class AppModule {}
