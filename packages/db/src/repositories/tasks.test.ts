import { randomUUID } from 'node:crypto';
import { NIL_UUID, canonicalSha256V1 } from '@ww/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCh, type ClickHouseClient } from '../client.js';
import { runMigrations } from '../migrate.js';
import { clickhouseUp } from '../testutil.js';
import {
  appendTaskVersion,
  createTask,
  getLatestTask,
  listLatestTasksByStatus,
  type CreateTaskInput,
  type TaskRow,
} from './tasks.js';
import { RepositoryConflictError } from './types.js';

const up = await clickhouseUp();

describe.skipIf(!up)('tasks repository', () => {
  const db = `ww_test_tasks_${Date.now()}_${process.pid}`;
  let ch: ClickHouseClient;

  const rowHash = (row: TaskRow): string => canonicalSha256V1([
    row.task_id, row.project_id, row.plan_id, row.parent_task_id, row.title,
    row.description, row.status, row.priority, row.issuer_agent_id,
    row.worker_agent_id, row.verifier_agent_id, row.group, [...row.depends_on],
    [...row.target_files], row.attempt, row.max_attempts, row.delegation_depth,
    row.token_budget, row.tokens_spent, row.commit_hash, row.result_summary,
    row.reject_reason, row.task_brief_id, row.assignment_attempt_id,
    row.created_at, row.updated_at, row.version,
  ]);

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

  function task(): CreateTaskInput {
    const now = new Date().toISOString();
    return {
      task_id: randomUUID(),
      project_id: randomUUID(),
      plan_id: NIL_UUID,
      parent_task_id: NIL_UUID,
      title: 'Implement repository',
      description: 'Keep state durable',
      status: 'queued',
      priority: 5,
      issuer_agent_id: randomUUID(),
      worker_agent_id: NIL_UUID,
      verifier_agent_id: NIL_UUID,
      group: 'coding',
      depends_on: [],
      target_files: ['packages/db/src/repositories/tasks.ts'],
      attempt: 0,
      max_attempts: 3,
      delegation_depth: 0,
      token_budget: 10_000,
      tokens_spent: '0',
      commit_hash: '',
      result_summary: '',
      reject_reason: '',
      task_brief_id: NIL_UUID,
      assignment_attempt_id: NIL_UUID,
      created_at: now,
      updated_at: now,
    };
  }

  it('Faz 0 nil varsayilanlariyla okur ve yeni brief/attempt baglarini append eder', async () => {
    const initial = await createTask(ch, task());
    expect(initial.task_brief_id).toBe(NIL_UUID);
    expect(initial.assignment_attempt_id).toBe(NIL_UUID);
    const assigned = await appendTaskVersion(ch, {
      expectedVersion: initial.version,
      next: {
        ...initial,
        status: 'assigned',
        worker_agent_id: randomUUID(),
        verifier_agent_id: randomUUID(),
        task_brief_id: randomUUID(),
        assignment_attempt_id: randomUUID(),
      },
    });
    expect((await getLatestTask(ch, initial.project_id, initial.task_id))?.version).toBe(
      assigned.version,
    );
    expect(await listLatestTasksByStatus(ch, initial.project_id, 'queued')).toEqual([]);
    expect((await listLatestTasksByStatus(ch, initial.project_id, 'assigned'))[0]?.task_id).toBe(
      initial.task_id,
    );
  });

  it('max surum retry kopyasini katlar ve divergent tie kaydini fail-closed reddeder', async () => {
    const initial = await createTask(ch, task());
    await ch.insert({
      table: 'tasks',
      values: [{ ...initial, row_hash: rowHash(initial) }],
      format: 'JSONEachRow',
    });
    expect(await getLatestTask(ch, initial.project_id, initial.task_id)).toEqual(initial);

    const divergent = { ...initial, title: 'divergent' };
    await ch.insert({
      table: 'tasks',
      values: [{ ...divergent, row_hash: rowHash(divergent) }],
      format: 'JSONEachRow',
    });
    await ch.command({ query: 'OPTIMIZE TABLE tasks FINAL' });
    await expect(getLatestTask(ch, initial.project_id, initial.task_id))
      .rejects.toBeInstanceOf(RepositoryConflictError);
    await expect(listLatestTasksByStatus(ch, initial.project_id, initial.status))
      .rejects.toBeInstanceOf(RepositoryConflictError);
  });
});
