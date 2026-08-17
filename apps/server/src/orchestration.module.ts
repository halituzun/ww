import { Inject, Injectable, Module, Optional } from '@nestjs/common';
import { z } from 'zod';
import {
  EntityIdSchema,
  PROJECT_TYPES,
  PROJECT_STATUSES,
  NIL_UUID,
  type AgentGroup,
  type EntityId,
  type AuthenticatedPrincipalV1,
} from '@ww/shared';
import { randomUUID } from 'node:crypto';
import {
  appendProjectVersion,
  createAgent,
  createCh,
  createPlan,
  createProject,
  createTask,
  enqueueTask,
  getLatestProject,
  listLatestProjects,
  getLatestTask,
  listLatestPlansByStatus,
  listLatestTasksByStatus,
  listLatestAgents,
  getMessage,
  getTaskBrief,
  type ClickHouseClient,
  type ProjectRow,
  type TaskRow,
  type WwRedis,
} from '@ww/db';
import {
  CommunicationService,
  PrincipalResolver,
  type PrincipalAuthentication,
} from '@ww/agents';
import {
} from '@ww/scheduler';
import { CommunicationWakeupPublisher, appendPromptVersion, createRedis, getActivePrompt } from '@ww/db';
import { BOOTSTRAP_AGENTS, planBootstrapPrompts } from './agent-bootstrap.js';
import { writeProjectScaffold } from './project-scaffold-writer.js';
import { resolveWorkspaceRoot } from './runtime-context.js';
import { isResumableStatus, resumeAnsweredTask } from './resume-answered-task.js';
import { buildBootstrapPlan } from './bootstrap-plan.js';
import { NO_TARGET_NOTE, buildCommandTask } from './command-task.js';
import { isConcretePlanId, resolveTaskPlanId } from './task-plan-id.js';
import {
  PHASE8_RUNTIME,
  PHASE9_RUNTIME_CONFIG,
  phase9RuntimeConfigFromEnvironment,
  phase9RuntimeFromConfig,
} from './runtime-composition.js';

/** Cevaplanan görevi yürüten tam yaşam döngüsü (composition'ın `resume`'u). */
interface ResumeRuntime {
  resume(input: Readonly<{
    taskId: EntityId;
    previousAttemptId: EntityId;
    questionMessageId: EntityId;
    replyMessageId: EntityId;
    answer: string;
    brief: unknown;
  }>): Promise<Readonly<{ status: string }>>;
}

function observeWakeupPublishError(error: Error, wakeup: { readonly recipient: unknown; readonly messageId: string }): void {
  // Redis is only a wakeup optimisation; the durable inbox poll repairs a
  // lost notification. Keep the loss observable and typed rather than
  // swallowing it, while allowing the durable write to succeed.
  console.warn(JSON.stringify({
    level: 'warn',
    code: 'COMMUNICATION_WAKEUP_PUBLISH_FAILED',
    message: error.message,
    recipient: wakeup.recipient,
    messageId: wakeup.messageId,
  }));
}

export const PROJECT_APPLICATION = Symbol('PROJECT_APPLICATION');
export const TASK_APPLICATION = Symbol('TASK_APPLICATION');
export const MESSAGE_APPLICATION = Symbol('MESSAGE_APPLICATION');
export const SERVER_DATABASE = Symbol('SERVER_DATABASE');

const ProjectInput = z.strictObject({ name: z.string().trim().min(1), slug: z.string().trim().min(1).optional(), type: z.enum(PROJECT_TYPES).optional(), description: z.string().default(''), budgetUsdLimit: z.number().finite().nonnegative().default(0), bootstrapAgents: z.boolean().default(false) });
const ProjectStatusInput = z.strictObject({ status: z.enum(PROJECT_STATUSES) });
const TaskInput = z.strictObject({ title: z.string().trim().min(1), description: z.string().default(''), acceptanceCriteria: z.array(z.string().trim().min(1)).default([]), dependencies: z.array(EntityIdSchema).default([]), files: z.array(z.string().trim().min(1)).default([]), budget: z.number().int().nonnegative().default(0), maxAttempts: z.number().int().min(1).max(3).default(3), planId: EntityIdSchema.optional() });
export const parseProjectInput = (value: unknown) => ProjectInput.parse(value);
export const parseProjectStatusInput = (value: unknown) => ProjectStatusInput.parse(value);
export const parseTaskInput = (value: unknown) => TaskInput.parse(value);
export type MessageApplicationInput = Readonly<{ projectId: EntityId; principal: AuthenticatedPrincipalV1; taskId?: EntityId; kind: 'user_command' | 'answer'; text: string; replyToMessageId?: EntityId }>;

