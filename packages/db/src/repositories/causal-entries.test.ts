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

  it('fresh exact retry hazirlanmis stale causal yazisini fence ile ezer', async () => {
    const staleInput = input({ lease_fence: '2' });
    let stalePrepared: (() => void) | undefined;
    let releaseStale: (() => void) | undefined;
    const prepared = new Promise<void>((resolve) => { stalePrepared = resolve; });
    const release = new Promise<void>((resolve) => { releaseStale = resolve; });
    const delayed = new Proxy(ch, {
      get(target, property) {
        if (property === 'insert') return async (options: Parameters<ClickHouseClient['insert']>[0]) => {
          if (options.table === 'task_causal_entries') {
            stalePrepared?.();
            await release;
          }
          return target.insert(options);
        };
        const member: unknown = Reflect.get(target, property, target);
        return typeof member === 'function' ? member.bind(target) : member;
      },
    });
    const staleWrite = appendTaskCausalEntry(delayed, staleInput);
    await prepared;
    const fresh = await appendTaskCausalEntry(ch, { ...staleInput, lease_fence: '3' });
    releaseStale?.();

    await expect(staleWrite).resolves.toEqual(fresh);
    await expect(appendTaskCausalEntry(ch, { ...staleInput, lease_fence: '4' }))
      .resolves.toMatchObject({ entry_id: fresh.entry_id, ordinal: 0, lease_fence: '4' });
    await ch.command({ query: 'OPTIMIZE TABLE task_causal_entries FINAL' });
    expect(await listTaskCausalEntries(ch, fresh.task_id, fresh.assignment_attempt_id))
      .toMatchObject([{ entry_id: fresh.entry_id, ordinal: 0, lease_fence: '4' }]);
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

  it('exact entry retryda en yuksek fence kazanir; farkli ordinal sahibi her fencede fail-closed olur', async () => {
    const first = await appendTaskCausalEntry(ch, input());
    await ch.insert({
      table: 'task_causal_entries',
      values: [{ ...first, lease_fence: '2' }],
      format: 'JSONEachRow',
    });
    expect(await listTaskCausalEntries(ch, first.task_id, first.assignment_attempt_id))
      .toMatchObject([{ entry_id: first.entry_id, ordinal: 0, lease_fence: '2' }]);

    const lowerFenceCompeting = {
      ...first,
      entry_id: randomUUID(),
      source_id: randomUUID(),
      lease_fence: '1',
    };
    await ch.insert({
      table: 'task_causal_entries',
      values: [lowerFenceCompeting],
      format: 'JSONEachRow',
    });
    await expect(listTaskCausalEntries(ch, first.task_id, first.assignment_attempt_id))
      .rejects.toBeInstanceOf(RepositoryConflictError);

    await ch.command({ query: 'OPTIMIZE TABLE task_causal_entries FINAL' });
    await expect(listTaskCausalEntries(ch, first.task_id, first.assignment_attempt_id))
      .rejects.toBeInstanceOf(RepositoryConflictError);
  });

  it('exact logical entry farkli fiziksel sirada en yuksek fence ile order-independent katlanir', async () => {
    const entries = [];
    for (const highFirst of [false, true]) {
      const base = await appendTaskCausalEntry(ch, input());
      const high = { ...base, lease_fence: '9' };
      await ch.insert({
        table: 'task_causal_entries',
        values: highFirst ? [high, base] : [base, high],
        format: 'JSONEachRow',
      });
      entries.push(base);
      await expect(listTaskCausalEntries(ch, base.task_id, base.assignment_attempt_id))
        .resolves.toMatchObject([{ entry_id: base.entry_id, ordinal: 0, lease_fence: '9' }]);
    }

    await ch.command({ query: 'OPTIMIZE TABLE task_causal_entries FINAL' });
    for (const base of entries) {
      await expect(listTaskCausalEntries(ch, base.task_id, base.assignment_attempt_id))
        .resolves.toMatchObject([{ entry_id: base.entry_id, ordinal: 0, lease_fence: '9' }]);
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
