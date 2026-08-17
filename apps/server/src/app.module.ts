import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';
import { MessagesController } from './messages.controller.js';
import { ProjectsController } from './projects.controller.js';
import { TasksController } from './tasks.controller.js';
import { EventsGateway } from './events.gateway.js';
import { OperationsController } from './operations.controller.js';
import { FilesController } from './files.controller.js';
import { NarratorController } from './narrator.controller.js';
import { ProvidersController } from './providers.controller.js';
import { ProviderHealthScheduler } from './provider-health.scheduler.js';
import { TaskPumpService } from './task-pump.service.js';
import { RecoverySweeperService } from './recovery-sweeper.service.js';
import { PlanApplicationService, PlansController } from './plans.controller.js';
import { DelegationApplicationService, DelegationController } from './delegation.controller.js';
import { MobilePreviewController } from './mobile-preview.controller.js';
import { KnowledgeController } from './knowledge.controller.js';
import { PromptsController } from './prompts.controller.js';
import { EffectsController } from './effects.controller.js';
import { RoleModelsController } from './role-models.controller.js';
import { BudgetController } from './budget.controller.js';
import { AuditController } from './audit.controller.js';
import { RuntimeController } from './runtime.controller.js';

// Vitest creates Nest application contexts without a websocket adapter; keep
// unit/e2e HTTP boots independent while production still registers the gateway.
const EVENTS_GATEWAY_PROVIDER = process.env['WW_ENABLE_WS'] !== '1'
  ? { provide: EventsGateway, useValue: null }
  : EventsGateway;
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
} from './runtime-composition.js';

@Module({
  imports: [OrchestrationModule],
  controllers: [
    EffectsController,
    PromptsController,
    KnowledgeController,
    MobilePreviewController,
    DelegationController,
    PlansController,HealthController, ProjectsController, TasksController, MessagesController, OperationsController, FilesController, NarratorController, ProvidersController, RoleModelsController, BudgetController, AuditController, RuntimeController],
  providers: [
    EVENTS_GATEWAY_PROVIDER,
    ProviderHealthScheduler,
    TaskPumpService,
    RecoverySweeperService,
    PlanApplicationService,
    DelegationApplicationService,
    { provide: HEALTH_DEPENDENCIES, useValue: DEFAULT_HEALTH_DEPENDENCIES },
    HealthService,
    { provide: PROJECT_APPLICATION, useExisting: ProjectApplicationService },
    { provide: TASK_APPLICATION, useExisting: TaskApplicationService },
    { provide: MESSAGE_APPLICATION, useExisting: MessageApplicationService },
    // PHASE8_RUNTIME/PHASE9_RUNTIME_CONFIG artık OrchestrationModule'den gelir
    // (bkz. oradaki not): ebeveynde durduklarında çocuk modül onları göremiyordu.
  ],
})
export class AppModule {}