/** User-supplied message references are invalid input, not server failures. */
export class MessageInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MessageInputError';
  }
}

export interface ServerDatabase { readonly ch: ClickHouseClient; readonly redis?: WwRedis; }
export interface ProjectApplication { create(input: ReturnType<typeof parseProjectInput>): Promise<ProjectRow>; get(projectId: string): Promise<ProjectRow | null>; list(): Promise<ProjectRow[]>; updateStatus(projectId: string, status: ReturnType<typeof parseProjectStatusInput>['status']): Promise<ProjectRow>; }
export interface TaskApplication { create(projectId: string, input: ReturnType<typeof parseTaskInput>): Promise<TaskRow>; get(projectId: string, taskId: string): Promise<TaskRow | null>; list(projectId: string): Promise<TaskRow[]>; }
export interface MessageApplication { send(input: MessageApplicationInput): Promise<unknown>; get(projectId: string, messageId: string): Promise<unknown>; }

@Injectable()
export class ProjectApplicationService implements ProjectApplication {
  constructor(@Inject(SERVER_DATABASE) private readonly database: ServerDatabase) {}
  async create(input: ReturnType<typeof parseProjectInput>): Promise<ProjectRow> {
    const projectId = randomUUID() as EntityId;
    const now = new Date().toISOString();
    const project = await createProject(this.database.ch, { project_id: projectId, name: input.name, slug: input.slug ?? input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), type: input.type ?? 'web', status: 'draft', description: input.description, workspace_path: `workspace/${projectId}`, budget_usd_limit: input.budgetUsdLimit, settings: {}, active_plan_id: NIL_UUID, created_at: now, updated_at: now });
    // Workspace iskeleti: kapı komutlarını ww.gate.json'dan okur. Dosya
    // yoksa iş üretilebiliyor ama KABUL EDİLEMİYOR ("Dosya bulunamadı").
    await writeProjectScaffold(
      resolveWorkspaceRoot(
        process.env['WW_WORKSPACE_ROOT'] ?? `${process.cwd()}/workspace`,
        project.slug,
      ),
      project.type,
      project.slug,
    );

    if (input.bootstrapAgents) {
      // Agent'lar prompt'a İŞARET EDER; satırı önce yaz, yoksa sarkan referans
      // brief mühürlemede patlar ve projenin hiçbir görevi koşamaz.
      const canonical = new Map<string, { prompt_name: string; prompt_version: number; content: string }>();
      for (const spec of BOOTSTRAP_AGENTS) {
        const active = await getActivePrompt(this.database.ch, spec.canonicalPrompt);
        if (active !== null) canonical.set(spec.canonicalPrompt, active);
      }
      for (const prompt of planBootstrapPrompts(projectId, canonical)) {
        await appendPromptVersion(this.database.ch, { ...prompt, created_at: now });
      }
      for (const agent of BOOTSTRAP_AGENTS) {
        await createAgent(this.database.ch, { agent_id: randomUUID(), project_id: projectId, role: agent.role, group: agent.group, name: agent.name, model_ref: agent.model, parent_agent_id: NIL_UUID, clone_of: NIL_UUID, status: 'idle', current_task_id: NIL_UUID, prompt_name: `bootstrap.${projectId}.${agent.role}`, prompt_version: 1, tasks_done: 0, tasks_rejected: 0, created_at: now, updated_at: now });
      }
    }

    return project;
  }
  get(projectId: string): Promise<ProjectRow | null> { return getLatestProject(this.database.ch, projectId); }
  list(): Promise<ProjectRow[]> { return listLatestProjects(this.database.ch); }
  async updateStatus(projectId: string, status: ReturnType<typeof parseProjectStatusInput>['status']): Promise<ProjectRow> {
    const current = await getLatestProject(this.database.ch, projectId);
    if (current === null) throw new Error('project bulunamadi');
    if (current.status === status) return current;
    return appendProjectVersion(this.database.ch, { expectedVersion: current.version, next: { ...current, status, updated_at: new Date().toISOString() } });
  }
}

