import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendKnowledgeVersion, clickhouseUp, createCh, createTask, runMigrations, type ClickHouseClient } from '@ww/db';
import { MemoryService } from '@ww/memory';
import { NIL_UUID } from '@ww/shared';
import { seedStandardKnowledge } from './standard-knowledge.js';

const up = await clickhouseUp();

// KABUL: tohumlamanın değeri, standartların gerçekten worker prompt'una
// girmesidir. Satırı yazıp Context Builder'ın onu almadığını görmek,
// hiç yazmamakla aynı kapıya çıkar.
describe.skipIf(!up)('standartlar bağlam paketine girer', () => {
  const db = `ww_test_std_knowledge_${Date.now()}_${process.pid}`;
  let ch: ClickHouseClient;

  beforeAll(async () => { await runMigrations({ database: db }); ch = createCh({ database: db }); });
  afterAll(async () => {
    const admin = createCh({ database: 'default' });
    await admin.command({ query: `DROP DATABASE IF EXISTS ${db}` });
    await admin.close();
    await ch.close();
  });

  it('tohumlanan standartlar context pack icinde gorunur', async () => {
    const projectId = randomUUID();
    const taskId = randomUUID();
    const at = '2026-08-18T09:00:00.000Z';
    const cutoffAt = new Date(Date.now() + 1_000).toISOString();
    await createTask(ch, {
      task_id: taskId, project_id: projectId, plan_id: randomUUID(),
      parent_task_id: NIL_UUID, title: 'Tahta bileşeni', description: 'satranç tahtası',
      acceptance_criteria: ['render eder'], status: 'queued', priority: 0,
      issuer_agent_id: randomUUID(), worker_agent_id: NIL_UUID,
      verifier_agent_id: NIL_UUID, group: 'coding', depends_on: [],
      target_files: ['src/Board.tsx'], attempt: 0, max_attempts: 3,
      delegation_depth: 0, token_budget: 0, tokens_spent: 0, commit_hash: '',
      result_summary: '', reject_reason: '', task_brief_id: NIL_UUID,
      assignment_attempt_id: NIL_UUID, created_at: at, updated_at: at,
    } as never);

    await seedStandardKnowledge(
      { appendKnowledgeVersion: (row) => appendKnowledgeVersion(ch, row as never) },
      projectId as never,
      at,
    );

    const pack = await new MemoryService(ch).buildContextPack({
      projectId: projectId as never, taskId: taskId as never,
      cutoffAt, tokenBudget: 8_000,
    });

    const labels = pack.chunks.map((chunk) => chunk.label).join(' ');
    expect(labels).toContain('knowledge:standard');
    expect(pack.chunks.map((chunk) => chunk.text).join('\n')).toContain('ViewModel');
  });
});
