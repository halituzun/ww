import type { ClickHouseClient } from '@ww/db';
import { appendEvent } from '@ww/db';
import {
  NIL_UUID,
  canonicalSha256V1,
  type EntityId,
  type TaskHandoffV1,
} from '@ww/shared';
import { FencedLeaseGuard } from './fenced-lease-guard.js';
import { deterministicSchedulerEntityId } from './ports.js';

export function taskHandoffEventId(handoffId: EntityId): EntityId {
  return deterministicSchedulerEntityId('task-handoff-event-v1', handoffId);
}

export function taskHandoffEventSequence(createdAt: string): string {
  const epochMs = Date.parse(createdAt);
  if (!Number.isSafeInteger(epochMs) || epochMs < 0) {
    throw new Error('task handoff event createdAt gecersiz');
  }
  return String(epochMs);
}

/** Appends the replay-safe timeline reference; task_handoffs remains canonical. */
export async function appendTaskHandoffEvent(
  ch: ClickHouseClient,
  handoff: TaskHandoffV1,
  causationId: EntityId,
  guard: FencedLeaseGuard,
): Promise<void> {
  await guard.assertHeld();
  await guard.after(appendEvent(ch, {
    event_id: taskHandoffEventId(handoff.handoffId),
    seq: taskHandoffEventSequence(handoff.createdAt),
    project_id: handoff.projectId,
    task_id: handoff.taskId,
    agent_id: NIL_UUID,
    event_type: 'task_handoff',
    tool_name: '',
    payload: {
      contractVersion: 1,
      handoffId: handoff.handoffId,
      taskBriefId: handoff.taskBriefId,
      fromAssignmentAttemptId: handoff.fromAssignmentAttemptId,
      toAssignmentAttemptId: handoff.toAssignmentAttemptId,
      ancestorCursor: {
        assignmentAttemptId: handoff.ancestorCursor.assignmentAttemptId,
        ...(handoff.ancestorCursor.handoffId === undefined
          ? {}
          : { handoffId: handoff.ancestorCursor.handoffId }),
        ordinal: handoff.ancestorCursor.ordinal,
      },
      causationId,
      handoffHash: canonicalSha256V1(handoff),
    },
    duration_ms: 0,
    created_at: handoff.createdAt,
  }));
}
