import { createHash } from 'node:crypto';
import type { ClickHouseClient } from '@ww/db';
import {
  acquireFencedLease,
  acquireFileLock,
  agentLockKey,
  appendEffectVersion,
  appendAgentVersion,
  appendAssignmentAttempt,
  appendTaskHandoff,
  fileLockKey,
  getAssignmentAttempt,
  getFileLockOwner,
  inspectFileLock,
  getLatestEffect,
  getMessage,
  getLatestAgent,
  getLatestTask,
  getTaskBrief,
  getTaskDurableMaxLeaseFence,
  getTaskHandoff,
  listLatestAgents,
  listLatestAgentsByStatus,
  listLatestTaskEffectsByStates,
  listTaskArtifacts,
  releaseFileLockUnderTaskLease,
  renewFileLock,
  reserveEffect,
  taskLockKey,
  transferOrAcquireFileLocks,
  type AgentRow,
  type EffectLedgerRow,
  type FileLockKey,
  type TaskRow,
  type WwRedis,
} from '@ww/db';
import {
  AssignmentAttemptV1Schema,
  EntityIdSchema,
  NIL_UUID,
  SourceVersionManifestV1Schema,
  TaskHandoffV1Schema,
  canonicalSha256V1,
  type AssignmentAttemptV1,
  type EntityId,
  type TaskBriefV1,
} from '@ww/shared';
import { SchedulerError, TaskDeferredError, schedulerBoundaryError } from './errors.js';
import { FencedLeaseGuard } from './fenced-lease-guard.js';
import { appendTaskFileLockEvents } from './file-lock-events.js';
import { appendTaskHandoffEvent } from './task-handoff-events.js';
import {
  DEFAULT_TASK_RULE_REFS_V1,
  deterministicSchedulerEntityId,
  systemClock,
  systemPrincipal,
  type ClockPort,
  type HandoffContext,
  type HandoffContextPort,
  type ReassignTaskInput,
  type RebaseTaskInput,
  type TaskBriefPolicy,
  type TaskBriefPolicyPort,
} from './ports.js';
import { TaskBriefService } from './task-brief-service.js';
import { TaskCausalLog } from './task-causal-log.js';
import { isRetryableFailedCommand } from './retryable-command.js';
import { AgentCloneService } from './agent-clone-service.js';
import { pickCloneSource } from './agent-clone-plan.js';
import { idleCloneCutoff } from './idle-clone-cutoff.js';
import {
  TaskTransitionService,
  assignmentAttemptIdForAssign,
} from './task-transition-service.js';

const DEFAULT_TASK_LEASE_TTL_MS = 600_000;
const DEFAULT_FILE_LOCK_TTL_SEC = 900;
const ASSIGNMENT_COMMAND_EFFECT_TYPE = 'scheduler_assignment_command_v1';
const FILE_LOCK_ACTIVE_STATUSES: ReadonlySet<TaskRow['status']> = new Set([
  'assigned',
  'working',
  'verifying',
  'testing',
  'approved',
]);

class DefaultTaskBriefPolicy implements TaskBriefPolicyPort {
  resolve({ task }: { readonly task: TaskRow }): TaskBriefPolicy {
    return Object.freeze({
      acceptanceCriteria: Object.freeze([task.description.trim() || task.title]),
      allowedTools: Object.freeze([]),
      ruleRefs: DEFAULT_TASK_RULE_REFS_V1,
      standardKnowledgeIds: Object.freeze([]),
      requirementKnowledgeIds: Object.freeze([]),
    });
  }
}

class DefaultHandoffContext implements HandoffContextPort {
  readonly #ch: ClickHouseClient;

  constructor(ch: ClickHouseClient) {
    this.#ch = ch;
  }

  async load(task: TaskRow): Promise<HandoffContext> {
    const artifacts = await listTaskArtifacts(this.#ch, task.project_id, task.task_id);
    return Object.freeze({
      artifactIds: Object.freeze(artifacts.map((artifact) => artifact.artifact_id)),
      evidenceRefs: Object.freeze(artifacts.map((artifact) => `artifact:${artifact.artifact_id}`)),
      pendingQuestionMessageIds: Object.freeze([]),
      pendingReceiptIds: Object.freeze([]),
      workspaceCheckpoint: Object.freeze({
        ...(task.commit_hash === '' ? {} : { commitHash: task.commit_hash }),
        changedPaths: Object.freeze([...task.target_files]),
      }),
    });
  }
}

export interface AssignmentServiceOptions {
  /** Klon servisi; testler kapatabilir. */
  readonly clones?: AgentCloneService;
  readonly clock?: ClockPort;
  readonly taskLeaseTtlMs?: number;
  readonly fileLockTtlSec?: number;
  readonly briefPolicy?: TaskBriefPolicyPort;
  readonly handoffContext?: HandoffContextPort;
}

interface ReservedAgent {
  readonly row: AgentRow;
  readonly changed: boolean;
}

interface LockSet {
  readonly keys: readonly FileLockKey[];
  readonly acquired: readonly FileLockKey[];
}

interface CommandEffect {
  readonly row: EffectLedgerRow;
  readonly stableEffectId: string;
  readonly requestHash: string;
}

interface InitialAssignmentPlan {
  readonly assignmentAttemptId: EntityId;
  readonly taskBriefId: EntityId;
  readonly workerAgentId: EntityId;
  readonly verifierAgentId: EntityId;
  readonly assignedAt: string;
  readonly briefHash: string;
  readonly sourceVersionManifest: TaskBriefV1['sourceVersionManifest'];
}

const SHA256_HEX = /^[a-f0-9]{64}$/;

function plannedCommandAttemptId(row: EffectLedgerRow): EntityId | undefined {
  if (
    row.result === null || typeof row.result !== 'object' || Array.isArray(row.result) ||
    !('assignmentAttemptId' in row.result)
  ) return undefined;
  return EntityIdSchema.parse(row.result.assignmentAttemptId);
}

function initialAssignmentPlan(row: EffectLedgerRow): InitialAssignmentPlan | undefined {
  const result: unknown = row.result;
  if (
    result === null || typeof result !== 'object' || Array.isArray(result)
  ) return undefined;
  const record = result as Record<string, unknown>;
  if (record['phase'] !== 'planned' || record['kind'] !== 'initial') return undefined;
  const assignedAt = record['assignedAt'];
  const briefHash = record['briefHash'];
  if (
    typeof assignedAt !== 'string' || !Number.isFinite(Date.parse(assignedAt)) ||
    typeof briefHash !== 'string' || !SHA256_HEX.test(briefHash)
  ) {
    throw new SchedulerError('INTEGRITY_CONFLICT', 'initial assignment planned sonucu gecersiz');
  }
  return Object.freeze({
    assignmentAttemptId: EntityIdSchema.parse(record['assignmentAttemptId']),
    taskBriefId: EntityIdSchema.parse(record['taskBriefId']),
    workerAgentId: EntityIdSchema.parse(record['workerAgentId']),
    verifierAgentId: EntityIdSchema.parse(record['verifierAgentId']),
    assignedAt: new Date(assignedAt).toISOString(),
    briefHash,
    sourceVersionManifest: SourceVersionManifestV1Schema.parse(
      record['sourceVersionManifest'],
    ),
  });
}

function plusMilliseconds(iso: string, milliseconds: number): string {
  return new Date(Date.parse(iso) + milliseconds).toISOString();
}

function sortedLockKeys(projectId: string, paths: readonly string[]): readonly FileLockKey[] {
  const uniquePaths = [...new Set(paths)].sort();
  return Object.freeze(uniquePaths.map((path) => fileLockKey(
    projectId,
    createHash('sha1').update(path).digest('hex'),
  )).sort());
}

function modelProvider(modelRef: string): string {
  const separator = modelRef.indexOf(':');
  if (separator <= 0) {
    throw new SchedulerError('INTEGRITY_CONFLICT', `model_ref provider prefix tasimiyor: ${modelRef}`);
  }
  return modelRef.slice(0, separator);
}

export class AssignmentService {
  readonly #projectId: EntityId;
  readonly #ch: ClickHouseClient;
  readonly #redis: WwRedis;
  readonly #briefService: TaskBriefService;
  readonly #transitionService: TaskTransitionService;
  readonly #causalLog: TaskCausalLog;
  readonly #clock: ClockPort;
  readonly #taskLeaseTtlMs: number;
  readonly #fileLockTtlSec: number;
  readonly #briefPolicy: TaskBriefPolicyPort;
  readonly #clones: AgentCloneService | undefined;
  readonly #handoffContext: HandoffContextPort;

  constructor(
    projectId: EntityId,
    consumerId: string,
    ch: ClickHouseClient,
    redis: WwRedis,
    briefService: TaskBriefService,
    transitionService: TaskTransitionService,
    causalLog: TaskCausalLog,
    options: AssignmentServiceOptions = {},
  ) {
    if (consumerId.trim().length === 0) throw new Error('consumerId bos olamaz');
    this.#projectId = projectId;
    this.#ch = ch;
    this.#redis = redis;
    this.#briefService = briefService;
    this.#transitionService = transitionService;
    this.#causalLog = causalLog;
    this.#clock = options.clock ?? systemClock;
    this.#taskLeaseTtlMs = options.taskLeaseTtlMs ?? DEFAULT_TASK_LEASE_TTL_MS;
    this.#fileLockTtlSec = options.fileLockTtlSec ?? DEFAULT_FILE_LOCK_TTL_SEC;
    this.#briefPolicy = options.briefPolicy ?? new DefaultTaskBriefPolicy();
    this.#handoffContext = options.handoffContext ?? new DefaultHandoffContext(ch);
    // docs/03 klonlama: varsayılan olarak AÇIK. Kapalıyken eşleşen agent'lar
    // meşgulse görev "idle worker bulunamadi" ile ertelenir.
    this.#clones = options.clones ?? new AgentCloneService(ch);
  }

  async assign(taskId: string): Promise<AssignmentAttemptV1> {
    return this.#withRepositoryBoundary('task assignment', () => this.#assign(taskId));
  }

