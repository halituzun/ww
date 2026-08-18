import { randomUUID } from 'node:crypto';
import { createCh, runMigrations, type ClickHouseClient } from '@ww/db';
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
});
