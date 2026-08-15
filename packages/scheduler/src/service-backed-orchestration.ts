import { canonicalSha256V1, EntityIdSchema, type AssignmentAttemptV1, type EntityId, type JsonValue } from '@ww/shared';
import { appendArtifact, appendEvent, acquireFencedLease, getTaskDurableMaxLeaseFence, taskLockKey, type AppendArtifactInput, type AppendEventInput, type ClickHouseClient, type WwRedis } from '@ww/db';
import type { Phase1SchedulerPort } from './phase1-orchestrator.js';
import { SchedulerOrchestrationPortAdapter } from './orchestration-port.js';
import { FencedLeaseGuard } from './fenced-lease-guard.js';

export interface SchedulerAttemptFencePort {
  assertCurrent(input: Readonly<{ taskId: EntityId; attempt: AssignmentAttemptV1 }>): Promise<void>;
}

/** A short-lived task lease used by privileged gate/commit operations. */
export interface SchedulerTaskLeaseScopePort {
  run<T>(input: Readonly<{ taskId: EntityId; attempt: AssignmentAttemptV1 }>, operation: (attempt: AssignmentAttemptV1) => Promise<T>): Promise<T>;
}

export interface RedisTaskLeaseScopeOptions { readonly ttlMs?: number; }

/**
 * Reacquires the current task lease immediately before a privileged operation.
 * AssignmentService may release its lease after a lifecycle transition; gate
 * and commit must therefore never reuse the stale assignment fence.
 */
export function createRedisTaskLeaseScope(
  ch: ClickHouseClient,
  redis: WwRedis,
  options: RedisTaskLeaseScopeOptions = {},
): SchedulerTaskLeaseScopePort {
  const ttlMs = options.ttlMs ?? 30_000;
  return {
    async run<T>(
      { taskId, attempt }: Readonly<{ taskId: EntityId; attempt: AssignmentAttemptV1 }>,
      operation: (attempt: AssignmentAttemptV1) => Promise<T>,
    ) {
      const lease = await acquireFencedLease(
        redis,
        taskLockKey(taskId),
        attempt.leaseOwner,
        ttlMs,
        await getTaskDurableMaxLeaseFence(ch, taskId),
      );
      if (lease === null) throw new Error(`task lease mesgul: ${taskId}`);
      const guard = new FencedLeaseGuard(redis, lease, ttlMs);
      try {
        await guard.assertHeld();
        const freshAttempt = Object.freeze({ ...attempt, leaseOwner: lease.owner, leaseFence: Number(lease.fence) });
        return await guard.after(operation(freshAttempt));
      } finally {
        await guard.stop(true);
      }
    },
  };
}

export interface SchedulerGateOperationPort {
  run(input: Readonly<{ taskId: EntityId; attempt: AssignmentAttemptV1 }>): Promise<Readonly<{ passed: boolean; evidenceRefs: readonly string[]; eventId?: EntityId }>>;
}

export interface SchedulerCommitOperationPort {
  commit(input: Readonly<{ taskId: EntityId; attempt: AssignmentAttemptV1 }>): Promise<Readonly<{ commitHash: string; artifactIds: readonly EntityId[]; eventId?: EntityId }>>;
}

export interface SchedulerArtifactPersistencePort {
  appendGate(input: Readonly<{ taskId: EntityId; attempt: AssignmentAttemptV1; passed: boolean; evidenceRefs: readonly string[]; eventId?: EntityId }>): Promise<void>;
  appendCommit(input: Readonly<{ taskId: EntityId; attempt: AssignmentAttemptV1; commitHash: string; artifactIds: readonly EntityId[]; eventId?: EntityId }>): Promise<void>;
}

export interface ServiceBackedSchedulerInput {
  readonly base: Phase1SchedulerPort;
  readonly fence: SchedulerAttemptFencePort;
  readonly gate: SchedulerGateOperationPort;
  readonly commit: SchedulerCommitOperationPort;
  readonly artifacts: SchedulerArtifactPersistencePort;
  /** Required by production composition; omitted only for legacy unit seams. */
  readonly leaseScope?: SchedulerTaskLeaseScopePort;
}

export interface SchedulerPersistenceClockPort { now(): string; }

export interface SchedulerRepositoryWriters {
  appendArtifact(input: AppendArtifactInput): Promise<unknown>;
  appendEvent(input: AppendEventInput): Promise<unknown>;
}

function deterministicId(namespace: string, value: unknown): EntityId {
  const hex = canonicalSha256V1({ namespace, value });
  return EntityIdSchema.parse(`${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`);
}

function sequence(value: unknown): string {
  return BigInt(`0x${canonicalSha256V1(value).slice(0, 15)}`).toString();
}

