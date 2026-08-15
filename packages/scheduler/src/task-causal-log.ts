import type { ClickHouseClient } from '@ww/db';
import {
  acquireFencedLease,
  appendEffectVersion,
  appendTaskCausalEntry,
  deterministicCausalEntryId,
  getAssignmentAttempt,
  getLatestEffect,
  getLatestTask,
  getTaskDurableMaxLeaseFence,
  getTaskCausalEntry,
  listLatestTaskEffectsByStates,
  reserveEffect,
  taskLockKey,
  type EffectLedgerRow,
  type TaskCausalEntryRow,
  type WwRedis,
} from '@ww/db';
import {
  NIL_UUID,
  TaskCausalCursorV1Schema,
  canonicalSha256V1,
  type JsonObject,
  type TaskCausalCursorV1,
} from '@ww/shared';
import { SchedulerError, TaskDeferredError, schedulerBoundaryError } from './errors.js';
import { FencedLeaseGuard } from './fenced-lease-guard.js';
import {
  deterministicSchedulerEntityId,
  type AppendTaskCausalEntryInput,
} from './ports.js';

const CAUSAL_APPEND_EFFECT_TYPE = 'task_causal_append_v1';

export interface TaskCausalLogOptions {
  readonly leaseTtlMs?: number;
}

export class TaskCausalLog {
  readonly #ch: ClickHouseClient;
  readonly #redis: WwRedis;
  readonly #leaseTtlMs: number;

  constructor(ch: ClickHouseClient, redis: WwRedis, options: TaskCausalLogOptions = {}) {
    this.#ch = ch;
    this.#redis = redis;
    this.#leaseTtlMs = options.leaseTtlMs ?? 60_000;
  }

  async append(input: AppendTaskCausalEntryInput): Promise<TaskCausalCursorV1> {
    try {
      return await this.#append(input);
    } catch (error) {
      throw schedulerBoundaryError(error, 'task causal append');
    }
  }

