import { randomUUID } from 'node:crypto';
import type { ClickHouseClient } from '@clickhouse/client';
import { NIL_UUID } from '@ww/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCh } from '../client.js';
import { runMigrations } from '../migrate.js';
import { clickhouseUp } from '../testutil.js';
import { appendAssignmentAttempt } from './briefs.js';
import { appendTaskCausalEntry } from './causal-entries.js';
import { reserveEffect } from './effects.js';
import { getTaskDurableMaxLeaseFence } from './scheduler-fences.js';

const up = await clickhouseUp();

describe.skipIf(!up)('scheduler durable fence repository', () => {
  const db = `ww_test_scheduler_fences_${Date.now()}_${process.pid}`;
  let ch: ClickHouseClient;

  beforeAll(async () => {
    await runMigrations({ database: db });
    ch = createCh({ database: db });
  });

  afterAll(async () => {
    const admin = createCh({ database: 'default' });
    await admin.command({ query: `DROP DATABASE IF EXISTS ${db}` });
    await admin.close();
    await ch.close();
  });

  it('yalniz task lease namespace tablolarini tek task-scope sorguda katlar', async () => {
    const taskId = randomUUID();
    const projectId = randomUUID();
    expect(await getTaskDurableMaxLeaseFence(ch, taskId)).toBe('0');

    const attemptId = randomUUID();
    await appendAssignmentAttempt(ch, {
      contractVersion: 1,
      assignmentAttemptId: attemptId,
      projectId,
      taskId,
      taskBriefId: randomUUID(),
      attemptNumber: 1,
      workerAgentId: randomUUID(),
      verifierAgentId: randomUUID(),
      leaseOwner: 'scheduler-fence-test',
      leaseFence: 4,
      leaseExpiresAt: '2026-08-14T10:10:00.000Z',
      startReason: 'initial',
      assignedAt: '2026-08-14T10:00:00.000Z',
    });
    await appendTaskCausalEntry(ch, {
      task_id: taskId,
      task_brief_id: randomUUID(),
      assignment_attempt_id: attemptId,
      handoff_id: NIL_UUID,
      source_type: 'message',
      source_id: randomUUID(),
      causation_id: NIL_UUID,
      lease_fence: '7',
      created_at: '2026-08-14T10:01:00.000Z',
    });
    await reserveEffect(ch, {
      causation_id: randomUUID(),
      stable_effect_id: `task-transition:${randomUUID()}`,
      project_id: projectId,
      task_id: taskId,
      assignment_attempt_id: attemptId,
      effect_type: 'task_transition',
      request: { taskId },
      replay_safety: 'replay_safe',
      lease_fence: '11',
      created_at: '2026-08-14T10:02:00.000Z',
    });
    await reserveEffect(ch, {
      causation_id: randomUUID(),
      stable_effect_id: `task-transition:${randomUUID()}`,
      project_id: projectId,
      task_id: randomUUID(),
      effect_type: 'task_transition',
      request: { unrelated: true },
      replay_safety: 'replay_safe',
      lease_fence: '999',
      created_at: '2026-08-14T10:03:00.000Z',
    });

    let query = '';
    const observed = new Proxy(ch, {
      get(target, property) {
        if (property === 'query') return (options: Parameters<ClickHouseClient['query']>[0]) => {
          query = String(options.query);
          return target.query(options);
        };
        const member: unknown = Reflect.get(target, property, target);
        return typeof member === 'function' ? member.bind(target) : member;
      },
    });
    await expect(getTaskDurableMaxLeaseFence(observed, taskId)).resolves.toBe('11');
    expect(query.match(/task_id = \{taskId:UUID\}/g)).toHaveLength(1);
    expect(query).toContain('task_lease_fence_observations');
    expect(query).toContain('PREWHERE task_id');
    expect(query).not.toContain('assignment_attempts');
    expect(query).not.toContain('task_causal_entries');
    expect(query).not.toContain('effect_ledger');
    expect(query).not.toContain('agents');
    expect(query).not.toContain('message_receipts');
  });
});
