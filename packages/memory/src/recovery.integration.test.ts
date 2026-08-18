import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createAgent,
  createCh,
  createProject,
  createRedis,
  createTask,
  getLatestAgent,
  getLatestTask,
  runMigrations,
  type ClickHouseClient,
  type WwRedis,
} from '@ww/db';
import { NIL_UUID, type EntityId } from '@ww/shared';
import { RecoveryService } from './recovery-service.js';

const enabled = process.env['WW_REQUIRE_INTEGRATION'] === '1';
let probe: ClickHouseClient | undefined;
let probeRedis: WwRedis | undefined;
try {
  probe = createCh();
  await probe.query({ query: 'SELECT 1', format: 'JSONEachRow' });
  probeRedis = await createRedis();
} catch {
  if (enabled) throw new Error('Recovery entegrasyon servisi kapalı');
}

describe.skipIf(probe === undefined || probeRedis === undefined)('RecoveryService süreç yeniden başlatma akışı', () => {
  let ch: ClickHouseClient;
  let redis: WwRedis;
  const database = `ww_test_memory_recovery_${Date.now()}_${process.pid}`;
  const projectId = randomUUID() as EntityId;
  const agentId = randomUUID() as EntityId;
  const taskId = randomUUID() as EntityId;
  const now = '2026-08-15T20:00:00.000Z';

  beforeAll(async () => {
    await runMigrations({ database });
    ch = createCh({ database });
    redis = await createRedis();
    await createProject(ch, {
      project_id: projectId, name: 'Recovery project', slug: `recovery-${projectId.slice(0, 8)}`,
      type: 'web', status: 'running', description: '', workspace_path: `workspace/${projectId}`,
      budget_usd_limit: 100, settings: {}, active_plan_id: NIL_UUID, created_at: now, updated_at: now,
    });
    await createAgent(ch, {
      agent_id: agentId, project_id: projectId, role: 'worker', group: 'coding', name: 'Worker',
      model_ref: 'mock:worker', parent_agent_id: NIL_UUID, clone_of: NIL_UUID, status: 'busy',
      current_task_id: taskId, prompt_name: 'role.worker', prompt_version: 1, tasks_done: 0,
      tasks_rejected: 0, created_at: now, updated_at: now,
    });
    await createTask(ch, {
      task_id: taskId, project_id: projectId, plan_id: NIL_UUID, parent_task_id: NIL_UUID,
      title: 'Recover me', description: '', acceptance_criteria: [], status: 'working', priority: 5,
      issuer_agent_id: agentId, worker_agent_id: agentId, verifier_agent_id: NIL_UUID, group: 'coding',
      depends_on: [], target_files: ['src/recovery.ts'], attempt: 1, max_attempts: 3, delegation_depth: 0,
      token_budget: 10, tokens_spent: '0', commit_hash: '', result_summary: '', reject_reason: '',
      task_brief_id: NIL_UUID, assignment_attempt_id: NIL_UUID, created_at: now, updated_at: now,
    });
  });

  afterAll(async () => {
    redis.destroy();
    await ch.close();
    const admin = createCh({ database: 'default' });
    await admin.command({ query: `DROP DATABASE IF EXISTS ${database}` });
    await admin.close();
    probeRedis?.destroy();
    await probe?.close();
  });

  it('stale worker/task leaseini queued + idle yapar ve ikinci restart duplicate üretmez', async () => {
    // Kurtarma artık bekleme payı ister: heartbeat ancak atamadan SONRA
    // yazılabildiği için yeni atanmış canlı agent'ı ölü saymamalıdır. Bu
    // senaryodaki agent/görev gerçekten ölüdür; payın dolduğu an sabitlenir.
    const afterGrace = new Date(Date.parse(now) + 120_000).toISOString();
    const service = new RecoveryService(ch, redis, { now: () => afterGrace });
    const first = await service.recoverProject(projectId);
    expect(first.requeuedTaskIds).toEqual([taskId]);
    expect(first.idledAgentIds).toEqual([agentId]);
    expect((await getLatestTask(ch, projectId, taskId))?.status).toBe('queued');
    expect((await getLatestAgent(ch, projectId, agentId))?.status).toBe('idle');

    const second = await service.recoverProject(projectId);
    expect(second.requeuedTaskIds).toEqual([]);
    expect(second.idledAgentIds).toEqual([]);
  });

  // ÖLÇÜLDÜ (canlı ClickHouse, 2026-08-18): 2853 `recovery_completed` olayının
  // 2805'i (%98) HİÇBİR ŞEY kurtarmamıştı ve 1972'si tamamen boştu. Bu, tüm
  // olay günlüğünün %65'i demek. Panel zaman çizelgesi 100 olay tuttuğu için
  // gerçek iş görünmez oluyordu.
  //
  // Sağlık kontrolünde aynı ilke zaten uygulanıyor: "Yayın SADECE değişimde;
  // her dakika 'hâlâ ok' bildirmek paneli boğar."
  it('hicbir sey kurtarmayan tarama olay YAZMAZ', async () => {
    const bosProje = randomUUID();
    const service = new RecoveryService(ch, redis, { now: () => now });

    const result = await service.recoverProject(bosProje);
    expect(result.requeuedTaskIds).toEqual([]);
    expect(result.idledAgentIds).toEqual([]);
    expect(result.streamRepairedTaskIds).toEqual([]);

    const rows = await ch.query({
      query: `SELECT count() AS n FROM events
        WHERE project_id = {projectId:UUID} AND event_type = 'recovery_completed'`,
      query_params: { projectId: bosProje }, format: 'JSONEachRow',
    }).then((r) => r.json<{ n: string }>());
    expect(Number(rows[0]?.n ?? 0)).toBe(0);
  });

  // ÖLÇÜLDÜ: aynı görev kimlikleri 51 kez "onarıldı". Plansız görev ATANAMAZ;
  // kuyruğa konunca pompa reddeder, teslim sınırı dolunca akıştan silinir,
  // kurtarma geri koyar — sonsuza dek. `attempt` 0'da kaldığı için
  // `max_attempts` freni de hiç devreye girmez.
  it('plansiz gorevi kuyruga geri koymaz ama BILDIRIR', async () => {
    const dongudekiProje = randomUUID() as EntityId;
    const plansizGorev = randomUUID() as EntityId;
    await ch.insert({
      table: 'tasks',
      values: [{
        task_id: plansizGorev, project_id: dongudekiProje, plan_id: NIL_UUID,
        parent_task_id: NIL_UUID, title: 'plansız', description: '',
        acceptance_criteria: [], status: 'queued', priority: 0,
        issuer_agent_id: randomUUID(), worker_agent_id: NIL_UUID, verifier_agent_id: NIL_UUID,
        group: 'coding', depends_on: [], target_files: [], attempt: 0, max_attempts: 3,
        delegation_depth: 0, token_budget: 0, tokens_spent: '0', commit_hash: '',
        result_summary: '', reject_reason: '', task_brief_id: NIL_UUID,
        assignment_attempt_id: NIL_UUID, created_at: now, updated_at: now, version: '1',
      }],
      format: 'JSONEachRow',
    });

    const service = new RecoveryService(ch, redis, { now: () => now });
    const result = await service.recoverProject(dongudekiProje);

    expect(result.streamRepairedTaskIds).toEqual([]);
    // Sessiz kalmaz: engellenen görev raporlanır.
    expect(result.blockedTaskIds).toEqual([plansizGorev]);
  });
});
