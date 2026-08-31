import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createAgent,
  createCh,
  createPlan,
  createProject,
  createTask,
  getLatestTask,
  listLatestPlansByStatus,
  runMigrations,
  type ClickHouseClient,
} from '@ww/db';
import { NIL_UUID, type EntityId } from '@ww/shared';
import { ReplanningService } from './replanning-service.js';

/**
 * Yeniden planlama sözleşmesini gerçek ClickHouse'a karşı doğrular.
 *
 * NEDEN entegrasyon: plan yazımı `INSERT ... SELECT` ile observed_at'i sunucu
 * tarafında üretir; sahte bir istemci bu yolu hiç denemez.
 */
const enabled = process.env['WW_REQUIRE_INTEGRATION'] === '1';
let probe: ClickHouseClient | undefined;
try {
  probe = createCh();
  await probe.query({ query: 'SELECT 1', format: 'JSONEachRow' });
} catch {
  if (enabled) throw new Error('ClickHouse entegrasyon servisi kapalı');
} finally {
  await probe?.close().catch(() => undefined);
  if (probe !== undefined) probe = createCh();
}

describe.skipIf(probe === undefined)('yeniden planlama sözleşmesi', () => {
  let ch: ClickHouseClient;
  const database = `ww_test_replan_${Date.now()}_${process.pid}`;
  const projectId = randomUUID() as EntityId;
  const agentId = randomUUID() as EntityId;
  const planId = randomUUID() as EntityId;
  const openTaskId = randomUUID() as EntityId;
  const doneTaskId = randomUUID() as EntityId;
  const now = '2026-08-31T09:00:00.000Z';

  const task = (taskId: EntityId, status: string) => ({
    task_id: taskId,
    project_id: projectId,
    plan_id: planId,
    parent_task_id: NIL_UUID,
    title: `gorev ${status}`,
    description: '',
    acceptance_criteria: ['kriter'],
    status,
    priority: 5,
    issuer_agent_id: agentId,
    worker_agent_id: NIL_UUID,
    verifier_agent_id: NIL_UUID,
    group: 'coding',
    depends_on: [],
    target_files: ['src/a.ts'],
    attempt: 0,
    max_attempts: 3,
    delegation_depth: 0,
    token_budget: 0,
    tokens_spent: '0',
    commit_hash: '',
    result_summary: '',
    reject_reason: '',
    task_brief_id: NIL_UUID,
    assignment_attempt_id: NIL_UUID,
    created_at: now,
    updated_at: now,
  });

  beforeAll(async () => {
    await runMigrations({ database });
    ch = createCh({ database });
    await createProject(ch, {
      project_id: projectId,
      name: 'yeniden planlama projesi',
      slug: `replan-${Date.now()}`,
      type: 'web',
      description: '',
      status: 'running',
      workspace_path: `/tmp/${projectId}`,
      budget_usd_limit: 0,
      settings: {},
      active_plan_id: NIL_UUID,
      created_at: now,
      updated_at: now,
    } as never);
    await createAgent(ch, {
      agent_id: agentId,
      project_id: projectId,
      role: 'pm',
      group: 'management',
      name: 'PM',
      model_ref: 'mock:pm',
      parent_agent_id: NIL_UUID,
      clone_of: NIL_UUID,
      status: 'idle',
      current_task_id: NIL_UUID,
      prompt_name: 'role.pm',
      prompt_version: 1,
      tasks_done: 0,
      tasks_rejected: 0,
      created_at: now,
      updated_at: now,
    } as never);
    await createPlan(ch, {
      plan_id: planId,
      project_id: projectId,
      plan_version: 2,
      status: 'approved',
      title: 'onaylı plan',
      content_md: '# plan',
      council_session_id: NIL_UUID,
      team_json: {},
      scenarios_json: { version: 1, tasks: [] },
      replan_reason: '',
      supersedes_plan_id: NIL_UUID,
      created_by_agent_id: agentId,
      approved_by: 'local-user',
      provider_diversity: 3,
      created_at: now,
    } as never);
    await createTask(ch, task(openTaskId, 'queued') as never);
    await createTask(ch, task(doneTaskId, 'done') as never);
  });

  afterAll(async () => {
    await ch?.command({ query: `DROP DATABASE IF EXISTS ${database}` }).catch(() => undefined);
    await ch?.close().catch(() => undefined);
  });

  it('planı superseded yapar, açık görevleri iptal eder, bitmişe dokunmaz', async () => {
    const result = await new ReplanningService(ch).replan({
      projectId,
      reason: 'kapsam degisti',
      summary: 'mobil destek eklenecek',
      now: '2026-08-31T10:00:00.000Z',
    });

    // docs/03: yeniden planlama planı devre dışı bırakır. Eskiden statü
    // 'approved' kalıyordu, yani iptal edilen plan hâlâ aktif görünüyordu.
    expect(result.supersededPlan.status).toBe('superseded');
    expect(result.supersededPlan.replan_reason).toBe('kapsam degisti');
    const stillApproved = await listLatestPlansByStatus(ch, projectId, 'approved');
    expect(stillApproved.find((plan) => plan.plan_id === planId)).toBeUndefined();

    // Etkilenen görevler cancelled olmalı; aksi hâlde kuyruk iptal edilen
    // planın işini üretmeye devam eder.
    expect(result.cancelledTasks.map((t) => t.task_id)).toEqual([openTaskId]);
    expect((await getLatestTask(ch, projectId, openTaskId))?.status).toBe('cancelled');
    expect((await getLatestTask(ch, projectId, openTaskId))?.reject_reason)
      .toContain('yeniden planlandi');
    // Biten iş iptal edilmez: yapılmış işi geri almak veri kaybıdır.
    expect((await getLatestTask(ch, projectId, doneTaskId))?.status).toBe('done');

    // Yeni sürüm konsey turundan doğar; hedef gerekçeyi ve özeti taşır.
    expect(result.nextPlanVersion).toBe(3);
    expect(result.councilGoal).toContain('kapsam degisti');
    expect(result.councilGoal).toContain('mobil destek');
  });
});
