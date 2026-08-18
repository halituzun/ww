// Parçaların fiilen birleştirildiği yer.
//
// Ayrı dosya: bootstrap kararları (fail-closed kontroller) ile kablolama
// ayrıştığında ikisi de okunur kalır ve bootstrap testleri kablolamayı
// mock'lamak zorunda kalmaz.
import { randomUUID } from 'node:crypto';
import { CommandRunner, DockerSandboxAdapter, WorkspacePaths, clickHouseExecutorEventStore, dbRedisExecutorAccess } from '@ww/executor';
import { MemoryService, TaskContextSnapshotBuilder } from '@ww/memory';
import {
  createAwaitUserAnswerOperation,
  createEscalationRecorder,
  createReassignOperation,
  createTransitionOperation,
} from '@ww/scheduler';
import type { ClickHouseClient, WwRedis } from '@ww/db';
import { chUsageSink, ProviderRateLimiter } from '@ww/providers';
import type { LlmProvider, RoutingIndex } from '@ww/providers';
import type { EntityId } from '@ww/shared';
import { createExecutorComposition, createResumeUserAnswerOperation } from './executor-composition.js';
import { createGateOperations } from './gate-operations.js';
import { createToolPortFactory } from './tool-factory.js';
import { createRuntimeContextService } from './runtime-context-service.js';
import { createExecutionErrorRecorder } from './execution-error-recorder.js';
import { renderContextPack } from './context-pack-render.js';
import { classifyArtifact, classifyLayer } from './artifact-classify.js';
import { buildAgentCapabilities } from './agent-capabilities.js';
import { appendArtifact, appendEvent, appendPromptInputSnapshot, getPromptVersion, getTaskCausalCursor, getAssignmentAttempt, getLatestTask, listLatestAgents, listLatestApiProviders } from '@ww/db';
import type { RuntimeModels } from './runtime-context.js';
import type { Phase9RuntimeCompositionInput } from './runtime-composition.js';
import { createLateBoundPort, type LateBoundPort } from './late-binding.js';
import { ProviderHealthCache } from './provider-health-cache.js';
import type { LateBoundServices } from './late-bind-runtime.js';
import { providerRequestsPerMinute } from './provider-rate.js';

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
  const memory = new MemoryService(input.ch);
  // Agent'lar kendi adlarına konuşabilmeli: yetenek haritası olmadan worker
  // raporu 'system' kimliğine düşer ve politika onu reddeder.
  const agents = await listLatestAgents(input.ch, input.projectId);
  const capabilities = buildAgentCapabilities(input.projectId, agents as never);
  const sessionId = randomUUID() as EntityId;
  // PM kimliği UYDURULAMAZ: mesajın alıcısı projenin gerçek PM agent'ıdır;
  // rastgele bir kimlik politika kontrolünde 'alıcı PM değil' diye düşer.
  const pmAgent = agents.find((agent) => agent.role === 'pm' && agent.status !== 'stopped')
    ?? agents.find((agent) => agent.status !== 'stopped');
  if (pmAgent === undefined) {
    throw new Error('projede aktif agent yok — PM alıcısı belirlenemiyor');
  }
  const owningPmId = pmAgent.agent_id as EntityId;

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
    // Üretilen çıktı ve fihrist commit ile birlikte yazılır: aksi halde
    // "agent ne üretti" ve "bu dosyayı kim, neden değiştirdi" sorularının
    // cevabı hiçbir yerde durmaz (docs/02 artifacts, docs/08 fihrist).
    recordArtifacts: async ({ projectId, taskId, agentId, commitHash, summary, targetFiles }) => {
      const now = new Date().toISOString();
      const ids: string[] = [];
      for (const filePath of targetFiles) {
        const artifactId = randomUUID() as EntityId;
        await appendArtifact(input.ch, {
          artifact_id: artifactId,
          project_id: projectId,
          task_id: taskId,
          agent_id: agentId,
          artifact_type: classifyArtifact(filePath) as never,
          name: filePath.split('/').pop() ?? filePath,
          path: filePath,
          summary,
          commit_hash: commitHash,
          created_at: now,
        } as never);
        ids.push(artifactId);
        await memory.updateFileIndex({
          projectId,
          filePath,
          summary,
          layer: classifyLayer(filePath),
          relatedTaskIds: [taskId],
          relatedArtifactIds: [artifactId],
          lastCommitHash: commitHash,
          updatedAt: now,
        } as never);
      }
      return ids;
    },
    workspaceRoot: input.projectRoot,
    requireGatePass: true,
    // Commit ayrıntıları GERÇEK görevden okunur. Sabit metinler ve BOŞ hedef
    // dosya listesi commit'i "en az bir hedef dosya gerektirir" ile
    // düşürüyordu: iş kapıyı geçse bile tarihe hiç yazılamıyordu. Ayrıca
    // uydurma başlık, commit mesajını denetim izi olmaktan çıkarır.
    taskDetails: async (taskId) => {
      const task = await getLatestTask(input.ch, input.projectId, taskId);
      if (task === null) throw new Error(`commit için görev bulunamadı: ${taskId}`);
      const [worker, verifier] = [
        agents.find((agent) => agent.agent_id === task.worker_agent_id),
        agents.find((agent) => agent.agent_id === task.verifier_agent_id),
      ];
      return {
        title: task.title,
        summary: task.result_summary.trim() === ''
          ? task.description.trim() || task.title
          : task.result_summary,
        targetFiles: [...task.target_files],
        workerName: worker?.name ?? 'ww worker',
        verifierName: verifier?.name ?? 'ww verifier',
      };
    },
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

  // Yönlendiricinin zincir kararı senkrondur; sağlık ClickHouse'ta durur.
  // Arada senkron okunabilen, bayatlayınca kendini geçersiz kılan bir görüntü
  // gerekir.
  const providerHealth = new ProviderHealthCache(
    () => listLatestApiProviders(input.ch),
    { onError: (reason) => {
      // Sağlık okunamıyorsa kapı AÇIK kalır; sessizce kalmaz.
      const detail = reason instanceof Error ? reason.message : String(reason);
      console.warn(`[ww] saglayici sagligi okunamadi: ${detail}`);
    } },
  );

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
    // Kontör kaydı ŞART: politika, model çağrısının kanıtlanmış kullanım
    // kaydı olmadan raporu kabul etmez (ve maliyet takibi de buradan gelir).
    usageSink: chUsageSink(input.ch),
    // docs/04 + docs/07: sağlayıcı başına istek/dakika. Varsayılan
    // WW_PROVIDER_RPM (0 = sınırsız). Pompa görevleri eşzamanlı işlediğinden
    // beri sınırsız çıkış gerçek bir 429 riski; 429'lar fallback'i tetikleyip
    // yükü daha da artırır.
    rateLimiter: new ProviderRateLimiter(() => providerRequestsPerMinute()),
    // docs/04: `health_status='down'` bir fallback tetikleyicisidir. Sağlık
    // taraması bu değeri yazıyor ve panel gösteriyordu, ama zincir kararına
    // hiç girmiyordu: düşmüş olduğu BİLİNEN sağlayıcı yine deneniyor,
    // zaman aşımı kadar bekleniyor, ancak ondan sonra yedeğe geçiliyordu.
    // Önbellek bilgisizliği "kapalı" saymaz (bkz. provider-health-cache.ts).
    providerHealth: (providerId: string) => providerHealth.statusOf(providerId),
    snapshotBuilder: new TaskContextSnapshotBuilder(input.ch),
    executor,
    toolFactory: createToolPortFactory({
      executor: toolExecutorPort.proxy as never,
      effectEscalation: { sessionId, owningPmId },
    }),
    // Köprü kendi kanalını composition içindeki gerçek CommunicationService'ten kurar.
    agentCapabilities: capabilities.capabilities,
    runtimeSession: {
      sessionId,
      owningPmId,
      // Gönderen, denemenin worker agent'ıdır.
      authenticateAs: async (attemptId: EntityId) => {
        const attempt = await getAssignmentAttempt(input.ch, attemptId);
        if (attempt === null) throw new Error(`deneme bulunamadı: ${attemptId}`);
        const credential = capabilities.credentialFor(attempt.workerAgentId);
        if (credential === undefined) {
          throw new Error(`worker agent yetkisi yok: ${attempt.workerAgentId}`);
        }
        return { type: 'agent_capability' as const, credential, issuedAt: new Date().toISOString() };
      },
      // Rapor atanmış verifier'a gider; PM soru/tırmandırma kanalıdır.
      verifierFor: async (attemptId: EntityId) => {
        const attempt = await getAssignmentAttempt(input.ch, attemptId);
        if (attempt === null) throw new Error(`deneme bulunamadı: ${attemptId}`);
        return attempt.verifierAgentId;
      },
    },
    runtimeContext: createRuntimeContextService({
      prompts: {
        /**
         * MÜHÜRLÜ SÜRÜM okunur. Eskiden `version` parametresi yok sayılıp o an
         * AKTİF prompt okunuyordu: brief v3'ü mühürlese bile prompt sonradan
         * düzenlenmişse koşu v7 ile yapılıyor, yani mühür yalan oluyordu ve
         * "bu çıktıyı hangi prompt üretti" sorusunun cevabı yanlış çıkıyordu.
         *
         * Mühürlenen sürüm bulunamazsa AKTİF olana düşülmez: sessiz bir
         * sürüm kayması, hiç koşmamaktan daha kötüdür.
         */
        load: async (name, version) =>
          (await getPromptVersion(input.ch, name, version))?.content ?? null,
      },
      workspaceRoot: input.projectRoot,
      models: input.models,
      // Mühürlü girdi KALICI yazılır; yoksa api_usage var olmayan bir
      // anlık görüntüye işaret eder ve "bu çıktıyı hangi prompt üretti"
      // sorusunun cevabı olmaz.
      persistSnapshot: (snapshot) => appendPromptInputSnapshot(input.ch, snapshot),
      // İmleç sabit 0 yazılıyordu: her mühür "bu agent daha önce hiçbir şey
      // görmedi" diyordu ve replay yanlış noktadan başlardı.
      loadCausalOrdinal: async ({ taskId, assignmentAttemptId }) =>
        (await getTaskCausalCursor(input.ch, taskId, assignmentAttemptId))?.ordinal ?? 0,
      // docs/05: "Hata → tam çıktı worker'a döner". Kapı ya da doğrulayıcı
      // reddi `tasks.reject_reason`'a yazılır; buradan okunup prompt'a
      // konmazsa yeniden denenen worker ilk denemeyle AYNI girdiyi görür ve
      // aynı hatayı üretir — üç denemenin biri her turda boşa gider.
      loadPriorFailure: async ({ taskId }) => {
        const task = await getLatestTask(input.ch, input.projectId, taskId);
        const reason = task?.reject_reason.trim() ?? '';
        if (task === null || reason === '') return null;
        return { attempt: task.attempt, reason };
      },
      // Context Builder bağlantısı ayrı bir adım; şimdilik boş bağlam.
      // docs/06 Context Builder: geçmiş kararlar, özetler, fihrist ve ilgili
      // yazışmalar modele girer. Boş dize dönmek hafıza katmanını yazıp
      // kullanmamaktı — agent'lar sıfır proje bağlamıyla çalışıyordu.
      loadContextPack: async ({ brief }) => {
        const scope = brief as unknown as {
          projectId: EntityId; taskId: EntityId; goal?: string; tokenBudget?: number;
        };
        try {
          const pack = await memory.buildContextPack({
            projectId: scope.projectId,
            taskId: scope.taskId,
            cutoffAt: new Date().toISOString(),
            // Bağlam bütçesi görevin toplam bütçesinin küçük bir dilimidir;
            // tamamını bağlama harcamak işe yer bırakmaz.
            tokenBudget: Math.max(500, Math.floor((scope.tokenBudget ?? 4_000) / 4)),
            ...(scope.goal === undefined ? {} : { query: scope.goal }),
          });
          return renderContextPack(pack.chunks as never);
        } catch (reason) {
          // Bağlam kurulamazsa iş DURMAZ ama sessiz de kalmaz: bağlamsız
          // çalışan agent daha kötü sonuç üretir, bunu bilmek gerekir.
          console.warn(`[ww] bağlam paketi kurulamadı: ${String(reason)}`);
          return '';
        }
      },
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
