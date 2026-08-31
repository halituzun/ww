import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createAgent,
  createCh,
  createPlan,
  createProject,
  listLatestTasks,
  runMigrations,
  type ClickHouseClient,
} from '@ww/db';
import { NIL_UUID, type EntityId } from '@ww/shared';
import { PlanApprovalError, PlanApprovalService } from './plan-approval-service.js';

/**
 * Plan onayının GÖREV ÜRETTİĞİNİ gerçek ClickHouse'a karşı doğrular.
 *
 * NEDEN entegrasyon: plan yazımı `INSERT ... SELECT` ile observed_at'i sunucu
 * tarafında üretir ve yazımdan sonra geri okuyup içerik karşılaştırır. Sahte
 * bir istemciyle bu yolu taklit etmek ClickHouse'u yeniden yazmak olurdu —
 * ve tam da denenmesi gereken yol burasıdır.
 */
const enabled = process.env['WW_REQUIRE_INTEGRATION'] === '1';
let probe: ClickHouseClient | undefined;
try {
  probe = createCh();
  await probe.query({ query: 'SELECT 1', format: 'JSONEachRow' });
} catch {
  if (enabled) throw new Error('ClickHouse entegrasyon servisi kapalı');
} finally {
  // Yoklama istemcisi dosya ömrü boyunca açık kalmamalı (bağlantı sızıntısı).
  await probe?.close().catch(() => undefined);
  if (probe !== undefined) probe = createCh();
}

describe.skipIf(probe === undefined)('plan onayı görev üretir', () => {
  let ch: ClickHouseClient;
  const database = `ww_test_plan_activation_${Date.now()}_${process.pid}`;
  const projectId = randomUUID() as EntityId;
  const agentId = randomUUID() as EntityId;
  const now = '2026-08-31T09:00:00.000Z';

  const taskSpec = (key: string, dependsOn: string[] = []) => ({
    key,
    title: `${key} başlığı`,
    description: 'aciklama',
    acceptanceCriteria: ['kriter'],
    targetFiles: [`src/${key}.ts`],
    dependsOn,
    group: 'coding' as const,
  });

  const seedPlan = async (tasks: unknown[]): Promise<EntityId> => {
    const planId = randomUUID() as EntityId;
    await createPlan(ch, {
      plan_id: planId,
      project_id: projectId,
      plan_version: 1,
      status: 'proposed',
      title: 'konsey planı',
      content_md: '# plan',
      council_session_id: NIL_UUID,
      team_json: {},
      scenarios_json: { version: 1, tasks },
      replan_reason: '',
      supersedes_plan_id: NIL_UUID,
      created_by_agent_id: agentId,
      approved_by: '',
      created_at: now,
    } as never);
    return planId;
  };

  const service = (enqueued: string[]) => new PlanApprovalService(
    ch,
    {
      enqueue: async (_projectId, taskId) => {
        enqueued.push(taskId);
      },
    },
    { ensureRoster: async () => 0 },
    { newTaskId: () => randomUUID() as EntityId },
  );

  beforeAll(async () => {
    await runMigrations({ database });
    ch = createCh({ database });
    await createProject(ch, {
      project_id: projectId,
      name: 'plan onay projesi',
      slug: `plan-onay-${Date.now()}`,
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
  });

  afterAll(async () => {
    await ch?.command({ query: `DROP DATABASE IF EXISTS ${database}` }).catch(() => undefined);
    await ch?.close().catch(() => undefined);
  });

  it('görevleri bağımlılık sırasına göre açar, kimlikleri çözer ve kuyruğa basar', async () => {
    const enqueued: string[] = [];
    // Grafik BİLEREK ters sırada veriliyor: sıralama topolojik olmalı.
    const planId = await seedPlan([taskSpec('g2', ['g1']), taskSpec('g1')]);

    const result = await service(enqueued).apply({
      projectId, planId, approved: true, actor: 'local-user', now,
    });

    expect(result.plan.status).toBe('approved');
    expect(result.createdTasks).toHaveLength(2);
    expect(result.createdTasks[0]?.title).toBe('g1 başlığı');
    // g2'nin bağımlılığı g1'in gerçek KİMLİĞİNE çözülmüş olmalı.
    expect(result.createdTasks[1]?.depends_on).toEqual([result.createdTasks[0]?.task_id]);
    // Hedef dosyalar taşınmalı: boş liste executor'da write_file'ı reddettirir.
    expect(result.createdTasks[0]?.target_files).toEqual(['src/g1.ts']);
    expect(enqueued).toHaveLength(2);

    const stored = await listLatestTasks(ch, projectId);
    expect(stored.filter((t) => t.plan_id === planId)).toHaveLength(2);
    expect(stored.every((t) => t.status === 'queued')).toBe(true);
  });

  it('görev kırılımı olmayan planı onaylamaz ve planı proposed bırakır', async () => {
    const enqueued: string[] = [];
    const planId = await seedPlan([]);

    await expect(service(enqueued).apply({
      projectId, planId, approved: true, actor: 'local-user', now,
    })).rejects.toThrow(PlanApprovalError);

    expect(enqueued).toHaveLength(0);
    // Statü ÇEVRİLMEMİŞ olmalı: "onaylandı ama hiçbir şey olmadı" durumu
    // düzeltilen kusurun ta kendisiydi.
    const plans = await ch.query({
      query: `SELECT status FROM plans WHERE plan_id = {planId:UUID} ORDER BY version DESC LIMIT 1`,
      query_params: { planId },
      format: 'JSONEachRow',
    });
    const rows = await plans.json<{ status: string }>();
    expect(rows[0]?.status).toBe('proposed');
  });
});
