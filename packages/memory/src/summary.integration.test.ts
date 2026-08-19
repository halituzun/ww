import { randomUUID } from 'node:crypto';
import { appendKnowledgeVersion, createCh, createTask, runMigrations, type ClickHouseClient } from '@ww/db';
import { NIL_UUID } from '@ww/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryService } from './memory-service.js';

async function clickhouseAvailable(): Promise<boolean> {
  const probe = createCh({ database: 'default' });
  try {
    await (await probe.query({ query: 'SELECT 1', format: 'JSONEachRow' })).json();
    return true;
  } catch (error) {
    if (process.env['WW_REQUIRE_INTEGRATION'] === '1') {
      throw new Error('WW_REQUIRE_INTEGRATION=1 ancak ClickHouse kullanilamiyor', { cause: error });
    }
    return false;
  } finally {
    await probe.close();
  }
}

const up = await clickhouseAvailable();

// docs/06 özet katmanı. `appendSummary`'nin HİÇ çağıranı ve HİÇ entegrasyon
// testi yoktu; bu yüzden gerçek tabloya hiç yazılmadığı fark edilmemişti.
describe.skipIf(!up)('MemoryService.appendSummary', () => {
  const database = `ww_test_summary_${Date.now()}_${process.pid}`;
  let ch: ClickHouseClient;

  beforeAll(async () => {
    await runMigrations({ database });
    ch = createCh({ database });
  });

  afterAll(async () => {
    const admin = createCh({ database: 'default' });
    await admin.command({ query: `DROP DATABASE IF EXISTS ${database}` });
    await admin.close();
    await ch.close();
  });

  // ASIL KUSUR: insert `{summary_id, ...input}` yazıyordu ve `input` alanları
  // camelCase (projectId/refId/createdByAgentId/createdAt). Tablo ise
  // snake_case ister. Yani satır ya reddediliyor ya da kimliksiz yazılıyordu.
  it('alanlari tablonun kolonlarina DOGRU esler', async () => {
    const projectId = randomUUID();
    const refId = randomUUID();
    const agentId = randomUUID();
    const memory = new MemoryService(ch);

    const summaryId = await memory.appendSummary({
      projectId: projectId as never,
      scope: 'task',
      refId: refId as never,
      content: 'Görev: renk yardımcısı\nSonuç: eklendi',
      createdByAgentId: agentId as never,
      createdAt: '2026-08-18T10:00:00.000Z',
    });

    const rows = await ch.query({
      query: `SELECT summary_id, project_id, scope, ref_id, content, created_by_agent_id
        FROM summaries WHERE summary_id = {summaryId:UUID}`,
      query_params: { summaryId }, format: 'JSONEachRow',
    }).then((r) => r.json<Record<string, unknown>>());

    expect(rows).toHaveLength(1);
    // Kimlik alanları BOŞ olmamalı: sıfır UUID yazılmış bir özet, hangi
    // göreve ait olduğu bilinmediği için hafızada işe yaramaz.
    expect(rows[0]).toMatchObject({
      project_id: projectId, ref_id: refId,
      created_by_agent_id: agentId, scope: 'task',
    });
    expect(String(rows[0]!['content'])).toContain('renk yardımcısı');
  });

  // ASIL KUSUR: özetler yalnızca knowledge VE file_index hiç eşleşmediğinde
  // bakılan bir SON ÇAREYDİ. Yazıcı bağlandığından beri bu, yazılan ama
  // okunmayan bir katman demekti: eşleşen tek bir karar, tüm görev
  // geçmişini görünmez yapıyordu.
  it('eslesen bir karar varken bile ozeti dondurur', async () => {
    const projectId = randomUUID();
    const memory = new MemoryService(ch);
    await appendKnowledgeVersion(ch, {
      knowledge_id: randomUUID(),
      project_id: projectId,
      kind: 'decision',
      title: 'Renk paleti kararı',
      content: 'Ana renk mavi olacak.',
      tags: ['renk'],
      source_task_id: NIL_UUID,
      source_message_id: NIL_UUID,
      status: 'active',
      superseded_by: NIL_UUID,
      created_at: '2026-08-18T09:00:00.000Z',
      row_hash: '',
    } as never);
    await memory.appendSummary({
      projectId: projectId as never,
      scope: 'task',
      refId: randomUUID() as never,
      content: 'Görev: renk yardımcısı eklendi\nSonuç: src/colors.ts yazıldı',
      createdByAgentId: randomUUID() as never,
      createdAt: '2026-08-18T10:00:00.000Z',
    });

    const chunks = await memory.query({ projectId: projectId as never, query: 'renk' });
    expect(chunks.map((chunk) => chunk.sourceTable)).toContain('summaries');
    expect(chunks.map((chunk) => chunk.sourceTable)).toContain('knowledge');
  });

  // docs/06 Context Builder 4. katman: "Taze gelişmeler — projenin son N görev
  // özeti (kronolojik farkındalık)". Bu katman HİÇ YOKTU: bağlam paketi yalnız
  // sorguyla eşleşeni alıyordu, yani sorgu vermeyen bir görev projede az önce
  // ne olduğunu HİÇ göremiyordu.
  it('baglam paketi sorgu olmadan da son ozetleri tasir', async () => {
    const projectId = randomUUID();
    const taskId = randomUUID();
    const memory = new MemoryService(ch);
    await createTask(ch, {
      task_id: taskId, project_id: projectId, plan_id: randomUUID(),
      parent_task_id: NIL_UUID, title: 'Tahta bileşeni',
      description: 'satranç tahtası', acceptance_criteria: ['render eder'],
      status: 'queued', priority: 0, issuer_agent_id: randomUUID(),
      worker_agent_id: NIL_UUID, verifier_agent_id: NIL_UUID, group: 'coding',
      depends_on: [], target_files: ['src/Board.tsx'], attempt: 0, max_attempts: 3,
      delegation_depth: 0, token_budget: 0, tokens_spent: 0, commit_hash: '',
      result_summary: '', reject_reason: '', task_brief_id: NIL_UUID,
      assignment_attempt_id: NIL_UUID,
      created_at: '2026-08-18T09:00:00.000Z', updated_at: '2026-08-18T09:00:00.000Z',
    } as never);
    await memory.appendSummary({
      projectId: projectId as never, scope: 'task', refId: randomUUID() as never,
      content: 'Görev: kuyruk pompası\nSonuç: alakasız ama TAZE bir gelişme',
      createdByAgentId: randomUUID() as never, createdAt: '2026-08-18T09:30:00.000Z',
    });

    const pack = await memory.buildContextPack({
      projectId: projectId as never, taskId: taskId as never,
      cutoffAt: '2026-08-18T12:00:00.000Z', tokenBudget: 4_000,
    });
    expect(pack.chunks.map((chunk) => chunk.label)).toContainEqual(
      expect.stringContaining('summary:task'),
    );
  });

  it('muhurlu gorevin hedef dosya fihristini sorgu olmadan tasir', async () => {
    const projectId = randomUUID();
    const taskId = randomUUID();
    const memory = new MemoryService(ch);
    await createTask(ch, {
      task_id: taskId, project_id: projectId, plan_id: randomUUID(),
      parent_task_id: NIL_UUID, title: 'Renk yardimcisi', description: 'yardimciyi ekle',
      acceptance_criteria: ['calisir'], status: 'queued', priority: 0,
      issuer_agent_id: randomUUID(), worker_agent_id: NIL_UUID,
      verifier_agent_id: NIL_UUID, group: 'coding', depends_on: [],
      target_files: ['src/colors.ts'], attempt: 0, max_attempts: 3,
      delegation_depth: 0, token_budget: 0, tokens_spent: 0, commit_hash: '',
      result_summary: '', reject_reason: '', task_brief_id: NIL_UUID,
      assignment_attempt_id: NIL_UUID,
      created_at: '2026-08-18T09:00:00.000Z', updated_at: '2026-08-18T09:00:00.000Z',
    } as never);
    await memory.updateFileIndex({
      projectId: projectId as never, filePath: 'src/colors.ts',
      summary: 'Renk sabitleri ve tema yardimcilari', layer: 'service',
      updatedAt: '2026-08-18T09:30:00.000Z',
    });

    const pack = await memory.buildContextPack({
      projectId: projectId as never, taskId: taskId as never,
      cutoffAt: '2026-08-18T12:00:00.000Z', tokenBudget: 4_000,
    });
    expect(pack.chunks.map((chunk) => chunk.label)).toContain('[file:src/colors.ts]');
  });

  // Kesme anı özetlerde de geçerlidir: yeniden koşan bir görev, KENDİSİNDEN
  // SONRA oluşmuş bir gelişmeyi görürse koşu tekrar edilemez olur.
  it('kesme anindan sonraki ozeti baglama koymaz', async () => {
    const projectId = randomUUID();
    const taskId = randomUUID();
    const memory = new MemoryService(ch);
    await createTask(ch, {
      task_id: taskId, project_id: projectId, plan_id: randomUUID(),
      parent_task_id: NIL_UUID, title: 'Tahta bileşeni', description: 'x',
      acceptance_criteria: ['y'], status: 'queued', priority: 0,
      issuer_agent_id: randomUUID(), worker_agent_id: NIL_UUID,
      verifier_agent_id: NIL_UUID, group: 'coding', depends_on: [],
      target_files: ['src/Board.tsx'], attempt: 0, max_attempts: 3,
      delegation_depth: 0, token_budget: 0, tokens_spent: 0, commit_hash: '',
      result_summary: '', reject_reason: '', task_brief_id: NIL_UUID,
      assignment_attempt_id: NIL_UUID,
      created_at: '2026-08-18T09:00:00.000Z', updated_at: '2026-08-18T09:00:00.000Z',
    } as never);
    await memory.appendSummary({
      projectId: projectId as never, scope: 'task', refId: randomUUID() as never,
      content: 'Görev: GELECEKTEN gelen özet', createdByAgentId: randomUUID() as never,
      createdAt: '2026-08-18T14:00:00.000Z',
    });

    const pack = await memory.buildContextPack({
      projectId: projectId as never, taskId: taskId as never,
      cutoffAt: '2026-08-18T12:00:00.000Z', tokenBudget: 4_000,
    });
    expect(pack.chunks.map((chunk) => chunk.text).join('\n')).not.toContain('GELECEKTEN');
  });

  // Canlı veride ölçüldü: iki görevde değiştirilmiş bir dosyanın fihristinde
  // (change_count=2) yalnızca BİR görev kimliği kalmıştı.
  it('fihrist ilgili gorevleri biriktirir, uzerine yazmaz', async () => {
    const projectId = randomUUID();
    const memory = new MemoryService(ch);
    const first = randomUUID();
    const second = randomUUID();

    await memory.updateFileIndex({
      projectId: projectId as never, filePath: 'src/Counter.tsx',
      summary: 'sayaç bileşeni', layer: 'view',
      relatedTaskIds: [first as never], relatedArtifactIds: [randomUUID() as never],
      lastCommitHash: 'aaa1111', updatedAt: '2026-08-18T10:00:00.000Z',
    });
    await memory.updateFileIndex({
      projectId: projectId as never, filePath: 'src/Counter.tsx',
      summary: 'sayaç bileşeni: sıfırlama eklendi', layer: 'view',
      relatedTaskIds: [second as never], relatedArtifactIds: [randomUUID() as never],
      lastCommitHash: 'bbb2222', updatedAt: '2026-08-18T11:00:00.000Z',
    });

    const rows = await ch.query({
      query: `SELECT related_task_ids, related_artifact_ids FROM file_index
        WHERE project_id = {projectId:UUID} AND file_path = 'src/Counter.tsx'
        ORDER BY version DESC LIMIT 1`,
      query_params: { projectId }, format: 'JSONEachRow',
    }).then((r) => r.json<Record<string, unknown>>());

    expect(rows[0]!['related_task_ids']).toEqual([first, second]);
    expect((rows[0]!['related_artifact_ids'] as string[]).length).toBe(2);
  });
});