  async #append(input: AppendTaskCausalEntryInput): Promise<TaskCausalCursorV1> {
    const task = await getLatestTask(this.#ch, input.projectId, input.taskId);
    if (task === null) throw new SchedulerError('TASK_NOT_FOUND', `task bulunamadi: ${input.taskId}`);
    this.#assertCurrent(task, input);
    const attempt = await getAssignmentAttempt(this.#ch, input.assignmentAttemptId);
    if (attempt === null) {
      throw new SchedulerError('INTEGRITY_CONFLICT', 'causal append assignment attempt bulunamadi');
    }
    if ((attempt.handoffId ?? NIL_UUID) !== (input.handoffId ?? NIL_UUID)) {
      throw new SchedulerError('INTEGRITY_CONFLICT', 'causal append handoff current attempt ile eslesmiyor');
    }

    const base = {
      task_id: input.taskId,
      task_brief_id: input.taskBriefId,
      assignment_attempt_id: input.assignmentAttemptId,
      handoff_id: input.handoffId ?? NIL_UUID,
      source_type: input.sourceType,
      source_id: input.sourceId,
      causation_id: input.causationId ?? NIL_UUID,
      lease_fence: String(attempt.leaseFence),
      created_at: input.createdAt,
    };
    const entryId = deterministicCausalEntryId(base);
    const lease = await acquireFencedLease(
      this.#redis,
      taskLockKey(input.taskId),
      `causal:${entryId}`,
      this.#leaseTtlMs,
      await getTaskDurableMaxLeaseFence(this.#ch, input.taskId),
    );
    if (lease === null) {
      throw new TaskDeferredError('LEASE_UNAVAILABLE', `causal task lease mesgul: ${input.taskId}`);
    }
    const guard = new FencedLeaseGuard(this.#redis, lease, this.#leaseTtlMs);
    try {
      return await this.#appendUnderLease(input, guard);
    } catch (error) {
      if (!(error instanceof SchedulerError) || error.code !== 'STALE_FENCE') throw error;
    } finally {
      await guard.stop(true);
    }
    return this.#reconcileAfterLeaseLoss(input);
  }

  async appendWithLease(
    input: AppendTaskCausalEntryInput,
    guard: FencedLeaseGuard,
  ): Promise<TaskCausalCursorV1> {
    try {
      return await this.#appendWithLease(input, guard);
    } catch (error) {
      throw schedulerBoundaryError(error, 'task causal append');
    }
  }

  async #appendWithLease(
    input: AppendTaskCausalEntryInput,
    guard: FencedLeaseGuard,
  ): Promise<TaskCausalCursorV1> {
    if (guard.lease.lockKey !== taskLockKey(input.taskId)) {
      throw new SchedulerError('STALE_FENCE', 'causal lease task kimligiyle eslesmiyor');
    }
    return this.#appendUnderLease(input, guard);
  }

  async #appendUnderLease(
    input: AppendTaskCausalEntryInput,
    guard: FencedLeaseGuard,
  ): Promise<TaskCausalCursorV1> {
    let effect: EffectLedgerRow | null = null;
    let effectCausationId: string | undefined;
    let stableEffectId: string | undefined;
    try {
      await guard.assertHeld();
      const current = await guard.after(getLatestTask(this.#ch, input.projectId, input.taskId));
      if (current === null) throw new SchedulerError('TASK_NOT_FOUND', `task bulunamadi: ${input.taskId}`);
      this.#assertCurrent(current, input);
      const attempt = await guard.after(getAssignmentAttempt(this.#ch, input.assignmentAttemptId));
      if (attempt === null) {
        throw new SchedulerError('INTEGRITY_CONFLICT', 'causal append assignment attempt bulunamadi');
      }
      if ((attempt.handoffId ?? NIL_UUID) !== (input.handoffId ?? NIL_UUID)) {
        throw new SchedulerError('INTEGRITY_CONFLICT', 'causal append handoff current attempt ile eslesmiyor');
      }
      const base = {
        task_id: input.taskId,
        task_brief_id: input.taskBriefId,
        assignment_attempt_id: input.assignmentAttemptId,
        handoff_id: input.handoffId ?? NIL_UUID,
        source_type: input.sourceType,
        source_id: input.sourceId,
        causation_id: input.causationId ?? NIL_UUID,
        lease_fence: String(attempt.leaseFence),
        created_at: input.createdAt,
      };
      const entryId = deterministicCausalEntryId(base);
      const durableFence = BigInt(await guard.after(
        getTaskDurableMaxLeaseFence(this.#ch, input.taskId),
      ));
      if (BigInt(guard.lease.fence) < durableFence) {
        throw new SchedulerError('STALE_FENCE', 'causal lease durable fence tabanini asmiyor');
      }
      effectCausationId = input.causationId ?? deterministicSchedulerEntityId(
        'task-causal-append-causation-v1',
        entryId,
      );
      stableEffectId = `task-causal-append:${entryId}`;
      const request = Object.freeze({
        projectId: input.projectId,
        taskId: input.taskId,
        taskBriefId: input.taskBriefId,
        assignmentAttemptId: input.assignmentAttemptId,
        handoffId: input.handoffId ?? NIL_UUID,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        causationId: input.causationId ?? NIL_UUID,
        createdAt: input.createdAt,
      });
      effect = await guard.after(getLatestEffect(this.#ch, effectCausationId, stableEffectId));
      const requestHash = canonicalSha256V1(request);
      if (effect !== null && effect.request_hash !== requestHash) {
        throw new SchedulerError(
          'INTEGRITY_CONFLICT',
          `causal entry deterministic kimlik/request hash catismasi: ${entryId}`,
        );
      }
      if (effect?.state === 'succeeded') return this.#parseEffectCursor(effect.result);
      if (effect?.state === 'uncertain') {
        return this.#reconcileAppendEffect(input, entryId, effect, guard, false);
      }
      if (effect !== null && effect.state !== 'pending') {
        throw new SchedulerError('UNCERTAIN_WRITE', `causal append effect terminal: ${effect.state}`);
      }
      if (effect === null) {
        const unresolved = await guard.after(this.#unresolvedEffects(input.taskId));
        const blocker = unresolved.find((row) => {
          const relatedAssignmentCommand =
            row.effect_type === 'scheduler_assignment_command_v1' &&
            row.result !== null && typeof row.result === 'object' && !Array.isArray(row.result) &&
            'assignmentAttemptId' in row.result &&
            row.result.assignmentAttemptId === input.assignmentAttemptId;
          return row.task_id === input.taskId && !relatedAssignmentCommand && (
            row.effect_type.startsWith('task_') ||
            row.effect_type === 'scheduler_assignment_command_v1'
          ) && row.causation_id !== effectCausationId &&
            row.stable_effect_id !== stableEffectId;
        });
        if (blocker !== undefined) {
          throw new SchedulerError(
            'UNCERTAIN_WRITE',
            `task icin uzlastirilmamis durable islem var: ${blocker.stable_effect_id}`,
          );
        }
      }
      await guard.assertHeld();
      if (effect === null) {
        effect = await reserveEffect(this.#ch, {
          causation_id: effectCausationId,
          stable_effect_id: stableEffectId,
          project_id: input.projectId,
          task_id: input.taskId,
          assignment_attempt_id: input.assignmentAttemptId,
          effect_type: CAUSAL_APPEND_EFFECT_TYPE,
          request,
          replay_safety: 'replay_safe',
          lease_fence: guard.lease.fence,
          created_at: input.createdAt,
        });
        await guard.assertHeld();
      }

      let stored = await guard.after(getTaskCausalEntry(
        this.#ch,
        input.taskId,
        input.assignmentAttemptId,
        entryId,
      ));
      if (stored !== null) {
        this.#assertEntryMatchesInput(stored, input);
      } else {
        await guard.assertHeld();
        stored = await guard.after(appendTaskCausalEntry(this.#ch, {
          ...base,
          lease_fence: guard.lease.fence,
        }));
      }
      const cursor = this.#cursor(
        stored.assignment_attempt_id,
        stored.handoff_id,
        stored.ordinal,
      );
      await guard.assertHeld();
      const succeeded = await guard.after(appendEffectVersion(this.#ch, {
        causation_id: effectCausationId,
        stable_effect_id: stableEffectId,
        expectedVersion: effect.effect_version,
        state: 'succeeded',
        result: this.#cursorJson(cursor),
        error: '',
        lease_fence: guard.lease.fence,
        created_at: input.createdAt,
      }));
      return this.#parseEffectCursor(succeeded.result);
    } catch (error) {
      throw schedulerBoundaryError(error, 'task causal append');
    }
  }

  async #unresolvedEffects(taskId: string): Promise<readonly EffectLedgerRow[]> {
    return Object.freeze(await listLatestTaskEffectsByStates(
      this.#ch,
      taskId,
      ['pending', 'uncertain'],
    ));
  }

  async #reconcileAfterLeaseLoss(
    input: AppendTaskCausalEntryInput,
  ): Promise<TaskCausalCursorV1> {
    const current = await getLatestTask(this.#ch, input.projectId, input.taskId);
    if (current === null) throw new SchedulerError('TASK_NOT_FOUND', `task bulunamadi: ${input.taskId}`);
    this.#assertCurrent(current, input);
    const attempt = await getAssignmentAttempt(this.#ch, input.assignmentAttemptId);
    if (attempt === null) {
      throw new SchedulerError('INTEGRITY_CONFLICT', 'causal reconcile attempt bulunamadi');
    }
    const base = {
      task_id: input.taskId,
      task_brief_id: input.taskBriefId,
      assignment_attempt_id: input.assignmentAttemptId,
      handoff_id: input.handoffId ?? NIL_UUID,
      source_type: input.sourceType,
      source_id: input.sourceId,
      causation_id: input.causationId ?? NIL_UUID,
      lease_fence: String(attempt.leaseFence),
      created_at: input.createdAt,
    };
    const entryId = deterministicCausalEntryId(base);
    const causationId = input.causationId ?? deterministicSchedulerEntityId(
      'task-causal-append-causation-v1',
      entryId,
    );
    const stableEffectId = `task-causal-append:${entryId}`;
    const lease = await acquireFencedLease(
      this.#redis,
      taskLockKey(input.taskId),
      `causal-reconcile:${entryId}`,
      this.#leaseTtlMs,
      await getTaskDurableMaxLeaseFence(this.#ch, input.taskId),
    );
    if (lease === null) {
      throw new TaskDeferredError('LEASE_UNAVAILABLE', `causal reconcile lease mesgul: ${input.taskId}`);
    }
    const guard = new FencedLeaseGuard(this.#redis, lease, this.#leaseTtlMs);
    try {
      await guard.assertHeld();
      const effect = await guard.after(getLatestEffect(this.#ch, causationId, stableEffectId));
      if (effect === null) {
        throw new SchedulerError('STALE_FENCE', 'causal lease effect reserve edilmeden kaybedildi');
      }
      const requestHash = canonicalSha256V1({
        projectId: input.projectId,
        taskId: input.taskId,
        taskBriefId: input.taskBriefId,
        assignmentAttemptId: input.assignmentAttemptId,
        handoffId: input.handoffId ?? NIL_UUID,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        causationId: input.causationId ?? NIL_UUID,
        createdAt: input.createdAt,
      });
      if (effect.request_hash !== requestHash) {
        throw new SchedulerError('INTEGRITY_CONFLICT', 'causal reconcile request hash catismasi');
      }
      if (effect.state === 'succeeded') return this.#parseEffectCursor(effect.result);
      if (effect.state === 'failed') {
        throw new SchedulerError('UNCERTAIN_WRITE', `causal append effect terminal: ${effect.state}`);
      }
      return await this.#reconcileAppendEffect(input, entryId, effect, guard, true);
    } finally {
      await guard.stop(true);
    }
  }

  async #reconcileAppendEffect(
    input: AppendTaskCausalEntryInput,
    entryId: string,
    effect: EffectLedgerRow,
    guard: FencedLeaseGuard,
    terminalizeMissing: boolean,
  ): Promise<TaskCausalCursorV1> {
    const stored = await guard.after(getTaskCausalEntry(
      this.#ch,
      input.taskId,
      input.assignmentAttemptId,
      entryId,
    ));
    if (stored !== null) {
      this.#assertEntryMatchesInput(stored, input);
      const cursor = this.#cursor(
        stored.assignment_attempt_id,
        stored.handoff_id,
        stored.ordinal,
      );
      await guard.assertHeld();
      const succeeded = await guard.after(appendEffectVersion(this.#ch, {
        causation_id: effect.causation_id,
        stable_effect_id: effect.stable_effect_id,
        expectedVersion: effect.effect_version,
        state: 'succeeded',
        result: this.#cursorJson(cursor),
        error: '',
        lease_fence: guard.lease.fence,
        created_at: input.createdAt,
      }));
      return this.#parseEffectCursor(succeeded.result);
    }
    if (effect.state === 'pending' && terminalizeMissing) {
      await guard.assertHeld();
      await guard.after(appendEffectVersion(this.#ch, {
        causation_id: effect.causation_id,
        stable_effect_id: effect.stable_effect_id,
        expectedVersion: effect.effect_version,
        state: 'uncertain',
        result: effect.result,
        error: `fresh fence could not observe accepted causal entry ${entryId}`,
        lease_fence: guard.lease.fence,
        created_at: input.createdAt,
      }));
    }
    throw new SchedulerError('UNCERTAIN_WRITE', `causal entry uzlastirilamadi: ${entryId}`);
  }

  #assertEntryMatchesInput(
    entry: TaskCausalEntryRow,
    input: AppendTaskCausalEntryInput,
  ): void {
    if (
      entry.task_id !== input.taskId ||
      entry.task_brief_id !== input.taskBriefId ||
      entry.assignment_attempt_id !== input.assignmentAttemptId ||
      entry.handoff_id !== (input.handoffId ?? NIL_UUID) ||
      entry.source_type !== input.sourceType ||
      entry.source_id !== input.sourceId ||
      entry.causation_id !== (input.causationId ?? NIL_UUID) ||
      entry.created_at !== new Date(input.createdAt).toISOString()
    ) {
      throw new SchedulerError(
        'INTEGRITY_CONFLICT',
        `causal entry deterministic kimlik/input catismasi: ${entry.entry_id}`,
      );
    }
  }

  #cursorJson(cursor: TaskCausalCursorV1): JsonObject {
    return {
      assignmentAttemptId: cursor.assignmentAttemptId,
      ...(cursor.handoffId === undefined ? {} : { handoffId: cursor.handoffId }),
      ordinal: cursor.ordinal,
    };
  }

  #parseEffectCursor(value: unknown): TaskCausalCursorV1 {
    return TaskCausalCursorV1Schema.parse(value);
  }

  #assertCurrent(
    task: Awaited<ReturnType<typeof getLatestTask>> & object,
    input: AppendTaskCausalEntryInput,
  ): void {
    if (
      task.project_id !== input.projectId || task.task_id !== input.taskId ||
      task.task_brief_id !== input.taskBriefId ||
      task.assignment_attempt_id !== input.assignmentAttemptId
    ) {
      throw new SchedulerError(
        'STALE_FENCE',
        'causal append current task brief/attempt sahibi degil',
      );
    }
  }

  #cursor(
    assignmentAttemptId: string,
    handoffId: string,
    ordinal: number,
  ): TaskCausalCursorV1 {
    return TaskCausalCursorV1Schema.parse({
      assignmentAttemptId,
      ...(handoffId === NIL_UUID ? {} : { handoffId }),
      ordinal,
    });
  }
}
