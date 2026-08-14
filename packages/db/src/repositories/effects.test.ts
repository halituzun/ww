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

  function effect(): ReserveEffectInput {
    return {
      causation_id: randomUUID(),
      stable_effect_id: `provider-completion:${randomUUID()}`,
      project_id: randomUUID(),
      effect_type: 'provider_completion',
      request: { messages: [{ content: 'hello', role: 'user' }] },
      replay_safety: 'non_replay_safe',
      created_at: '2026-08-14T15:00:00+03:00',
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
        created_at: pending.created_at,
      }],
      format: 'JSONEachRow',
    });
    await expect(getLatestEffect(ch, pending.causation_id, pending.stable_effect_id))
      .rejects.toBeInstanceOf(RepositoryConflictError);
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
        created_at: input.created_at,
      }],
      format: 'JSONEachRow',
    });
    await expect(getLatestEffect(ch, input.causation_id, input.stable_effect_id))
      .rejects.toBeInstanceOf(StoredRecordError);
  });
});
