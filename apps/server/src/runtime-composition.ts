import { CommunicationWakeupPublisher, getFencedLease, taskLockKey } from '@ww/db';
import type { EntityId } from '@ww/shared';
import { randomUUID } from 'node:crypto';
import type { ClickHouseClient, WwRedis } from '@ww/db';
import type { LlmProvider, ModelRouter, RouterOptions } from '@ww/providers';
import {
  CommunicationEscalationDelivery,
  CommunicationService,
  createRuntimeCommunicationDelivery,
  createAgentRuntime,
  createDurableModelRouter,
  type AgentRuntime,
  type EffectRunner,
  type PrincipalAuthentication,
  type ProviderEffectContext,
  InboxWorker,
  PrincipalResolver,
  createPhase1RuntimeBridge,
  type Phase1RuntimeContextPort,
  type Phase1ToolPortFactory,
  type Phase1RuntimeCommunicationPort,
  type AgentCapabilityBinding,
} from '@ww/agents';
import {
  AssignmentService,
  TaskBriefService,
  TaskCausalLog,
  TaskTransitionService,
  createRedisTaskLeaseScope,
  ClickHouseSchedulerArtifactPersistence,
  createServiceBackedSchedulerPort,
  systemPrincipal,
  type ServiceBackedSchedulerInput,
  type Phase1RuntimePort,
  type Phase1SchedulerPort,
} from '@ww/scheduler';
import {
  GateRunner,
  GitWorkspace,
  ToolExecutor,
  type ExecutorAccessPort,
  type ExecutorAuditPort,
  type ExecutorCommunicationPort,
  type ExecutorEffectPort,
  type ExecutorHostCommandPort,
  type ExecutorIntentPort,
  type ExecutorSandboxInputPolicyPort,
  type GateCommitAuditPort,
  type GateInputPolicyPort,
  type SandboxPort,
} from '@ww/executor';
import {
  runPhase1Orchestrator,
  createBrakeGuard,
  createClickHouseBrakePorts,
  type Phase1BrakeCheck,
  resumePhase1Orchestrator,
  type Phase1OrchestratorInput,
  type Phase1ResumeInput,
  type Phase1OrchestratorResult,
} from '@ww/scheduler';
import { InboxPollingModule, inboxWorkerDrainPort } from './inbox-poll.module.js';
import type { DynamicModule } from '@nestjs/common';

function observeWakeupPublishError(error: Error, wakeup: { readonly recipient: unknown; readonly messageId: string }): void {
  console.warn(JSON.stringify({
    level: 'warn',
    code: 'COMMUNICATION_WAKEUP_PUBLISH_FAILED',
    message: error.message,
    recipient: wakeup.recipient,
    messageId: wakeup.messageId,
  }));
}

/** The server-owned Phase 8 boundary: every model call goes through the durable router. */
export interface Phase8RuntimeComposition {
  readonly runtime: AgentRuntime;
  readonly router: ModelRouter;
  readonly effectRunner: EffectRunner;
  readonly orchestrate: (input: Omit<Phase1OrchestratorInput, 'scheduler' | 'runtime'>) => Promise<Phase1OrchestratorResult>;
}

export interface Phase8RuntimeCompositionInput {
  /** docs/07 güvenlik freni; verilmezse orkestratör eskisi gibi çalışır. */
  readonly brakes?: Phase1BrakeCheck | undefined;
  readonly ch: ClickHouseClient;
  readonly redis: WwRedis;
  readonly providers: Map<string, LlmProvider>;
  readonly fallbacks: RouterOptions['fallbacks'];
  readonly communication: CommunicationService;
  readonly internalAuthentication: PrincipalAuthentication;
  readonly providerContext: ProviderEffectContext;
  readonly usageSink: NonNullable<Parameters<typeof createDurableModelRouter>[1]>['usageSink'];
  /** Injected by the server's scheduler composition; required, never defaulted. */
  readonly scheduler: Phase1SchedulerPort;
  /** Narrow bridge from worker/verifier loops to the orchestrator. */
  readonly orchestrationRuntime: Phase1RuntimePort;
}

export const PHASE8_RUNTIME = Symbol('PHASE8_RUNTIME');
export const PHASE9_RUNTIME_CONFIG = Symbol('PHASE9_RUNTIME_CONFIG');

export interface Phase9RuntimeConfig {
  readonly composition: Phase9RuntimeCompositionInput;
}

let registeredPhase9Config: Phase9RuntimeConfig | undefined;

/** Main/bootstrap and integration harnesses register an explicit, already
 * validated dependency graph. Environment variables alone never fabricate
 * provider or executor capabilities. */
