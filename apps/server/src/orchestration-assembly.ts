// Parçaların fiilen birleştirildiği yer.
//
// Ayrı dosya: bootstrap kararları (fail-closed kontroller) ile kablolama
// ayrıştığında ikisi de okunur kalır ve bootstrap testleri kablolamayı
// mock'lamak zorunda kalmaz.
import { randomUUID } from 'node:crypto';
import { CommandRunner, DockerSandboxAdapter, WorkspacePaths, clickHouseExecutorEventStore, dbRedisExecutorAccess } from '@ww/executor';
import { TaskContextSnapshotBuilder } from '@ww/memory';
import {
  createAwaitUserAnswerOperation,
  createEscalationRecorder,
  createReassignOperation,
  createTransitionOperation,
} from '@ww/scheduler';
import type { ClickHouseClient, WwRedis } from '@ww/db';
import type { LlmProvider, RoutingIndex } from '@ww/providers';
import type { EntityId } from '@ww/shared';
import { createExecutorComposition, createResumeUserAnswerOperation } from './executor-composition.js';
import { createGateOperations } from './gate-operations.js';
import { createToolPortFactory } from './tool-factory.js';
import { createRuntimeContextService } from './runtime-context-service.js';
import { createExecutionErrorRecorder } from './execution-error-recorder.js';
import { appendEvent, getActivePrompt } from '@ww/db';
import type { RuntimeModels } from './runtime-context.js';
import type { Phase9RuntimeCompositionInput } from './runtime-composition.js';
import { createLateBoundPort, type LateBoundPort } from './late-binding.js';
import type { LateBoundServices } from './late-bind-runtime.js';

export interface AssemblyInput {
  ch: ClickHouseClient;
  redis: WwRedis;
  projectId: EntityId;
  projectRoot: string;
  consumerId: string;
  localSessionToken: string;
  providers: Map<string, LlmProvider>;
  routing: RoutingIndex;
  models: RuntimeModels;
}

export interface AssemblyResult {
  /** Gerçek girdi tipi: derleyici composition'ın TAM olduğunu doğrular. */
  composition: Phase9RuntimeCompositionInput;
  /** Composition kurulduktan SONRA çağrılmalı; yoksa portlar açık hata verir. */
  bindLate(services: LateBoundServices): void;
}

export async function createOrchestrationComposition(
  input: AssemblyInput,
): Promise<AssemblyResult> {
  const auditStore = clickHouseExecutorEventStore(input.ch);
  const sessionId = randomUUID() as EntityId;
  const owningPmId = randomUUID() as EntityId;

  const executor = createExecutorComposition({
    sandbox: new DockerSandboxAdapter({
      image: process.env['WW_EXECUTOR_IMAGE'] ?? 'ww-executor-runtime:local',
    }),
    hostCommand: new CommandRunner(),
    access: dbRedisExecutorAccess(input.ch, input.redis),
    auditStore: auditStore as never,
    communication: {
      // Araç katmanının iletişim uçları; runtime köprüsü kendi kanalını
      // kullandığı için bunlar araç çağrısı yolunda kalır.
      askQuestion: async () => ({ acknowledged: true }) as never,
      reportResult: async () => ({ acknowledged: true }) as never,
      submitVerdict: async () => ({ acknowledged: true }) as never,
    },
  });

  // Kapı/commit geç bağlanır: gateRunner ve gitWorkspace composition'ın
  // İÇİNDE kurulur, dolayısıyla girdi hazırlanırken henüz yoktur.
  const gateOps = createGateOperations({
    workspaceRoot: input.projectRoot,
    requireGatePass: true,
    taskDetails: async (taskId) => ({
      title: `görev ${String(taskId).slice(0, 8)}`,
      summary: 'ww orkestrasyonu tarafından üretildi',
      targetFiles: [],
      workerName: 'ww worker',
      verifierName: 'ww verifier',
    }),
  });

  const escalate = createEscalationRecorder(input.ch);

  // Composition'ın kendi servisleri henüz yok; geç bağlanacaklar.
  const transitionPort: LateBoundPort<{ apply: (...args: never[]) => never }> =
    createLateBoundPort('taskTransitionService');
  const assignmentPort: LateBoundPort<{
    reassign: (...args: never[]) => never;
    resumeUserAnswer: (...args: never[]) => never;
  }> = createLateBoundPort('assignmentService');
  const toolExecutorPort: LateBoundPort<{
    definitions: (...args: never[]) => never;
    validate: (...args: never[]) => never;
    execute: (...args: never[]) => never;
  }> = createLateBoundPort('toolExecutor');

  const composition = {
    ch: input.ch,
    redis: input.redis,
    projectId: input.projectId,
    consumerId: input.consumerId,
    localSessionToken: input.localSessionToken,
    providers: input.providers,
    fallbacks: (modelRef: string) => input.routing.fallbacks(modelRef),
    internalAuthentication: {
      type: 'internal_service' as const,
      credential: input.localSessionToken,
      issuedAt: new Date().toISOString(),
    },
    providerContext: { sessionId, owningPmId },
    usageSink: async () => undefined,
    snapshotBuilder: new TaskContextSnapshotBuilder(input.ch),
    executor,
    toolFactory: createToolPortFactory({
      executor: toolExecutorPort.proxy as never,
      effectEscalation: { sessionId, owningPmId },
    }),
    // Köprü kendi kanalını composition içindeki gerçek CommunicationService'ten kurar.
    runtimeSession: { sessionId, owningPmId },
    runtimeContext: createRuntimeContextService({
      prompts: {
        load: async (name) => (await getActivePrompt(input.ch, name))?.content ?? null,
      },
      workspaceRoot: input.projectRoot,
      models: input.models,
      // Context Builder bağlantısı ayrı bir adım; şimdilik boş bağlam.
      loadContextPack: async () => '',
    }),
    schedulerOperations: (() => {
      const transition = createTransitionOperation({
        port: transitionPort.proxy as never,
        principalName: 'ww-scheduler',
      });
      return {
      transition,
      gate: gateOps.gate,
      commit: gateOps.commit,
      escalate,
      reassign: createReassignOperation(assignmentPort.proxy as never),
      awaitUserAnswer: createAwaitUserAnswerOperation({ recordQuestion: async () => undefined }),
      resumeUserAnswer: createResumeUserAnswerOperation(assignmentPort.proxy as never),
      handleExecutionError: createExecutionErrorRecorder({
        appendEvent: (row) => appendEvent(input.ch, row as never),
        // Geçiş kilitleri de bırakır; yalnızca durum döndürmek yetmez.
        transition: (call) => transition(call as never),
        log: (message) => console.warn(`[ww] ${message}`),
        now: () => new Date().toISOString(),
      }),
      };
    })(),
  };

  return {
    composition,
    bindLate(services): void {
      transitionPort.bind(services.taskTransitionService as never);
      assignmentPort.bind(services.assignmentService as never);
      toolExecutorPort.bind(services.toolExecutor as never);
      gateOps.bind({
        gateRunner: services.gateRunner as never,
        git: services.gitWorkspace as never,
        // Workspace'i composition kurmaz; proje kökünü bilen taraf burasıdır.
        workspace: new WorkspacePaths(input.projectRoot) as never,
      });
    },
  };
}