  async #assign(taskId: string): Promise<AssignmentAttemptV1> {
    const task = await this.#task(taskId);
    if (task.status === 'assigned') return this.#recoverAssigned(task);
    if (task.status !== 'queued') {
      throw new TaskDeferredError(
        'DEPENDENCY_BLOCKED',
        `task atama icin queued degil: ${task.task_id}:${task.status}`,
      );
    }
    await this.#assertDependenciesDone(task);
    const prepared = await this.#prepareInitialAssignment(task);
    const {
      worker: selectedWorker,
      verifier: selectedVerifier,
      brief,
      assignedAt,
      attemptId,
      existing,
      command,
    } = prepared;
    let worker = selectedWorker;
    let verifier = selectedVerifier;
    const causationId = command.row.causation_id;
    const transitionRequest = {
      protocolVersion: 1 as const,
      transitionRequestId: deterministicSchedulerEntityId('initial-assignment-request-v1', causationId),
      projectId: task.project_id,
      taskId: task.task_id,
      taskBriefId: brief.taskBriefId,
      causationId,
      requestedAt: assignedAt,
      action: 'assign' as const,
      workerAgentId: worker.agent_id,
      verifierAgentId: verifier.agent_id,
    };
    const derivedAttemptId = assignmentAttemptIdForAssign(transitionRequest);
    if (derivedAttemptId !== attemptId) {
      throw new SchedulerError('INTEGRITY_CONFLICT', 'initial attempt kimligi deterministik degil');
    }
    if (existing !== null) {
      if (
        existing.workerAgentId !== worker.agent_id ||
        existing.verifierAgentId !== verifier.agent_id ||
        existing.taskBriefId !== brief.taskBriefId
      ) throw new SchedulerError('INTEGRITY_CONFLICT', 'existing initial attempt secimi catismali');
    }
    let taskGuard = await this.#acquireTaskGuard(task, attemptId);
    const taskGuards: FencedLeaseGuard[] = [taskGuard];
    const acquiredInitialLocks: FileLockKey[] = [];
    let agentGuards: readonly FencedLeaseGuard[] = [];
    const reservations: ReservedAgent[] = [];
    let taskActivated = false;
    try {
      const current = await taskGuard.after(this.#task(task.task_id));
      if (current.status === 'assigned') {
        throw new TaskDeferredError('LEASE_UNAVAILABLE', 'task baska atama tarafindan aktive edildi');
      }
      if (current.status !== 'queued' || current.version !== task.version) {
        throw new TaskDeferredError('DEPENDENCY_BLOCKED', 'task atama sirasinda degisti');
      }
      await taskGuard.after(this.#assertDependenciesDone(current));
      await this.#ensureLocks(current, attemptId, taskGuard, acquiredInitialLocks);
      agentGuards = await this.#acquireAgentGuards(
        [worker.agent_id, verifier.agent_id],
        `assignment:${attemptId}`,
      );
      [worker, verifier] = await this.#lockedAgentPair(
        current,
        brief,
        worker.agent_id,
        verifier.agent_id,
        agentGuards,
      );
      const attempt = existing ?? AssignmentAttemptV1Schema.parse({
        contractVersion: 1,
        assignmentAttemptId: attemptId,
        projectId: current.project_id,
        taskId: current.task_id,
        taskBriefId: brief.taskBriefId,
        attemptNumber: current.attempt + 1,
        workerAgentId: worker.agent_id,
        verifierAgentId: verifier.agent_id,
        leaseOwner: taskGuard.lease.owner,
        leaseFence: Number(taskGuard.lease.fence),
        leaseExpiresAt: plusMilliseconds(assignedAt, this.#taskLeaseTtlMs),
        startReason: 'initial',
        assignedAt,
      });
      await taskGuard.assertHeld();
      await taskGuard.after(appendAssignmentAttempt(this.#ch, attempt));
      const workerReservation = await this.#reserveAgent(
        worker.agent_id,
        current.task_id,
        assignedAt,
        agentGuards,
      );
      reservations.push(workerReservation);
      await this.#assertAgentGuard(worker.agent_id, agentGuards);
      const verifierReservation = await this.#reserveAgent(
        verifier.agent_id,
        current.task_id,
        assignedAt,
        agentGuards,
      );
      reservations.push(verifierReservation);
      await this.#assertAgentGuard(verifier.agent_id, agentGuards);
      await this.#transitionService.applyWithGuard(
        systemPrincipal('scheduler', assignedAt),
        transitionRequest,
        taskGuard,
      );
      taskActivated = true;
      const refreshedTaskGuard = await this.#refreshTaskGuardAfterTransition(
        taskGuard,
        current.task_id,
        attempt.assignmentAttemptId,
      );
      if (refreshedTaskGuard !== taskGuard) taskGuards.push(refreshedTaskGuard);
      taskGuard = refreshedTaskGuard;
      await appendTaskFileLockEvents(
        this.#ch,
        current,
        attempt,
        'lock_acquired',
        assignedAt,
        taskGuard,
      );
      await this.#appendAttemptStart(attempt, brief, 'assignment', taskGuard);
      await this.#completeCommand(command, attempt, assignedAt, taskGuard);
      return attempt;
    } finally {
      let cleanupError: unknown;
      let needsRollback = !taskActivated;
      if (needsRollback) {
        try {
          const reconciled = await this.#initialCleanupSnapshot(
            task.task_id,
            attemptId,
            taskGuard,
          );
          if (reconciled.guard !== taskGuard) taskGuards.push(reconciled.guard);
          taskGuard = reconciled.guard;
          needsRollback = this.#shouldRollbackInitialAssignment(
            reconciled.task,
            attemptId,
            brief.taskBriefId,
          );
        } catch (error) {
          needsRollback = false;
          cleanupError ??= error;
        }
      }
      if (needsRollback) {
        for (const reservation of [...reservations].reverse()) {
          try {
            await this.#rollbackInitialReservation(
              reservation,
              task.task_id,
              assignedAt,
              taskGuard,
              agentGuards,
            );
          } catch (error) {
            cleanupError ??= error;
          }
        }
      }
      try {
        await this.#stopGuards(agentGuards);
      } catch (error) {
        cleanupError ??= error;
      }
      if (needsRollback && acquiredInitialLocks.length > 0) {
        try {
          const reconciled = await this.#initialCleanupSnapshot(
            task.task_id,
            attemptId,
            taskGuard,
          );
          if (reconciled.guard !== taskGuard) taskGuards.push(reconciled.guard);
          taskGuard = reconciled.guard;
          needsRollback = this.#shouldRollbackInitialAssignment(
            reconciled.task,
            attemptId,
            brief.taskBriefId,
          );
          if (needsRollback) {
            for (const key of [...acquiredInitialLocks].reverse()) {
              await taskGuard.assertHeld();
              await this.#releaseLockUnderTaskGuard(key, attemptId, taskGuard);
            }
          }
        } catch (error) {
          cleanupError ??= error;
        }
      }
      try {
        await this.#stopGuards(taskGuards);
      } catch (error) {
        cleanupError ??= error;
      }
      if (cleanupError !== undefined) throw cleanupError;
    }
  }

  async retry(
    taskId: string,
    startReason: 'retry_after_rejection' | 'retry_after_gate_failure',
  ): Promise<AssignmentAttemptV1> {
    return this.#withRepositoryBoundary(
      'task correction assignment',
      () => this.#sameOwnerCorrection(taskId, startReason, undefined),
    );
  }

  async rebase(input: RebaseTaskInput): Promise<AssignmentAttemptV1> {
    return this.#withRepositoryBoundary(
      'task rebase assignment',
      () => this.#sameOwnerCorrection(input.taskId, 'rebase', input),
    );
  }

  async reassign(input: ReassignTaskInput): Promise<AssignmentAttemptV1> {
    return this.#withRepositoryBoundary('task reassignment', () => this.#reassign(input));
  }

  /** Validates an authoritative user answer and starts a fresh same-owner attempt. */
  async resumeUserAnswer(input: Readonly<{
    taskId: EntityId;
    taskBriefId: EntityId;
    previousAttemptId: EntityId;
    questionMessageId: EntityId;
    replyMessageId: EntityId;
    answer: string;
  }>): Promise<AssignmentAttemptV1> {
    return this.#withRepositoryBoundary('user answer resume', () => this.#resumeUserAnswer(input));
  }

  async #resumeUserAnswer(input: Readonly<{
    taskId: EntityId;
    taskBriefId: EntityId;
    previousAttemptId: EntityId;
    questionMessageId: EntityId;
    replyMessageId: EntityId;
    answer: string;
  }>): Promise<AssignmentAttemptV1> {
    const taskId = EntityIdSchema.parse(input.taskId);
    const taskBriefId = EntityIdSchema.parse(input.taskBriefId);
    const previousAttemptId = EntityIdSchema.parse(input.previousAttemptId);
    const questionMessageId = EntityIdSchema.parse(input.questionMessageId);
    const replyMessageId = EntityIdSchema.parse(input.replyMessageId);
    if (input.answer.trim().length === 0) throw new TaskDeferredError('DEPENDENCY_BLOCKED', 'bos user answer resume edilemez');
    let task = await this.#task(taskId);
    if (task.status !== 'waiting_user' && task.status !== 'escalated') {
      throw new TaskDeferredError('DEPENDENCY_BLOCKED', 'user answer resume waiting_user veya escalated task gerektirir');
    }
    if (task.assignment_attempt_id === NIL_UUID) throw new SchedulerError('INTEGRITY_CONFLICT', 'escalated task current attempt tasimiyor');
    if (task.assignment_attempt_id !== previousAttemptId) throw new SchedulerError('STALE_FENCE', 'user answer previous attempt current degil');
    const question = await getMessage(this.#ch, task.project_id, questionMessageId);
    const reply = await getMessage(this.#ch, task.project_id, replyMessageId);
    if (question === null || reply === null || question.protocolVersion !== 1 || reply.protocolVersion !== 1) {
      throw new SchedulerError('INTEGRITY_CONFLICT', 'question veya answer mesaji bulunamadi');
    }
    if (
      question.envelope.kind !== 'question' ||
      question.envelope.taskBriefId !== taskBriefId ||
      reply.envelope.kind !== 'answer' ||
      reply.envelope.replyToMessageId !== questionMessageId ||
      question.envelope.taskId !== taskId ||
      reply.envelope.taskId !== taskId ||
      reply.envelope.payload.type !== 'answer' ||
      reply.envelope.payload.text !== input.answer
    ) throw new SchedulerError('INTEGRITY_CONFLICT', 'question answer task baglami eslesmiyor');
    const winner = await getLatestEffect(this.#ch, questionMessageId, 'question-answer-winner');
    if (
      winner === null || winner.state !== 'succeeded' ||
      winner.result === null || typeof winner.result !== 'object' || Array.isArray(winner.result) ||
      (winner.result as { readonly answerMessageId?: unknown })['answerMessageId'] !== replyMessageId
    ) throw new SchedulerError('INTEGRITY_CONFLICT', 'question answer authoritative winner degil');
    if (task.status === 'waiting_user') {
      await this.#transitionService.apply(
        systemPrincipal('scheduler:user-answer-received', this.#clock.now()),
        {
          protocolVersion: 1,
          transitionRequestId: deterministicSchedulerEntityId('user-answer-received-transition-v1', { taskId, previousAttemptId, replyMessageId }),
          projectId: task.project_id,
          taskId,
          taskBriefId: (await this.#currentAttempt(task)).taskBriefId,
          assignmentAttemptId: previousAttemptId,
          causationId: deterministicSchedulerEntityId('user-answer-received-causation-v1', { taskId, replyMessageId }),
          requestedAt: this.#clock.now(),
          action: 'user_answered',
        } as never,
      );
      task = await this.#task(taskId);
    }
    return this.#sameOwnerCorrection(taskId, 'retry_after_rejection', undefined);
  }

  async renewAttemptFileLocks(taskId: string): Promise<void> {
    return this.#withRepositoryBoundary(
      'attempt file lock heartbeat',
      () => this.#renewAttemptFileLocks(EntityIdSchema.parse(taskId)),
    );
  }

  async #renewAttemptFileLocks(taskId: EntityId): Promise<void> {
    const observed = await this.#task(taskId);
    if (!FILE_LOCK_ACTIVE_STATUSES.has(observed.status)) {
      throw new TaskDeferredError(
        'DEPENDENCY_BLOCKED',
        `file lock heartbeat aktif task gerektirir: ${taskId}:${observed.status}`,
      );
    }
    const attempt = await this.#currentAttempt(observed);
    const operationId = deterministicSchedulerEntityId('file-lock-heartbeat-v1', {
      taskId,
      assignmentAttemptId: attempt.assignmentAttemptId,
    });
    const guard = await this.#acquireTaskGuard(observed, operationId);
    try {
      const current = await guard.after(this.#task(taskId));
      if (
        !FILE_LOCK_ACTIVE_STATUSES.has(current.status) ||
        current.assignment_attempt_id !== attempt.assignmentAttemptId
      ) {
        throw new SchedulerError(
          'STALE_FENCE',
          `file lock heartbeat current attempt degisti: ${taskId}`,
        );
      }
      const keys = sortedLockKeys(current.project_id, current.target_files);
      await this.#transferOrReconcileLockSet(
        keys,
        attempt.assignmentAttemptId,
        attempt.assignmentAttemptId,
        guard,
        'heartbeat',
      );
    } finally {
      await guard.stop(true);
    }
  }

  async #reassign(input: ReassignTaskInput): Promise<AssignmentAttemptV1> {
    const taskId = EntityIdSchema.parse(input.taskId);
    const causationId = EntityIdSchema.parse(input.causationId);
    const requestedAt = new Date(input.requestedAt).toISOString();
    const normalizedInput = Object.freeze({
      command: 'reassignment',
      projectId: this.#projectId,
      taskId,
      causationId,
      requestedAt,
    });
    const observed = await this.#task(taskId);
    let taskGuard = await this.#acquireTaskGuard(
      observed,
      deterministicSchedulerEntityId('reassignment-operation-v1', normalizedInput),
    );
    const taskGuards: FencedLeaseGuard[] = [taskGuard];
    let agentGuards: readonly FencedLeaseGuard[] = [];
    let command: CommandEffect | undefined;
    let taskActivated = false;
    let lockTransferRejected = false;
    let transferredFromAttemptId: EntityId | undefined;
    let transferredToAttemptId: EntityId | undefined;
    const reservations: ReservedAgent[] = [];
    try {
      const task = await taskGuard.after(this.#task(taskId));
      if (task.status !== 'working') {
        throw new TaskDeferredError('DEPENDENCY_BLOCKED', 'reassignment working task gerektirir');
      }
      const begunCommand = await this.#beginCommand(
        task,
        causationId,
        requestedAt,
        normalizedInput,
        taskGuard,
      );
      command = begunCommand;
      const plannedAttemptId = plannedCommandAttemptId(begunCommand.row);
      if (
        begunCommand.row.state === 'succeeded' ||
        (plannedAttemptId !== undefined && task.assignment_attempt_id === plannedAttemptId)
      ) {
        return await this.#recoverCommand(task, begunCommand, taskGuard, agentGuards);
      }
      if (begunCommand.row.state === 'uncertain') {
        throw new SchedulerError('UNCERTAIN_WRITE', 'reassignment command sonucu uzlastirilamadi');
      }
      const previous = await taskGuard.after(this.#currentAttempt(task));
      const brief = await taskGuard.after(this.#currentBrief(task));
      const ancestor = await this.#sealPriorCursor(
        task,
        previous,
        causationId,
        'handoff_sealed',
        requestedAt,
        taskGuard,
      );
      const attemptId = deterministicSchedulerEntityId('assignment-attempt-v1', {
        taskId: task.task_id,
        taskBriefId: brief.taskBriefId,
        previousAttemptId: previous.assignmentAttemptId,
        startReason: 'reassignment',
        causationId,
      });
      const handoffId = deterministicSchedulerEntityId('task-handoff-v1', {
        taskId: task.task_id,
        fromAttemptId: previous.assignmentAttemptId,
        toAttemptId: attemptId,
        ancestor,
      });
      transferredFromAttemptId = previous.assignmentAttemptId;
      transferredToAttemptId = attemptId;
      command = await this.#recordPlannedCommand(
        command,
        attemptId,
        requestedAt,
        taskGuard,
        {
          kind: 'reassignment',
          taskBriefId: brief.taskBriefId,
          briefHash: canonicalSha256V1(brief),
          sourceVersionManifest: brief.sourceVersionManifest,
        },
      );
      this.#assertCommandBriefPlan(command.row, brief);
      const existingAttempt = await taskGuard.after(getAssignmentAttempt(this.#ch, attemptId));
      let [worker, verifier] = existingAttempt === null
        ? await taskGuard.after(this.#selectAgents(task, previous.workerAgentId, brief))
        : [
          await taskGuard.after(this.#agent(existingAttempt.workerAgentId)),
          await taskGuard.after(this.#agent(existingAttempt.verifierAgentId)),
        ] as const;
      agentGuards = await this.#acquireAgentGuards(
        [
          previous.workerAgentId,
          previous.verifierAgentId,
          worker.agent_id,
          verifier.agent_id,
        ],
        `reassignment:${attemptId}`,
      );
      [worker, verifier] = await this.#lockedAgentPair(
        task,
        brief,
        worker.agent_id,
        verifier.agent_id,
        agentGuards,
      );
      const priorHandoff = await taskGuard.after(getTaskHandoff(this.#ch, handoffId));
      const context = priorHandoff === null
        ? await taskGuard.after(this.#handoffContext.load(task, previous))
        : undefined;
      try {
        await this.#transferAttemptLocks(
          task,
          previous.assignmentAttemptId,
          attemptId,
          taskGuard,
        );
      } catch (error) {
        if (error instanceof TaskDeferredError && error.code === 'FILE_LOCK_UNAVAILABLE') {
          lockTransferRejected = true;
        }
        throw error;
      }
      await taskGuard.assertHeld();
      const lockRelease = priorHandoff?.lockRelease ?? Object.freeze({
        releasedLockKeys: sortedLockKeys(task.project_id, task.target_files),
        failedLockKeys: Object.freeze([]),
      });
      const handoff = priorHandoff ?? (() => {
        if (context === undefined) {
          throw new SchedulerError('INTEGRITY_CONFLICT', 'handoff context yuklenemedi');
        }
        return TaskHandoffV1Schema.parse({
          contractVersion: 1,
          handoffId,
          projectId: task.project_id,
          taskId: task.task_id,
          taskBriefId: brief.taskBriefId,
          fromAssignmentAttemptId: previous.assignmentAttemptId,
          toAssignmentAttemptId: attemptId,
          ancestorCursor: ancestor,
          artifactIds: context.artifactIds,
          evidenceRefs: context.evidenceRefs,
          pendingQuestionMessageIds: context.pendingQuestionMessageIds,
          pendingReceiptIds: context.pendingReceiptIds,
          workspaceCheckpoint: context.workspaceCheckpoint,
          leaseRelease: {
            status: 'failed',
            leaseOwner: previous.leaseOwner,
            leaseFence: previous.leaseFence,
            error: 'immutable attempt lease artik current operation fence sahibi degil',
          },
          lockRelease,
          createdAt: requestedAt,
        });
      })();
      const attempt = existingAttempt ?? AssignmentAttemptV1Schema.parse({
        contractVersion: 1,
        assignmentAttemptId: attemptId,
        projectId: task.project_id,
        taskId: task.task_id,
        taskBriefId: brief.taskBriefId,
        attemptNumber: previous.attemptNumber + 1,
        workerAgentId: worker.agent_id,
        verifierAgentId: verifier.agent_id,
        leaseOwner: taskGuard.lease.owner,
        leaseFence: Number(taskGuard.lease.fence),
        leaseExpiresAt: plusMilliseconds(requestedAt, this.#taskLeaseTtlMs),
        startReason: 'reassignment',
        previousAttemptId: previous.assignmentAttemptId,
        handoffId,
        assignedAt: requestedAt,
      });
      const activationAt = attempt.assignedAt;
      await taskGuard.assertHeld();
      await taskGuard.after(appendTaskHandoff(this.#ch, handoff));
      await appendTaskHandoffEvent(this.#ch, handoff, causationId, taskGuard);
      await taskGuard.assertHeld();
      await taskGuard.after(appendAssignmentAttempt(this.#ch, attempt));
      const workerReservation = await this.#reserveAgent(
        attempt.workerAgentId,
        task.task_id,
        requestedAt,
        agentGuards,
      );
      reservations.push(workerReservation);
      await this.#assertAgentGuard(attempt.workerAgentId, agentGuards);
      const verifierReservation = await this.#reserveAgent(
        attempt.verifierAgentId,
        task.task_id,
        requestedAt,
        agentGuards,
      );
      reservations.push(verifierReservation);
      await this.#assertAgentGuard(attempt.verifierAgentId, agentGuards);
      await this.#transitionService.activateAttemptWithGuard(
        systemPrincipal('scheduler', activationAt),
        {
          projectId: task.project_id,
          taskId: task.task_id,
          taskBriefId: brief.taskBriefId,
          previousAssignmentAttemptId: previous.assignmentAttemptId,
          assignmentAttemptId: attempt.assignmentAttemptId,
          workerAgentId: attempt.workerAgentId,
          verifierAgentId: attempt.verifierAgentId,
          causationId,
          requestedAt: activationAt,
        },
        taskGuard,
      );
      taskActivated = true;
      const refreshedTaskGuard = await this.#refreshTaskGuardAfterTransition(
        taskGuard,
        task.task_id,
        attempt.assignmentAttemptId,
      );
      if (refreshedTaskGuard !== taskGuard) taskGuards.push(refreshedTaskGuard);
      taskGuard = refreshedTaskGuard;
      if (previous.workerAgentId !== attempt.workerAgentId) {
        await this.#releaseAgent(previous.workerAgentId, task.task_id, requestedAt, agentGuards);
      }
      if (previous.verifierAgentId !== attempt.verifierAgentId) {
        await this.#releaseAgent(previous.verifierAgentId, task.task_id, requestedAt, agentGuards);
      }
      await appendTaskFileLockEvents(
        this.#ch,
        task,
        previous,
        'lock_released',
        activationAt,
        taskGuard,
      );
      await appendTaskFileLockEvents(
        this.#ch,
        task,
        attempt,
        'lock_acquired',
        activationAt,
        taskGuard,
      );
      await this.#appendAttemptStart(attempt, brief, 'handoff', taskGuard);
      await this.#completeCommand(command, attempt, requestedAt, taskGuard);
      return attempt;
    } finally {
      let cleanupError: unknown;
      const freshReservationRollback: ReservedAgent[] = [];
      let rollbackReservations = !taskActivated;
      if (rollbackReservations && transferredToAttemptId !== undefined) {
        try {
          rollbackReservations = (await this.#task(taskId)).assignment_attempt_id !==
            transferredToAttemptId;
        } catch (error) {
          cleanupError ??= error;
        }
      }
      if (rollbackReservations) {
        for (const reservation of reservations.reverse()) {
          try {
            await this.#rollbackAgent(reservation, requestedAt, agentGuards);
          } catch (error) {
            if (error instanceof SchedulerError && error.code === 'STALE_FENCE') {
              freshReservationRollback.push(reservation);
            } else {
              cleanupError ??= error;
            }
          }
        }
      }
      try {
        await this.#stopGuards(agentGuards);
      } catch (error) {
        cleanupError ??= error;
      }
      try {
        await this.#stopGuards(taskGuards);
      } catch (error) {
        cleanupError ??= error;
      }
      if (!taskActivated && transferredToAttemptId !== undefined) {
        for (const reservation of freshReservationRollback) {
          try {
            await this.#rollbackReservationFreshIfAttemptNotActivated(
              reservation,
              taskId,
              transferredToAttemptId,
              requestedAt,
            );
          } catch (error) {
            cleanupError ??= error;
          }
        }
      }
      if (
        !taskActivated && !lockTransferRejected && transferredFromAttemptId !== undefined &&
        transferredToAttemptId !== undefined
      ) {
        try {
          await this.#restoreTransferredLocksFresh(
            taskId,
            transferredToAttemptId,
            transferredFromAttemptId,
          );
        } catch (error) {
          cleanupError ??= error;
        }
      }
      if (cleanupError !== undefined) throw cleanupError;
    }
  }

  async #sameOwnerCorrection(
    taskId: string,
    startReason: 'retry_after_rejection' | 'retry_after_gate_failure' | 'rebase',
    rebaseInput: RebaseTaskInput | undefined,
  ): Promise<AssignmentAttemptV1> {
    const parsedTaskId = EntityIdSchema.parse(taskId);
    const observed = await this.#task(parsedTaskId);
    const operationIdentity = rebaseInput?.causationId ?? deterministicSchedulerEntityId(
      'same-owner-operation-v1',
      { taskId: parsedTaskId, startReason },
    );
    let taskGuard = await this.#acquireTaskGuard(observed, EntityIdSchema.parse(operationIdentity));
    const taskGuards: FencedLeaseGuard[] = [taskGuard];
    let agentGuards: readonly FencedLeaseGuard[] = [];
    let command: CommandEffect | undefined;
    let taskActivated = false;
    let lockTransferRejected = false;
    let attempt: AssignmentAttemptV1 | undefined;
    let previous: AssignmentAttemptV1 | undefined;
    let transferredToAttemptId: EntityId | undefined;
    let reservationAt: string | undefined;
    const reservations: ReservedAgent[] = [];
    try {
      const task = await taskGuard.after(this.#task(parsedTaskId));
      if (task.status !== 'working' && task.status !== 'escalated') {
        throw new TaskDeferredError(
          'DEPENDENCY_BLOCKED',
          'correction attempt working veya escalated task gerektirir',
        );
      }
      previous = await taskGuard.after(this.#currentAttempt(task));
      const currentBrief = await taskGuard.after(this.#currentBrief(task));
      const normalizedInput = this.#normalizedCorrectionInput(
        task.task_id,
        startReason,
        rebaseInput,
      );
      const unresolved = (await taskGuard.after(this.#unresolvedCommands(task.task_id)))
        .filter((effect) =>
          effect.task_id === task.task_id &&
          effect.effect_type === ASSIGNMENT_COMMAND_EFFECT_TYPE);
      const requestHash = canonicalSha256V1(normalizedInput);
      const matching = unresolved.filter((effect) => effect.request_hash === requestHash);
      if (matching.length > 1) {
        throw new SchedulerError('INTEGRITY_CONFLICT', 'birden cok matching correction command var');
      }
      if (matching[0] !== undefined) {
        command = await this.#beginCommand(
          task,
          matching[0].causation_id,
          matching[0].created_at,
          normalizedInput,
          taskGuard,
        );
      } else if (unresolved.length > 0) {
        throw new SchedulerError(
          'UNCERTAIN_WRITE',
          `task icin farkli assignment command uzlastirilmamis: ${unresolved[0]!.causation_id}`,
        );
      } else if (rebaseInput !== undefined) {
        command = await this.#beginCommand(
          task,
          rebaseInput.causationId,
          new Date(rebaseInput.requestedAt).toISOString(),
          normalizedInput,
          taskGuard,
        );
      }
      if (command !== undefined) {
        const plannedAttemptId = plannedCommandAttemptId(command.row);
        if (
          command.row.state === 'succeeded' ||
          (plannedAttemptId !== undefined && task.assignment_attempt_id === plannedAttemptId)
        ) {
          return await this.#recoverCommand(task, command, taskGuard);
        }
        if (command.row.state === 'uncertain') {
          throw new SchedulerError('UNCERTAIN_WRITE', 'correction command sonucu uzlastirilamadi');
        }
      }
      agentGuards = await this.#acquireAgentGuards(
        [previous.workerAgentId, previous.verifierAgentId],
        `correction:${operationIdentity}`,
      );
      const [worker, verifier] = await this.#lockedAgentPair(
        task,
        currentBrief,
        previous.workerAgentId,
        previous.verifierAgentId,
        agentGuards,
      );
      if (
        task.status !== 'escalated' && startReason !== 'rebase' &&
        previous.startReason === startReason &&
        previous.attemptNumber === task.attempt + 1
      ) {
        await this.#ensureLocks(task, previous.assignmentAttemptId, taskGuard);
        await this.#appendAttemptStart(previous, currentBrief, startReason, taskGuard);
        return previous;
      }
      const causationId = command?.row.causation_id ?? rebaseInput?.causationId ?? deterministicSchedulerEntityId(
        'same-owner-retry-causation-v1',
        {
          taskId: task.task_id,
          taskVersion: task.version,
          previousAttemptId: previous.assignmentAttemptId,
          startReason,
        },
      );
      const requestedAtCandidate = rebaseInput === undefined
        ? this.#clock.now()
        : new Date(rebaseInput.requestedAt).toISOString();
      command ??= await this.#beginCommand(
        task,
        causationId,
        requestedAtCandidate,
        normalizedInput,
        taskGuard,
      );
      const requestedAt = command.row.created_at;
      await this.#sealPriorCursor(
        task,
        previous,
        causationId,
        'retry_sealed',
        requestedAt,
        taskGuard,
      );
      const policy = await taskGuard.after(Promise.resolve(
        this.#briefPolicy.resolve({ task, worker, verifier }),
      ));
      const brief = startReason === 'rebase'
        ? await this.#briefService.sealWithGuard({
        taskId: task.task_id,
        ...(rebaseInput?.planId === undefined ? {} : { planId: rebaseInput.planId }),
        workerPrompt: { name: worker.prompt_name, version: worker.prompt_version },
        verifierPrompt: { name: verifier.prompt_name, version: verifier.prompt_version },
        acceptanceCriteria: rebaseInput?.acceptanceCriteria ?? policy.acceptanceCriteria,
        allowedTools: rebaseInput?.allowedTools ?? policy.allowedTools,
        ruleRefs: rebaseInput?.ruleRefs ?? policy.ruleRefs,
        standardKnowledgeIds: rebaseInput?.standardKnowledgeIds ?? policy.standardKnowledgeIds,
        requirementKnowledgeIds: rebaseInput?.requirementKnowledgeIds ?? policy.requirementKnowledgeIds,
        baseContextCutoffAt: requestedAt,
        rebase: true,
      }, taskGuard)
        : currentBrief;
      const attemptId = deterministicSchedulerEntityId('assignment-attempt-v1', {
        taskId: task.task_id,
        taskBriefId: brief.taskBriefId,
        previousAttemptId: previous.assignmentAttemptId,
        startReason,
        causationId,
      });
      transferredToAttemptId = attemptId;
      command = await this.#recordPlannedCommand(
        command,
        attemptId,
        requestedAt,
        taskGuard,
        {
          kind: startReason,
          taskBriefId: brief.taskBriefId,
          briefHash: canonicalSha256V1(brief),
          sourceVersionManifest: brief.sourceVersionManifest,
        },
      );
      this.#assertCommandBriefPlan(command.row, brief);
      try {
        await this.#transferAttemptLocks(
          task,
          previous.assignmentAttemptId,
          attemptId,
          taskGuard,
        );
      } catch (error) {
        if (error instanceof TaskDeferredError && error.code === 'FILE_LOCK_UNAVAILABLE') {
          lockTransferRejected = true;
        }
        throw error;
      }
      await taskGuard.assertHeld();
      const existingAttempt = await taskGuard.after(getAssignmentAttempt(this.#ch, attemptId));
      attempt = existingAttempt ?? AssignmentAttemptV1Schema.parse({
        contractVersion: 1,
        assignmentAttemptId: attemptId,
        projectId: task.project_id,
        taskId: task.task_id,
        taskBriefId: brief.taskBriefId,
        attemptNumber: previous.attemptNumber + 1,
        workerAgentId: previous.workerAgentId,
        verifierAgentId: previous.verifierAgentId,
        leaseOwner: taskGuard.lease.owner,
        leaseFence: Number(taskGuard.lease.fence),
        leaseExpiresAt: plusMilliseconds(requestedAt, this.#taskLeaseTtlMs),
        startReason,
        previousAttemptId: previous.assignmentAttemptId,
        assignedAt: requestedAt,
      });
      const activationAt = attempt.assignedAt;
      reservationAt = activationAt;
      await taskGuard.assertHeld();
      await taskGuard.after(appendAssignmentAttempt(this.#ch, attempt));
      if (task.status === 'escalated') {
        reservations.push(await this.#reserveAgent(
          attempt.workerAgentId,
          task.task_id,
          activationAt,
          agentGuards,
        ));
        reservations.push(await this.#reserveAgent(
          attempt.verifierAgentId,
          task.task_id,
          activationAt,
          agentGuards,
        ));
      }
      const activated = await this.#transitionService.activateAttemptWithGuard(
        systemPrincipal('scheduler', activationAt),
        {
          projectId: task.project_id,
          taskId: task.task_id,
          taskBriefId: brief.taskBriefId,
          previousAssignmentAttemptId: previous.assignmentAttemptId,
          assignmentAttemptId: attempt.assignmentAttemptId,
          workerAgentId: attempt.workerAgentId,
          verifierAgentId: attempt.verifierAgentId,
          causationId,
          requestedAt: activationAt,
        },
        taskGuard,
      );
      taskActivated = true;
      if (activated.status === 'escalated') {
        await this.#resumeEscalatedAttempt(
          task.task_id,
          attempt,
          causationId,
          taskGuard,
        );
      }
      const refreshedTaskGuard = await this.#refreshTaskGuardAfterTransition(
        taskGuard,
        task.task_id,
        attempt.assignmentAttemptId,
      );
      if (refreshedTaskGuard !== taskGuard) taskGuards.push(refreshedTaskGuard);
      taskGuard = refreshedTaskGuard;
      await this.#ensureLocks(task, attempt.assignmentAttemptId, taskGuard);
      if (task.status !== 'escalated') {
        await appendTaskFileLockEvents(
          this.#ch,
          task,
          previous,
          'lock_released',
          activationAt,
          taskGuard,
        );
      }
      await appendTaskFileLockEvents(
        this.#ch,
        task,
        attempt,
        'lock_acquired',
        activationAt,
        taskGuard,
      );
      await this.#appendAttemptStart(
        attempt,
        brief,
        startReason,
        taskGuard,
      );
      await this.#completeCommand(command, attempt, requestedAt, taskGuard);
      return attempt;
    } finally {
      let cleanupError: unknown;
      if (!taskActivated && reservationAt !== undefined) {
        for (const reservation of [...reservations].reverse()) {
          try {
            await this.#rollbackAgent(reservation, reservationAt, agentGuards);
          } catch (error) {
            cleanupError ??= error;
          }
        }
      }
      try {
        await this.#stopGuards(agentGuards);
      } catch (error) {
        cleanupError ??= error;
      }
      try {
        await this.#stopGuards(taskGuards);
      } catch (error) {
        cleanupError ??= error;
      }
      if (
        !taskActivated && !lockTransferRejected && transferredToAttemptId !== undefined &&
        previous !== undefined
      ) {
        try {
          await this.#restoreTransferredLocksFresh(
            parsedTaskId,
            transferredToAttemptId,
            previous.assignmentAttemptId,
          );
        } catch (error) {
          cleanupError ??= error;
        }
      }
      if (cleanupError !== undefined) throw cleanupError;
    }
  }

  async #recoverAssigned(task: TaskRow): Promise<AssignmentAttemptV1> {
    const taskGuard = await this.#acquireTaskGuard(
      task,
      deterministicSchedulerEntityId('assignment-recovery-v1', {
        taskId: task.task_id,
        assignmentAttemptId: task.assignment_attempt_id,
      }),
    );
    let agentGuards: readonly FencedLeaseGuard[] = [];
    const reservations: ReservedAgent[] = [];
    try {
      const current = await taskGuard.after(this.#task(task.task_id));
      if (
        current.status !== 'assigned' ||
        current.assignment_attempt_id !== task.assignment_attempt_id ||
        current.task_brief_id !== task.task_brief_id
      ) throw new TaskDeferredError('LEASE_UNAVAILABLE', 'assignment recovery current fold degisti');
      const attempt = await taskGuard.after(this.#currentAttempt(current));
      const brief = await taskGuard.after(this.#currentBrief(current));
      agentGuards = await this.#acquireAgentGuards(
        [attempt.workerAgentId, attempt.verifierAgentId],
        `assignment-recovery:${attempt.assignmentAttemptId}`,
      );
      const [worker, verifier] = await this.#lockedAgentPair(
        current,
        brief,
        attempt.workerAgentId,
        attempt.verifierAgentId,
        agentGuards,
      );
      const locks = await this.#ensureLocks(current, attempt.assignmentAttemptId, taskGuard);
      try {
        const workerReservation = await this.#reserveAgent(
          worker.agent_id,
          current.task_id,
          this.#clock.now(),
          agentGuards,
        );
        reservations.push(workerReservation);
        await this.#assertAgentGuard(worker.agent_id, agentGuards);
        const verifierReservation = await this.#reserveAgent(
          verifier.agent_id,
          current.task_id,
          this.#clock.now(),
          agentGuards,
        );
        reservations.push(verifierReservation);
        await this.#assertAgentGuard(verifier.agent_id, agentGuards);
      } catch (error) {
        let cleanupError: unknown;
        for (const reservation of [...reservations].reverse()) {
          try {
            await this.#rollbackAgent(reservation, this.#clock.now(), agentGuards);
          } catch (rollbackError) {
            cleanupError ??= rollbackError;
          }
        }
        try {
          await this.#releaseLocks(locks.keys, attempt.assignmentAttemptId, taskGuard);
        } catch (releaseError) {
          cleanupError ??= releaseError;
        }
        if (cleanupError !== undefined) {
          throw new SchedulerError(
            'UNCERTAIN_WRITE',
            'assignment recovery cleanup tamamlanamadi',
            cleanupError,
          );
        }
        throw error;
      }
      await appendTaskFileLockEvents(
        this.#ch,
        current,
        attempt,
        'lock_acquired',
        attempt.assignedAt,
        taskGuard,
      );
      await this.#appendAttemptStart(attempt, brief, 'assignment', taskGuard);
      const pendingCommands = (await taskGuard.after(this.#unresolvedCommands(current.task_id)))
        .filter((effect) =>
          effect.task_id === current.task_id &&
          effect.effect_type === ASSIGNMENT_COMMAND_EFFECT_TYPE &&
          plannedCommandAttemptId(effect) === attempt.assignmentAttemptId);
      if (pendingCommands.length > 1) {
        throw new SchedulerError('INTEGRITY_CONFLICT', 'assignment recovery birden cok command buldu');
      }
      const pendingCommand = pendingCommands[0];
      if (pendingCommand?.state === 'uncertain') {
        throw new SchedulerError('UNCERTAIN_WRITE', 'assignment recovery command uncertain');
      }
      if (pendingCommand !== undefined) {
        await this.#completeCommand(Object.freeze({
          row: pendingCommand,
          stableEffectId: pendingCommand.stable_effect_id,
          requestHash: pendingCommand.request_hash,
        }), attempt, pendingCommand.created_at, taskGuard);
      }
      return attempt;
    } finally {
      let cleanupError: unknown;
      try {
        await this.#stopGuards(agentGuards);
      } catch (error) {
        cleanupError ??= error;
      }
      try {
        await taskGuard.stop(true);
      } catch (error) {
        cleanupError ??= error;
      }
      if (cleanupError !== undefined) throw cleanupError;
    }
  }

  async #appendAttemptStart(
    attempt: AssignmentAttemptV1,
    brief: TaskBriefV1,
    sourceType: string,
    guard?: FencedLeaseGuard,
  ): Promise<void> {
    const input = {
      projectId: attempt.projectId,
      taskId: attempt.taskId,
      taskBriefId: brief.taskBriefId,
      assignmentAttemptId: attempt.assignmentAttemptId,
      ...(attempt.handoffId === undefined ? {} : { handoffId: attempt.handoffId }),
      sourceType,
      sourceId: attempt.assignmentAttemptId,
      createdAt: attempt.assignedAt,
    };
    if (guard === undefined) await this.#causalLog.append(input);
    else await this.#causalLog.appendWithLease(input, guard);
  }

  async #sealPriorCursor(
    task: TaskRow,
    attempt: AssignmentAttemptV1,
    causationId: EntityId,
    sourceType: 'retry_sealed' | 'handoff_sealed',
    createdAt: string,
    guard: FencedLeaseGuard,
  ) {
    return this.#causalLog.appendWithLease({
      projectId: task.project_id,
      taskId: task.task_id,
      taskBriefId: attempt.taskBriefId,
      assignmentAttemptId: attempt.assignmentAttemptId,
      ...(attempt.handoffId === undefined ? {} : { handoffId: attempt.handoffId }),
      sourceType,
      sourceId: causationId,
      causationId,
      createdAt,
    }, guard);
  }

  async #task(taskId: string): Promise<TaskRow> {
    const task = await getLatestTask(this.#ch, this.#projectId, taskId);
    if (task === null) throw new SchedulerError('TASK_NOT_FOUND', `task bulunamadi: ${taskId}`);
    return task;
  }

  async #agent(agentId: string): Promise<AgentRow> {
    const agent = await getLatestAgent(this.#ch, this.#projectId, agentId);
    if (agent === null) throw new SchedulerError('INTEGRITY_CONFLICT', `agent bulunamadi: ${agentId}`);
    return agent;
  }

  async #currentAttempt(task: TaskRow): Promise<AssignmentAttemptV1> {
    if (task.assignment_attempt_id === NIL_UUID) {
      throw new SchedulerError('INTEGRITY_CONFLICT', 'task current assignment attempt tasimiyor');
    }
    const attempt = await getAssignmentAttempt(this.#ch, task.assignment_attempt_id);
    if (
      attempt === null || attempt.taskId !== task.task_id ||
      attempt.taskBriefId !== task.task_brief_id
    ) throw new SchedulerError('INTEGRITY_CONFLICT', 'task current attempt kaydi catismali');
    return attempt;
  }

  async #currentBrief(task: TaskRow): Promise<TaskBriefV1> {
    if (task.task_brief_id === NIL_UUID) {
      throw new SchedulerError('INTEGRITY_CONFLICT', 'task current brief tasimiyor');
    }
    const brief = await getTaskBrief(this.#ch, task.task_brief_id);
    if (brief === null || brief.taskId !== task.task_id) {
      throw new SchedulerError('INTEGRITY_CONFLICT', 'task current brief kaydi catismali');
    }
    return brief;
  }

  async #assertDependenciesDone(task: TaskRow): Promise<void> {
    for (const dependencyId of task.depends_on) {
      const dependency = await this.#task(dependencyId);
      if (dependency.status !== 'done') {
        throw new TaskDeferredError(
          'DEPENDENCY_BLOCKED',
          `dependency tamamlanmadi: ${dependencyId}:${dependency.status}`,
        );
      }
    }
  }

  async #prepareInitialAssignment(task: TaskRow): Promise<{
    readonly worker: AgentRow;
    readonly verifier: AgentRow;
    readonly brief: TaskBriefV1;
    readonly assignedAt: string;
    readonly attemptId: EntityId;
    readonly existing: AssignmentAttemptV1 | null;
    readonly command: CommandEffect;
  }> {
    const preparationId = deterministicSchedulerEntityId('initial-assignment-prepare-v1', {
      taskId: task.task_id,
      taskVersion: task.version,
    });
    const preparationGuard = await this.#acquireTaskGuard(task, preparationId);
    try {
      const current = await preparationGuard.after(this.#task(task.task_id));
      if (current.status !== 'queued' || current.version !== task.version) {
        throw new TaskDeferredError('DEPENDENCY_BLOCKED', 'task brief hazirliginda degisti');
      }
      await preparationGuard.after(this.#assertDependenciesDone(current));
      const normalizedInput = Object.freeze({
        command: 'initial',
        projectId: current.project_id,
        taskId: current.task_id,
        taskVersion: current.version,
      });
      const causationId = deterministicSchedulerEntityId(
        'initial-assignment-causation-v1',
        normalizedInput,
      );
      const initialCandidate = new Date(this.#clock.now()).toISOString();
      let command = await this.#beginCommand(
        current,
        causationId,
        initialCandidate,
        normalizedInput,
        preparationGuard,
      );
      const initialAt = command.row.created_at;
      if (command.row.state === 'uncertain') {
        throw new SchedulerError('UNCERTAIN_WRITE', 'initial assignment command uzlastirilamadi');
      }
      if (command.row.state === 'succeeded') {
        throw new SchedulerError(
          'INTEGRITY_CONFLICT',
          'completed initial assignment command queued task ile eslesmiyor',
        );
      }
      const pinned = initialAssignmentPlan(command.row);
      if (pinned !== undefined) {
        const brief = await preparationGuard.after(getTaskBrief(this.#ch, pinned.taskBriefId));
        if (
          brief === null || brief.taskId !== current.task_id ||
          canonicalSha256V1(brief) !== pinned.briefHash ||
          canonicalSha256V1(brief.sourceVersionManifest) !==
            canonicalSha256V1(pinned.sourceVersionManifest)
        ) {
          throw new SchedulerError(
            'INTEGRITY_CONFLICT',
            'pinned initial assignment brief/source manifest catismali',
          );
        }
        const existing = await preparationGuard.after(getAssignmentAttempt(
          this.#ch,
          pinned.assignmentAttemptId,
        ));
        let worker = await preparationGuard.after(this.#agent(
          existing?.workerAgentId ?? pinned.workerAgentId,
        ));
        let verifier = await preparationGuard.after(this.#agent(
          existing?.verifierAgentId ?? pinned.verifierAgentId,
        ));
        try {
          this.#assertAssignablePair(current, brief, worker, verifier);
        } catch (error) {
          if (
            existing !== null || !(error instanceof TaskDeferredError) ||
            error.code !== 'NO_ELIGIBLE_AGENT'
          ) throw error;
          [worker, verifier] = await preparationGuard.after(this.#selectAgents(
            current,
            undefined,
            brief,
          ));
          command = await this.#recordPlannedCommand(
            command,
            pinned.assignmentAttemptId,
            pinned.assignedAt,
            preparationGuard,
            {
              kind: 'initial',
              taskBriefId: brief.taskBriefId,
              workerAgentId: worker.agent_id,
              verifierAgentId: verifier.agent_id,
              assignedAt: pinned.assignedAt,
              briefHash: pinned.briefHash,
              sourceVersionManifest: pinned.sourceVersionManifest,
            },
            true,
          );
        }
        if (existing !== null && (
          existing.taskBriefId !== brief.taskBriefId ||
          existing.workerAgentId !== worker.agent_id ||
          existing.verifierAgentId !== verifier.agent_id
        )) {
          throw new SchedulerError('INTEGRITY_CONFLICT', 'pinned initial attempt catismali');
        }
        return Object.freeze({
          worker,
          verifier,
          brief,
          assignedAt: pinned.assignedAt,
          attemptId: pinned.assignmentAttemptId,
          existing,
          command,
        });
      }
      let [worker, verifier] = await preparationGuard.after(this.#selectAgents(
        current,
        undefined,
        undefined,
      ));
      const policy = await preparationGuard.after(Promise.resolve(
        this.#briefPolicy.resolve({ task: current, worker, verifier }),
      ));
      const brief = await this.#briefService.sealWithGuard({
        taskId: current.task_id,
        workerPrompt: { name: worker.prompt_name, version: worker.prompt_version },
        verifierPrompt: { name: verifier.prompt_name, version: verifier.prompt_version },
        acceptanceCriteria: policy.acceptanceCriteria,
        allowedTools: policy.allowedTools,
        ruleRefs: policy.ruleRefs,
        standardKnowledgeIds: policy.standardKnowledgeIds,
        requirementKnowledgeIds: policy.requirementKnowledgeIds,
        baseContextCutoffAt: initialAt,
      }, preparationGuard);
      this.#assertBriefMatchesAgents(brief, worker, verifier);
      const attemptId = deterministicSchedulerEntityId('assignment-attempt-v1', {
        taskId: current.task_id,
        taskBriefId: brief.taskBriefId,
        causationId,
      });
      command = await this.#recordPlannedCommand(
        command,
        attemptId,
        initialAt,
        preparationGuard,
        {
          kind: 'initial',
          taskBriefId: brief.taskBriefId,
          workerAgentId: worker.agent_id,
          verifierAgentId: verifier.agent_id,
          assignedAt: initialAt,
          briefHash: canonicalSha256V1(brief),
          sourceVersionManifest: brief.sourceVersionManifest,
        },
      );
      const existing = await preparationGuard.after(getAssignmentAttempt(this.#ch, attemptId));
      if (existing !== null) {
        worker = await preparationGuard.after(this.#agent(existing.workerAgentId));
        verifier = await preparationGuard.after(this.#agent(existing.verifierAgentId));
        this.#assertAssignablePair(current, brief, worker, verifier);
      }
      return Object.freeze({
        worker,
        verifier,
        brief,
        assignedAt: existing?.assignedAt ?? initialAt,
        attemptId,
        existing,
        command,
      });
    } finally {
      await preparationGuard.stop(true);
    }
  }

  async #beginCommand(
    task: TaskRow,
    causationId: EntityId,
    requestedAt: string,
    request: unknown,
    guard: FencedLeaseGuard,
  ): Promise<CommandEffect> {
    const stableEffectId = `task-assignment-command:${task.task_id}`;
    const requestHash = canonicalSha256V1(request);
    let row = await guard.after(getLatestEffect(this.#ch, causationId, stableEffectId));
    if (row !== null && row.request_hash !== requestHash) {
      throw new SchedulerError(
        'INTEGRITY_CONFLICT',
        `assignment command causation/request hash catismasi: ${causationId}`,
      );
    }
    // Kurtarmanın uzlaştırdığı (düşmüş) replay-safe komut yeni denemeyi
    // ENGELLEMEMELİDİR; aksi halde uzlaştırma blokajı bir adım öteye taşır ve
    // görev yine kalıcı olarak atanamaz kalır (bkz. retryable-command.ts).
    if (row !== null && isRetryableFailedCommand(row)) {
      await guard.assertHeld();
      row = await appendEffectVersion(this.#ch, {
        causation_id: row.causation_id,
        stable_effect_id: row.stable_effect_id,
        expectedVersion: row.effect_version,
        state: 'pending',
        result: {},
        error: '',
        lease_fence: guard.lease.fence,
        created_at: requestedAt,
      });
    }
    if (
      row !== null && row.state !== 'pending' && row.state !== 'succeeded' &&
      row.state !== 'uncertain'
    ) {
      throw new SchedulerError('UNCERTAIN_WRITE', `assignment command terminal: ${row.state}`);
    }
    if (row === null) {
      const unresolved = await guard.after(this.#unresolvedCommands(task.task_id));
      const blocker = unresolved.find((effect) =>
        effect.task_id === task.task_id && effect.effect_type === ASSIGNMENT_COMMAND_EFFECT_TYPE);
      if (blocker !== undefined) {
        throw new SchedulerError(
          'UNCERTAIN_WRITE',
          `task icin baska assignment command uzlastirilmamis: ${blocker.causation_id}`,
        );
      }
      await guard.assertHeld();
      row = await reserveEffect(this.#ch, {
        causation_id: causationId,
        stable_effect_id: stableEffectId,
        project_id: task.project_id,
        task_id: task.task_id,
        effect_type: ASSIGNMENT_COMMAND_EFFECT_TYPE,
        request,
        replay_safety: 'replay_safe',
        lease_fence: guard.lease.fence,
        created_at: requestedAt,
      });
      await guard.assertHeld();
    }
    return Object.freeze({ row, stableEffectId, requestHash });
  }

  async #unresolvedCommands(taskId: string): Promise<readonly EffectLedgerRow[]> {
    return Object.freeze(await listLatestTaskEffectsByStates(
      this.#ch,
      taskId,
      ['pending', 'uncertain'],
    ));
  }

  async #recordPlannedCommand(
    command: CommandEffect,
    attemptId: EntityId,
    createdAt: string,
    guard: FencedLeaseGuard,
    details: Readonly<Record<string, unknown>> = {},
    replacePlanned = false,
  ): Promise<CommandEffect> {
    const planned = plannedCommandAttemptId(command.row);
    if (planned !== undefined && planned !== attemptId) {
      throw new SchedulerError(
        'INTEGRITY_CONFLICT',
        `assignment command planned attempt catismasi: ${planned}:${attemptId}`,
      );
    }
    if ((planned !== undefined && !replacePlanned) || command.row.state !== 'pending') return command;
    await guard.assertHeld();
    const row = await guard.after(appendEffectVersion(this.#ch, {
      causation_id: command.row.causation_id,
      stable_effect_id: command.stableEffectId,
      expectedVersion: command.row.effect_version,
      state: 'pending',
      result: { phase: 'planned', assignmentAttemptId: attemptId, ...details },
      error: '',
      lease_fence: guard.lease.fence,
      created_at: createdAt,
    }));
    return Object.freeze({ ...command, row });
  }

  async #completeCommand(
    command: CommandEffect,
    attempt: AssignmentAttemptV1,
    createdAt: string,
    guard: FencedLeaseGuard,
  ): Promise<void> {
    if (command.row.state === 'succeeded') return;
    await guard.assertHeld();
    await guard.after(appendEffectVersion(this.#ch, {
      causation_id: command.row.causation_id,
      stable_effect_id: command.stableEffectId,
      expectedVersion: command.row.effect_version,
      state: 'succeeded',
      result: { assignmentAttemptId: attempt.assignmentAttemptId },
      error: '',
      lease_fence: guard.lease.fence,
      created_at: createdAt,
    }));
  }

  #assertCommandBriefPlan(row: EffectLedgerRow, brief: TaskBriefV1): void {
    const result: unknown = row.result;
    if (result === null || typeof result !== 'object' || Array.isArray(result)) {
      throw new SchedulerError('INTEGRITY_CONFLICT', 'assignment command brief plani nesne degil');
    }
    const record = result as Record<string, unknown>;
    const taskBriefId = EntityIdSchema.parse(record['taskBriefId']);
    const briefHash = record['briefHash'];
    const sourceVersionManifest = SourceVersionManifestV1Schema.parse(
      record['sourceVersionManifest'],
    );
    if (
      taskBriefId !== brief.taskBriefId ||
      typeof briefHash !== 'string' || briefHash !== canonicalSha256V1(brief) ||
      canonicalSha256V1(sourceVersionManifest) !==
        canonicalSha256V1(brief.sourceVersionManifest)
    ) {
      throw new SchedulerError(
        'INTEGRITY_CONFLICT',
        `assignment command pinned brief/source manifest catismasi: ${brief.taskBriefId}`,
      );
    }
  }

  async #recoverCommand(
    task: TaskRow,
    command: CommandEffect,
    guard: FencedLeaseGuard,
    heldAgentGuards: readonly FencedLeaseGuard[] = [],
  ): Promise<AssignmentAttemptV1> {
    const attemptId = plannedCommandAttemptId(command.row);
    if (attemptId === undefined) {
      throw new SchedulerError('INTEGRITY_CONFLICT', 'assignment command planned attempt tasimiyor');
    }
    const attempt = await guard.after(getAssignmentAttempt(this.#ch, attemptId));
    if (attempt === null || attempt.taskId !== task.task_id || attempt.projectId !== this.#projectId) {
      throw new SchedulerError('INTEGRITY_CONFLICT', 'completed command attempt kaydi bulunamadi');
    }
    const current = await guard.after(this.#task(task.task_id));
    if (current.assignment_attempt_id !== attempt.assignmentAttemptId) return attempt;
    const brief = await guard.after(this.#currentBrief(current));
    const previous = attempt.previousAttemptId === undefined
      ? null
      : await guard.after(getAssignmentAttempt(this.#ch, attempt.previousAttemptId));
    if (attempt.previousAttemptId !== undefined && previous === null) {
      throw new SchedulerError('INTEGRITY_CONFLICT', 'completed command previous attempt yok');
    }
    const ownsGuards = heldAgentGuards.length === 0;
    const guards = ownsGuards
      ? await this.#acquireAgentGuards([
        attempt.workerAgentId,
        attempt.verifierAgentId,
        ...(previous === null ? [] : [previous.workerAgentId, previous.verifierAgentId]),
      ], `command-recovery:${attempt.assignmentAttemptId}`)
      : heldAgentGuards;
    try {
      await this.#lockedAgentPair(
        current,
        brief,
        attempt.workerAgentId,
        attempt.verifierAgentId,
        guards,
      );
      if (previous !== null && command.row.state !== 'succeeded') {
        await this.#transferAttemptLocks(
          current,
          previous.assignmentAttemptId,
          attempt.assignmentAttemptId,
          guard,
        );
      } else {
        await this.#ensureLocks(current, attempt.assignmentAttemptId, guard);
      }
      await this.#reserveAgent(attempt.workerAgentId, current.task_id, this.#clock.now(), guards);
      await this.#assertAgentGuard(attempt.workerAgentId, guards);
      await this.#reserveAgent(attempt.verifierAgentId, current.task_id, this.#clock.now(), guards);
      await this.#assertAgentGuard(attempt.verifierAgentId, guards);
      if (previous !== null && previous.workerAgentId !== attempt.workerAgentId) {
        await this.#releaseAgent(previous.workerAgentId, current.task_id, this.#clock.now(), guards);
      }
      if (previous !== null && previous.verifierAgentId !== attempt.verifierAgentId) {
        await this.#releaseAgent(previous.verifierAgentId, current.task_id, this.#clock.now(), guards);
      }
      if (previous !== null && command.row.state !== 'succeeded') {
        await this.#transitionService.activateAttemptWithGuard(
          systemPrincipal('scheduler', attempt.assignedAt),
          {
            projectId: current.project_id,
            taskId: current.task_id,
            taskBriefId: attempt.taskBriefId,
            previousAssignmentAttemptId: previous.assignmentAttemptId,
            assignmentAttemptId: attempt.assignmentAttemptId,
            workerAgentId: attempt.workerAgentId,
            verifierAgentId: attempt.verifierAgentId,
            causationId: command.row.causation_id,
            requestedAt: attempt.assignedAt,
          },
          guard,
        );
      }
      await this.#resumeEscalatedAttempt(
        current.task_id,
        attempt,
        command.row.causation_id,
        guard,
      );
      if (previous !== null && current.status !== 'escalated') {
        await appendTaskFileLockEvents(
          this.#ch,
          current,
          previous,
          'lock_released',
          attempt.assignedAt,
          guard,
        );
      }
      await appendTaskFileLockEvents(
        this.#ch,
        current,
        attempt,
        'lock_acquired',
        attempt.assignedAt,
        guard,
      );
      await this.#appendAttemptStart(
        attempt,
        brief,
        attempt.startReason === 'reassignment' ? 'handoff' : attempt.startReason,
        guard,
      );
      await this.#completeCommand(command, attempt, command.row.created_at, guard);
      return attempt;
    } finally {
      if (ownsGuards) await this.#stopGuards(guards);
    }
  }

  async #resumeEscalatedAttempt(
    taskId: EntityId,
    attempt: AssignmentAttemptV1,
    causationId: EntityId,
    guard: FencedLeaseGuard,
  ): Promise<void> {
    let current = await guard.after(this.#task(taskId));
    if (current.status !== 'escalated') return;
    if (current.assignment_attempt_id !== attempt.assignmentAttemptId) {
      current = await guard.after(this.#task(taskId));
      if (current.assignment_attempt_id !== attempt.assignmentAttemptId) {
        throw new SchedulerError(
          'STALE_FENCE',
          `escalation resolution current attempt degisti: ${taskId}`,
        );
      }
    }
    const transitionRequestId = deterministicSchedulerEntityId(
      'escalation-resolved-transition-v1',
      {
        taskId,
        assignmentAttemptId: attempt.assignmentAttemptId,
        causationId,
      },
    );
    await this.#transitionService.applyWithGuard(
      systemPrincipal('scheduler', attempt.assignedAt),
      {
        protocolVersion: 1,
        transitionRequestId,
        projectId: current.project_id,
        taskId,
        taskBriefId: attempt.taskBriefId,
        assignmentAttemptId: attempt.assignmentAttemptId,
        causationId,
        requestedAt: attempt.assignedAt,
        action: 'escalation_resolved',
      },
      guard,
    );
  }

  #normalizedCorrectionInput(
    taskId: EntityId,
    startReason: 'retry_after_rejection' | 'retry_after_gate_failure' | 'rebase',
    input: RebaseTaskInput | undefined,
  ): unknown {
    return Object.freeze({
      command: startReason,
      projectId: this.#projectId,
      taskId,
      ...(input === undefined ? {} : {
        causationId: input.causationId,
        requestedAt: new Date(input.requestedAt).toISOString(),
        planId: input.planId ?? NIL_UUID,
        acceptanceCriteria: input.acceptanceCriteria ?? null,
        allowedTools: input.allowedTools ?? null,
        ruleRefs: input.ruleRefs ?? null,
        standardKnowledgeIds: input.standardKnowledgeIds ?? null,
        requirementKnowledgeIds: input.requirementKnowledgeIds ?? null,
      }),
    });
  }

  #assertBriefMatchesAgents(
    brief: TaskBriefV1,
    worker: AgentRow,
    verifier: AgentRow,
  ): void {
    for (const agent of [worker, verifier]) {
      const matched = brief.promptRefs.some((ref) =>
        ref.sourceType === 'prompt' && ref.sourceId === agent.prompt_name &&
        ref.version === agent.prompt_version);
      if (!matched) {
        throw new SchedulerError(
          'INTEGRITY_CONFLICT',
          `agent promptu immutable brief ile eslesmiyor: ${agent.agent_id}`,
        );
      }
    }
  }

  #assertAssignablePair(
    task: TaskRow,
    brief: TaskBriefV1,
    worker: AgentRow,
    verifier: AgentRow,
  ): void {
    if (
      worker.role !== 'worker' || verifier.role !== 'verifier' ||
      worker.group !== task.group || verifier.group !== task.group ||
      worker.agent_id === verifier.agent_id
    ) {
      throw new SchedulerError('INTEGRITY_CONFLICT', 'immutable attempt agent cifti gecersiz');
    }
    for (const agent of [worker, verifier]) {
      if (
        agent.status !== 'idle' &&
        !(agent.status === 'busy' && agent.current_task_id === task.task_id)
      ) {
        throw new TaskDeferredError(
          'NO_ELIGIBLE_AGENT',
          `prepared attempt agenti kullanilabilir degil: ${agent.agent_id}`,
        );
      }
    }
    this.#assertBriefMatchesAgents(brief, worker, verifier);
  }

  async #selectAgents(
    task: TaskRow,
    excludedWorkerId?: string,
    brief?: TaskBriefV1,
  ): Promise<readonly [AgentRow, AgentRow]> {
    const idle = await listLatestAgentsByStatus(this.#ch, this.#projectId, 'idle');
    const reserved = (await listLatestAgentsByStatus(this.#ch, this.#projectId, 'busy'))
      .filter((agent) => agent.current_task_id === task.task_id);
    const candidates = [...idle, ...reserved].sort((left, right) =>
      left.agent_id.localeCompare(right.agent_id));
    let worker = candidates.find((agent) =>
      agent.role === 'worker' && agent.group === task.group &&
      agent.agent_id !== excludedWorkerId &&
      (brief === undefined || brief.promptRefs.some((ref) =>
        ref.sourceType === 'prompt' && ref.sourceId === agent.prompt_name &&
        ref.version === agent.prompt_version)));
    if (worker === undefined) {
      // docs/03: "uygun agent meşgulse aynı rol/prompt/bağlamla klon açılır".
      // Klon servisi yazılıydı ama hiçbir yerden çağrılmıyordu; eşleşen tüm
      // agent'lar meşgulken atama burada düşüyordu (canlı koşuda görüldü).
      const cloned = await this.#cloneBusyAgent(task, 'worker', brief);
      if (cloned === undefined) {
        throw new TaskDeferredError('NO_ELIGIBLE_AGENT', `idle worker bulunamadi: ${task.group}`);
      }
      candidates.push(cloned);
      worker = cloned;
    }
    // Klonlama sonrası worker kesindir; tip daralması için açık kontrol.
    if (worker === undefined) {
      throw new TaskDeferredError('NO_ELIGIBLE_AGENT', `idle worker bulunamadi: ${task.group}`);
    }
    const verifiers = candidates.filter((agent) =>
      agent.role === 'verifier' && agent.group === task.group && agent.agent_id !== worker.agent_id &&
      (brief === undefined || brief.promptRefs.some((ref) =>
        ref.sourceType === 'prompt' && ref.sourceId === agent.prompt_name &&
        ref.version === agent.prompt_version)));
    verifiers.sort((left, right) => {
      const workerProvider = modelProvider(worker.model_ref);
      const leftIndependent = modelProvider(left.model_ref) === workerProvider ? 1 : 0;
      const rightIndependent = modelProvider(right.model_ref) === workerProvider ? 1 : 0;
      return leftIndependent - rightIndependent || left.agent_id.localeCompare(right.agent_id);
    });
    let verifier = verifiers[0];
    if (verifier === undefined) {
      // docs/03 klonlama kuralı ROLE BAKMAZ: "uygun agent meşgulse aynı
      // rol/prompt/bağlamla klon açılır". Klon worker için bağlanmış ama
      // verifier için unutulmuştu; tek verifier'lı bir projede ikinci görev
      // sonsuza dek "idle verifier bulunamadi" ile erteleniyordu.
      const clonedVerifier = await this.#cloneBusyAgent(task, 'verifier', brief);
      // Klon KAYNAĞIYLA aynı modeli taşır, yani çapraz kontrol bağımsızlığı
      // zayıflayabilir. docs/03 bunu "mümkünse" diye yazıyor: hiç
      // doğrulanmayan iş, aynı sağlayıcıyla doğrulanandan kötüdür.
      if (clonedVerifier === undefined || clonedVerifier.agent_id === worker.agent_id) {
        throw new TaskDeferredError('NO_ELIGIBLE_AGENT', `idle verifier bulunamadi: ${task.group}`);
      }
      verifier = clonedVerifier;
    }
    return Object.freeze([worker, verifier]);
  }

  async #minimumFence(task: TaskRow): Promise<string> {
    return getTaskDurableMaxLeaseFence(this.#ch, task.task_id);
  }

  async #acquireTaskGuard(task: TaskRow, attemptId: EntityId): Promise<FencedLeaseGuard> {
    const lease = await acquireFencedLease(
      this.#redis,
      taskLockKey(task.task_id),
      `assignment:${attemptId}`,
      this.#taskLeaseTtlMs,
      await this.#minimumFence(task),
    );
    if (lease === null) {
      throw new TaskDeferredError('LEASE_UNAVAILABLE', `task lease mesgul: ${task.task_id}`);
    }
    const guard = new FencedLeaseGuard(this.#redis, lease, this.#taskLeaseTtlMs);
    try {
      await guard.assertHeld();
      return guard;
    } catch (error) {
      await guard.stop(true);
      throw error;
    }
  }

  async #refreshTaskGuardAfterTransition(
    guard: FencedLeaseGuard,
    taskId: EntityId,
    attemptId: EntityId,
  ): Promise<FencedLeaseGuard> {
    try {
      await guard.assertHeld();
      return guard;
    } catch (error) {
      if (!(error instanceof SchedulerError) || error.code !== 'STALE_FENCE') throw error;
    }
    await guard.stop(false);
    const current = await this.#task(taskId);
    if (current.assignment_attempt_id !== attemptId) {
      throw new SchedulerError(
        'UNCERTAIN_WRITE',
        `transition sonrasi current attempt uzlastirilamadi: ${taskId}`,
      );
    }
    return this.#acquireTaskGuard(
      current,
      deterministicSchedulerEntityId('assignment-post-transition-v1', {
        taskId,
        attemptId,
      }),
    );
  }

  async #ensureLocks(
    task: TaskRow,
    owner: string,
    guard: FencedLeaseGuard,
    acquired: FileLockKey[] = [],
  ): Promise<LockSet> {
    const keys = sortedLockKeys(task.project_id, task.target_files);
    try {
      for (const key of keys) {
        await guard.assertHeld();
        if (await this.#renewOrReconcileFileLock(key, owner, guard)) {
          acquired.push(key);
          await guard.assertHeld();
          continue;
        }
        await guard.assertHeld();
        await this.#acquireOrReconcileFileLock(key, owner, guard);
        // Record immediately after Redis accepted ownership. A following lease
        // assertion may fail and must not orphan this lock.
        acquired.push(key);
        await guard.assertHeld();
      }
      return Object.freeze({ keys, acquired: Object.freeze(acquired) });
    } catch (error) {
      await this.#releaseLocks(acquired, owner, guard);
      throw error;
    }
  }

  async #renewOrReconcileFileLock(
    key: FileLockKey,
    owner: string,
    guard: FencedLeaseGuard,
  ): Promise<boolean> {
    let firstFailure: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await guard.assertHeld();
      try {
        if (await renewFileLock(this.#redis, key, owner, this.#fileLockTtlSec)) return true;
        firstFailure ??= new Error('file lock renew false dondurdu');
      } catch (error) {
        firstFailure ??= error;
      }
      let observedOwner: string | null;
      let observedPttlMs: number;
      try {
        const snapshot = await inspectFileLock(this.#redis, key);
        observedOwner = snapshot.owner;
        observedPttlMs = snapshot.pttlMs;
      } catch (reconciliation) {
        throw new SchedulerError(
          'UNCERTAIN_WRITE',
          `file lock renew sonucu atomik owner/PTTL ile okunamadi: ${key}`,
          { renew: firstFailure, reconciliation },
        );
      }
      if (observedOwner !== null && observedPttlMs < 0) {
        throw new SchedulerError(
          'UNCERTAIN_WRITE',
          `file lock renew owner/PTTL snapshotunda expiry yok: ${key}`,
          { renew: firstFailure, observedOwner, observedPttlMs },
        );
      }
      if (observedOwner !== null && observedOwner !== owner) {
        throw new TaskDeferredError(
          'FILE_LOCK_UNAVAILABLE',
          `file lock renew foreign owner ile catisti: ${key}:${observedOwner}`,
        );
      }
      if (
        observedOwner === owner &&
        observedPttlMs >= Math.max(1, (this.#fileLockTtlSec * 1_000) - 1_000)
      ) return true;
      if (attempt === 0) continue;
      if (observedOwner === null) return false;
      throw new SchedulerError(
        'UNCERTAIN_WRITE',
        `file lock renew iki denemede PTTL tabanina uzlastirilamadi: ${key}`,
        { renew: firstFailure, observedPttlMs },
      );
    }
    return false;
  }

  async #acquireOrReconcileFileLock(
    key: FileLockKey,
    owner: string,
    guard: FencedLeaseGuard,
  ): Promise<void> {
    let firstFailure: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await guard.assertHeld();
      try {
        if (await acquireFileLock(this.#redis, key, owner, this.#fileLockTtlSec)) return;
        firstFailure ??= new Error('file lock acquire false dondurdu');
      } catch (error) {
        firstFailure ??= error;
      }
      let observed: string | null;
      try {
        observed = await getFileLockOwner(this.#redis, key);
      } catch (reconciliation) {
        throw new SchedulerError(
          'UNCERTAIN_WRITE',
          `file lock acquire sonucu okunamadi: ${key}`,
          { acquire: firstFailure, reconciliation },
        );
      }
      if (observed === owner) return;
      if (observed !== null) {
        throw new TaskDeferredError(
          'FILE_LOCK_UNAVAILABLE',
          `file lock foreign owner ile mesgul: ${key}:${observed}`,
        );
      }
      if (attempt === 0) continue;
      throw new SchedulerError(
        'UNCERTAIN_WRITE',
        `file lock acquire sonucu iki denemede uzlastirilamadi: ${key}`,
        firstFailure,
      );
    }
  }

  async #transferAttemptLocks(
    task: TaskRow,
    fromAttemptId: EntityId,
    toAttemptId: EntityId,
    guard: FencedLeaseGuard,
  ): Promise<void> {
    const keys = sortedLockKeys(task.project_id, task.target_files);
    await this.#transferOrReconcileLockSet(
      keys,
      fromAttemptId,
      toAttemptId,
      guard,
      'forward',
    );
  }

  async #restoreAttemptLocks(
    task: TaskRow,
    fromAttemptId: EntityId,
    toAttemptId: EntityId,
    guard: FencedLeaseGuard,
  ): Promise<void> {
    const keys = sortedLockKeys(task.project_id, task.target_files);
    await this.#transferOrReconcileLockSet(
      keys,
      fromAttemptId,
      toAttemptId,
      guard,
      'rollback',
    );
  }

  async #transferOrReconcileLockSet(
    keys: readonly FileLockKey[],
    fromOwner: string,
    toOwner: string,
    guard: FencedLeaseGuard,
    mode: 'forward' | 'heartbeat' | 'rollback',
  ): Promise<void> {
    if (keys.length === 0) return;
    let firstFailure: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await guard.assertHeld();
      try {
        if (await transferOrAcquireFileLocks(
          this.#redis,
          keys,
          fromOwner,
          toOwner,
          this.#fileLockTtlSec,
        )) {
          await guard.assertHeld();
          return;
        }
        firstFailure ??= new Error('atomik file lock transfer false dondurdu');
      } catch (error) {
        firstFailure ??= error;
      }

      let owners: readonly (string | null)[];
      try {
        owners = await Promise.all(keys.map((key) => getFileLockOwner(this.#redis, key)));
      } catch (reconciliation) {
        throw new SchedulerError(
          'UNCERTAIN_WRITE',
          `file lock ${mode} sonucu okunamadi`,
          { transfer: firstFailure, reconciliation },
        );
      }
      if (owners.every((owner) => owner === toOwner)) {
        await guard.assertHeld();
        return;
      }
      const foreignIndex = owners.findIndex((owner) =>
        owner !== null && owner !== fromOwner && owner !== toOwner);
      if (foreignIndex >= 0) {
        const key = keys[foreignIndex]!;
        const owner = owners[foreignIndex]!;
        const includesTargetOwner = fromOwner !== toOwner &&
          owners.some((candidate) => candidate === toOwner);
        if (mode !== 'rollback' && !includesTargetOwner) {
          throw new TaskDeferredError(
            'FILE_LOCK_UNAVAILABLE',
            `file lock ${mode} foreign owner ile catisti: ${key}:${owner}`,
          );
        }
        throw new SchedulerError(
          'UNCERTAIN_WRITE',
          `file lock ${mode} mixed/foreign owner setiyle catisti: ${key}:${owner}`,
          firstFailure,
        );
      }
      if (attempt === 0) continue;
      throw new SchedulerError(
        'UNCERTAIN_WRITE',
        `file lock ${mode} safe owner seti exact hedefe uzlastirilamadi`,
        { transfer: firstFailure, owners },
      );
    }
  }

  async #restoreTransferredLocksFresh(
    taskId: EntityId,
    plannedAttemptId: EntityId,
    previousAttemptId: EntityId,
  ): Promise<void> {
    const observed = await this.#task(taskId);
    if (observed.assignment_attempt_id === plannedAttemptId) return;
    if (observed.assignment_attempt_id !== previousAttemptId) {
      throw new SchedulerError(
        'UNCERTAIN_WRITE',
        `file lock rollback current attempt uzlastirilamadi: ${taskId}`,
      );
    }
    const recoveryId = deterministicSchedulerEntityId('assignment-lock-rollback-v1', {
      taskId,
      plannedAttemptId,
      previousAttemptId,
    });
    const guard = await this.#acquireTaskGuard(observed, recoveryId);
    try {
      const current = await guard.after(this.#task(taskId));
      if (current.assignment_attempt_id === plannedAttemptId) return;
      if (current.assignment_attempt_id !== previousAttemptId) {
        throw new SchedulerError(
          'UNCERTAIN_WRITE',
          `file lock rollback fence altinda current attempt degisti: ${taskId}`,
        );
      }
      await this.#restoreAttemptLocks(
        current,
        plannedAttemptId,
        previousAttemptId,
        guard,
      );
    } finally {
      await guard.stop(true);
    }
  }

  async #acquireAgentGuards(
    agentIds: readonly EntityId[],
    owner: string,
  ): Promise<readonly FencedLeaseGuard[]> {
    const guards: FencedLeaseGuard[] = [];
    try {
      for (const agentId of [...new Set(agentIds)].sort()) {
        const agent = await this.#agent(agentId);
        const lease = await acquireFencedLease(
          this.#redis,
          agentLockKey(agentId),
          owner,
          this.#taskLeaseTtlMs,
          agent.assignment_fence,
        );
        if (lease === null) {
          throw new TaskDeferredError('LEASE_UNAVAILABLE', `agent lease mesgul: ${agentId}`);
        }
        const guard = new FencedLeaseGuard(this.#redis, lease, this.#taskLeaseTtlMs);
        guards.push(guard);
        await guard.assertHeld();
      }
      return Object.freeze(guards);
    } catch (error) {
      await this.#stopGuards(guards);
      throw error;
    }
  }

  async #stopGuards(guards: readonly FencedLeaseGuard[]): Promise<void> {
    let firstError: unknown;
    for (const guard of [...guards].reverse()) {
      try {
        await guard.stop(true);
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError !== undefined) throw firstError;
  }

  async #assertAgentGuards(guards: readonly FencedLeaseGuard[]): Promise<void> {
    for (const guard of guards) await guard.assertHeld();
  }

  async #assertAgentGuard(
    agentId: string,
    guards: readonly FencedLeaseGuard[],
  ): Promise<FencedLeaseGuard> {
    const guard = this.#agentGuard(agentId, guards);
    await guard.assertHeld();
    return guard;
  }

  async #lockedAgentPair(
    task: TaskRow,
    brief: TaskBriefV1,
    workerId: EntityId,
    verifierId: EntityId,
    guards: readonly FencedLeaseGuard[],
  ): Promise<readonly [AgentRow, AgentRow]> {
    await this.#assertAgentGuards(guards);
    const worker = await this.#agent(workerId);
    await this.#assertAgentGuards(guards);
    const verifier = await this.#agent(verifierId);
    await this.#assertAgentGuards(guards);
    this.#assertAssignablePair(task, brief, worker, verifier);
    return Object.freeze([worker, verifier]);
  }

  async #releaseLocks(
    keys: readonly FileLockKey[],
    owner: string,
    guard: FencedLeaseGuard,
  ): Promise<void> {
    let firstError: unknown;
    for (const key of [...keys].reverse()) {
      try {
        await this.#releaseLockUnderTaskGuard(key, owner, guard);
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError !== undefined) throw firstError;
  }

  async #releaseLockUnderTaskGuard(
    key: FileLockKey,
    owner: string,
    guard: FencedLeaseGuard,
  ): Promise<void> {
    const taskId = guard.lease.lockKey.split(':')[2];
    if (taskId === undefined || taskLockKey(taskId) !== guard.lease.lockKey) {
      throw new SchedulerError('STALE_FENCE', 'file lock rollback task guard gerektirir');
    }
    const taskLeaseKey = taskLockKey(taskId);
    let firstFailure: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await guard.assertHeld();
      try {
        if (await releaseFileLockUnderTaskLease(
          this.#redis,
          taskLeaseKey,
          guard.lease.owner,
          guard.lease.fence,
          key,
          owner,
        )) {
          await guard.assertHeld();
          return;
        }
        firstFailure ??= new Error('task-fenced file lock release false dondurdu');
      } catch (error) {
        firstFailure ??= error;
      }
      await guard.assertHeld();
      let observed: string | null;
      try {
        observed = await getFileLockOwner(this.#redis, key);
      } catch (reconciliation) {
        throw new SchedulerError(
          'UNCERTAIN_WRITE',
          `task-fenced file lock release sonucu okunamadi: ${key}`,
          { release: firstFailure, reconciliation },
        );
      }
      if (observed === null || observed !== owner) return;
    }
    throw new SchedulerError(
      'UNCERTAIN_WRITE',
      `task-fenced file lock release sonrasi eski owner kaldi: ${key}:${owner}`,
      firstFailure,
    );
  }

  async #reserveAgent(
    agentId: string,
    taskId: EntityId,
    at: string,
    guards: readonly FencedLeaseGuard[],
  ): Promise<ReservedAgent> {
    await this.#assertAgentGuards(guards);
    const current = await this.#agent(agentId);
    await this.#assertAgentGuards(guards);
    if (current.status === 'busy' && current.current_task_id === taskId) {
      return Object.freeze({ row: current, changed: false });
    }
    if (current.status !== 'idle' || current.current_task_id !== NIL_UUID) {
      throw new TaskDeferredError('NO_ELIGIBLE_AGENT', `agent artik idle degil: ${agentId}`);
    }
    const row = await appendAgentVersion(this.#ch, {
      expectedVersion: current.version,
      assignmentFence: this.#agentFence(agentId, guards),
      next: { ...current, status: 'busy', current_task_id: taskId, updated_at: at },
    });
    return Object.freeze({ row, changed: true });
  }

  async #rollbackInitialReservation(
    reservation: ReservedAgent,
    taskId: EntityId,
    at: string,
    taskGuard: FencedLeaseGuard,
    agentGuards: readonly FencedLeaseGuard[],
  ): Promise<void> {
    if (!reservation.changed) return;
    try {
      const task = await taskGuard.after(this.#task(taskId));
      if (!this.#isQueuedUnassigned(task)) return;
      try {
        await this.#rollbackAgent(reservation, at, agentGuards);
        return;
      } catch (error) {
        if (!(error instanceof SchedulerError) || error.code !== 'STALE_FENCE') throw error;
      }
      await this.#agentGuard(reservation.row.agent_id, agentGuards).stop(true);
      await this.#rollbackReservationWithFreshAgentFence(reservation, task, at, taskGuard);
      return;
    } catch (error) {
      if (!(error instanceof SchedulerError) || error.code !== 'STALE_FENCE') throw error;
    }

    // The task guard itself was lost. Stop its heartbeat before taking a fresh
    // fence, then re-check both task ownership and the exact accepted agent row.
    await taskGuard.stop(false);
    await this.#agentGuard(reservation.row.agent_id, agentGuards).stop(true);
    const observed = await this.#task(taskId);
    if (!this.#isQueuedUnassigned(observed)) return;
    const recoveryId = deterministicSchedulerEntityId('initial-agent-rollback-v1', {
      taskId,
      agentId: reservation.row.agent_id,
      acceptedAgentVersion: reservation.row.version,
      acceptedAgentFence: reservation.row.assignment_fence,
    });
    const freshTaskGuard = await this.#acquireTaskGuard(observed, recoveryId);
    try {
      const current = await freshTaskGuard.after(this.#task(taskId));
      if (!this.#isQueuedUnassigned(current)) return;
      await this.#rollbackReservationWithFreshAgentFence(
        reservation,
        current,
        at,
        freshTaskGuard,
      );
    } finally {
      await freshTaskGuard.stop(true);
    }
  }

  async #rollbackReservationWithFreshAgentFence(
    reservation: ReservedAgent,
    task: TaskRow,
    at: string,
    taskGuard: FencedLeaseGuard,
  ): Promise<void> {
    if (!this.#isQueuedUnassigned(task)) return;
    const guards = await this.#acquireAgentGuards(
      [reservation.row.agent_id],
      `initial-rollback:${reservation.row.agent_id}:${reservation.row.version}`,
    );
    try {
      await taskGuard.assertHeld();
      const currentTask = await taskGuard.after(this.#task(task.task_id));
      if (!this.#isQueuedUnassigned(currentTask)) return;
      const current = await this.#agent(reservation.row.agent_id);
      await this.#assertAgentGuard(current.agent_id, guards);
      if (current.status === 'idle' && current.current_task_id === NIL_UUID) return;
      if (
        current.version !== reservation.row.version ||
        current.assignment_fence !== reservation.row.assignment_fence ||
        current.status !== 'busy' || current.current_task_id !== task.task_id
      ) {
        throw new SchedulerError(
          'UNCERTAIN_WRITE',
          `accepted agent reservation fresh fence altinda uzlastirilamadi: ${current.agent_id}`,
        );
      }
      await appendAgentVersion(this.#ch, {
        expectedVersion: current.version,
        assignmentFence: this.#agentFence(current.agent_id, guards),
        next: { ...current, status: 'idle', current_task_id: NIL_UUID, updated_at: at },
      });
    } finally {
      await this.#stopGuards(guards);
    }
  }

  async #rollbackReservationFreshIfAttemptNotActivated(
    reservation: ReservedAgent,
    taskId: EntityId,
    plannedAttemptId: EntityId,
    at: string,
  ): Promise<void> {
    if (!reservation.changed) return;
    const observed = await this.#task(taskId);
    if (observed.assignment_attempt_id === plannedAttemptId) return;
    const recoveryId = deterministicSchedulerEntityId('reassignment-agent-rollback-v1', {
      taskId,
      plannedAttemptId,
      agentId: reservation.row.agent_id,
      acceptedAgentVersion: reservation.row.version,
      acceptedAgentFence: reservation.row.assignment_fence,
    });
    const taskGuard = await this.#acquireTaskGuard(observed, recoveryId);
    let guards: readonly FencedLeaseGuard[] = [];
    try {
      const currentTask = await taskGuard.after(this.#task(taskId));
      if (currentTask.assignment_attempt_id === plannedAttemptId) return;
      guards = await this.#acquireAgentGuards(
        [reservation.row.agent_id],
        `reassignment-rollback:${reservation.row.agent_id}:${reservation.row.version}`,
      );
      const current = await this.#agent(reservation.row.agent_id);
      await this.#assertAgentGuard(current.agent_id, guards);
      if (current.status === 'idle' && current.current_task_id === NIL_UUID) return;
      if (
        current.version !== reservation.row.version ||
        current.assignment_fence !== reservation.row.assignment_fence ||
        current.status !== 'busy' || current.current_task_id !== taskId
      ) {
        throw new SchedulerError(
          'UNCERTAIN_WRITE',
          `reassignment agent reservation uzlastirilamadi: ${current.agent_id}`,
        );
      }
      await appendAgentVersion(this.#ch, {
        expectedVersion: current.version,
        assignmentFence: this.#agentFence(current.agent_id, guards),
        next: { ...current, status: 'idle', current_task_id: NIL_UUID, updated_at: at },
      });
    } finally {
      let cleanupError: unknown;
      try {
        await this.#stopGuards(guards);
      } catch (error) {
        cleanupError ??= error;
      }
      try {
        await taskGuard.stop(true);
      } catch (error) {
        cleanupError ??= error;
      }
      if (cleanupError !== undefined) throw cleanupError;
    }
  }

  async #initialCleanupSnapshot(
    taskId: EntityId,
    attemptId: EntityId,
    guard: FencedLeaseGuard,
  ): Promise<{ readonly task: TaskRow; readonly guard: FencedLeaseGuard }> {
    try {
      return Object.freeze({ task: await guard.after(this.#task(taskId)), guard });
    } catch (error) {
      if (!(error instanceof SchedulerError) || error.code !== 'STALE_FENCE') throw error;
    }
    await guard.stop(false);
    const observed = await this.#task(taskId);
    const fresh = await this.#acquireTaskGuard(
      observed,
      deterministicSchedulerEntityId('initial-cleanup-reconcile-v1', {
        taskId,
        attemptId,
      }),
    );
    try {
      return Object.freeze({ task: await fresh.after(this.#task(taskId)), guard: fresh });
    } catch (error) {
      await fresh.stop(true);
      throw error;
    }
  }

  #shouldRollbackInitialAssignment(
    task: TaskRow,
    attemptId: EntityId,
    taskBriefId: EntityId,
  ): boolean {
    if (this.#isQueuedUnassigned(task)) return true;
    if (
      task.status === 'assigned' && task.assignment_attempt_id === attemptId &&
      task.task_brief_id === taskBriefId
    ) return false;
    throw new SchedulerError(
      'UNCERTAIN_WRITE',
      `initial assignment cleanup durable task sahibini uzlastiramadi: ${task.task_id}`,
    );
  }

  #isQueuedUnassigned(task: TaskRow): boolean {
    return task.status === 'queued' && task.assignment_attempt_id === NIL_UUID &&
      task.worker_agent_id === NIL_UUID && task.verifier_agent_id === NIL_UUID;
  }

  async #rollbackAgent(
    reservation: ReservedAgent,
    at: string,
    guards: readonly FencedLeaseGuard[],
  ): Promise<void> {
    if (!reservation.changed) return;
    await this.#assertAgentGuard(reservation.row.agent_id, guards);
    const current = await this.#agent(reservation.row.agent_id);
    await this.#assertAgentGuard(reservation.row.agent_id, guards);
    if (
      current.version !== reservation.row.version || current.status !== 'busy' ||
      current.current_task_id !== reservation.row.current_task_id ||
      current.assignment_fence !== reservation.row.assignment_fence
    ) return;
    await appendAgentVersion(this.#ch, {
      expectedVersion: current.version,
      assignmentFence: this.#agentFence(current.agent_id, guards),
      next: { ...current, status: 'idle', current_task_id: NIL_UUID, updated_at: at },
    });
    await this.#assertAgentGuards(guards);
  }

  async #releaseAgent(
    agentId: string,
    taskId: EntityId,
    at: string,
    guards: readonly FencedLeaseGuard[],
  ): Promise<void> {
    await this.#assertAgentGuard(agentId, guards);
    const current = await this.#agent(agentId);
    await this.#assertAgentGuard(agentId, guards);
    if (current.status !== 'busy' || current.current_task_id !== taskId) return;
    await appendAgentVersion(this.#ch, {
      expectedVersion: current.version,
      assignmentFence: this.#agentFence(agentId, guards),
      next: { ...current, status: 'idle', current_task_id: NIL_UUID, updated_at: at },
    });
    await this.#assertAgentGuard(agentId, guards);
  }

  #agentFence(agentId: string, guards: readonly FencedLeaseGuard[]): string {
    return this.#agentGuard(agentId, guards).lease.fence;
  }

  #agentGuard(agentId: string, guards: readonly FencedLeaseGuard[]): FencedLeaseGuard {
    const key = agentLockKey(agentId);
    const guard = guards.find((candidate) => candidate.lease.lockKey === key);
    if (guard === undefined) {
      throw new SchedulerError('STALE_FENCE', `agent fenced guard bulunamadi: ${agentId}`);
    }
    return guard;
  }

  async #withRepositoryBoundary<T>(context: string, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      throw schedulerBoundaryError(error, context);
    }
  }

  /**
   * Eşleşen agent'lar MEŞGULSE bir klon açar (docs/03). Klon sınırı aşılırsa
   * `undefined` döner ve çağıran görevi ERTELER — sınırsız klon açmak agent
   * kadrosunu ve sağlayıcı kotasını tüketir.
   */
  async #cloneBusyAgent(
    task: TaskRow,
    role: 'worker' | 'verifier',
    brief: TaskBriefV1 | undefined,
  ): Promise<AgentRow | undefined> {
    if (this.#clones === undefined) return undefined;
    // docs/03: "boşta kalan klonlar 10 dk sonra stopped yapılır". Süpürme
    // TAM BURADA koşar çünkü tam burada gerekir: klon açmadan önce ölü
    // klonları toplamak, `max_clones_per_agent`/`max_parallel_agents`
    // sınırlarının birikmiş çöple dolmasını engeller. Süpürme hiç
    // çağrılmıyordu; sınırlar dolunca klonlama sessizce duruyordu.
    //
    // Süpürme hatası ATAMAYI DÜŞÜRMEZ: temizlik yapılamadı diye görevi
    // ertelemek, çözdüğünden fazlasını bozar.
    const cutoff = idleCloneCutoff(this.#clock.now());
    if (cutoff !== undefined) {
      try {
        await this.#clones.stopIdleClones(this.#projectId, cutoff);
      } catch {
        // Sessiz değil: bir sonraki sınır hatası zaten görünür olacak.
      }
    }
    const agents = await listLatestAgents(this.#ch, this.#projectId, { limit: 1_000 });
    const promptRef = brief?.promptRefs.find((ref) => ref.sourceType === 'prompt');
    const source = pickCloneSource(agents as never, {
      role,
      group: task.group,
      ...(promptRef === undefined ? {} : {
        promptName: promptRef.sourceId, promptVersion: promptRef.version,
      }),
    });
    if (source === undefined) return undefined;
    try {
      return await this.#clones.cloneIfBusy(this.#projectId, source.agent_id as EntityId);
    } catch {
      // Klon limiti aşıldıysa görev ertelenir; bu bir HATA DEĞİL, sınırdır.
      return undefined;
    }
  }

}
