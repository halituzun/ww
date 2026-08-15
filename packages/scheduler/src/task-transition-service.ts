import type { ClickHouseClient } from '@ww/db';
import {
  RepositoryWriteError,
  acquireFencedLease,
  agentLockKey,
  appendAgentVersion,
  appendEffectVersion,
  appendEvent,
  appendTaskVersion,
  getAssignmentAttempt,
  getFileLockOwner,
  getLatestAgent,
  getLatestEffect,
  getLatestTask,
  getTaskDurableMaxLeaseFence,
  getTaskBrief,
  listLatestTaskEffectsByStates,
  releaseFileLock,
  reserveEffect,
  taskLockKey,
  type EffectLedgerRow,
  type FencedLease,
  type FileLockKey,
  type TaskRow,
  type WwRedis,
} from '@ww/db';
import {
  AuthenticatedPrincipalV1Schema,
  EntityIdSchema,
  NIL_UUID,
  PolicyDecisionSchema,
  TASK_STATUSES,
  TaskTransitionRequestV1Schema,
  canonicalSha256V1,
  type AuthenticatedPrincipalV1,
  type EntityId,
  type JsonObject,
  type PolicyDecision,
  type TaskStatus,
  type TaskTransitionActionV1,
  type TaskTransitionRequestV1,
} from '@ww/shared';
import {
  SchedulerError,
  TaskDeferredError,
  TaskPolicyDeniedError,
  schedulerBoundaryError,
} from './errors.js';
import { FencedLeaseGuard } from './fenced-lease-guard.js';
import { appendTaskFileLockEvents, taskFileLocks } from './file-lock-events.js';
import {
  deterministicSchedulerEntityId,
  type TaskStateV1,
} from './ports.js';

const TASK_LEASE_TTL_MS = 60_000;
const TRANSITION_EFFECT_TYPE = 'task_transition_v1';
const ATTEMPT_ACTIVATION_EFFECT_TYPE = 'task_attempt_activation_v1';
const RULE_VERSION = 1;
const TERMINAL_RESOURCE_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'done',
  'failed',
  'cancelled',
  'escalated',
]);

const STATIC_EDGES: Readonly<Partial<Record<TaskStatus, Readonly<Partial<
Record<TaskTransitionActionV1, TaskStatus>>>>>> = Object.freeze({
  queued: Object.freeze({ assign: 'assigned', cancel: 'cancelled' }),
  assigned: Object.freeze({ start_work: 'working' }),
  working: Object.freeze({
    // Rebase/resume activation may already have moved the fresh attempt to
    // working before the orchestrator re-enters its lifecycle.
    start_work: 'working',
    report_result: 'verifying',
    fail: 'failed',
    // A worker may pause an active attempt while waiting for an explicit
    // user decision. The question itself is durable evidence; the answer
    // later moves waiting_user back to escalated before a fresh assignment.
    request_user_input: 'waiting_user',
  }),
  verifying: Object.freeze({ verifier_approved: 'testing' }),
  testing: Object.freeze({ gate_passed: 'approved' }),
  approved: Object.freeze({ commit_completed: 'done' }),
  escalated: Object.freeze({
    escalation_resolved: 'working',
    request_user_input: 'waiting_user',
  }),
  // An answer is durable input, not permission to reuse resources released at escalation.
  // The scheduler creates a fresh attempt from the resulting escalated state.
  waiting_user: Object.freeze({ user_answered: 'escalated' }),
});

export interface TaskTransitionEvaluation {
  readonly decision: PolicyDecision;
  readonly toStatus?: TaskStatus;
}

function decision(
  ruleId: PolicyDecision['ruleId'],
  allowed: boolean,
  reason: string,
  evidenceRefs: readonly string[],
): PolicyDecision {
  return Object.freeze({ ruleId, ruleVersion: RULE_VERSION, allowed, reason, evidenceRefs });
}

function principalEffectIdentity(principal: AuthenticatedPrincipalV1): JsonObject {
  if (principal.principalType === 'agent') {
    return {
      principalType: principal.principalType,
      principalId: principal.principalId,
      role: principal.role,
      agentVersion: principal.agentVersion,
    };
  }
  if (principal.principalType === 'system') {
    return {
      principalType: principal.principalType,
      principalId: principal.principalId,
      serviceName: principal.serviceName,
    };
  }
  return {
    principalType: principal.principalType,
    principalId: principal.principalId,
  };
}

function attemptScoped(request: TaskTransitionRequestV1): request is TaskTransitionRequestV1 & {
  readonly taskBriefId: EntityId;
  readonly assignmentAttemptId: EntityId;
} {
  return 'taskBriefId' in request && 'assignmentAttemptId' in request;
}

function principalOwnsAction(
  principal: AuthenticatedPrincipalV1,
  task: TaskRow,
  action: TaskTransitionActionV1,
): boolean {
  if (principal.principalType === 'system') return true;
  if (principal.principalType === 'user') {
    return action === 'user_answered' || action === 'cancel';
  }
  if (action === 'start_work' || action === 'report_result') {
    return principal.role === 'worker' && principal.principalId === task.worker_agent_id;
  }
  if (action === 'verifier_approved' || action === 'verifier_rejected') {
    return principal.role === 'verifier' && principal.principalId === task.verifier_agent_id;
  }
  if (
    action === 'escalation_resolved' || action === 'request_user_input' ||
    action === 'cancel' || action === 'fail'
  ) return principal.role === 'pm';
  return false;
}

function conditionalStatus(task: TaskRow, action: TaskTransitionActionV1): TaskStatus | undefined {
  if (task.status === 'verifying' && action === 'verifier_rejected') {
    return task.attempt + 1 >= task.max_attempts ? 'escalated' : 'working';
  }
  if (task.status === 'testing' && action === 'gate_failed') {
    return task.attempt + 1 >= task.max_attempts ? 'escalated' : 'working';
  }
  return undefined;
}

/** Pure FSM and TASK-* policy guard; it performs no persistence or I/O. */
export function evaluateTaskTransition(
  task: TaskRow,
  principal: AuthenticatedPrincipalV1,
  request: TaskTransitionRequestV1,
): TaskTransitionEvaluation {
  const staticTarget = STATIC_EDGES[task.status]?.[request.action];
  const target = staticTarget ?? conditionalStatus(task, request.action);
  if (target === undefined) {
    return Object.freeze({
      decision: decision(
        'TASK-001',
        false,
        `gecersiz task FSM gecisi: ${task.status} --${request.action}--> ?`,
        [`task:${task.task_id}`, `status:${task.status}`],
      ),
    });
  }
  if (request.action === 'cancel' && request.fromStatus !== task.status) {
    return Object.freeze({
      decision: decision(
        'TASK-003',
        false,
        `cancel fromStatus current task durumuyla eslesmiyor: ${request.fromStatus}`,
        [`task:${task.task_id}`, `status:${task.status}`],
      ),
    });
  }
  if (!principalOwnsAction(principal, task, request.action)) {
    return Object.freeze({
      decision: decision(
        'TASK-002',
        false,
        `principal ${request.action} aksiyonuna yetkili degil`,
        [`principal:${principal.principalId}`, `task:${task.task_id}`],
      ),
    });
  }
  if (
    request.projectId !== task.project_id || request.taskId !== task.task_id ||
    (attemptScoped(request) && (
      request.taskBriefId !== task.task_brief_id ||
      request.assignmentAttemptId !== task.assignment_attempt_id
    ))
  ) {
    return Object.freeze({
      decision: decision(
        'TASK-003',
        false,
        'transition task/brief/attempt current fold ile eslesmiyor',
        [`task:${task.task_id}`, `brief:${task.task_brief_id}`, `attempt:${task.assignment_attempt_id}`],
      ),
    });
  }
  if (
    (request.action === 'verifier_rejected' || request.action === 'gate_failed') &&
    task.max_attempts === 0
  ) {
    return Object.freeze({
      decision: decision(
        'TASK-004',
        false,
        'task max_attempts sifir oldugu icin correction run baslatilamaz',
        [`task:${task.task_id}`],
      ),
    });
  }
  return Object.freeze({
    decision: decision(
      'TASK-001',
      true,
      `task FSM gecisine izin verildi: ${task.status} --${request.action}--> ${target}`,
      [`task:${task.task_id}`, `status:${task.status}`],
    ),
    toStatus: target,
  });
}

