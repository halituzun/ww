import { createHash } from 'node:crypto';
import type { ClickHouseClient } from '@ww/db';
import {
  appendEvent,
  fileLockKey,
  type FileLockKey,
  type TaskRow,
} from '@ww/db';
import { NIL_UUID, type AssignmentAttemptV1, type EventType } from '@ww/shared';
import { FencedLeaseGuard } from './fenced-lease-guard.js';
import { deterministicSchedulerEntityId } from './ports.js';

export interface TaskFileLock {
  readonly key: FileLockKey;
  readonly path: string;
}

export function taskFileLocks(task: TaskRow): readonly TaskFileLock[] {
  const locks = new Map<FileLockKey, string>();
  for (const path of [...new Set(task.target_files)].sort()) {
    const key = fileLockKey(
      task.project_id,
      createHash('sha1').update(path).digest('hex'),
    );
    if (!locks.has(key)) locks.set(key, path);
  }
  return Object.freeze([...locks.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, path]) => Object.freeze({ key, path })));
}

export function fileLockEventSequence(
  createdAt: string,
  index: number,
  eventType: Extract<EventType, 'lock_acquired' | 'lock_released'>,
): string {
  if (!Number.isFinite(Date.parse(createdAt))) throw new Error('lock event createdAt gecersiz');
  if (!Number.isSafeInteger(index) || index < 0) throw new Error('lock event index gecersiz');
  return (BigInt(index) * 2n + (eventType === 'lock_released' ? 0n : 1n)).toString();
}

export async function appendTaskFileLockEvents(
  ch: ClickHouseClient,
  task: TaskRow,
  attempt: AssignmentAttemptV1,
  eventType: Extract<EventType, 'lock_acquired' | 'lock_released'>,
  createdAt: string,
  guard: FencedLeaseGuard,
): Promise<void> {
  const locks = taskFileLocks(task);
  for (const [index, lock] of locks.entries()) {
    await guard.assertHeld();
    await guard.after(appendEvent(ch, {
      event_id: deterministicSchedulerEntityId('task-file-lock-lifecycle-v1', {
        taskId: task.task_id,
        assignmentAttemptId: attempt.assignmentAttemptId,
        lockKey: lock.key,
        eventType,
      }),
      seq: fileLockEventSequence(createdAt, index, eventType),
      project_id: task.project_id,
      task_id: task.task_id,
      agent_id: NIL_UUID,
      event_type: eventType,
      tool_name: '',
      payload: {
        contractVersion: 1,
        lockKey: lock.key,
        path: lock.path,
        assignmentAttemptId: attempt.assignmentAttemptId,
      },
      duration_ms: 0,
      created_at: createdAt,
    }));
  }
}
