import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCh, type ClickHouseClient } from '../client.js';
import { runMigrations } from '../migrate.js';
import { clickhouseUp } from '../testutil.js';
import { getFileIndex, listFileIndex, listFileIndexByPathsAsOf, upsertFileIndex } from './file-index.js';

const up = await clickhouseUp();
describe.skipIf(!up)('file index repository', () => {
  const db = `ww_test_file_index_${Date.now()}_${process.pid}`;
  let ch: ClickHouseClient;
  beforeAll(async () => { await runMigrations({ database: db }); ch = createCh({ database: db }); });
  afterAll(async () => { const admin = createCh({ database: 'default' }); await admin.command({ query: `DROP DATABASE IF EXISTS ${db}` }); await admin.close(); await ch.close(); });

  it('upsert eder, idempotent retryyi fold eder ve file_index ile memory kaynaklanir', async () => {
    const projectId = randomUUID();
    const input = { project_id: projectId, file_path: 'src/App.tsx', summary: 'panel ana görünümü', layer: 'view' as const, exports: ['App'], related_task_ids: [], related_artifact_ids: [], related_knowledge_ids: [], last_commit_hash: 'abc', updated_at: new Date().toISOString() };
    const first = await upsertFileIndex(ch, input);
    const second = await upsertFileIndex(ch, input);
    expect(second.file_path).toBe(first.file_path);
    expect(second.version).toBe(first.version);
    expect(second.change_count).toBe(first.change_count);
    expect((await listFileIndex(ch, projectId))).toHaveLength(1);
    expect(await getFileIndex(ch, projectId, input.file_path)).toEqual(second);
  });

  // PENCERE HATASININ MÜHÜRÜ: hedef dosyalar eskiden
  // `listFileIndexAsOf(..., limit = hedefSayisi * 2)` ile çekilip sonra
  // filtreleniyordu. O sorgu `ORDER BY file_path LIMIT n` olduğu için
  // projenin ALFABETİK İLK n satırı geliyordu; alfabetik sonda duran hedef
  // dosyalar o pencereye HİÇ düşmüyordu ve bağlama sessizce girmiyordu.
  it('hedef dosyayi alfabetik konumdan BAGIMSIZ getirir', async () => {
    const projectId = randomUUID();
    const now = new Date().toISOString();
    const base = {
      project_id: projectId, summary: 'dosya', layer: 'view' as const,
      exports: [], related_task_ids: [], related_artifact_ids: [],
      related_knowledge_ids: [], last_commit_hash: 'abc', updated_at: now,
    };
    // Yirmi alfabetik ÖNCE gelen dosya; hedef en sonda.
    for (const letter of 'abcdefghijklmnopqrst') {
      await upsertFileIndex(ch, { ...base, file_path: `src/${letter}.ts` });
    }
    await upsertFileIndex(ch, { ...base, file_path: 'src/zzz-hedef.ts', summary: 'hedef dosya' });

    const rows = await listFileIndexByPathsAsOf(
      ch, projectId, new Date(Date.now() + 60_000).toISOString(), ['src/zzz-hedef.ts'],
    );
    expect(rows.map((row) => row.file_path)).toEqual(['src/zzz-hedef.ts']);
    expect(rows[0]?.summary).toBe('hedef dosya');
  });

  it('bos yol listesinde sorgu yapmaz', async () => {
    expect(await listFileIndexByPathsAsOf(ch, randomUUID(), new Date().toISOString(), []))
      .toEqual([]);
  });
});