export function assignmentAttemptIdForAssign(request: TaskTransitionRequestV1): EntityId {
  if (request.action !== 'assign') {
    throw new SchedulerError('INTEGRITY_CONFLICT', 'assignment attempt kimligi yalniz assign icin uretilir');
  }
  return deterministicSchedulerEntityId('assignment-attempt-v1', {
    taskId: request.taskId,
    taskBriefId: request.taskBriefId,
    causationId: request.causationId,
  });
}

export function transitionIdFor(request: TaskTransitionRequestV1): EntityId {
  return deterministicSchedulerEntityId('task-transition-v1', {
    taskId: request.taskId,
    causationId: request.causationId,
  });
}

function taskState(
  row: TaskRow,
  transitionId: EntityId,
  policy: PolicyDecision,
): TaskStateV1 {
  return Object.freeze({
    projectId: row.project_id,
    taskId: row.task_id,
    taskVersion: row.version,
    status: row.status,
    ...(row.task_brief_id === NIL_UUID ? {} : { taskBriefId: row.task_brief_id }),
    ...(row.assignment_attempt_id === NIL_UUID
      ? {}
      : { assignmentAttemptId: row.assignment_attempt_id }),
    ...(row.worker_agent_id === NIL_UUID ? {} : { workerAgentId: row.worker_agent_id }),
    ...(row.verifier_agent_id === NIL_UUID ? {} : { verifierAgentId: row.verifier_agent_id }),
    attempt: row.attempt,
    transitionId,
    decision: policy,
  });
}

function taskStateJson(state: TaskStateV1): JsonObject {
  return {
    projectId: state.projectId,
    taskId: state.taskId,
    taskVersion: state.taskVersion,
    status: state.status,
    ...(state.taskBriefId === undefined ? {} : { taskBriefId: state.taskBriefId }),
    ...(state.assignmentAttemptId === undefined
      ? {}
      : { assignmentAttemptId: state.assignmentAttemptId }),
    ...(state.workerAgentId === undefined ? {} : { workerAgentId: state.workerAgentId }),
    ...(state.verifierAgentId === undefined ? {} : { verifierAgentId: state.verifierAgentId }),
    attempt: state.attempt,
    transitionId: state.transitionId,
    decision: state.decision,
  };
}

function parseTaskState(value: unknown): TaskStateV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SchedulerError('INTEGRITY_CONFLICT', 'transition result task state nesnesi degil');
  }
  const record = value as Record<string, unknown>;
  const status = record['status'];
  const attempt = record['attempt'];
  const policy = record['decision'];
  if (
    typeof record['projectId'] !== 'string' || typeof record['taskId'] !== 'string' ||
    typeof record['taskVersion'] !== 'string' ||
    typeof status !== 'string' || !(TASK_STATUSES as readonly string[]).includes(status) ||
    !Number.isSafeInteger(attempt) || (attempt as number) < 0 ||
    typeof record['transitionId'] !== 'string' ||
    policy === null || typeof policy !== 'object' || Array.isArray(policy)
  ) throw new SchedulerError('INTEGRITY_CONFLICT', 'transition result task state gecersiz');
  const parsedPolicy = PolicyDecisionSchema.safeParse(policy);
  if (!parsedPolicy.success) {
    throw new SchedulerError('INTEGRITY_CONFLICT', 'transition policy sonucu gecersiz');
  }
  return Object.freeze({
    projectId: EntityIdSchema.parse(record['projectId']),
    taskId: EntityIdSchema.parse(record['taskId']),
    taskVersion: record['taskVersion'],
    status: status as TaskStatus,
    ...(typeof record['taskBriefId'] === 'string'
      ? { taskBriefId: EntityIdSchema.parse(record['taskBriefId']) }
      : {}),
    ...(typeof record['assignmentAttemptId'] === 'string'
      ? { assignmentAttemptId: EntityIdSchema.parse(record['assignmentAttemptId']) }
      : {}),
    ...(typeof record['workerAgentId'] === 'string'
      ? { workerAgentId: EntityIdSchema.parse(record['workerAgentId']) }
      : {}),
    ...(typeof record['verifierAgentId'] === 'string'
      ? { verifierAgentId: EntityIdSchema.parse(record['verifierAgentId']) }
      : {}),
    attempt: attempt as number,
    transitionId: EntityIdSchema.parse(record['transitionId']),
    decision: parsedPolicy.data,
  });
}

function mutateTask(
  current: TaskRow,
  request: TaskTransitionRequestV1,
  toStatus: TaskStatus,
): Omit<TaskRow, 'version'> {
  let next: Omit<TaskRow, 'version'> = {
    ...current,
    status: toStatus,
    updated_at: request.requestedAt,
  };
  if (request.action === 'assign') {
    next = {
      ...next,
      worker_agent_id: request.workerAgentId,
      verifier_agent_id: request.verifierAgentId,
      task_brief_id: request.taskBriefId,
      assignment_attempt_id: assignmentAttemptIdForAssign(request),
    };
  } else if (request.action === 'report_result') {
    next = { ...next, result_summary: request.resultSummary };
  } else if (request.action === 'verifier_rejected' || request.action === 'gate_failed') {
    next = {
      ...next,
      attempt: current.attempt + 1,
      reject_reason: request.reason,
    };
  } else if (request.action === 'user_answered') {
    // A user answer closes the paused attempt; the subsequent correction
    // assignment is attempt N+1 and must be reflected in the task cursor.
    next = { ...next, attempt: current.attempt + 1 };
  } else if (request.action === 'commit_completed') {
    next = { ...next, commit_hash: request.commitHash };
  }
  return next;
}

interface PreparedTransition {
  readonly beforeVersion: string;
  readonly expectedTaskHash: string;
  readonly eventLeaseFence: string;
  readonly state: TaskStateV1;
}

function parsePreparedResult(value: unknown): PreparedTransition | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record['phase'] !== 'prepared') return null;
  if (
    typeof record['beforeVersion'] !== 'string' ||
    typeof record['expectedTaskHash'] !== 'string' ||
    typeof record['eventLeaseFence'] !== 'string' ||
    !/^[1-9]\d*$/.test(record['eventLeaseFence'])
  ) {
    throw new SchedulerError('INTEGRITY_CONFLICT', 'prepared transition sonucu gecersiz');
  }
  return Object.freeze({
    beforeVersion: record['beforeVersion'],
    expectedTaskHash: record['expectedTaskHash'],
    eventLeaseFence: record['eventLeaseFence'],
    state: parseTaskState(record['state']),
  });
}

