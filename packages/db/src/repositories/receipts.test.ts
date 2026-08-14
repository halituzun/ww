import { randomUUID } from 'node:crypto';
import type { ClickHouseClient } from '@clickhouse/client';
import { canonicalJsonV1 } from '@ww/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCh } from '../client.js';
import { runMigrations } from '../migrate.js';
import { clickhouseUp } from '../testutil.js';
import {
  appendReceiptVersion,
  createReceipt,
  getLatestReceipt,
  listLatestReceiptsByState,
  type CreateMessageReceiptInput,
} from './receipts.js';
import {
  RepositoryConflictError,
  RepositoryWriteError,
  StoredRecordError,
  type AcknowledgedWriteVerificationCause,
  type UncertainWriteCause,
} from './types.js';

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

describe.skipIf(!up)('receipts repository', () => {
  const db = `ww_test_receipts_${Date.now()}_${process.pid}`;
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

  function receipt(receiptId = randomUUID()): CreateMessageReceiptInput {
    const recipientId = randomUUID();
    return {
      receipt_id: receiptId,
      message_id: randomUUID(),
      project_id: randomUUID(),
      recipient_id: recipientId,
      recipient_snapshot: { type: 'agent', id: recipientId },
      state: 'enqueued',
      claim_owner: '',
      claim_fence: '0',
      retry_count: 0,
      error: '',
      created_at: '2026-08-14T15:00:00+03:00',
    };
  }

  it('create ve append retrylerini uzlaştırır; state filtresini fold sonrasında uygular', async () => {
    const input = receipt();
    const initial = await createReceipt(throwAfterAcceptedInsert(ch), input);
    expect(initial.created_at).toBe('2026-08-14T12:00:00.000Z');
    expect(await createReceipt(ch, input)).toEqual(initial);

    const processedInput = {
      expectedVersion: initial.receipt_version,
      next: { ...initial, state: 'processed' as const },
    };
    const processed = await appendReceiptVersion(throwAfterAcceptedInsert(ch), processedInput);
    expect(await appendReceiptVersion(ch, processedInput)).toEqual(processed);
    await expect(appendReceiptVersion(ch, {
      expectedVersion: (BigInt(processed.receipt_version) + 1n).toString(),
      next: { ...processed },
    })).rejects.toBeInstanceOf(RepositoryConflictError);
    expect(await listLatestReceiptsByState(
      ch,
      initial.project_id,
      initial.recipient_id,
      'enqueued',
    )).toEqual([]);
    expect(await listLatestReceiptsByState(
      ch,
      initial.project_id,
      initial.recipient_id,
      'processed',
    )).toEqual([processed]);
  });

  it('insert hatasi sonrasi bos rereadde original insert nedenini korur', async () => {
    const insert = new Error('simulated rejected insert');
    const rejected = {
      query: ch.query.bind(ch),
      insert: async () => { throw insert; },
    } as unknown as ClickHouseClient;

    await expect(createReceipt(rejected, receipt())).rejects.toSatisfy((error: unknown) => {
      if (!(error instanceof RepositoryWriteError)) return false;
      const cause = error.cause as UncertainWriteCause;
      return cause.insert === insert && cause.reconciliation === undefined;
    });
  });

  it('ledger post-ack read hatasini typed verir ve exact retry ayni receipt kaydini bulur', async () => {
    const input = receipt();
    const verification = new Error('receipt verification unavailable');
    let failNextQuery = false;
    const acknowledged = new Proxy(ch, {
      get(target, property) {
        if (property === 'insert') return async (options: Parameters<ClickHouseClient['insert']>[0]) => {
          await target.insert(options);
          failNextQuery = true;
        };
        if (property === 'query') return (options: Parameters<ClickHouseClient['query']>[0]) => {
          if (failNextQuery) {
            failNextQuery = false;
            throw verification;
          }
          return target.query(options);
        };
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const failure = await createReceipt(acknowledged, input).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RepositoryWriteError);
    const cause = (failure as RepositoryWriteError).cause as AcknowledgedWriteVerificationCause;
    expect(cause).toMatchObject({ commitLikely: true, verification });
    expect(await createReceipt(ch, input)).toEqual(
      await getLatestReceipt(ch, input.project_id, input.receipt_id),
    );
  });

  it('aynı deterministic receipt ID için farklı içeriği reddeder', async () => {
    const input = receipt();
    await createReceipt(ch, input);
    await expect(createReceipt(ch, { ...input, message_id: randomUUID() }))
      .rejects.toBeInstanceOf(RepositoryConflictError);
  });

  it('latest aynı-version divergent satırı sessizce seçmez', async () => {
    const initial = await createReceipt(ch, receipt());
    await ch.insert({
      table: 'message_receipts',
      values: [{
        receipt_id: initial.receipt_id,
        message_id: initial.message_id,
        project_id: initial.project_id,
        recipient_id: initial.recipient_id,
        recipient_snapshot_json: canonicalJsonV1(initial.recipient_snapshot),
        receipt_version: initial.receipt_version,
        state: 'failed',
        claim_owner: '',
        claim_fence: '0',
        claim_expires_at: null,
        retry_count: 0,
        next_attempt_at: null,
        error: 'divergent',
        created_at: initial.created_at,
      }],
      format: 'JSONEachRow',
    });
    await expect(getLatestReceipt(ch, initial.project_id, initial.receipt_id))
      .rejects.toBeInstanceOf(RepositoryConflictError);
  });

  it('ledger concurrent divergent appendleri ayni deterministic surumde fail-closed tutar', async () => {
    const initial = await createReceipt(ch, receipt());
    let capturedReads = 0;
    let releaseReads: (() => void) | undefined;
    const readGate = new Promise<void>((resolve) => { releaseReads = resolve; });
    const concurrent = new Proxy(ch, {
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
    const outcomes = await Promise.allSettled([
      appendReceiptVersion(concurrent, {
        expectedVersion: initial.receipt_version,
        next: { ...initial, state: 'processed', error: '' },
      }),
      appendReceiptVersion(concurrent, {
        expectedVersion: initial.receipt_version,
        next: { ...initial, state: 'failed', error: 'divergent' },
      }),
    ]);
    expect(outcomes.some((result) => (
      result.status === 'rejected' && result.reason instanceof RepositoryConflictError
    ))).toBe(true);

    await ch.command({ query: 'OPTIMIZE TABLE message_receipts FINAL' });
    const versionsResult = await ch.query({
      query: `SELECT toString(receipt_version) AS version, count() AS count
        FROM message_receipts WHERE receipt_id = {receiptId:UUID}
        GROUP BY receipt_version ORDER BY receipt_version`,
      query_params: { receiptId: initial.receipt_id },
      format: 'JSONEachRow',
    });
    expect(await versionsResult.json()).toEqual([
      { version: '1', count: '1' },
      { version: '2', count: '2' },
    ]);
    await expect(getLatestReceipt(ch, initial.project_id, initial.receipt_id))
      .rejects.toBeInstanceOf(RepositoryConflictError);
  });

  it('bozuk recipient snapshot JSON kaydını sızdırmaz', async () => {
    const input = receipt();
    await ch.insert({
      table: 'message_receipts',
      values: [{
        receipt_id: input.receipt_id,
        message_id: input.message_id,
        project_id: input.project_id,
        recipient_id: input.recipient_id,
        recipient_snapshot_json: '{bad-json',
        receipt_version: '1',
        state: 'enqueued',
        claim_owner: '',
        claim_fence: '0',
        claim_expires_at: null,
        retry_count: 0,
        next_attempt_at: null,
        error: '',
        created_at: input.created_at,
      }],
      format: 'JSONEachRow',
    });
    await expect(getLatestReceipt(ch, input.project_id, input.receipt_id))
      .rejects.toBeInstanceOf(StoredRecordError);
  });
});
