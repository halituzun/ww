import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCh, type ClickHouseClient } from '../client.js';
import { runMigrations } from '../migrate.js';
import { clickhouseUp } from '../testutil.js';
import { listRecentSummaries } from './summaries.js';

const up = await clickhouseUp();
describe.skipIf(!up)('summaries repository', () => {
  const db = `ww_test_summaries_${Date.now()}_${process.pid}`;
  let ch: ClickHouseClient;
  beforeAll(async () => { await runMigrations({ database: db }); ch = createCh({ database: db }); });
  afterAll(async () => { const admin = createCh({ database: 'default' }); await admin.command({ query: `DROP DATABASE IF EXISTS ${db}` }); await admin.close(); await ch.close(); });

  const write = async (projectId: string, content: string, createdAt: string): Promise<void> => {
    await ch.insert({
      table: 'summaries',
      values: [{
        summary_id: randomUUID(), project_id: projectId, scope: 'task',
        ref_id: randomUUID(), content, created_by_agent_id: randomUUID(),
        created_at: createdAt,
      }],
      format: 'JSONEachRow',
    });
  };

  it('en yeniden eskiye siralar ve limiti uygular', async () => {
    const projectId = randomUUID();
    await write(projectId, 'eski', '2026-08-18T09:00:00.000Z');
    await write(projectId, 'yeni', '2026-08-18T11:00:00.000Z');
    const rows = await listRecentSummaries(ch, projectId, 1);
    expect(rows.map((row) => row.content)).toEqual(['yeni']);
    // Tarih ISO metni olarak döner: çağıran onu Date.parse ile karşılaştırır.
    expect(Date.parse(rows[0]!.created_at)).toBeGreaterThan(0);
  });

  // Bu testin varlık sebebi somut bir kusur: kolon `formatDateTime(...) AS
  // created_at` diye takma adlanmıştı ve ClickHouse WHERE içindeki
  // `created_at`'i o String takma ada çözüyordu — kesme filtresi
  // "No operation lessOrEquals between String and DateTime64" ile düşüyordu.
  it('kesme anindan sonrakileri eler', async () => {
    const projectId = randomUUID();
    await write(projectId, 'once', '2026-08-18T09:00:00.000Z');
    await write(projectId, 'sonra', '2026-08-18T14:00:00.000Z');
    const rows = await listRecentSummaries(ch, projectId, 10, '2026-08-18T12:00:00.000Z');
    expect(rows.map((row) => row.content)).toEqual(['once']);
  });

  it('gecersiz limiti fail-closed reddeder', async () => {
    await expect(listRecentSummaries(ch, randomUUID(), 0)).rejects.toThrow(/limiti gecersiz/);
    await expect(listRecentSummaries(ch, randomUUID(), 1_001)).rejects.toThrow(/limiti gecersiz/);
  });

  // KOPYA ÖZET MÜHÜRÜ: tablo MergeTree (ReplacingMergeTree DEĞİL) ve
  // summary_id üzerinde benzersizlik yok. Kimlik eskiden createdAt içerdiği
  // için aynı özet her yeniden koşuda FARKLI kimlikle yazılıyordu; bağlam
  // paketi son beş özeti aldığı için kopyalar pencereyi doldurup gerçek
  // geçmişi dışarı itiyordu.
  it('ayni summary_id iki kez yazilirsa okumada bir kez doner', async () => {
    const projectId = randomUUID();
    const summaryId = randomUUID();
    const row = {
      summary_id: summaryId,
      project_id: projectId,
      scope: 'task',
      ref_id: randomUUID(),
      content: 'ayni ozet',
      created_by_agent_id: randomUUID(),
      created_at: '2026-08-31T09:00:00.000Z',
    };
    await ch.insert({ table: 'summaries', values: [row], format: 'JSONEachRow' });
    await ch.insert({ table: 'summaries', values: [row], format: 'JSONEachRow' });

    const rows = await listRecentSummaries(ch, projectId, 10);
    expect(rows.filter((item) => item.summary_id === summaryId)).toHaveLength(1);
  });
});