@Injectable()
export class TaskApplicationService implements TaskApplication {
  #redis: Promise<WwRedis> | undefined;
  constructor(@Inject(SERVER_DATABASE) private readonly database: ServerDatabase) {
    this.#redis = database.redis === undefined ? undefined : Promise.resolve(database.redis);
  }
  async create(projectId: string, input: ReturnType<typeof parseTaskInput>): Promise<TaskRow> {
    const project = await getLatestProject(this.database.ch, projectId);
    if (!project) throw new Error('project bulunamadi');
    const agents = await listLatestAgents(this.database.ch, project.project_id);
    const issuer = agents.find((agent) => agent.role === 'pm' && agent.status !== 'stopped')
      ?? agents.find((agent) => agent.status !== 'stopped');
    if (!issuer) throw new Error('project icin aktif issuer agent bulunamadi');
    const taskId = randomUUID() as EntityId;
    const now = new Date().toISOString();
    // Plansız görev atanamaz ve sessizce hiç çalışmaz (bkz. task-plan-id.ts).
    // Plan görev açılışında çözülür: issuer agent burada GARANTİDİR, oysa
    // proje oluşturulurken (bootstrapAgents=false) hiç agent olmayabilir ve
    // plan kaydı yaratıcı agent kimliği ister.
    let planId: EntityId;
    const known = {
      approved: await listLatestPlansByStatus(this.database.ch, project.project_id, 'approved'),
      proposed: await listLatestPlansByStatus(this.database.ch, project.project_id, 'proposed'),
    };
    if (isConcretePlanId(input.planId) || known.approved.length > 0 || known.proposed.length > 0) {
      planId = resolveTaskPlanId(input.planId, known);
    } else {
      // Plansız projede her görev "task plan kimligi tasimiyor" ile reddedilir
      // ve kullanıcıya "queued" görünürken hiç çalışmaz.
      const seeded = await createPlan(this.database.ch, buildBootstrapPlan({
        projectId: project.project_id as EntityId,
        projectName: project.name,
        planId: randomUUID() as EntityId,
        createdByAgentId: issuer.agent_id as EntityId,
        createdAt: new Date().toISOString(),
      }) as never);
      planId = seeded.plan_id as EntityId;
    }
    const task = await createTask(this.database.ch, { task_id: taskId, project_id: project.project_id, plan_id: planId, parent_task_id: NIL_UUID, title: input.title, description: input.description, acceptance_criteria: input.acceptanceCriteria, status: 'queued', priority: 5, issuer_agent_id: issuer.agent_id, worker_agent_id: NIL_UUID, verifier_agent_id: NIL_UUID, group: 'coding' as AgentGroup, depends_on: input.dependencies, target_files: input.files, attempt: 0, max_attempts: input.maxAttempts, delegation_depth: 0, token_budget: input.budget, tokens_spent: '0', commit_hash: '', result_summary: '', reject_reason: '', task_brief_id: NIL_UUID, assignment_attempt_id: NIL_UUID, created_at: now, updated_at: now });
    this.#redis ??= createRedis();
    await enqueueTask(await this.#redis, `ww:queue:${project.project_id}`, task.task_id);
    return task;
  }
  get(projectId: string, taskId: string): Promise<TaskRow | null> { return getLatestTask(this.database.ch, projectId, taskId); }
  list(projectId: string): Promise<TaskRow[]> { return listLatestTasksByStatus(this.database.ch, projectId, 'queued'); }
}

@Injectable()
export class MessageApplicationService implements MessageApplication {
  readonly #redis: Promise<WwRedis>;
  #communication: CommunicationService | undefined;

  readonly #runtime: ResumeRuntime | null;

  readonly #tasks: TaskApplicationService;

