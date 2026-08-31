import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appendAgentVersion,
  createAgent,
  createCh,
  createProject,
  getLatestAgent,
  listLatestAgents,
  runMigrations,
  type ClickHouseClient,
} from '@ww/db';
import { NIL_UUID, type EntityId } from '@ww/shared';
import { AgentCloneService, CloneLimitError } from './agent-clone-service.js';

/**
 * `AgentCloneService`'in DAVRANIŞINI sabitler.
 *
 * NEDEN VAR: bu servisin hiçbir testi yoktu. CLAUDE.md onu "yazılmış ama
 * bağlanmamış kod"un motive edici örneği olarak anıyor; wiring-check'in kendi
 * yorumu ise `stopIdleClones` için "ne üretim ne test çağırıyordu ve docs/03'ün
 * klon süpürme kuralı hiç koşmadı" diyor. Yani sembol bağlandı ama davranışı
 * hâlâ hiçbir şeyle sabitlenmemişti: bir sonraki değişiklik onu sessizce
 * bozabilirdi.
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

describe.skipIf(probe === undefined)('AgentCloneService', () => {
  let ch: ClickHouseClient;
  const database = `ww_test_clone_${Date.now()}_${process.pid}`;
  const projectId = randomUUID() as EntityId;
  const now = '2026-08-31T09:00:00.000Z';

  const agent = (over: Record<string, unknown> = {}) => ({
    agent_id: randomUUID(),
    project_id: projectId,
    role: 'worker',
    group: 'coding',
    name: 'Worker 1',
    model_ref: 'mistral:mistral-large-latest',
    parent_agent_id: NIL_UUID,
    clone_of: NIL_UUID,
    status: 'busy',
    current_task_id: NIL_UUID,
    prompt_name: 'role.worker.coding',
    prompt_version: 1,
    tasks_done: 0,
    tasks_rejected: 0,
    created_at: now,
    updated_at: now,
    ...over,
  });

  beforeAll(async () => {
    await runMigrations({ database });
    ch = createCh({ database });
    await createProject(ch, {
      project_id: projectId,
      name: 'klon projesi',
      slug: `klon-${Date.now()}`,
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
  });

  afterAll(async () => {
    await ch?.command({ query: `DROP DATABASE IF EXISTS ${database}` }).catch(() => undefined);
    await ch?.close().catch(() => undefined);
  });

  it('meşgul agenttan klon üretir ve kimliğini kaynağa bağlar', async () => {
    const source = agent({ name: 'Kaynak Worker' });
    await createAgent(ch, source as never);

    const clone = await new AgentCloneService(ch).cloneIfBusy(projectId, source.agent_id as EntityId);

    expect(clone.clone_of).toBe(source.agent_id);
    expect(clone.name).toBe('Kaynak Worker-1');
    // Klon kaynağın SÖZLEŞMESİNİ taşımalı: farklı prompt ya da model,
    // "aynı işi yapan ikinci agent" olmaktan çıkarırdı.
    expect(clone.role).toBe(source.role);
    expect(clone.model_ref).toBe(source.model_ref);
    expect(clone.prompt_name).toBe(source.prompt_name);
    expect(clone.prompt_version).toBe(source.prompt_version);
    // Yeni klon İŞE HAZIR olmalı; 'busy' doğsa atama onu hiç seçmezdi.
    expect(clone.status).toBe('idle');
  });

  it('kaynak agent yoksa fail-closed düşer', async () => {
    await expect(new AgentCloneService(ch).cloneIfBusy(projectId, randomUUID() as EntityId))
      .rejects.toThrow(CloneLimitError);
  });

  it('agent başına klon limitini uygular', async () => {
    const source = agent({ name: 'Sinirli Worker' });
    await createAgent(ch, source as never);
    const service = new AgentCloneService(ch, { maxClonesPerAgent: 2, maxParallelAgents: 100 });

    await service.cloneIfBusy(projectId, source.agent_id as EntityId);
    await service.cloneIfBusy(projectId, source.agent_id as EntityId);
    // Üçüncü klon limiti aşar: sınırsız klonlama sağlayıcı rate limitine
    // çarpar ve bütçeyi tüketir (docs/07 frenler).
    await expect(service.cloneIfBusy(projectId, source.agent_id as EntityId))
      .rejects.toThrow(/clone limiti/);
  });

  it('global paralel agent limitini uygular', async () => {
    const source = agent({ name: 'Global Worker' });
    await createAgent(ch, source as never);
    const mevcut = (await listLatestAgents(ch, projectId, { limit: 1_000 })).length;
    const service = new AgentCloneService(ch, { maxClonesPerAgent: 99, maxParallelAgents: mevcut });

    await expect(service.cloneIfBusy(projectId, source.agent_id as EntityId))
      .rejects.toThrow(/global agent limiti/);
  });

  // docs/03 klon süpürme kuralı: boşta kalan klonlar toplanır. Bu metot
  // uzun süre HİÇ çağrılmadı; davranışı burada sabitlenir.
  it('yalnız BOŞTA ve ESKİMİŞ klonları durdurur', async () => {
    const source = agent({ name: 'Supurme Kaynak' });
    await createAgent(ch, source as never);

    const eskiBosta = agent({
      name: 'eski-bosta', clone_of: source.agent_id, status: 'idle',
      updated_at: '2020-01-01T00:00:00.000Z',
    });
    const eskiMesgul = agent({
      name: 'eski-mesgul', clone_of: source.agent_id, status: 'busy',
      updated_at: '2020-01-01T00:00:00.000Z',
    });
    const yeniBosta = agent({
      name: 'yeni-bosta', clone_of: source.agent_id, status: 'idle',
      updated_at: '2030-01-01T00:00:00.000Z',
    });
    for (const row of [eskiBosta, eskiMesgul, yeniBosta]) await createAgent(ch, row as never);

    const stopped = await new AgentCloneService(ch)
      .stopIdleClones(projectId, '2026-01-01T00:00:00.000Z');

    expect(stopped).toContain(eskiBosta.agent_id);
    // MEŞGUL klonu durdurmak, süren işi öldürürdü.
    expect(stopped).not.toContain(eskiMesgul.agent_id);
    // Taze klon havuzda kalmalı: hemen yeniden klonlamak boşuna maliyettir.
    expect(stopped).not.toContain(yeniBosta.agent_id);
    // ORİJİNAL agent klon değildir; süpürme onu asla kapatmamalı.
    expect(stopped).not.toContain(source.agent_id);

    expect((await getLatestAgent(ch, projectId, eskiBosta.agent_id as EntityId))?.status)
      .toBe('stopped');
    expect((await getLatestAgent(ch, projectId, source.agent_id as EntityId))?.status)
      .toBe('busy');
  });

  it('durdurulan klonun görev bağı bırakılır', async () => {
    const source = agent({ name: 'Bag Kaynak' });
    await createAgent(ch, source as never);
    const taskId = randomUUID();
    const created = await createAgent(ch, agent({
      name: 'bagli-klon', clone_of: source.agent_id, status: 'idle',
      current_task_id: taskId, updated_at: '2020-01-01T00:00:00.000Z',
    }) as never);
    // Fence'in ilerlediğini de görmek isteriz: bayat bir fence, durdurulan
    // agenta yapılacak sonraki yazımı sessizce kabul ettirirdi.
    const fenceOnce = created.assignment_fence;

    await new AgentCloneService(ch).stopIdleClones(projectId, '2026-01-01T00:00:00.000Z');

    const after = await getLatestAgent(ch, projectId, created.agent_id as EntityId);
    expect(after?.status).toBe('stopped');
    expect(after?.current_task_id).toBe(NIL_UUID);
    expect(BigInt(after!.assignment_fence)).toBeGreaterThan(BigInt(fenceOnce));
  });

  it('appendAgentVersion ile yazılan durum geri okunabilir', async () => {
    // Süpürmenin kullandığı yazma yolu, doğrudan da doğrulanır.
    const row = await createAgent(ch, agent({ name: 'yol-testi', status: 'idle' }) as never);
    const next = await appendAgentVersion(ch, {
      expectedVersion: row.version,
      assignmentFence: String(BigInt(row.assignment_fence) + 1n),
      next: { ...row, status: 'stopped', updated_at: '2026-08-31T10:00:00.000Z' },
    });
    expect(next.status).toBe('stopped');
  });
});
