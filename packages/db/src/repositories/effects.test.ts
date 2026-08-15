import { randomUUID } from 'node:crypto';
import type { ClickHouseClient } from '@clickhouse/client';
import { NIL_UUID, canonicalSha256V1 } from '@ww/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCh } from '../client.js';
import { runMigrations } from '../migrate.js';
import { clickhouseUp } from '../testutil.js';
import {
  appendEffectVersion,
  getLatestEffect,
  listLatestEffectsByState,
  listLatestTaskEffectsByStates,
  reserveEffect,
  type ReserveEffectInput,
} from './effects.js';
import { RepositoryConflictError, StoredRecordError } from './types.js';

const up = await clickhouseUp();

function throwAfterAcceptedInsert(ch: ClickHouseClient): ClickHouseClient {
  return {
    query: ch.query.bind(ch),
    insert: async (options: Parameters<ClickHouseClient['insert']>[0]) => {
      await ch.insert(options);
      throw new Error('simulated timeout after accepted insert');
    },
  } as unknown as ClickHouseClient;
}

describe.skipIf(!up)('effects repository', () => {
  const db = `ww_test_effects_${Date.now()}_${process.pid}`;
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

  function effect(overrides: Partial<ReserveEffectInput> = {}): ReserveEffectInput {
    return {
      causation_id: randomUUID(),
      stable_effect_id: `provider-completion:${randomUUID()}`,
      project_id: randomUUID(),
      effect_type: 'provider_completion',
      request: { messages: [{ content: 'hello', role: 'user' }] },
      replay_safety: 'non_replay_safe',
      lease_fence: '1',
      created_at: '2026-08-14T15:00:00+03:00',
      ...overrides,
    };
  }

  it('reserve/append uncertain insertlerini aynı key/hash/version ile uzlaştırır', async () => {
    const input = effect();
    const pending = await reserveEffect(throwAfterAcceptedInsert(ch), input);
    expect(pending.created_at).toBe('2026-08-14T12:00:00.000Z');
    expect(pending.request_hash).toBe(canonicalSha256V1(input.request));
    expect(await reserveEffect(ch, input)).toEqual(pending);

    const completionInput = {
      causation_id: pending.causation_id,
      stable_effect_id: pending.stable_effect_id,
      expectedVersion: pending.effect_version,
      state: 'succeeded' as const,
      result: { invocationId: randomUUID(), text: 'done' },
      error: '',
      lease_fence: '1',
      created_at: '2026-08-14T15:01:00+03:00',
    };
    const completed = await appendEffectVersion(throwAfterAcceptedInsert(ch), completionInput);
    expect(await appendEffectVersion(ch, completionInput)).toEqual(completed);
    expect(await listLatestEffectsByState(ch, input.project_id, 'pending')).toEqual([]);
    expect(await listLatestEffectsByState(ch, input.project_id, 'succeeded')).toEqual([completed]);
  });

  it('aynı causation/effect key için farklı request hashini reddeder', async () => {
    const input = effect();
    await reserveEffect(ch, input);
    await expect(reserveEffect(ch, { ...input, request: { messages: [] } }))
      .rejects.toBeInstanceOf(RepositoryConflictError);
  });

  it('fresh exact retry hazirlanmis stale effect yazisini fence ile ezer', async () => {
    const reservation = effect();
    const staleReservation = await reserveEffect(ch, reservation);
    const pending = await reserveEffect(ch, { ...reservation, lease_fence: '2' });
    expect(pending).toMatchObject({
      effect_version: staleReservation.effect_version,
      lease_fence: '2',
    });
    let stalePrepared: (() => void) | undefined;
    let releaseStale: (() => void) | undefined;
    const prepared = new Promise<void>((resolve) => { stalePrepared = resolve; });
    const release = new Promise<void>((resolve) => { releaseStale = resolve; });
    const delayed = new Proxy(ch, {
      get(target, property) {
        if (property === 'insert') return async (options: Parameters<ClickHouseClient['insert']>[0]) => {
          if (options.table === 'effect_ledger') {
            stalePrepared?.();
            await release;
          }
          return target.insert(options);
        };
        const member: unknown = Reflect.get(target, property, target);
        return typeof member === 'function' ? member.bind(target) : member;
      },
    });
    const common = {
      causation_id: pending.causation_id,
      stable_effect_id: pending.stable_effect_id,
      expectedVersion: pending.effect_version,
      created_at: '2026-08-14T12:03:00.000Z',
    };
    const staleWrite = appendEffectVersion(delayed, {
      ...common,
      state: 'uncertain',
      result: {},
      error: 'stale timeout',
      lease_fence: '2',
    });
    await prepared;
    const fresh = await appendEffectVersion(ch, {
      ...common,
      state: 'succeeded',
      result: { accepted: true },
      error: '',
      lease_fence: '3',
    });
    releaseStale?.();

    await expect(staleWrite).resolves.toEqual(fresh);
    await expect(getLatestEffect(ch, pending.causation_id, pending.stable_effect_id))
      .resolves.toEqual(fresh);
    expect(await listLatestEffectsByState(ch, pending.project_id, 'uncertain')).toEqual([]);
  });

  it('stale effect once inerse fresh exact retry ayni versioni yuksek fence ile duzeltir', async () => {
    const pending = await reserveEffect(ch, effect());
    const common = {
      causation_id: pending.causation_id,
      stable_effect_id: pending.stable_effect_id,
      expectedVersion: pending.effect_version,
      created_at: '2026-08-14T12:04:00.000Z',
    };
    const stale = await appendEffectVersion(ch, {
      ...common,
      state: 'uncertain',
      result: {},
      error: 'stale landed first',
      lease_fence: '2',
    });
    const fresh = await appendEffectVersion(ch, {
      ...common,
      state: 'succeeded',
      result: { accepted: true },
      error: '',
      lease_fence: '3',
    });

    expect(fresh).toMatchObject({
      effect_version: stale.effect_version,
      lease_fence: '3',
      state: 'succeeded',
    });
    await expect(getLatestEffect(ch, pending.causation_id, pending.stable_effect_id))
      .resolves.toEqual(fresh);
  });

  it('latest aynı-version divergent effect satırını reddeder', async () => {
    const pending = await reserveEffect(ch, effect());
    await ch.insert({
      table: 'effect_ledger',
      values: [{
        causation_id: pending.causation_id,
        stable_effect_id: pending.stable_effect_id,
        project_id: pending.project_id,
        task_id: NIL_UUID,
        assignment_attempt_id: NIL_UUID,
        effect_type: pending.effect_type,
        request_hash: pending.request_hash,
        replay_safety: pending.replay_safety,
        state: 'failed',
        result_json: '{}',
        error: 'divergent',
        effect_version: pending.effect_version,
        lease_fence: pending.lease_fence,
        created_at: pending.created_at,
      }],
      format: 'JSONEachRow',
    });
    await expect(getLatestEffect(ch, pending.causation_id, pending.stable_effect_id))
      .rejects.toBeInstanceOf(RepositoryConflictError);
  });

  it('ayni effect versioninda en yuksek lease fence fiziksel sira ve OPTIMIZE sonrasi kazanir', async () => {
    const written: Array<{
      readonly causationId: string;
      readonly stableEffectId: string;
    }> = [];
    for (const staleLandsLast of [false, true]) {
      const pending = await reserveEffect(ch, effect());
      written.push({
        causationId: pending.causation_id,
        stableEffectId: pending.stable_effect_id,
      });
      const nextVersion = (BigInt(pending.effect_version) + 1n).toString();
      const fresh = {
        causation_id: pending.causation_id,
        stable_effect_id: pending.stable_effect_id,
        project_id: pending.project_id,
        task_id: pending.task_id,
        assignment_attempt_id: pending.assignment_attempt_id,
        effect_type: pending.effect_type,
        request_hash: pending.request_hash,
        replay_safety: pending.replay_safety,
        state: 'succeeded',
        result_json: '{"accepted":true}',
        error: '',
        effect_version: nextVersion,
        lease_fence: '3',
        created_at: '2026-08-14T12:02:00.000Z',
      };
      const stale = {
        ...fresh,
        state: 'uncertain',
        result_json: '{}',
        error: 'late stale writer',
        lease_fence: '2',
      };
      await ch.insert({
        table: 'effect_ledger',
        values: staleLandsLast ? [fresh, stale] : [stale, fresh],
        format: 'JSONEachRow',
      });

      expect(await getLatestEffect(ch, pending.causation_id, pending.stable_effect_id))
        .toMatchObject({ state: 'succeeded', result: { accepted: true }, lease_fence: '3' });
      expect(await listLatestEffectsByState(ch, pending.project_id, 'uncertain')).toEqual([]);
      expect(await listLatestEffectsByState(ch, pending.project_id, 'succeeded'))
        .toContainEqual(expect.objectContaining({
          causation_id: pending.causation_id,
          lease_fence: '3',
        }));
    }

    await ch.command({ query: 'OPTIMIZE TABLE effect_ledger FINAL' });
    for (const identity of written) {
      expect(await getLatestEffect(ch, identity.causationId, identity.stableEffectId))
        .toMatchObject({ state: 'succeeded', result: { accepted: true }, lease_fence: '3' });
    }
  });

  it('bozuk result JSON kaydını sızdırmaz', async () => {
    const input = effect();
    await ch.insert({
      table: 'effect_ledger',
      values: [{
        causation_id: input.causation_id,
        stable_effect_id: input.stable_effect_id,
        project_id: input.project_id,
        task_id: NIL_UUID,
        assignment_attempt_id: NIL_UUID,
        effect_type: input.effect_type,
        request_hash: canonicalSha256V1(input.request),
        replay_safety: input.replay_safety,
        state: 'pending',
        result_json: '{bad-json',
        error: '',
        effect_version: '1',
        lease_fence: '1',
        created_at: input.created_at,
      }],
      format: 'JSONEachRow',
    });
    await expect(getLatestEffect(ch, input.causation_id, input.stable_effect_id))
      .rejects.toBeInstanceOf(StoredRecordError);
  });

  it('task-scoped unresolved sorgusu fiziksel historyyi SQLde latest adaylara indirger', async () => {
    const projectId = randomUUID();
    const taskId = randomUUID();
    const otherTaskId = randomUUID();
    const target = effect({ project_id: projectId, task_id: taskId });
    const requestHash = canonicalSha256V1(target.request);
    const targetRows = Array.from({ length: 200 }, (_, index) => ({
      causation_id: target.causation_id,
      stable_effect_id: target.stable_effect_id,
      project_id: projectId,
      task_id: taskId,
      assignment_attempt_id: NIL_UUID,
      effect_type: target.effect_type,
      request_hash: requestHash,
      replay_safety: target.replay_safety,
      state: index === 199 ? 'uncertain' : 'succeeded',
      result_json: '{}',
      error: index === 199 ? 'latest timeout' : '',
      effect_version: String(index + 1),
      lease_fence: '7',
      created_at: target.created_at,
    }));
    const unrelatedRows = Array.from({ length: 200 }, (_, index) => {
      const unrelated = effect({ project_id: projectId, task_id: otherTaskId });
      return {
        causation_id: unrelated.causation_id,
        stable_effect_id: unrelated.stable_effect_id,
        project_id: projectId,
        task_id: otherTaskId,
        assignment_attempt_id: NIL_UUID,
        effect_type: unrelated.effect_type,
        request_hash: canonicalSha256V1(unrelated.request),
        replay_safety: unrelated.replay_safety,
        state: 'pending',
        result_json: '{}',
        error: '',
        effect_version: '1',
        lease_fence: String(index + 100),
        created_at: unrelated.created_at,
      };
    });
    await ch.insert({
      table: 'effect_ledger',
      values: [...targetRows, ...unrelatedRows],
      format: 'JSONEachRow',
    });

    let observedQuery = '';
    const observed = new Proxy(ch, {
      get(targetClient, property) {
        if (property === 'query') return (options: Parameters<ClickHouseClient['query']>[0]) => {
          observedQuery = String(options.query);
          return targetClient.query(options);
        };
        const member: unknown = Reflect.get(targetClient, property, targetClient);
        return typeof member === 'function' ? member.bind(targetClient) : member;
      },
    });
    const unresolved = await listLatestTaskEffectsByStates(
      observed,
      taskId,
      ['pending', 'uncertain'],
    );
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]).toMatchObject({
      task_id: taskId,
      state: 'uncertain',
      effect_version: '200',
      lease_fence: '7',
    });
    expect(observedQuery).toContain('WHERE task_id = {taskId:UUID}');
    expect(observedQuery).toContain('max(effect_version) OVER');
    expect(observedQuery).toContain('max(lease_fence) OVER');
    expect(observedQuery).not.toContain('WHERE project_id');
  });

  it('task effect projection cok granullu veride primary-key pruning uygular', async () => {
    const projectId = randomUUID();
    const taskId = '88888888-8888-4888-8888-888888888888';
    const beforeTaskId = '11111111-1111-4111-8111-111111111111';
    const afterTaskId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const requestHash = canonicalSha256V1({ projection: 'pruning' });
    const physical = Array.from({ length: 18_001 }, (_, index) => ({
      causation_id: randomUUID(),
      stable_effect_id: `projection-pruning:${index}`,
      project_id: projectId,
      task_id: index === 9_000 ? taskId : index < 9_000 ? beforeTaskId : afterTaskId,
      assignment_attempt_id: NIL_UUID,
      effect_type: 'projection_pruning',
      request_hash: requestHash,
      replay_safety: 'replay_safe',
      state: index === 9_000 ? 'uncertain' : 'succeeded',
      result_json: '{}',
      error: index === 9_000 ? 'target' : '',
      effect_version: '1',
      lease_fence: '17',
      created_at: '2026-08-14T12:00:00.000Z',
    }));
    await ch.insert({ table: 'effect_ledger', values: physical, format: 'JSONEachRow' });

    expect(await listLatestTaskEffectsByStates(ch, taskId, ['uncertain']))
      .toMatchObject([{ task_id: taskId, lease_fence: '17', error: 'target' }]);
    const explanation = await ch.query({
      query: `EXPLAIN indexes = 1
        SELECT causation_id FROM
        (
          SELECT *, max(lease_fence) OVER
            (PARTITION BY causation_id, stable_effect_id) AS maximum_lease_fence
          FROM
          (
            SELECT *, max(effect_version) OVER
              (PARTITION BY causation_id, stable_effect_id) AS maximum_effect_version
            FROM task_effect_ledger
            PREWHERE task_id = {taskId:UUID}
          )
          WHERE effect_version = maximum_effect_version
        )
        WHERE lease_fence = maximum_lease_fence`,
      query_params: { taskId },
      format: 'JSONEachRow',
    });
    const explainText = (await explanation.json<{ explain: string }>())
      .map((row) => row.explain)
      .join('\n');
    expect(explainText).toContain('PrimaryKey');
    const granules = /Granules: (\d+)\/(\d+)/.exec(explainText);
    expect(granules).not.toBeNull();
    const selected = Number(granules![1]);
    const total = Number(granules![2]);
    expect(total).toBeGreaterThanOrEqual(2);
    expect(selected).toBeLessThan(total);
  });

  it('task-scoped state filtresi ayni latest version/fence tie catismasini gizlemez', async () => {
    const taskId = randomUUID();
    const pending = await reserveEffect(ch, effect({ task_id: taskId }));
    await ch.insert({
      table: 'effect_ledger',
      values: [{
        causation_id: pending.causation_id,
        stable_effect_id: pending.stable_effect_id,
        project_id: pending.project_id,
        task_id: pending.task_id,
        assignment_attempt_id: pending.assignment_attempt_id,
        effect_type: pending.effect_type,
        request_hash: pending.request_hash,
        replay_safety: pending.replay_safety,
        state: 'succeeded',
        result_json: '{"accepted":true}',
        error: '',
        effect_version: pending.effect_version,
        lease_fence: pending.lease_fence,
        created_at: pending.created_at,
      }],
      format: 'JSONEachRow',
    });

    await expect(listLatestTaskEffectsByStates(ch, taskId, ['pending']))
      .rejects.toBeInstanceOf(RepositoryConflictError);
  });
});