interface PreparedActivation {
  readonly eventLeaseFence: string;
}

function parsePreparedActivation(value: unknown): PreparedActivation | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record['phase'] !== 'prepared_activation') return null;
  if (
    typeof record['eventLeaseFence'] !== 'string' ||
    !/^[1-9]\d*$/.test(record['eventLeaseFence'])
  ) {
    throw new SchedulerError('INTEGRITY_CONFLICT', 'prepared activation sonucu gecersiz');
  }
  return Object.freeze({ eventLeaseFence: record['eventLeaseFence'] });
}

export interface TaskTransitionServiceOptions {
  readonly leaseTtlMs?: number;
}

export interface ActivateTaskAttemptInput {
  readonly projectId: EntityId;
  readonly taskId: EntityId;
  readonly taskBriefId: EntityId;
  readonly previousAssignmentAttemptId: EntityId;
  readonly assignmentAttemptId: EntityId;
  readonly workerAgentId: EntityId;
  readonly verifierAgentId: EntityId;
  readonly causationId: EntityId;
  readonly requestedAt: string;
}

export class TaskTransitionService {
  readonly #ch: ClickHouseClient;
  readonly #redis: WwRedis;
  readonly #leaseTtlMs: number;

  constructor(ch: ClickHouseClient, redis: WwRedis, options: TaskTransitionServiceOptions = {}) {
    this.#ch = ch;
    this.#redis = redis;
    this.#leaseTtlMs = options.leaseTtlMs ?? TASK_LEASE_TTL_MS;
  }

  async apply(
    principal: AuthenticatedPrincipalV1,
    requestValue: TaskTransitionRequestV1,
  ): Promise<TaskStateV1> {
    try {
      return await this.#apply(principal, requestValue);
    } catch (error) {
      throw schedulerBoundaryError(error, 'task transition', 'TASK_NOT_FOUND');
    }
  }

