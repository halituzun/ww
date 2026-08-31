import type { ClickHouseClient } from '@clickhouse/client';
import { concreteEntityId } from './identifiers.js';
import { storedRecord, storedUInt64, type UInt64String } from './types.js';

/**
 * Returns the highest durable task-lease fence observed by scheduler-owned rows.
 * Agent assignment and receipt claim fences are intentionally excluded because
 * they belong to different Redis lease namespaces.
 */
export async function getTaskDurableMaxLeaseFence(
  ch: ClickHouseClient,
  taskId: string,
): Promise<UInt64String> {
  const task = concreteEntityId(taskId, 'taskId');
  const result = await ch.query({
    query: `SELECT toString(max(lease_fence)) AS lease_fence
      FROM task_lease_fence_observations
      PREWHERE task_id = {taskId:UUID}`,
    query_params: { taskId: task },
    format: 'JSONEachRow',
  });
  const rows = await result.json<unknown>();
  const row = storedRecord(rows[0], 'task durable max lease fence');
  return storedUInt64(row['lease_fence'], 'task durable max lease fence.lease_fence');
}