export function registerPhase9RuntimeConfig(config: Phase9RuntimeConfig): void {
  registeredPhase9Config = config;
}

export function phase9RuntimeConfigFromEnvironment(): Phase9RuntimeConfig | null {
  if (process.env['WW_PHASE8_RUNTIME_ENABLED'] !== '1') return null;
  return registeredPhase9Config ?? null;
}

export function phase9RuntimeFromConfig(
  config: Phase9RuntimeConfig | null,
): Phase9RuntimeComposition | null {
  if (config === null) {
    if (process.env['WW_PHASE8_RUNTIME_ENABLED'] !== '1') return null;
    throw new Error('WW_PHASE8_RUNTIME_ENABLED=1 ancak Phase9RuntimeConfig kayitli degil');
  }
  return createPhase9RuntimeComposition(config.composition);
}

/** AppModule exposes this explicit state until concrete provider/scheduler wiring is configured. */
export function phase8RuntimeFromEnvironment(): Phase8RuntimeComposition | null {
  if (process.env['WW_PHASE8_RUNTIME_ENABLED'] !== '1') return null;
  throw new Error(
    'WW_PHASE8_RUNTIME_ENABLED=1 ancak scheduler/provider composition kayitli degil; ' +
    'Phase8RuntimeComposition dependency injection ile saglanmalidir',
  );
}

export function createPhase8RuntimeComposition(
  input: Phase8RuntimeCompositionInput,
): Phase8RuntimeComposition {
  const escalation = new CommunicationEscalationDelivery(
    input.communication,
    input.internalAuthentication,
  );
  const durable = createDurableModelRouter(input.providers, {
    ch: input.ch,
    redis: input.redis,
    usageSink: input.usageSink,
    fallbacks: input.fallbacks,
    escalationPort: escalation,
    providerContext: input.providerContext,
  });
  return Object.freeze({
    runtime: createAgentRuntime({}),
    router: durable.router,
    effectRunner: durable.effectRunner,
    orchestrate: (orchestrationInput: Omit<Phase1OrchestratorInput, 'scheduler' | 'runtime'>) => runPhase1Orchestrator({
      ...(input.brakes === undefined ? {} : { brakes: input.brakes }),
      ...orchestrationInput,
      scheduler: input.scheduler,
      runtime: input.orchestrationRuntime,
    }),
  });
}

/**
 * The production server composition.  Unlike the legacy Phase 8 test seam,
 * this factory owns the concrete durable services and requires every
 * side-effect port from the caller.  A missing operation is therefore a
 * startup error, never a silently successful no-op.
 */
export interface Phase9ExecutorCompositionInput {
  readonly sandbox: SandboxPort;
  readonly gateAudit: GateCommitAuditPort;
  readonly gateInputPolicy: GateInputPolicyPort;
  readonly hostCommand: ExecutorHostCommandPort;
  readonly access: ExecutorAccessPort;
  readonly communication: ExecutorCommunicationPort;
  readonly audit: ExecutorAuditPort;
  readonly effects: ExecutorEffectPort;
  readonly intents: ExecutorIntentPort;
  readonly sandboxInputs: ExecutorSandboxInputPolicyPort;
}

export interface Phase9RuntimeCompositionInput extends Omit<Phase8RuntimeCompositionInput, 'scheduler' | 'orchestrationRuntime' | 'communication'> {
  readonly projectId: import('@ww/shared').EntityId;
  readonly consumerId: string;
  readonly snapshotBuilder: ConstructorParameters<typeof TaskBriefService>[2];
  /** The lifecycle operations that remain server-owned (gate/commit/runtime policy). */
  readonly schedulerOperations: Omit<Phase1SchedulerPort, 'assign'>;
  /** Optional production wrapper that fences executor gate/commit and persists evidence. */
  readonly serviceBackedScheduler?: ServiceBackedSchedulerInput;
  /** Legacy injection seam; production uses runtimeContext/toolFactory/communication. */
  readonly orchestrationRuntime?: Phase1RuntimePort;
  readonly runtimeContext?: Phase1RuntimeContextPort;
  readonly toolFactory?: Phase1ToolPortFactory;
  readonly runtimeCommunication?: Phase1RuntimeCommunicationPort;
  /**
   * Verilirse `runtimeCommunication` composition'ın KENDİ CommunicationService'i
   * üzerinden kurulur. Çağıranın sahte bir port uydurmasına gerek kalmaz —
   * sahte port worker'a "soru iletildi" yalanı söylerdi.
   */
  readonly runtimeSession?: Readonly<{ sessionId: EntityId; owningPmId: EntityId }>;
  readonly localSessionToken: string;
  /** Explicit agent credentials for server-owned worker/verifier communication. */
  readonly agentCapabilities?: ReadonlyMap<string, AgentCapabilityBinding>;
  readonly executor: Phase9ExecutorCompositionInput;
}

