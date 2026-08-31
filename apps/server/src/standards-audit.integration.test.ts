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
import { StandardsAuditApplicationService } from './standards-audit.service.js';

/**
 * Denetim döngüsünün ÜRETİM tarafı.
 *
 * NEDEN VAR: denetçi mantığının (standards-audit.ts) 27 testi vardı ama onu
 * çalıştıran ve sonucu VERİTABANINA yazan servisin hiç testi yoktu. Bu
 * ayrımın bedeli bilinen bir kusur sınıfıdır: kural doğru çalışsa bile,
 * bulguyu görev haline getirmeyen bir denetim "rapor edip unutan" bir süse
 * dönüşür.
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

describe.skipIf(probe === undefined)('StandardsAuditApplicationService', () => {
  let ch: ClickHouseClient;
  const database = `ww_test_std_audit_${Date.now()}_${process.pid}`;
  const projectId = randomUUID() as EntityId;
  const agentId = randomUUID() as EntityId;
  const planId = randomUUID() as EntityId;
  const now = '2026-08-31T09:00:00.000Z';

  const service = () => new StandardsAuditApplicationService({ ch } as never);

  beforeAll(async () => {
    await runMigrations({ database });
    ch = createCh({ database });
    await createProject(ch, {
      project_id: projectId,
      name: 'denetim projesi',
      slug: `denetim-${Date.now()}`,
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
      plan_version: 1,
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
  });

  afterAll(async () => {
    await ch?.command({ query: `DROP DATABASE IF EXISTS ${database}` }).catch(() => undefined);
    await ch?.close().catch(() => undefined);
  });

  // View'da fetch: STD-001.
  const ihlalliView = {
    filePath: 'apps/panel/src/components/Kirli.tsx',
    content: 'export function Kirli() { fetch("/x"); return null; }\n',
  };

  it('her ihlal için hem bulgu hem DÜZELTME GÖREVİ açar', async () => {
    const result = await service().auditFiles(projectId, [ihlalliView]);

    expect(result.findings.length).toBeGreaterThan(0);
    const finding = result.findings[0]!;
    expect(finding.ruleId).toBe('STD-001');
    // ASIL DEĞİŞMEZ: bulgu var ama düzelten yok durumu KAYIT SEVİYESİNDE
    // imkânsız olmalı; aksi hâlde denetim "rapor edip unutan" bir süs olur.
    expect(finding.correctiveTaskId).not.toBe(NIL_UUID);

    const tasks = await listLatestTasks(ch, projectId);
    const corrective = tasks.find((task) => task.task_id === finding.correctiveTaskId);
    expect(corrective).toBeDefined();
    expect(corrective?.status).toBe('queued');
    expect(corrective?.title).toContain('Standart düzeltmesi');
  });

  it('düzeltme görevi GERÇEK bir plana bağlanır', async () => {
    const result = await service().auditFiles(projectId, [ihlalliView]);
    const tasks = await listLatestTasks(ch, projectId);
    const corrective = tasks.find(
      (task) => task.task_id === result.findings[0]!.correctiveTaskId,
    );
    // Plansız görev ATANAMAZ ve sessizce hiç çalışmaz; plansız açmak
    // denetimi yine görünür ama işlevsiz kılardı.
    expect(corrective?.plan_id).toBe(planId);
    expect(corrective?.plan_id).not.toBe(NIL_UUID);
  });

  // STD-001 düzeltmesi mantığı ViewModel'e taşımayı gerektirir; executor
  // MÜHÜRLÜ hedef listesi dışına yazdırmaz, yani tek hedefle düzeltme
  // fiilen imkânsızdı.
  it('STD-001 düzeltmesinde ViewModel dosyası da hedeftir', async () => {
    const result = await service().auditFiles(projectId, [ihlalliView]);
    const tasks = await listLatestTasks(ch, projectId);
    const corrective = tasks.find(
      (task) => task.task_id === result.findings[0]!.correctiveTaskId,
    );
    expect(corrective?.target_files.length).toBeGreaterThan(1);
    expect(corrective?.target_files).toContain(ihlalliView.filePath);
    expect(corrective?.target_files.some((path) => path.includes('viewmodels/'))).toBe(true);
  });

  it('temiz dosyada bulgu da görev de açmaz', async () => {
    const before = (await listLatestTasks(ch, projectId)).length;
    const result = await service().auditFiles(projectId, [{
      filePath: 'apps/panel/src/components/Temiz.tsx',
      content: 'export function Temiz() { return null; }\n',
    }]);
    expect(result.findings).toHaveLength(0);
    expect((await listLatestTasks(ch, projectId)).length).toBe(before);
  });

  it('kaynak görev verilirse düzeltme onun ALTINDA açılır', async () => {
    const sourceTaskId = randomUUID() as EntityId;
    const result = await service().auditFiles(projectId, [ihlalliView], sourceTaskId);
    const tasks = await listLatestTasks(ch, projectId);
    const corrective = tasks.find(
      (task) => task.task_id === result.findings[0]!.correctiveTaskId,
    );
    expect(corrective?.parent_task_id).toBe(sourceTaskId);
    // Derinlik sınırı delegasyon zincirinin sonsuza gitmesini engeller.
    expect(corrective?.delegation_depth).toBe(1);
  });

  it('aktif agent yoksa fail-closed düşer', async () => {
    const bosProje = randomUUID() as EntityId;
    await createProject(ch, {
      project_id: bosProje,
      name: 'agentsiz',
      slug: `agentsiz-${Date.now()}`,
      type: 'web',
      description: '',
      status: 'running',
      workspace_path: `/tmp/${bosProje}`,
      budget_usd_limit: 0,
      settings: {},
      active_plan_id: NIL_UUID,
      created_at: now,
      updated_at: now,
    } as never);
    await expect(service().auditFiles(bosProje, [ihlalliView]))
      .rejects.toThrow(/aktif agent/);
  });
});
