import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCh, type ClickHouseClient } from '../client.js';
import { runMigrations } from '../migrate.js';
import { clickhouseUp } from '../testutil.js';
import { getFileIndex, listFileIndex, upsertFileIndex } from './file-index.js';

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
});