  async #apply(
    principal: AuthenticatedPrincipalV1,
    requestValue: TaskTransitionRequestV1,
  ): Promise<TaskStateV1> {
    principal = AuthenticatedPrincipalV1Schema.parse(principal);
    const request = TaskTransitionRequestV1Schema.parse(requestValue);
    const current = await getLatestTask(this.#ch, request.projectId, request.taskId);
    if (current === null) throw new SchedulerError('TASK_NOT_FOUND', `task bulunamadi: ${request.taskId}`);
    const minimumFence = await this.#minimumFence(current);
    const transitionId = transitionIdFor(request);
    const lease = await acquireFencedLease(
      this.#redis,
      taskLockKey(request.taskId),
      `transition:${transitionId}`,
      this.#leaseTtlMs,
      minimumFence,
    );
    if (lease === null) {
      throw new TaskDeferredError('LEASE_UNAVAILABLE', `task lease mesgul: ${request.taskId}`);
    }
    const guard = new FencedLeaseGuard(this.#redis, lease, this.#leaseTtlMs);
    try {
      return await this.applyWithGuard(principal, request, guard);
    } catch (error) {
      if (!(error instanceof SchedulerError) || error.code !== 'STALE_FENCE') throw error;
    } finally {
      await guard.stop(true);
    }
    return this.#reconcileTransitionAfterLeaseLoss(principal, request);
  }

  async applyWithLease(
    principal: AuthenticatedPrincipalV1,
    requestValue: TaskTransitionRequestV1,
    lease: FencedLease,
  ): Promise<TaskStateV1> {
    try {
      return await this.#applyWithLease(principal, requestValue, lease);
    } catch (error) {
      throw schedulerBoundaryError(error, 'task transition', 'TASK_NOT_FOUND');
    }
  }

  async #applyWithLease(
    principal: AuthenticatedPrincipalV1,
    requestValue: TaskTransitionRequestV1,
    lease: FencedLease,
  ): Promise<TaskStateV1> {
    const guard = new FencedLeaseGuard(this.#redis, lease, this.#leaseTtlMs);
    try {
      return await this.applyWithGuard(principal, requestValue, guard);
    } finally {
      await guard.stop(true);
    }
  }

  async applyWithGuard(
    principal: AuthenticatedPrincipalV1,
    requestValue: TaskTransitionRequestV1,
    guard: FencedLeaseGuard,
  ): Promise<TaskStateV1> {
    try {
      return await this.#applyWithGuard(principal, requestValue, guard);
    } catch (error) {
      throw schedulerBoundaryError(error, 'task transition', 'TASK_NOT_FOUND');
    }
  }

  async #applyWithGuard(
    principal: AuthenticatedPrincipalV1,
    requestValue: TaskTransitionRequestV1,
    guard: FencedLeaseGuard,
  ): Promise<TaskStateV1> {
    principal = AuthenticatedPrincipalV1Schema.parse(principal);
    const request = TaskTransitionRequestV1Schema.parse(requestValue);
    if (guard.lease.lockKey !== taskLockKey(request.taskId)) {
      throw new SchedulerError('STALE_FENCE', 'transition lease task kimligiyle eslesmiyor');
    }
    try {
      await guard.assertHeld();
      return await this.#applyUnderLease(principal, request, guard);
    } catch (error) {
      if (!(error instanceof SchedulerError) || error.code !== 'STALE_FENCE') throw error;
      const transitionId = transitionIdFor(request);
      const effect = await getLatestEffect(
        this.#ch,
        request.causationId,
        `task-transition:${transitionId}`,
      );
      if (effect === null) throw error;
      await guard.stop(true).catch(() => false);
      return this.#reconcileTransitionAfterLeaseLoss(principal, request);
    }
  }

  async activateAttemptWithLease(
    principal: AuthenticatedPrincipalV1,
    input: ActivateTaskAttemptInput,
    lease: FencedLease,
  ): Promise<TaskStateV1> {
    try {
      return await this.#activateAttemptWithLease(principal, input, lease);
    } catch (error) {
      throw schedulerBoundaryError(error, 'task attempt activation', 'TASK_NOT_FOUND');
    }
  }

  async #activateAttemptWithLease(
    principal: AuthenticatedPrincipalV1,
    input: ActivateTaskAttemptInput,
    lease: FencedLease,
  ): Promise<TaskStateV1> {
    const guard = new FencedLeaseGuard(this.#redis, lease, this.#leaseTtlMs);
    try {
      return await this.activateAttemptWithGuard(principal, input, guard);
    } finally {
      await guard.stop(true);
    }
  }

  async activateAttemptWithGuard(
    principal: AuthenticatedPrincipalV1,
    input: ActivateTaskAttemptInput,
    guard: FencedLeaseGuard,
  ): Promise<TaskStateV1> {
    try {
      return await this.#activateAttemptWithGuard(principal, input, guard);
    } catch (error) {
      throw schedulerBoundaryError(error, 'task attempt activation', 'TASK_NOT_FOUND');
    }
  }

  async #activateAttemptWithGuard(
    principal: AuthenticatedPrincipalV1,
    input: ActivateTaskAttemptInput,
    guard: FencedLeaseGuard,
  ): Promise<TaskStateV1> {
    principal = AuthenticatedPrincipalV1Schema.parse(principal);
    if (principal.principalType !== 'system') {
      throw new TaskPolicyDeniedError(decision(
        'TASK-002',
        false,
        'attempt activation yalniz scheduler system principal tarafindan yapilabilir',
        [`principal:${principal.principalId}`, `task:${input.taskId}`],
      ));
    }
    if (guard.lease.lockKey !== taskLockKey(input.taskId)) {
      throw new SchedulerError('STALE_FENCE', 'attempt activation lease task ile eslesmiyor');
    }
    let effect: EffectLedgerRow | null = null;
    const activationId = deterministicSchedulerEntityId('task-attempt-activation-v1', {
      taskId: input.taskId,
      causationId: input.causationId,
    });
    const stableEffectId = `task-attempt-activation:${activationId}`;
    try {
      await guard.assertHeld();
      effect = await guard.after(getLatestEffect(this.#ch, input.causationId, stableEffectId));
      const activationRequest = { principal: principalEffectIdentity(principal), input };
      const activationRequestHash = canonicalSha256V1(activationRequest);
      if (effect !== null && effect.request_hash !== activationRequestHash) {
        throw new SchedulerError(
          'INTEGRITY_CONFLICT',
          `attempt activation deterministic kimlik/request hash catismasi: ${activationId}`,
        );
      }
      if (effect?.state === 'succeeded') return parseTaskState(effect.result);
      if (effect?.state === 'uncertain') {
        return this.#reconcileActivationEffect(principal, input, effect, guard, false);
      }
      if (effect?.state === 'failed') {
        throw new SchedulerError('UNCERTAIN_WRITE', `attempt activation terminal: ${effect.state}`);
      }
      let current = await guard.after(getLatestTask(this.#ch, input.projectId, input.taskId));
      if (current === null) throw new SchedulerError('TASK_NOT_FOUND', `task bulunamadi: ${input.taskId}`);
      if (BigInt(guard.lease.fence) < BigInt(await guard.after(this.#minimumFence(current)))) {
        throw new SchedulerError('STALE_FENCE', 'attempt activation durable fence tabanini asmiyor');
      }
      if (current.status !== 'working' && current.status !== 'escalated') {
        throw new TaskPolicyDeniedError(decision(
          'TASK-001',
          false,
          `attempt activation working/escalated durumunu gerektirir: ${current.status}`,
          [`task:${current.task_id}`, `status:${current.status}`],
        ));
      }
      const attempt = await guard.after(getAssignmentAttempt(this.#ch, input.assignmentAttemptId));
      const brief = await guard.after(getTaskBrief(this.#ch, input.taskBriefId));
      if (
        attempt === null || attempt.taskBriefId !== input.taskBriefId ||
        attempt.workerAgentId !== input.workerAgentId ||
        attempt.verifierAgentId !== input.verifierAgentId ||
        attempt.previousAttemptId !== input.previousAssignmentAttemptId
      ) throw new SchedulerError('INTEGRITY_CONFLICT', 'new immutable attempt activation ile eslesmiyor');
      if (brief === null || brief.taskId !== input.taskId || brief.projectId !== input.projectId) {
        throw new SchedulerError('INTEGRITY_CONFLICT', 'attempt activation brief kaydi eslesmiyor');
      }

      if (effect === null) {
        const unresolved = await guard.after(this.#unresolvedEffects(input.taskId));
        const blocker = unresolved.find((row) =>
          row.task_id === input.taskId && (
            row.effect_type.startsWith('task_') ||
            row.effect_type === 'scheduler_assignment_command_v1'
          ) &&
          row.causation_id !== input.causationId &&
          row.stable_effect_id !== stableEffectId);
        if (blocker !== undefined) {
          throw new SchedulerError(
            'UNCERTAIN_WRITE',
            `task icin uzlastirilmamis transition var: ${blocker.stable_effect_id}`,
          );
        }
      }

      await guard.assertHeld();
      if (effect === null) {
        effect = await reserveEffect(this.#ch, {
          causation_id: input.causationId,
          stable_effect_id: stableEffectId,
          project_id: input.projectId,
          task_id: input.taskId,
          assignment_attempt_id: input.assignmentAttemptId,
          effect_type: ATTEMPT_ACTIVATION_EFFECT_TYPE,
          request: activationRequest,
          replay_safety: 'replay_safe',
          lease_fence: guard.lease.fence,
          created_at: input.requestedAt,
        });
        await guard.assertHeld();
      }
      let prepared = parsePreparedActivation(effect.result);
      if (prepared === null) {
        await guard.assertHeld();
        effect = await guard.after(appendEffectVersion(this.#ch, {
          causation_id: input.causationId,
          stable_effect_id: stableEffectId,
          expectedVersion: effect.effect_version,
          state: 'pending',
          result: { phase: 'prepared_activation', eventLeaseFence: guard.lease.fence },
          error: '',
          lease_fence: guard.lease.fence,
          created_at: input.requestedAt,
        }));
        prepared = parsePreparedActivation(effect.result);
        if (prepared === null) {
          throw new SchedulerError('INTEGRITY_CONFLICT', 'activation hazirlik sonucu okunamadi');
        }
      }
      if (current.assignment_attempt_id !== input.assignmentAttemptId) {
        if (current.assignment_attempt_id !== input.previousAssignmentAttemptId) {
          throw new SchedulerError('STALE_FENCE', 'attempt activation previous owner current degil');
        }
        await guard.assertHeld();
        current = await guard.after(appendTaskVersion(this.#ch, {
          expectedVersion: current.version,
          next: {
            ...current,
            plan_id: brief.planId,
            task_brief_id: input.taskBriefId,
            assignment_attempt_id: input.assignmentAttemptId,
            worker_agent_id: input.workerAgentId,
            verifier_agent_id: input.verifierAgentId,
            updated_at: input.requestedAt,
          },
        }));
      } else if (
        current.plan_id !== brief.planId ||
        current.task_brief_id !== input.taskBriefId ||
        current.worker_agent_id !== input.workerAgentId ||
        current.verifier_agent_id !== input.verifierAgentId
      ) {
        throw new SchedulerError('INTEGRITY_CONFLICT', 'activated attempt task projectionu catismali');
      }
      const policy = decision(
        'TASK-003',
        true,
        'immutable correction assignment attempt current task folduna baglandi',
        [`task:${input.taskId}`, `attempt:${input.assignmentAttemptId}`],
      );
      const state = taskState(current, activationId, policy);
      await guard.assertHeld();
      await guard.after(appendEvent(this.#ch, {
        event_id: deterministicSchedulerEntityId('task-attempt-activated-v1', activationId),
        seq: String(Date.parse(input.requestedAt)),
        project_id: input.projectId,
        task_id: input.taskId,
        agent_id: NIL_UUID,
        event_type: 'status_change',
        tool_name: '',
        payload: {
          contractVersion: 1,
          transitionId: activationId,
          action: 'activate_attempt',
          toStatus: current.status,
          previousAssignmentAttemptId: input.previousAssignmentAttemptId,
          assignmentAttemptId: input.assignmentAttemptId,
          taskBriefId: input.taskBriefId,
          leaseFence: prepared.eventLeaseFence,
          requestHash: activationRequestHash,
        },
        duration_ms: 0,
        created_at: input.requestedAt,
      }));
      await guard.assertHeld();
      const succeeded = await guard.after(appendEffectVersion(this.#ch, {
        causation_id: input.causationId,
        stable_effect_id: stableEffectId,
        expectedVersion: effect.effect_version,
        state: 'succeeded',
        result: taskStateJson(state),
        error: '',
        lease_fence: guard.lease.fence,
        created_at: input.requestedAt,
      }));
      return parseTaskState(succeeded.result);
    } catch (error) {
      if (error instanceof RepositoryWriteError) {
        throw new SchedulerError(
          'UNCERTAIN_WRITE',
          `attempt activation durable yazisi uzlastirilamadi: ${activationId}`,
          error,
        );
      }
      if (!(error instanceof SchedulerError) || error.code !== 'STALE_FENCE') throw error;
      let observed: EffectLedgerRow | null;
      try {
        observed = await getLatestEffect(this.#ch, input.causationId, stableEffectId);
      } catch (reconciliationRead) {
        if (effect === null) throw error;
        throw new SchedulerError(
          'UNCERTAIN_WRITE',
          `attempt activation effect sonucu okunamadi: ${activationId}`,
          { staleFence: error, reconciliationRead },
        );
      }
      if (observed === null && effect === null) throw error;
      await guard.stop(true).catch(() => false);
      try {
        return await this.#reconcileActivationAfterLeaseLoss(principal, input);
      } catch (reconciliation) {
        if (reconciliation instanceof SchedulerError && reconciliation.code === 'UNCERTAIN_WRITE') {
          throw reconciliation;
        }
        throw new SchedulerError(
          'UNCERTAIN_WRITE',
          `attempt activation fresh fence ile uzlastirilamadi: ${activationId}`,
          { staleFence: error, reconciliation },
        );
      }
    }
  }

  async #reconcileActivationAfterLeaseLoss(
    principal: AuthenticatedPrincipalV1,
    input: ActivateTaskAttemptInput,
  ): Promise<TaskStateV1> {
    const observed = await getLatestTask(this.#ch, input.projectId, input.taskId);
    if (observed === null) {
      throw new SchedulerError('TASK_NOT_FOUND', `task bulunamadi: ${input.taskId}`);
    }
    const activationId = deterministicSchedulerEntityId('task-attempt-activation-v1', {
      taskId: input.taskId,
      causationId: input.causationId,
    });
    const stableEffectId = `task-attempt-activation:${activationId}`;
    const lease = await acquireFencedLease(
      this.#redis,
      taskLockKey(input.taskId),
      `attempt-activation-reconcile:${activationId}`,
      this.#leaseTtlMs,
      await this.#minimumFence(observed),
    );
    if (lease === null) {
      throw new TaskDeferredError(
        'LEASE_UNAVAILABLE',
        `attempt activation reconcile lease mesgul: ${input.taskId}`,
      );
    }
    const guard = new FencedLeaseGuard(this.#redis, lease, this.#leaseTtlMs);
    try {
      await guard.assertHeld();
      const effect = await guard.after(getLatestEffect(
        this.#ch,
        input.causationId,
        stableEffectId,
      ));
      if (effect === null) {
        throw new SchedulerError(
          'STALE_FENCE',
          'attempt activation effect reserve edilmeden lease kaybedildi',
        );
      }
      const requestHash = canonicalSha256V1({
        principal: principalEffectIdentity(principal),
        input,
      });
      if (effect.request_hash !== requestHash) {
        throw new SchedulerError('INTEGRITY_CONFLICT', 'attempt activation reconcile hash catismasi');
      }
      if (effect.state === 'succeeded') return parseTaskState(effect.result);
      if (effect.state === 'failed') {
        throw new SchedulerError('UNCERTAIN_WRITE', `attempt activation terminal: ${effect.state}`);
      }
      return this.#reconcileActivationEffect(principal, input, effect, guard, true);
    } finally {
      await guard.stop(true);
    }
  }

  async #reconcileActivationEffect(
    principal: AuthenticatedPrincipalV1,
    input: ActivateTaskAttemptInput,
    effect: EffectLedgerRow,
    guard: FencedLeaseGuard,
    terminalizeMissing: boolean,
  ): Promise<TaskStateV1> {
    const activationId = deterministicSchedulerEntityId('task-attempt-activation-v1', {
      taskId: input.taskId,
      causationId: input.causationId,
    });
    const stableEffectId = `task-attempt-activation:${activationId}`;
    const requestHash = canonicalSha256V1({
      principal: principalEffectIdentity(principal),
      input,
    });
    const prepared = parsePreparedActivation(effect.result);
    if (prepared === null) {
      throw new SchedulerError(
        'UNCERTAIN_WRITE',
        `attempt activation event fence hazirligi bulunamadi: ${activationId}`,
      );
    }
    const current = await guard.after(getLatestTask(this.#ch, input.projectId, input.taskId));
    if (current === null) {
      throw new SchedulerError('TASK_NOT_FOUND', `task bulunamadi: ${input.taskId}`);
    }
    if (current.assignment_attempt_id !== input.assignmentAttemptId) {
      if (effect.state === 'pending' && terminalizeMissing) {
        await guard.assertHeld();
        await guard.after(appendEffectVersion(this.#ch, {
          causation_id: input.causationId,
          stable_effect_id: stableEffectId,
          expectedVersion: effect.effect_version,
          state: 'uncertain',
          result: effect.result,
          error: `fresh fence could not observe accepted activation ${activationId}`,
          lease_fence: guard.lease.fence,
          created_at: input.requestedAt,
        }));
      }
      throw new SchedulerError(
        'UNCERTAIN_WRITE',
        `attempt activation durable sonucu uzlastirilamadi: ${activationId}`,
      );
    }
    const brief = await guard.after(getTaskBrief(this.#ch, input.taskBriefId));
    if (
      brief === null || current.status !== 'working' || current.plan_id !== brief.planId ||
      current.task_brief_id !== input.taskBriefId ||
      current.worker_agent_id !== input.workerAgentId ||
      current.verifier_agent_id !== input.verifierAgentId
    ) {
      throw new SchedulerError('INTEGRITY_CONFLICT', 'accepted activation projectionu catismali');
    }
    const policy = decision(
      'TASK-003',
      true,
      'immutable correction assignment attempt current task folduna baglandi',
      [`task:${input.taskId}`, `attempt:${input.assignmentAttemptId}`],
    );
    const state = taskState(current, activationId, policy);
    await guard.assertHeld();
    await guard.after(appendEvent(this.#ch, {
      event_id: deterministicSchedulerEntityId('task-attempt-activated-v1', activationId),
      seq: String(Date.parse(input.requestedAt)),
      project_id: input.projectId,
      task_id: input.taskId,
      agent_id: NIL_UUID,
      event_type: 'status_change',
      tool_name: '',
      payload: {
        contractVersion: 1,
        transitionId: activationId,
        action: 'activate_attempt',
        toStatus: current.status,
        previousAssignmentAttemptId: input.previousAssignmentAttemptId,
        assignmentAttemptId: input.assignmentAttemptId,
        taskBriefId: input.taskBriefId,
        leaseFence: prepared.eventLeaseFence,
        requestHash,
      },
      duration_ms: 0,
      created_at: input.requestedAt,
    }));
    await guard.assertHeld();
    const succeeded = await guard.after(appendEffectVersion(this.#ch, {
      causation_id: input.causationId,
      stable_effect_id: stableEffectId,
      expectedVersion: effect.effect_version,
      state: 'succeeded',
      result: taskStateJson(state),
      error: '',
      lease_fence: guard.lease.fence,
      created_at: input.requestedAt,
    }));
    return parseTaskState(succeeded.result);
  }

  async #applyUnderLease(
    principal: AuthenticatedPrincipalV1,
    request: TaskTransitionRequestV1,
    guard: FencedLeaseGuard,
  ): Promise<TaskStateV1> {
    const transitionId = transitionIdFor(request);
    const stableEffectId = `task-transition:${transitionId}`;
    const requestBody = { principal: principalEffectIdentity(principal), request };
    const requestHash = canonicalSha256V1(requestBody);
    let effect: EffectLedgerRow | null = null;
    try {
      effect = await guard.after(getLatestEffect(this.#ch, request.causationId, stableEffectId));
      if (effect !== null && effect.request_hash !== requestHash) {
        throw new SchedulerError(
          'INTEGRITY_CONFLICT',
          `transition deterministic kimlik/request hash catismasi: ${transitionId}`,
        );
      }
      if (effect?.state === 'succeeded') return parseTaskState(effect.result);
      if (effect?.state === 'uncertain') {
        return this.#reconcileTransitionEffect(
          principal,
          request,
          transitionId,
          stableEffectId,
          effect,
          guard,
          false,
        );
      }
      if (effect?.state === 'failed') {
        throw new SchedulerError('UNCERTAIN_WRITE', `transition effect terminal: ${effect.state}`);
      }

      if (effect === null) {
        const unresolved = await guard.after(this.#unresolvedEffects(request.taskId));
        const blocker = unresolved.find((row) =>
          row.task_id === request.taskId && (
            row.effect_type.startsWith('task_') ||
            row.effect_type === 'scheduler_assignment_command_v1'
          ) &&
          row.causation_id !== request.causationId &&
          row.stable_effect_id !== stableEffectId);
        if (blocker !== undefined) {
          throw new SchedulerError(
            'UNCERTAIN_WRITE',
            `task icin uzlastirilmamis transition var: ${blocker.stable_effect_id}`,
          );
        }
      }

      let current = await guard.after(getLatestTask(this.#ch, request.projectId, request.taskId));
      if (current === null) throw new SchedulerError('TASK_NOT_FOUND', `task bulunamadi: ${request.taskId}`);
      if (BigInt(guard.lease.fence) < BigInt(await guard.after(this.#minimumFence(current)))) {
        throw new SchedulerError('STALE_FENCE', 'transition lease durable fence tabanini asmiyor');
      }
      if (current.status === 'escalated' && request.action === 'escalation_resolved') {
        await this.#assertEscalationResolutionResources(current, guard);
      }

      let initialEvaluation: TaskTransitionEvaluation | undefined;
      if (effect === null) {
        initialEvaluation = evaluateTaskTransition(current, principal, request);
        if (!initialEvaluation.decision.allowed || initialEvaluation.toStatus === undefined) {
          await guard.assertHeld();
          await guard.after(this.#appendPolicyEvent(
            principal,
            request,
            transitionId,
            initialEvaluation.decision,
          ));
          throw new TaskPolicyDeniedError(initialEvaluation.decision);
        }
        await guard.after(this.#assertAssignmentReferences(request));
      }

      await guard.assertHeld();
      if (effect === null) {
        effect = await reserveEffect(this.#ch, {
          causation_id: request.causationId,
          stable_effect_id: stableEffectId,
          project_id: request.projectId,
          task_id: request.taskId,
          ...('assignmentAttemptId' in request
            ? { assignment_attempt_id: request.assignmentAttemptId }
            : {}),
          effect_type: TRANSITION_EFFECT_TYPE,
          request: requestBody,
          replay_safety: 'replay_safe',
          lease_fence: guard.lease.fence,
          created_at: request.requestedAt,
        });
        await guard.assertHeld();
      }

      let prepared = parsePreparedResult(effect.result);
      if (prepared === null) {
        const evaluation = initialEvaluation ?? evaluateTaskTransition(current, principal, request);
        if (!evaluation.decision.allowed || evaluation.toStatus === undefined) {
          await guard.assertHeld();
          await guard.after(this.#appendPolicyEvent(principal, request, transitionId, evaluation.decision));
          throw new TaskPolicyDeniedError(evaluation.decision);
        }
        await guard.after(this.#assertAssignmentReferences(request));
        const next = mutateTask(current, request, evaluation.toStatus);
        const expectedVersion = (BigInt(current.version) + 1n).toString();
        const expectedRow: TaskRow = Object.freeze({ ...next, version: expectedVersion });
        const state = taskState(expectedRow, transitionId, evaluation.decision);
        await guard.assertHeld();
        effect = await guard.after(appendEffectVersion(this.#ch, {
          causation_id: request.causationId,
          stable_effect_id: stableEffectId,
          expectedVersion: effect.effect_version,
          state: 'pending',
          result: {
            phase: 'prepared',
            beforeVersion: current.version,
            expectedTaskHash: canonicalSha256V1(expectedRow),
            eventLeaseFence: guard.lease.fence,
            state: taskStateJson(state),
          },
          error: '',
          lease_fence: guard.lease.fence,
          created_at: request.requestedAt,
        }));
        prepared = parsePreparedResult(effect.result);
        if (prepared === null) {
          throw new SchedulerError('INTEGRITY_CONFLICT', 'transition hazirlik sonucu okunamadi');
        }
      }

      if (current.version === prepared.beforeVersion) {
        const evaluation = evaluateTaskTransition(current, principal, request);
        if (!evaluation.decision.allowed || evaluation.toStatus === undefined) {
          throw new TaskPolicyDeniedError(evaluation.decision);
        }
        await guard.assertHeld();
        const stored = await guard.after(appendTaskVersion(this.#ch, {
          expectedVersion: current.version,
          next: mutateTask(current, request, evaluation.toStatus),
        }));
        if (canonicalSha256V1(stored) !== prepared.expectedTaskHash) {
          throw new SchedulerError('INTEGRITY_CONFLICT', 'transition task projection hash catismasi');
        }
        current = stored;
      } else if (
        current.version !== prepared.state.taskVersion ||
        canonicalSha256V1(current) !== prepared.expectedTaskHash
      ) {
        throw new SchedulerError('UNCERTAIN_WRITE', 'transition sonrasi task fold uzlastirilamadi');
      }

      if (request.action !== 'user_answered') {
        await this.#cleanupTerminalResources(current, request.requestedAt, guard);
      }
      await guard.assertHeld();
      await guard.after(this.#appendStatusEvent(
        principal,
        request,
        transitionId,
        prepared.state,
        prepared.eventLeaseFence,
      ));
      await guard.assertHeld();
      const succeeded = await guard.after(appendEffectVersion(this.#ch, {
        causation_id: request.causationId,
        stable_effect_id: stableEffectId,
        expectedVersion: effect.effect_version,
        state: 'succeeded',
        result: taskStateJson(prepared.state),
        error: '',
        lease_fence: guard.lease.fence,
        created_at: request.requestedAt,
      }));
      return parseTaskState(succeeded.result);
    } catch (error) {
      throw schedulerBoundaryError(error, 'task transition', 'TASK_NOT_FOUND');
    }
  }

  async #unresolvedEffects(taskId: string): Promise<readonly EffectLedgerRow[]> {
    return Object.freeze(await listLatestTaskEffectsByStates(
      this.#ch,
      taskId,
      ['pending', 'uncertain'],
    ));
  }

  async #reconcileTransitionAfterLeaseLoss(
    principal: AuthenticatedPrincipalV1,
    request: TaskTransitionRequestV1,
  ): Promise<TaskStateV1> {
    const current = await getLatestTask(this.#ch, request.projectId, request.taskId);
    if (current === null) throw new SchedulerError('TASK_NOT_FOUND', `task bulunamadi: ${request.taskId}`);
    const transitionId = transitionIdFor(request);
    const lease = await acquireFencedLease(
      this.#redis,
      taskLockKey(request.taskId),
      `transition-reconcile:${transitionId}`,
      this.#leaseTtlMs,
      await this.#minimumFence(current),
    );
    if (lease === null) {
      throw new TaskDeferredError('LEASE_UNAVAILABLE', `transition reconcile lease mesgul: ${request.taskId}`);
    }
    const guard = new FencedLeaseGuard(this.#redis, lease, this.#leaseTtlMs);
    const stableEffectId = `task-transition:${transitionId}`;
    try {
      await guard.assertHeld();
      const effect = await guard.after(getLatestEffect(
        this.#ch,
        request.causationId,
        stableEffectId,
      ));
      if (effect === null) {
        throw new SchedulerError('STALE_FENCE', 'transition lease effect reserve edilmeden kaybedildi');
      }
      const requestHash = canonicalSha256V1({
        principal: principalEffectIdentity(principal),
        request,
      });
      if (effect.request_hash !== requestHash) {
        throw new SchedulerError('INTEGRITY_CONFLICT', 'transition reconcile request hash catismasi');
      }
      if (effect.state === 'succeeded') return parseTaskState(effect.result);
      if (effect.state === 'failed') {
        throw new SchedulerError('UNCERTAIN_WRITE', `transition effect terminal: ${effect.state}`);
      }
      return await this.#reconcileTransitionEffect(
        principal,
        request,
        transitionId,
        stableEffectId,
        effect,
        guard,
        true,
      );
    } finally {
      await guard.stop(true);
    }
  }

  async #reconcileTransitionEffect(
    principal: AuthenticatedPrincipalV1,
    request: TaskTransitionRequestV1,
    transitionId: EntityId,
    stableEffectId: string,
    effect: EffectLedgerRow,
    guard: FencedLeaseGuard,
    terminalizeMissing: boolean,
  ): Promise<TaskStateV1> {
    const prepared = parsePreparedResult(effect.result);
    const current = await guard.after(getLatestTask(this.#ch, request.projectId, request.taskId));
    if (current === null) throw new SchedulerError('TASK_NOT_FOUND', `task bulunamadi: ${request.taskId}`);
    if (
      prepared !== null && current.version === prepared.state.taskVersion &&
      canonicalSha256V1(current) === prepared.expectedTaskHash
    ) {
      if (request.action !== 'user_answered') {
        await this.#cleanupTerminalResources(current, request.requestedAt, guard);
      }
      await guard.assertHeld();
      await guard.after(this.#appendStatusEvent(
        principal,
        request,
        transitionId,
        prepared.state,
        prepared.eventLeaseFence,
      ));
      await guard.assertHeld();
      const succeeded = await guard.after(appendEffectVersion(this.#ch, {
        causation_id: request.causationId,
        stable_effect_id: stableEffectId,
        expectedVersion: effect.effect_version,
        state: 'succeeded',
        result: taskStateJson(prepared.state),
        error: '',
        lease_fence: guard.lease.fence,
        created_at: request.requestedAt,
      }));
      return parseTaskState(succeeded.result);
    }
    if (effect.state === 'pending' && terminalizeMissing) {
      await guard.assertHeld();
      await guard.after(appendEffectVersion(this.#ch, {
        causation_id: request.causationId,
        stable_effect_id: stableEffectId,
        expectedVersion: effect.effect_version,
        state: 'uncertain',
        result: effect.result,
        error: `fresh fence could not observe accepted transition ${transitionId}`,
        lease_fence: guard.lease.fence,
        created_at: request.requestedAt,
      }));
    }
    throw new SchedulerError(
      'UNCERTAIN_WRITE',
      `transition durable sonucu uzlastirilamadi: ${transitionId}`,
    );
  }

  async #assertAssignmentReferences(request: TaskTransitionRequestV1): Promise<void> {
    if (request.action !== 'assign') return;
    const brief = await getTaskBrief(this.#ch, request.taskBriefId);
    if (
      brief === null || brief.taskId !== request.taskId || brief.projectId !== request.projectId
    ) throw new SchedulerError('INTEGRITY_CONFLICT', 'assign brief task/proje ile eslesmiyor');
    const attemptId = assignmentAttemptIdForAssign(request);
    const attempt = await getAssignmentAttempt(this.#ch, attemptId);
    if (
      attempt === null || attempt.taskBriefId !== request.taskBriefId ||
      attempt.workerAgentId !== request.workerAgentId ||
      attempt.verifierAgentId !== request.verifierAgentId
    ) throw new SchedulerError('INTEGRITY_CONFLICT', 'assign immutable attempt ile eslesmiyor');
  }

  async #minimumFence(task: TaskRow): Promise<string> {
    return getTaskDurableMaxLeaseFence(this.#ch, task.task_id);
  }

  async #assertEscalationResolutionResources(
    task: TaskRow,
    taskGuard: FencedLeaseGuard,
  ): Promise<void> {
    if (task.assignment_attempt_id === NIL_UUID) {
      throw new TaskDeferredError(
        'DEPENDENCY_BLOCKED',
        `escalation resolution fresh attempt gerektirir: ${task.task_id}`,
      );
    }
    const attempt = await taskGuard.after(getAssignmentAttempt(
      this.#ch,
      task.assignment_attempt_id,
    ));
    const previous = attempt?.previousAttemptId === undefined
      ? null
      : await taskGuard.after(getAssignmentAttempt(this.#ch, attempt.previousAttemptId));
    if (
      attempt === null || attempt.previousAttemptId === undefined ||
      previous === null || attempt.attemptNumber !== previous.attemptNumber + 1 ||
      (task.attempt !== attempt.attemptNumber && task.attempt !== attempt.attemptNumber - 1) ||
      attempt.taskBriefId !== task.task_brief_id ||
      attempt.workerAgentId !== task.worker_agent_id ||
      attempt.verifierAgentId !== task.verifier_agent_id
    ) {
      throw new TaskDeferredError(
        'DEPENDENCY_BLOCKED',
        `escalation resolution current fresh attempt ile eslesmiyor: ${task.task_id}`,
      );
    }
    for (const agentId of [attempt.workerAgentId, attempt.verifierAgentId]) {
      const agent = await taskGuard.after(getLatestAgent(this.#ch, task.project_id, agentId));
      if (agent?.status !== 'busy' || agent.current_task_id !== task.task_id) {
        throw new TaskDeferredError(
          'DEPENDENCY_BLOCKED',
          `escalation resolution agent rezervasyonu eksik: ${agentId}`,
        );
      }
    }
    for (const { key } of taskFileLocks(task)) {
      let owner: string | null;
      try {
        owner = await getFileLockOwner(this.#redis, key);
      } catch (error) {
        throw new SchedulerError(
          'UNCERTAIN_WRITE',
          `escalation resolution file lock sonucu okunamadi: ${key}`,
          error,
        );
      }
      if (owner !== attempt.assignmentAttemptId) {
        throw new TaskDeferredError(
          'DEPENDENCY_BLOCKED',
          `escalation resolution file lock eksik: ${key}`,
        );
      }
    }
  }

  async #cleanupTerminalResources(
    task: TaskRow,
    at: string,
    taskGuard: FencedLeaseGuard,
  ): Promise<void> {
    if (!TERMINAL_RESOURCE_STATUSES.has(task.status)) return;
    const agentIds = [...new Set([task.worker_agent_id, task.verifier_agent_id])]
      .filter((agentId) => agentId !== NIL_UUID)
      .sort();
    const agentGuards: Array<{
      readonly agentId: string;
      readonly guard: FencedLeaseGuard;
    }> = [];
    try {
      for (const agentId of agentIds) {
        await taskGuard.assertHeld();
        const observed = await taskGuard.after(getLatestAgent(
          this.#ch,
          task.project_id,
          agentId,
        ));
        if (observed === null) {
          throw new SchedulerError(
            'INTEGRITY_CONFLICT',
            `terminal cleanup agent bulunamadi: ${agentId}`,
          );
        }
        const lease = await acquireFencedLease(
          this.#redis,
          agentLockKey(agentId),
          `terminal-cleanup:${task.task_id}`,
          this.#leaseTtlMs,
          observed.assignment_fence,
        );
        if (lease === null) {
          throw new TaskDeferredError(
            'LEASE_UNAVAILABLE',
            `terminal cleanup agent lease mesgul: ${agentId}`,
          );
        }
        const guard = new FencedLeaseGuard(this.#redis, lease, this.#leaseTtlMs);
        agentGuards.push({ agentId, guard });
        await guard.assertHeld();
      }

      for (const { agentId, guard } of agentGuards) {
        await taskGuard.assertHeld();
        await guard.assertHeld();
        const current = await guard.after(getLatestAgent(this.#ch, task.project_id, agentId));
        if (current === null) {
          throw new SchedulerError(
            'INTEGRITY_CONFLICT',
            `terminal cleanup agent kayboldu: ${agentId}`,
          );
        }
        if (current.status === 'busy' && current.current_task_id === task.task_id) {
          await taskGuard.assertHeld();
          await guard.assertHeld();
          await guard.after(appendAgentVersion(this.#ch, {
            expectedVersion: current.version,
            assignmentFence: guard.lease.fence,
            next: {
              ...current,
              status: 'idle',
              current_task_id: NIL_UUID,
              updated_at: at,
            },
          }));
          await guard.assertHeld();
        } else if (current.current_task_id === task.task_id) {
          throw new SchedulerError(
            'INTEGRITY_CONFLICT',
            `terminal cleanup agent durumu catismali: ${agentId}:${current.status}`,
          );
        }
      }

      if (task.assignment_attempt_id !== NIL_UUID) {
        const attempt = await taskGuard.after(getAssignmentAttempt(
          this.#ch,
          task.assignment_attempt_id,
        ));
        if (attempt === null || attempt.taskId !== task.task_id) {
          throw new SchedulerError(
            'INTEGRITY_CONFLICT',
            `terminal cleanup current attempt bulunamadi: ${task.assignment_attempt_id}`,
          );
        }
        for (const { key } of [...taskFileLocks(task)].reverse()) {
          await this.#releaseTerminalFileLock(
            key,
            task.assignment_attempt_id,
            taskGuard,
          );
        }
        await appendTaskFileLockEvents(
          this.#ch,
          task,
          attempt,
          'lock_released',
          at,
          taskGuard,
        );
      }
    } finally {
      let firstError: unknown;
      for (const { guard } of [...agentGuards].reverse()) {
        try {
          await guard.stop(true);
        } catch (error) {
          firstError ??= error;
        }
      }
      if (firstError !== undefined) throw firstError;
    }
  }

  async #releaseTerminalFileLock(
    key: FileLockKey,
    owner: string,
    taskGuard: FencedLeaseGuard,
  ): Promise<void> {
    let firstFailure: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await taskGuard.assertHeld();
      try {
        if (await releaseFileLock(this.#redis, key, owner)) {
          await taskGuard.assertHeld();
          return;
        }
        firstFailure ??= new Error('compare-and-delete false dondurdu');
      } catch (error) {
        firstFailure ??= error;
      }
      let observed: string | null;
      try {
        observed = await getFileLockOwner(this.#redis, key);
      } catch (reconciliation) {
        throw new SchedulerError(
          'UNCERTAIN_WRITE',
          `terminal file lock release sonucu okunamadi: ${key}`,
          { release: firstFailure, reconciliation },
        );
      }
      if (observed === null || observed !== owner) return;
    }
    throw new SchedulerError(
      'UNCERTAIN_WRITE',
      `terminal file lock release sonrasi eski owner kaldi: ${key}:${owner}`,
      firstFailure,
    );
  }

  async #appendPolicyEvent(
    principal: AuthenticatedPrincipalV1,
    request: TaskTransitionRequestV1,
    transitionId: EntityId,
    policy: PolicyDecision,
  ): Promise<void> {
    await appendEvent(this.#ch, {
      event_id: deterministicSchedulerEntityId('task-policy-decision-v1', transitionId),
      seq: String(Date.parse(request.requestedAt)),
      project_id: request.projectId,
      task_id: request.taskId,
      agent_id: principal.principalType === 'agent' ? principal.principalId : NIL_UUID,
      event_type: 'policy_decision',
      tool_name: '',
      payload: { contractVersion: 1, transitionId, action: request.action, decision: policy },
      duration_ms: 0,
      created_at: request.requestedAt,
    });
  }

  async #appendStatusEvent(
    principal: AuthenticatedPrincipalV1,
    request: TaskTransitionRequestV1,
    transitionId: EntityId,
    state: TaskStateV1,
    leaseFence: string,
  ): Promise<void> {
    await appendEvent(this.#ch, {
      event_id: deterministicSchedulerEntityId('task-status-change-v1', transitionId),
      seq: String(Date.parse(request.requestedAt)),
      project_id: request.projectId,
      task_id: request.taskId,
      agent_id: principal.principalType === 'agent' ? principal.principalId : NIL_UUID,
      event_type: 'status_change',
      tool_name: '',
      payload: {
        contractVersion: 1,
        transitionId,
        transitionRequestId: request.transitionRequestId,
        causationId: request.causationId,
        action: request.action,
        toStatus: state.status,
        taskVersion: state.taskVersion,
        requestHash: canonicalSha256V1({
          principal: principalEffectIdentity(principal),
          request,
        }),
        leaseFence,
      },
      duration_ms: 0,
      created_at: request.requestedAt,
    });
  }
}
