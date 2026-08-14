import { randomUUID } from 'node:crypto';
import { NIL_UUID } from '@ww/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCh, type ClickHouseClient } from '../client.js';
import { runMigrations } from '../migrate.js';
import { clickhouseUp } from '../testutil.js';
import {
  appendTaskCausalEntry,
  deterministicCausalEntryId,
  getTaskCausalEntry,
  getTaskCausalCursor,
  listTaskCausalEntries,
  type AppendTaskCausalEntryInput,
} from './causal-entries.js';
import { RepositoryConflictError } from './types.js';

const up = await clickhouseUp();

describe.skipIf(!up)('task causal entries repository', () => {
  const db = `ww_test_causal_${Date.now()}_${process.pid}`;
  let ch: ClickHouseClient;
  beforeAll(async () => {
    await runMigrations({ database: db });
    ch = createCh({ database: db });
  });
  afterAll(async () => {
    const admin = createCh({ database: 'default' });
    await admin.command({ query: `DROP DATABASE IF EXISTS ${db}` });
    await admin.close();
    await ch.close();
  });

  function input(overrides: Partial<AppendTaskCausalEntryInput> = {}): AppendTaskCausalEntryInput {
    return {
      task_id: randomUUID(), task_brief_id: randomUUID(), assignment_attempt_id: randomUUID(),
      handoff_id: NIL_UUID, source_type: 'message', source_id: randomUUID(),
      causation_id: NIL_UUID, lease_fence: '1', created_at: new Date().toISOString(), ...overrides,
    };
  }

  it('deterministic retryyi tek logical entryye katlar ve ordinal siralar', async () => {
    const firstInput = input();
    const first = await appendTaskCausalEntry(ch, firstInput);
    expect(await appendTaskCausalEntry(ch, firstInput)).toEqual(first);
    await ch.insert({ table: 'task_causal_entries', values: [first], format: 'JSONEachRow' });
    const second = await appendTaskCausalEntry(ch, input({
      task_id: first.task_id, task_brief_id: first.task_brief_id,
      assignment_attempt_id: first.assignment_attempt_id, source_id: randomUUID(),
    }));
    expect([first.ordinal, second.ordinal]).toEqual([0, 1]);
    expect(await listTaskCausalEntries(ch, first.task_id, first.assignment_attempt_id)).toHaveLength(2);
    expect((await getTaskCausalCursor(ch, first.task_id, first.assignment_attempt_id))?.ordinal).toBe(1);
    expect(deterministicCausalEntryId(firstInput)).toBe(first.entry_id);
  });

  it('read path ayni ordinalde farkli entry kimligini fail-closed reddeder', async () => {
    const base = await appendTaskCausalEntry(ch, input());
    await ch.insert({
      table: 'task_causal_entries',
      values: [{ ...base, entry_id: randomUUID(), source_id: randomUUID() }],
      format: 'JSONEachRow',
    });
    await expect(listTaskCausalEntries(ch, base.task_id, base.assignment_attempt_id)).rejects.toBeInstanceOf(
      RepositoryConflictError,
    );
  });

  it('exact retry entry kimligi dogru olsa da ordinal sahibini yeniden dogrular', async () => {
    const firstInput = input();
    const first = await appendTaskCausalEntry(ch, firstInput);
    await ch.insert({
      table: 'task_causal_entries',
      values: [{ ...first, entry_id: randomUUID(), source_id: randomUUID() }],
      format: 'JSONEachRow',
    });

    await expect(appendTaskCausalEntry(ch, firstInput)).rejects.toBeInstanceOf(
      RepositoryConflictError,
    );
    await expect(getTaskCausalEntry(
      ch,
      first.task_id,
      first.assignment_attempt_id,
      first.entry_id,
    )).rejects.toBeInstanceOf(RepositoryConflictError);
  });

  it('exact retry entry ve ordinal namespaceini tek snapshotta okuyarak aradaki pencereyi kapatir', async () => {
    const firstInput = input();
    const first = await appendTaskCausalEntry(ch, firstInput);
    let injected = false;
    const atomic = new Proxy(ch, {
      get(target, property) {
        if (property === 'query') return async (options: Parameters<ClickHouseClient['query']>[0]) => {
          const query = String(options.query);
          if (!injected && (
            query.includes('ORDER BY ordinal ASC, entry_id ASC') ||
            query.includes('AND ordinal = {ordinal:UInt64}')
          )) {
            injected = true;
            await target.insert({
              table: 'task_causal_entries',
              values: [{ ...first, ordinal: first.ordinal + 1 }],
              format: 'JSONEachRow',
            });
          }
          return target.query(options);
        };
        const member: unknown = Reflect.get(target, property, target);
        return typeof member === 'function' ? member.bind(target) : member;
      },
    });

    await expect(appendTaskCausalEntry(atomic, firstInput)).rejects.toBeInstanceOf(
      RepositoryConflictError,
    );
    expect(injected).toBe(true);
  });

  it('ambiguous attempt streaminden next ordinal ayirmaz veya yeni entry yazmaz', async () => {
    for (const ambiguity of ['entry_id', 'ordinal'] as const) {
      const first = await appendTaskCausalEntry(ch, input());
      await ch.insert({
        table: 'task_causal_entries',
        values: [ambiguity === 'entry_id'
          ? { ...first, lease_fence: '2' }
          : { ...first, entry_id: randomUUID(), source_id: randomUUID() }],
        format: 'JSONEachRow',
      });
      const nextInput = input({
        task_id: first.task_id,
        task_brief_id: first.task_brief_id,
        assignment_attempt_id: first.assignment_attempt_id,
      });
      const nextEntryId = deterministicCausalEntryId(nextInput);

      await expect(appendTaskCausalEntry(ch, nextInput)).rejects.toBeInstanceOf(
        RepositoryConflictError,
      );
      const result = await ch.query({
        query: `SELECT count() AS count FROM task_causal_entries
          WHERE task_id = {taskId:UUID}
            AND assignment_attempt_id = {assignmentAttemptId:UUID}
            AND entry_id = {entryId:UUID}`,
        query_params: {
          taskId: first.task_id,
          assignmentAttemptId: first.assignment_attempt_id,
          entryId: nextEntryId,
        },
        format: 'JSONEachRow',
      });
      expect(await result.json()).toEqual([{ count: '0' }]);
    }
  });

  it('uncertain insert sonrasi ordinal catismasini write errora cevirmeden korur', async () => {
    const value = input();
    const uncertain = new Proxy(ch, {
      get(target, property) {
        if (property === 'insert') return async (options: Parameters<ClickHouseClient['insert']>[0]) => {
          await target.insert(options);
          await target.insert({
            table: 'task_causal_entries',
            values: [{
              ...value,
              ordinal: 0,
              entry_id: randomUUID(),
              source_id: randomUUID(),
            }],
            format: 'JSONEachRow',
          });
          throw new Error('simulated timeout after accept');
        };
        const member: unknown = Reflect.get(target, property, target);
        return typeof member === 'function' ? member.bind(target) : member;
      },
    });

    await expect(appendTaskCausalEntry(uncertain, value)).rejects.toBeInstanceOf(
      RepositoryConflictError,
    );
  });

  it('partial namespace divergenceini uncertain veya acknowledged write olarak gizlemez', async () => {
    for (const mode of ['uncertain', 'acknowledged'] as const) {
      const value = input();
      const divergent = {
        ...value,
        ordinal: 1,
        entry_id: deterministicCausalEntryId(value),
      };
      const partial = new Proxy(ch, {
        get(target, property) {
          if (property === 'insert') return async () => {
            await target.insert({
              table: 'task_causal_entries',
              values: [divergent],
              format: 'JSONEachRow',
            });
            if (mode === 'uncertain') throw new Error('simulated partial insert timeout');
          };
          const member: unknown = Reflect.get(target, property, target);
          return typeof member === 'function' ? member.bind(target) : member;
        },
      });

      await expect(appendTaskCausalEntry(partial, value)).rejects.toBeInstanceOf(
        RepositoryConflictError,
      );
    }
  });
});
