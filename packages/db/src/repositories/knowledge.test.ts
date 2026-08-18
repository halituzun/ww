import { randomUUID } from 'node:crypto';
import { NIL_UUID, canonicalSha256V1 } from '@ww/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCh, type ClickHouseClient } from '../client.js';
import { runMigrations } from '../migrate.js';
import { clickhouseUp } from '../testutil.js';
import {
  appendKnowledgeVersion,
  getKnowledgeAsOf,
  getKnowledgeSourceRefAsOf,
  getLatestKnowledge,
  listKnowledgeIdsBySourceTask,
  listLatestKnowledgeByStatus,
  type AppendKnowledgeVersionInput,
  type KnowledgeRow,
} from './knowledge.js';
import { RepositoryConflictError } from './types.js';

const up = await clickhouseUp();
describe.skipIf(!up)('knowledge repository', () => {
  const db = `ww_test_knowledge_${Date.now()}_${process.pid}`;
  let ch: ClickHouseClient;
  const rowHash = (row: KnowledgeRow): string => canonicalSha256V1([
    row.knowledge_id, row.project_id, row.kind, row.title, row.content,
    [...row.tags], row.source_task_id, row.source_message_id, row.status,
    row.superseded_by, row.created_at, row.observed_at, row.version,
  ]);
  beforeAll(async () => { await runMigrations({ database: db }); ch = createCh({ database: db }); });
  afterAll(async () => {
    const admin = createCh({ database: 'default' });
    await admin.command({ query: `DROP DATABASE IF EXISTS ${db}` });
    await admin.close(); await ch.close();
  });
  const value = (): AppendKnowledgeVersionInput => ({
    knowledge_id: randomUUID(), project_id: randomUUID(), kind: 'decision', title: 'Routing',
    content: 'Workers route directly to PM.', tags: ['communication'], source_task_id: NIL_UUID,
    source_message_id: NIL_UUID, status: 'active', superseded_by: NIL_UUID,
    created_at: '2026-08-14T10:00:00.000Z',
  });

  function concurrentSnapshotClients(): readonly [ClickHouseClient, ClickHouseClient] {
    let capturedReads = 0;
    let releaseReads: (() => void) | undefined;
    const readGate = new Promise<void>((resolve) => { releaseReads = resolve; });
    const wrap = (delayMs: number): ClickHouseClient => new Proxy(ch, {
      get(target, property) {
        if (property === 'query') return async (options: Parameters<ClickHouseClient['query']>[0]) => {
          const result = await target.query(options);
          return new Proxy(result, {
            get(queryResult, queryProperty) {
              if (queryProperty !== 'json') {
                const value: unknown = Reflect.get(queryResult, queryProperty, queryResult);
                return typeof value === 'function' ? value.bind(queryResult) : value;
              }
              return async () => {
                const rows = await queryResult.json<unknown>();
                if (capturedReads < 2) {
                  capturedReads += 1;
                  if (capturedReads === 2) releaseReads?.();
                  await readGate;
                  if (delayMs > 0) {
                    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
                  }
                }
                return rows;
              };
            },
          });
        };
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    return [wrap(0), wrap(15)];
  }

  it('latest, fold-sonrasi status ve as-of source manifest uretir', async () => {
    const initialInput = { ...value(), created_at: '2020-01-01T00:00:00.000Z' };
    const initial = await appendKnowledgeVersion(ch, initialInput);
    const equalTimestamp = await appendKnowledgeVersion(ch, {
      ...initialInput,
      content: 'Equal source timestamp.',
    }, initial.version);
    const next = await appendKnowledgeVersion(ch, {
      ...initialInput,
      content: 'Superseded with backdated source timestamp.',
      status: 'superseded',
      created_at: '2019-01-01T00:00:00.000Z',
    }, equalTimestamp.version);
    await ch.command({ query: 'OPTIMIZE TABLE knowledge FINAL' });
    expect((await getLatestKnowledge(ch, initial.project_id, initial.knowledge_id))?.version).toBe(next.version);
    expect(Date.parse(equalTimestamp.observed_at)).toBeGreaterThan(Date.parse(initial.observed_at));
    expect(Date.parse(next.observed_at)).toBeGreaterThan(Date.parse(equalTimestamp.observed_at));
    expect((await getKnowledgeAsOf(
      ch,
      initial.project_id,
      initial.knowledge_id,
      initial.observed_at,
    ))?.content).toBe(initial.content);
    expect((await getKnowledgeAsOf(
      ch,
      initial.project_id,
      initial.knowledge_id,
      equalTimestamp.observed_at,
    ))?.content).toBe(equalTimestamp.content);
    expect((await getKnowledgeAsOf(
      ch,
      initial.project_id,
      initial.knowledge_id,
      next.observed_at,
    ))?.content).toBe(next.content);
    expect(await listLatestKnowledgeByStatus(ch, initial.project_id, 'active')).toEqual([]);
    expect((await getKnowledgeSourceRefAsOf(
      ch,
      initial.project_id,
      initial.knowledge_id,
      initial.observed_at,
    ))?.sourceType).toBe('knowledge');
  });

  it('same-version divergent tie kaydini readerda reddeder', async () => {
    const row = await appendKnowledgeVersion(ch, value());
    const divergent = { ...row, content: 'divergent' };
    await ch.insert({
      table: 'knowledge',
      values: [{ ...divergent, row_hash: rowHash(divergent) }],
      format: 'JSONEachRow',
    });
    await ch.command({ query: 'OPTIMIZE TABLE knowledge FINAL' });
    await expect(getLatestKnowledge(ch, row.project_id, row.knowledge_id)).rejects.toBeInstanceOf(
      RepositoryConflictError,
    );
  });

  it('concurrent identical create/append observed farklarini katlar ve future created_at zamani yonetmez', async () => {
    const input = {
      ...value(),
      created_at: '2099-01-01T00:00:00.000Z',
    };
    const createClients = concurrentSnapshotClients();
    const created = await Promise.all([
      appendKnowledgeVersion(createClients[0], input),
      appendKnowledgeVersion(createClients[1], input),
    ]);
    await ch.command({ query: 'OPTIMIZE TABLE knowledge FINAL' });
    const initial = await getLatestKnowledge(ch, input.project_id, input.knowledge_id);
    expect(initial).not.toBeNull();
    expect(initial?.version).toBe('1');
    expect(Date.parse(initial!.observed_at)).toBeLessThan(Date.parse(input.created_at));
    expect(created.map((row) => row.version)).toEqual(['1', '1']);

    const appendInput = { ...input, content: 'Concurrent identical update.' };
    const appendClients = concurrentSnapshotClients();
    const appended = await Promise.all([
      appendKnowledgeVersion(appendClients[0], appendInput, initial!.version),
      appendKnowledgeVersion(appendClients[1], appendInput, initial!.version),
    ]);
    await ch.command({ query: 'OPTIMIZE TABLE knowledge FINAL' });
    const latest = await getLatestKnowledge(ch, input.project_id, input.knowledge_id);
    expect(latest?.version).toBe('2');
    expect(latest?.content).toBe(appendInput.content);
    expect(appended.map((row) => row.version)).toEqual(['2', '2']);
    expect((await getKnowledgeAsOf(
      ch,
      input.project_id,
      input.knowledge_id,
      initial!.observed_at,
    ))?.content).toBe(initial!.content);
    expect(await appendKnowledgeVersion(ch, appendInput, initial!.version)).toEqual(latest);

    const physicalResult = await ch.query({
      query: `SELECT toString(version) AS version, count() AS count,
          toString(uniqExact(observed_at)) AS observed_count
        FROM knowledge WHERE knowledge_id = {knowledgeId:UUID}
        GROUP BY version ORDER BY version`,
      query_params: { knowledgeId: input.knowledge_id },
      format: 'JSONEachRow',
    });
    expect(await physicalResult.json()).toEqual([
      { version: '1', count: '2', observed_count: '2' },
      { version: '2', count: '2', observed_count: '2' },
    ]);
  });

  it('gec gelen erken identical kopya canonical rowu degistirse de source hashini sabit tutar', async () => {
    const initial = await appendKnowledgeVersion(ch, value());
    const before = await getKnowledgeSourceRefAsOf(
      ch,
      initial.project_id,
      initial.knowledge_id,
      initial.observed_at,
    );
    const earlier = {
      ...initial,
      observed_at: new Date(Date.parse(initial.observed_at) - 1).toISOString(),
    };
    await ch.insert({
      table: 'knowledge',
      values: [{ ...earlier, row_hash: rowHash(earlier) }],
      format: 'JSONEachRow',
    });
    await ch.command({ query: 'OPTIMIZE TABLE knowledge FINAL' });

    const canonical = await getLatestKnowledge(ch, initial.project_id, initial.knowledge_id);
    const after = await getKnowledgeSourceRefAsOf(
      ch,
      initial.project_id,
      initial.knowledge_id,
      initial.observed_at,
    );
    expect(canonical?.observed_at).toBe(earlier.observed_at);
    expect(after).toEqual(before);
  });

  it('knowledge exact retryini direction-aware expectedVersion ile ayirir', async () => {
    const input = value();
    const initial = await appendKnowledgeVersion(ch, input);
    expect(await appendKnowledgeVersion(ch, input)).toEqual(initial);
    const nextInput = {
      ...input,
      content: 'Updated decision.',
      created_at: '2026-08-14T11:00:00.000Z',
    };
    const updated = await appendKnowledgeVersion(ch, nextInput, initial.version);
    expect(await appendKnowledgeVersion(ch, nextInput, initial.version)).toEqual(updated);
    await expect(appendKnowledgeVersion(
      ch,
      nextInput,
      (BigInt(updated.version) + 1n).toString(),
    )).rejects.toBeInstanceOf(RepositoryConflictError);
  });

  it('legacy epoch observed_at kaydini created_at effective zamaniyla okur', async () => {
    const input = value();
    await ch.insert({
      table: 'knowledge',
      values: [{ ...input, version: '1' }],
      format: 'JSONEachRow',
    });
    expect(await getKnowledgeAsOf(
      ch,
      input.project_id,
      input.knowledge_id,
      '2026-08-14T09:59:59.999Z',
    )).toBeNull();
    const legacy = await getKnowledgeAsOf(
      ch,
      input.project_id,
      input.knowledge_id,
      input.created_at,
    );
    expect(legacy?.observed_at).toBe(input.created_at);
  });

// docs/08 fihristi "Kararlar: [K-12 …]" satırını gösterir ama
// `file_index.related_knowledge_ids` canlı veride HER SATIRDA boştu:
// kolon ve panel satırı vardı, dolduran yer yoktu. Bağ, kararın zaten
// taşıdığı `source_task_id` üzerinden kurulur.
describe('listKnowledgeIdsBySourceTask', () => {
  it('gorevin dogurdugu kararlari dondurur, baskasininkini dondurmez', async () => {
    const projectId = randomUUID();
    const taskId = randomUUID();
    const otherTaskId = randomUUID();
    const mine = randomUUID();
    const at = '2026-08-18T09:00:00.000Z';
    const row = (knowledgeId: string, sourceTaskId: string) => ({
      knowledge_id: knowledgeId, project_id: projectId, kind: 'decision' as const,
      title: 'karar', content: 'içerik', tags: [],
      source_task_id: sourceTaskId, source_message_id: NIL_UUID,
      status: 'active' as const, superseded_by: NIL_UUID, created_at: at, row_hash: '',
    });
    await appendKnowledgeVersion(ch, row(mine, taskId) as never);
    await appendKnowledgeVersion(ch, row(randomUUID(), otherTaskId) as never);

    expect(await listKnowledgeIdsBySourceTask(ch, projectId, taskId)).toEqual([mine]);
  });

  it('karar yoksa bos dizi doner', async () => {
    expect(await listKnowledgeIdsBySourceTask(ch, randomUUID(), randomUUID())).toEqual([]);
  });
});
});