export interface Phase9RuntimeComposition extends Phase8RuntimeComposition {
  readonly communication: CommunicationService;
  readonly principalResolver: PrincipalResolver;
  readonly inboxWorker: InboxWorker;
  readonly taskBriefService: TaskBriefService;
  readonly taskTransitionService: TaskTransitionService;
  readonly taskCausalLog: TaskCausalLog;
  readonly assignmentService: AssignmentService;
  readonly gateRunner: GateRunner;
  readonly gitWorkspace: GitWorkspace;
  readonly toolExecutor: ToolExecutor;
  readonly scheduler: Phase1SchedulerPort;
  readonly inboxPollingModule: DynamicModule;
  readonly resume: (input: Omit<Phase1ResumeInput, 'scheduler' | 'runtime'>) => Promise<Phase1OrchestratorResult>;
}

/** Build one project-scoped runtime.  The project scope is intentional: an
 * AssignmentService carries project and consumer identity and must not be
 * shared between projects. */
export function createPhase9RuntimeComposition(
  input: Phase9RuntimeCompositionInput,
): Phase9RuntimeComposition {
  if (input.localSessionToken.trim().length === 0) {
    throw new Error('Phase9 localSessionToken bos olamaz');
  }
  if (input.consumerId.trim().length === 0) {
    throw new Error('Phase9 consumerId bos olamaz');
  }

  // Fren varsayılan olarak AÇIKTIR: docs/07 frenleri güvenlik sınırı sayar,
  // kapatmak bilinçli bir karar olmalıdır.
  const brakes: Phase1BrakeCheck | undefined = input.brakes
    ?? (process.env['WW_DISABLE_BRAKES'] === '1'
      ? undefined
      : createBrakeGuard(createClickHouseBrakePorts(input.ch, {
          onError: (taskId, reason) =>
            console.warn(`[ww] fren verisi okunamadı (task ${taskId}): ${String(reason)}`),
        })));

  const principalResolver = new PrincipalResolver(input.ch, {
    localSessionToken: input.localSessionToken,
    ...(input.agentCapabilities === undefined ? {} : { agentCapabilities: input.agentCapabilities }),
  });
  const wakeups = new CommunicationWakeupPublisher(input.redis, {
    onPublishError: observeWakeupPublishError,
  });
  const communication = new CommunicationService(
    input.ch,
    input.redis,
    principalResolver,
    wakeups,
  );
  const escalation = new CommunicationEscalationDelivery(
    communication,
    input.internalAuthentication,
  );
  const durable = createDurableModelRouter(input.providers, {
    ch: input.ch,
    redis: input.redis,
    usageSink: input.usageSink,
    fallbacks: input.fallbacks,
    escalationPort: escalation,
    providerContext: input.providerContext,
  });

  const taskBriefService = new TaskBriefService(
    input.projectId,
    input.ch,
    input.snapshotBuilder,
    { redis: input.redis },
  );
  const taskTransitionService = new TaskTransitionService(input.ch, input.redis);
  const taskCausalLog = new TaskCausalLog(input.ch, input.redis);
  const assignmentService = new AssignmentService(
    input.projectId,
    input.consumerId,
    input.ch,
    input.redis,
    taskBriefService,
    taskTransitionService,
    taskCausalLog,
  );

  // Assignment is the one operation that can be composed from the concrete
  // scheduler service. Every other orchestration operation is explicitly
  // supplied by the server because gate/commit policies need its workspace
  // and authentication context.
  const baseOperations: Phase1SchedulerPort = {
    ...input.schedulerOperations,
    assign: (taskId) => assignmentService.assign(taskId),
    awaitUserAnswer: async (value) => {
      if (value.questionMessageId === undefined) {
        throw new Error('user answer bekleme akisi questionMessageId gerektirir');
      }
      const requestedAt = new Date().toISOString();
      await taskTransitionService.apply(systemPrincipal('server:question', requestedAt), {
        protocolVersion: 1,
        transitionRequestId: randomUUID(),
        projectId: input.projectId,
        taskId: value.taskId,
        taskBriefId: value.attempt.taskBriefId,
        assignmentAttemptId: value.attempt.assignmentAttemptId,
        causationId: randomUUID(),
        requestedAt,
        action: 'request_user_input',
        questionMessageId: value.questionMessageId,
      });
    },
    resumeUserAnswer: async (value) => assignmentService.resumeUserAnswer({
      taskId: value.taskId,
      taskBriefId: value.taskBriefId,
      previousAttemptId: value.previousAttemptId,
      questionMessageId: value.questionMessageId,
      replyMessageId: value.replyMessageId,
      answer: value.answer,
    }),
  };
  const serviceBacked = input.serviceBackedScheduler ?? {
    base: baseOperations,
    fence: {
      assertCurrent: async ({ taskId, attempt }: { taskId: import('@ww/shared').EntityId; attempt: import('@ww/shared').AssignmentAttemptV1 }) => {
        const lease = await getFencedLease(input.redis, taskLockKey(taskId));
        if (lease === null || lease.owner !== attempt.leaseOwner || lease.fence !== String(attempt.leaseFence)) {
          throw new Error(`stale task lease: ${taskId}`);
        }
      },
    },
    gate: { run: input.schedulerOperations.gate },
    commit: {
      commit: async (value) => {
        const result = await input.schedulerOperations.commit(value);
        return { commitHash: result.commitHash, artifactIds: [] };
      },
    },
    artifacts: new ClickHouseSchedulerArtifactPersistence(input.ch),
    leaseScope: createRedisTaskLeaseScope(input.ch, input.redis),
  } satisfies ServiceBackedSchedulerInput;
  const scheduler = createServiceBackedSchedulerPort({
    ...serviceBacked,
    base: baseOperations,
    leaseScope: serviceBacked.leaseScope ?? createRedisTaskLeaseScope(input.ch, input.redis),
  });

  const gateRunner = new GateRunner(
    input.executor.sandbox,
    input.executor.gateAudit,
    input.executor.gateInputPolicy,
  );
  const gitWorkspace = new GitWorkspace(
    input.executor.hostCommand,
    gateRunner,
    input.executor.access,
  );
  const toolExecutor = new ToolExecutor({
    access: input.executor.access,
    communication: input.executor.communication,
    audit: input.executor.audit,
    effects: input.executor.effects,
    intents: input.executor.intents,
    sandboxInputs: input.executor.sandboxInputs,
    sandbox: input.executor.sandbox,
    gitWorkspace,
  });

  const inboxWorker = new InboxWorker(
    input.ch,
    input.redis,
    { apply: taskTransitionService.apply.bind(taskTransitionService) },
    durable.effectRunner,
    { receiptEscalationPort: escalation },
  );
  const inboxPollingModule = InboxPollingModule.forRoot({
    drainPort: inboxWorkerDrainPort(inboxWorker),
  });
  const runtime = createAgentRuntime({});
  // Sahte port yerine gerçek mesaj kanalı: soru/rapor ClickHouse'a yazılır.
  const runtimeCommunication = input.runtimeCommunication ?? (
    input.runtimeSession === undefined ? undefined : createRuntimeCommunicationDelivery({
      communication,
      authentication: input.internalAuthentication,
      sessionId: input.runtimeSession.sessionId,
      owningPmId: input.runtimeSession.owningPmId,
      now: () => new Date().toISOString(),
    })
  );
  const orchestrationRuntime = input.runtimeContext !== undefined &&
    input.toolFactory !== undefined && runtimeCommunication !== undefined
    ? createPhase1RuntimeBridge({
      runtime,
      router: durable.router,
      context: input.runtimeContext,
      tools: input.toolFactory,
      communication: runtimeCommunication,
    })
    : input.orchestrationRuntime;
  if (orchestrationRuntime === undefined) {
    throw new Error('Phase9 runtime bridge veya orchestrationRuntime zorunludur');
  }

  return Object.freeze({
    runtime,
    router: durable.router,
    effectRunner: durable.effectRunner,
    communication,
    principalResolver,
    inboxWorker,
    taskBriefService,
    taskTransitionService,
    taskCausalLog,
    assignmentService,
    gateRunner,
    gitWorkspace,
    toolExecutor,
    scheduler,
    inboxPollingModule,
    orchestrate: (orchestrationInput: Omit<Phase1OrchestratorInput, 'scheduler' | 'runtime'>) =>
      runPhase1Orchestrator({
        ...(brakes === undefined ? {} : { brakes }),
        ...orchestrationInput,
        scheduler,
        runtime: orchestrationRuntime,
      }),
    resume: (orchestrationInput: Omit<Phase1ResumeInput, 'scheduler' | 'runtime'>) =>
      resumePhase1Orchestrator({
        ...(brakes === undefined ? {} : { brakes }),
        ...orchestrationInput,
        scheduler,
        runtime: orchestrationRuntime,
      }),
  });
}