/** Repository-backed persistence adapter. The DB repositories retain idempotency/reconciliation semantics. */
export class ClickHouseSchedulerArtifactPersistence implements SchedulerArtifactPersistencePort {
  readonly #clock: SchedulerPersistenceClockPort;
  readonly #writers: SchedulerRepositoryWriters;
  constructor(ch: ClickHouseClient, clock: SchedulerPersistenceClockPort = { now: () => new Date().toISOString() }, writers: SchedulerRepositoryWriters = { appendArtifact: (value) => appendArtifact(ch, value), appendEvent: (value) => appendEvent(ch, value) }) {
    this.#clock = clock;
    this.#writers = writers;
  }
  async appendGate(input: Parameters<SchedulerArtifactPersistencePort['appendGate']>[0]): Promise<void> {
    const eventId = input.eventId ?? deterministicId('scheduler-gate-event-v1', input);
    await this.#writers.appendEvent({
      event_id: eventId, seq: sequence({ eventId }), project_id: input.attempt.projectId, task_id: input.taskId, agent_id: input.attempt.verifierAgentId,
      event_type: 'test_run', tool_name: 'ww.gate', payload: { taskId: input.taskId, assignmentAttemptId: input.attempt.assignmentAttemptId, passed: input.passed, evidenceRefs: [...input.evidenceRefs] } as JsonValue,
      duration_ms: 0, created_at: this.#clock.now(),
    });
  }
  async appendCommit(input: Parameters<SchedulerArtifactPersistencePort['appendCommit']>[0]): Promise<void> {
    const createdAt = this.#clock.now();
    for (const artifactId of input.artifactIds) {
      await this.#writers.appendArtifact({
        artifact_id: artifactId, project_id: input.attempt.projectId, task_id: input.taskId, agent_id: input.attempt.workerAgentId,
        artifact_type: 'doc', name: `task-${input.taskId}`, path: `task/${input.taskId}`, summary: 'Phase 1 task artifact', commit_hash: input.commitHash, created_at: createdAt,
      });
    }
    const eventId = input.eventId ?? deterministicId('scheduler-commit-event-v1', input);
    await this.#writers.appendEvent({
      event_id: eventId, seq: sequence({ eventId }), project_id: input.attempt.projectId, task_id: input.taskId, agent_id: input.attempt.workerAgentId,
      event_type: 'commit', tool_name: 'git.commit', payload: { taskId: input.taskId, assignmentAttemptId: input.attempt.assignmentAttemptId, commitHash: input.commitHash, artifactIds: [...input.artifactIds] } as JsonValue,
      duration_ms: 0, created_at: createdAt,
    });
  }
}

/**
 * Wraps executor gate/Git services with scheduler-owned attempt fencing and
 * artifact/commit evidence persistence. The injected persistence ports are
 * implemented by DB/effect services in server composition; this adapter never
 * writes a repository directly.
 */
export function createServiceBackedSchedulerPort(input: ServiceBackedSchedulerInput): Phase1SchedulerPort {
  const wrapped: Phase1SchedulerPort = {
    assign: (taskId) => input.base.assign(taskId),
    awaitUserAnswer: (value) => input.base.awaitUserAnswer(value),
    resumeUserAnswer: (value) => input.base.resumeUserAnswer(value),
    handleExecutionError: (value) => input.base.handleExecutionError(value),
    transition: (value) => input.base.transition(value),
    reassign: (value) => input.base.reassign(value),
    escalate: (value) => input.base.escalate(value),
    gate: async ({ taskId, attempt }) => {
      const run = async (freshAttempt: AssignmentAttemptV1) => {
        await input.fence.assertCurrent({ taskId, attempt: freshAttempt });
        const result = await input.gate.run({ taskId, attempt: freshAttempt });
        await input.artifacts.appendGate({ taskId, attempt: freshAttempt, passed: result.passed, evidenceRefs: result.evidenceRefs, ...(result.eventId === undefined ? {} : { eventId: result.eventId }) });
        return result;
      };
      const result = input.leaseScope === undefined
        ? await run(attempt)
        : await input.leaseScope.run({ taskId, attempt }, run);
      return result;
    },
    commit: async ({ taskId, attempt }) => {
      const run = async (freshAttempt: AssignmentAttemptV1) => {
        await input.fence.assertCurrent({ taskId, attempt: freshAttempt });
        const result = await input.commit.commit({ taskId, attempt: freshAttempt });
        await input.artifacts.appendCommit({ taskId, attempt: freshAttempt, commitHash: result.commitHash, artifactIds: result.artifactIds, ...(result.eventId === undefined ? {} : { eventId: result.eventId }) });
        return result;
      };
      const result = input.leaseScope === undefined
        ? await run(attempt)
        : await input.leaseScope.run({ taskId, attempt }, run);
      return result;
    },
  };
  return new SchedulerOrchestrationPortAdapter(wrapped);
}
