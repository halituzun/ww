import { Inject, Injectable, Module } from '@nestjs/common';
import { z } from 'zod';
import {
  EntityIdSchema,
  PROJECT_TYPES,
  NIL_UUID,
  type AgentGroup,
  type EntityId,
  type AuthenticatedPrincipalV1,
} from '@ww/shared';
import { randomUUID } from 'node:crypto';
import {
  createCh,
  createProject,
  createTask,
  enqueueTask,
  getLatestProject,
  getLatestTask,
  listLatestTasksByStatus,
  listLatestAgents,
  getMessage,
  getTaskBrief,
  type ClickHouseClient,
  type ProjectRow,
  type TaskRow,
  type WwRedis,
} from '@ww/db';
import { TaskContextSnapshotBuilder } from '@ww/memory';
import {
  CommunicationService,
  PrincipalResolver,
  type PrincipalAuthentication,
} from '@ww/agents';
import {
  AssignmentService,
  TaskBriefService,
  TaskCausalLog,
  TaskTransitionService,
} from '@ww/scheduler';
import { CommunicationWakeupPublisher, createRedis } from '@ww/db';

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

const ProjectInput = z.strictObject({ name: z.string().trim().min(1), slug: z.string().trim().min(1).optional(), type: z.enum(PROJECT_TYPES).optional(), description: z.string().default(''), budgetUsdLimit: z.number().finite().nonnegative().default(0) });
const TaskInput = z.strictObject({ title: z.string().trim().min(1), description: z.string().default(''), acceptanceCriteria: z.array(z.string().trim().min(1)).default([]), dependencies: z.array(EntityIdSchema).default([]), files: z.array(z.string().trim().min(1)).default([]), budget: z.number().int().nonnegative().default(0), maxAttempts: z.number().int().min(1).max(3).default(3), planId: EntityIdSchema.optional() });
export const parseProjectInput = (value: unknown) => ProjectInput.parse(value);
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
export interface ProjectApplication { create(input: ReturnType<typeof parseProjectInput>): Promise<ProjectRow>; get(projectId: string): Promise<ProjectRow | null>; }
export interface TaskApplication { create(projectId: string, input: ReturnType<typeof parseTaskInput>): Promise<TaskRow>; get(projectId: string, taskId: string): Promise<TaskRow | null>; list(projectId: string): Promise<TaskRow[]>; }
export interface MessageApplication { send(input: MessageApplicationInput): Promise<unknown>; get(projectId: string, messageId: string): Promise<unknown>; }

@Injectable()
export class ProjectApplicationService implements ProjectApplication {
  constructor(@Inject(SERVER_DATABASE) private readonly database: ServerDatabase) {}
  async create(input: ReturnType<typeof parseProjectInput>): Promise<ProjectRow> {
    const projectId = randomUUID() as EntityId;
    const now = new Date().toISOString();
    return createProject(this.database.ch, { project_id: projectId, name: input.name, slug: input.slug ?? input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), type: input.type ?? 'web', status: 'draft', description: input.description, workspace_path: `workspace/${projectId}`, budget_usd_limit: input.budgetUsdLimit, settings: {}, active_plan_id: NIL_UUID, created_at: now, updated_at: now });
  }
  get(projectId: string): Promise<ProjectRow | null> { return getLatestProject(this.database.ch, projectId); }
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
    const task = await createTask(this.database.ch, { task_id: taskId, project_id: project.project_id, plan_id: input.planId ?? NIL_UUID, parent_task_id: NIL_UUID, title: input.title, description: input.description, acceptance_criteria: input.acceptanceCriteria, status: 'queued', priority: 5, issuer_agent_id: issuer.agent_id, worker_agent_id: NIL_UUID, verifier_agent_id: NIL_UUID, group: 'coding' as AgentGroup, depends_on: input.dependencies, target_files: input.files, attempt: 0, max_attempts: input.maxAttempts, delegation_depth: 0, token_budget: input.budget, tokens_spent: '0', commit_hash: '', result_summary: '', reject_reason: '', task_brief_id: NIL_UUID, assignment_attempt_id: NIL_UUID, created_at: now, updated_at: now });
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
  readonly #assignments = new Map<string, AssignmentService>();

  constructor(@Inject(SERVER_DATABASE) private readonly database: ServerDatabase) {
    // Redis is connected lazily so health-only and unit-test boots do not require
    // infrastructure, while every real message still uses the durable service.
    this.#redis = database.redis === undefined ? createRedis() : Promise.resolve(database.redis);
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
      if (task !== null && (task.status === 'waiting_user' || task.status === 'escalated')) {
        const brief = await getTaskBrief(this.database.ch, taskBriefId);
        if (brief === null) throw new MessageInputError('cevap task brief kaydi bulunamadi');
        let assignment = this.#assignments.get(input.projectId);
        if (assignment === undefined) {
          const snapshotBuilder = new TaskContextSnapshotBuilder(this.database.ch);
          const taskBriefService = new TaskBriefService(input.projectId, this.database.ch, snapshotBuilder, { redis });
          const transitionService = new TaskTransitionService(this.database.ch, redis);
          assignment = new AssignmentService(
            input.projectId,
            `rest-answer-${input.projectId}`,
            this.database.ch,
            redis,
            taskBriefService,
            transitionService,
            new TaskCausalLog(this.database.ch, redis),
          );
          this.#assignments.set(input.projectId, assignment);
        }
        await assignment.resumeUserAnswer({
          taskId,
          taskBriefId,
          previousAttemptId: assignmentAttemptId,
          questionMessageId: input.replyToMessageId,
          replyMessageId: sent.messageId,
          answer: input.text,
        });
      }
    }
    return sent;
  }

  get(projectId: string, messageId: string): Promise<unknown> {
    return getMessage(this.database.ch, projectId, messageId);
  }
}

@Module({ providers: [{ provide: SERVER_DATABASE, useFactory: (): ServerDatabase => ({ ch: createCh() }) }, ProjectApplicationService, TaskApplicationService, MessageApplicationService], exports: [ProjectApplicationService, TaskApplicationService, MessageApplicationService] })
export class OrchestrationModule {}