  constructor(
    @Inject(SERVER_DATABASE) private readonly database: ServerDatabase,
    @Optional() @Inject(PHASE8_RUNTIME) runtime?: ResumeRuntime | null,
    tasks?: TaskApplicationService,
  ) {
    // Emirden görev açmak için görev servisi gerekir; enjekte edilmezse
    // aynı veritabanıyla kurulur (birim testlerde DI yoktur).
    this.#tasks = tasks ?? new TaskApplicationService(database);
    // Redis is connected lazily so health-only and unit-test boots do not require
    // infrastructure, while every real message still uses the durable service.
    this.#redis = database.redis === undefined ? createRedis() : Promise.resolve(database.redis);
    this.#runtime = runtime ?? null;
  }

  async send(input: MessageApplicationInput): Promise<unknown> {
    const redis = await this.#redis;
    const token = process.env['WW_LOCAL_SESSION_TOKEN'];
    if (token === undefined || token.length === 0) throw new Error('WW_LOCAL_SESSION_TOKEN ayarlanmalidir');
    if (this.#communication === undefined) {
      const resolver = new PrincipalResolver(this.database.ch, { localSessionToken: token });
      const wakeups = new CommunicationWakeupPublisher(redis, { onPublishError: observeWakeupPublishError });
      this.#communication = new CommunicationService(this.database.ch, redis, resolver, wakeups);
    }
    const agents = await listLatestAgents(this.database.ch, input.projectId);
    const pm = agents.find((agent) => agent.role === 'pm' && agent.status !== 'stopped');
    if (pm === undefined) throw new MessageInputError('proje icin aktif PM agent bulunamadi');
    const now = input.principal.authenticatedAt;
    const authentication: PrincipalAuthentication = {
      type: 'local_user', credential: token, issuedAt: now,
    };
    let sessionId = randomUUID() as EntityId;
    let taskId = input.taskId;
    let taskBriefId: EntityId | undefined;
    let assignmentAttemptId: EntityId | undefined;
    let recipient: { type: 'agent'; id: EntityId } = { type: 'agent', id: pm.agent_id };
    if (input.kind === 'answer') {
      if (input.replyToMessageId === undefined) throw new MessageInputError('answer replyToMessageId gerektirir');
      const original = await getMessage(this.database.ch, input.projectId, input.replyToMessageId);
      if (original === null || original.protocolVersion !== 1) throw new MessageInputError('cevaplanacak mesaj bulunamadi');
      sessionId = original.envelope.sessionId;
      recipient = original.envelope.authenticatedPrincipal.principalType === 'agent'
        ? { type: 'agent', id: original.envelope.authenticatedPrincipal.principalId }
        : recipient;
      taskId ??= original.envelope.taskId;
      taskBriefId = original.envelope.taskBriefId;
      assignmentAttemptId = original.envelope.assignmentAttemptId;
      if (taskId === undefined || taskBriefId === undefined || assignmentAttemptId === undefined) {
        throw new MessageInputError('cevaplanacak mesaj task baglamini tasimiyor');
      }
    }
    const payload = input.kind === 'answer'
      ? { type: 'answer' as const, text: input.text }
      : { type: 'user_command' as const, text: input.text };
    const sent = await this.#communication.send(authentication, {
      projectId: input.projectId,
      sessionId,
      ...(taskId === undefined ? {} : { taskId }),
      ...(taskBriefId === undefined ? {} : { taskBriefId }),
      ...(assignmentAttemptId === undefined ? {} : { assignmentAttemptId }),
      recipient,
      kind: input.kind,
      payload,
      ...(input.replyToMessageId === undefined ? {} : { replyToMessageId: input.replyToMessageId }),
      idempotencyKey: `rest:${input.kind}:${input.projectId}:${input.replyToMessageId ?? sessionId}`,
      provenance: { class: 'user_input' },
      priority: 'normal',
      createdAt: now,
    });
    if (input.kind === 'answer' && taskId !== undefined && taskBriefId !== undefined && assignmentAttemptId !== undefined && input.replyToMessageId !== undefined) {
      const task = await getLatestTask(this.database.ch, input.projectId, taskId);
      if (task !== null && isResumableStatus(task.status)) {
        const brief = await getTaskBrief(this.database.ch, taskBriefId);
        if (brief === null) throw new MessageInputError('cevap task brief kaydi bulunamadi');
        // NOT: burada AYRI bir AssignmentService kurulurdu. Motorun kendi
        // zamanlayıcısı varken ikinci bir sahip kurmak, aynı görev üzerinde
        // iki fence kaynağı demekti; devam artık motorun kendi yolundan geçer.
        const runtime = this.#runtime;
        if (runtime === null) {
          // Motor kayıtlı değilken cevabı sessizce kaydedip "devam ediyor"
          // izlenimi vermek, görevi görünmez biçimde asardı.
          throw new MessageInputError('cevap alindi ama orkestrasyon motoru kayitli degil');
        }
        const resumeInput = {
          taskId,
          previousAttemptId: assignmentAttemptId,
          questionMessageId: input.replyToMessageId,
          replyMessageId: sent.messageId,
          answer: input.text,
          brief,
        };
        // AYRI KOŞAR: yaşam döngüsü dakikalarca sürebilir, HTTP cevabı
        // kullanıcının yazdığının kaydedildiğini hemen bildirmelidir.
        void resumeAnsweredTask(taskId, {
          resume: async () => runtime.resume(resumeInput),
          onDone: (status) => {
            console.log(JSON.stringify({
              level: 'log', code: 'ANSWERED_TASK_RESUMED', taskId, status,
            }));
          },
          onError: (reason) => {
            console.error(JSON.stringify({
              level: 'error',
              code: 'ANSWERED_TASK_RESUME_FAILED',
              message: reason instanceof Error ? reason.message : String(reason),
              taskId,
            }));
          },
        });
      }
    }
    // EMİR İŞE DÖNÜŞÜR: `user_command` mesajı yazılıyor ve PM'in gelen
    // kutusuna düşüyordu ama hiçbir şey onu göreve çevirmiyordu — canlı
    // koşuda emir gönderildi, görev sayısı değişmedi (bkz. command-task.ts).
    // Göreve bağlı bir emir (çalışan işe müdahale) burada yeni görev AÇMAZ:
    // o mesaj zaten ilgili agent'ın gelen kutusuna gider.
    if (input.kind === 'user_command' && taskId === undefined) {
      const spec = buildCommandTask(input.text);
      // Dosya adı geçmiyorsa görev AÇILMAZ ama emir reddedilmez: sohbet de
      // meşru bir kullanım. Kullanıcıya iş açılmadığı AÇIKÇA söylenir.
      if (spec === null) return { ...sent, note: NO_TARGET_NOTE };
      const created = await this.#tasks.create(input.projectId, {
        title: spec.title,
        description: spec.description,
        acceptanceCriteria: [...spec.acceptanceCriteria],
        dependencies: [],
        files: [...spec.targetFiles],
        budget: 0,
        maxAttempts: 3,
      } as never);
      return { ...sent, taskId: created.task_id };
    }
    return sent;
  }

  get(projectId: string, messageId: string): Promise<unknown> {
    return getMessage(this.database.ch, projectId, messageId);
  }
}

// PHASE8_RUNTIME burada sağlanır, AppModule'de DEĞİL: çocuk modül ebeveynin
// sağlayıcısını göremez. Motor AppModule'de kaldığı sürece bu modüldeki
// MessageApplicationService onu @Optional() üzerinden hep `undefined` görür ve
// cevaplanan görev sessizce hiçbir yere gitmez. Buradan export edilmesi
// AppModule'deki TaskPumpService'in aynı örneği almasını da sürdürür.
@Module({
  providers: [
    { provide: SERVER_DATABASE, useFactory: (): ServerDatabase => ({ ch: createCh() }) },
    { provide: PHASE9_RUNTIME_CONFIG, useFactory: phase9RuntimeConfigFromEnvironment },
    { provide: PHASE8_RUNTIME, inject: [PHASE9_RUNTIME_CONFIG], useFactory: phase9RuntimeFromConfig },
    ProjectApplicationService,
    TaskApplicationService,
    MessageApplicationService,
  ],
  exports: [
    SERVER_DATABASE,
    PHASE9_RUNTIME_CONFIG,
    PHASE8_RUNTIME,
    ProjectApplicationService,
    TaskApplicationService,
    MessageApplicationService,
  ],
})
export class OrchestrationModule {}
