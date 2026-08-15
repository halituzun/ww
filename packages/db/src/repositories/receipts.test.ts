import { randomUUID } from 'node:crypto';
import type { ClickHouseClient } from '@clickhouse/client';
import { NIL_UUID, SYSTEM_SENTINEL, canonicalJsonV1 } from '@ww/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCh } from '../client.js';
import { runMigrations } from '../migrate.js';
import {
  acquireFencedLease,
  leaseFenceKey,
  receiptLockKey,
  releaseFencedLease,
} from '../redis-leases.js';
import { createRedis } from '../redis.js';
import { clickhouseUp, redisUp } from '../testutil.js';
import {
  appendReceiptVersion,
  createReceipt,
  getLatestReceipt,
  listDueMessageReceiptCandidates,
  listDueMessageReceipts,
  listLatestReceiptsByMessage,
  listLatestReceiptsByState,
  listTerminalReceiptEventCandidates,
  type CreateMessageReceiptInput,
  type MessageReceiptRow,
} from './receipts.js';
import {
  RepositoryConflictError,
  RepositoryWriteError,
  StoredRecordError,
  type AcknowledgedWriteVerificationCause,
  type UncertainWriteCause,
} from './types.js';

const up = await clickhouseUp();
const redisAvailable = await redisUp();

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

  function storedReceipt(row: MessageReceiptRow): Record<string, unknown> {
    return {
      ...row,
      recipient_snapshot_json: canonicalJsonV1(row.recipient_snapshot),
      claim_expires_at: row.claim_expires_at ?? null,
      next_attempt_at: row.next_attempt_at ?? null,
    };
  }

  async function receiptScanBucket(receiptId: string): Promise<number> {
    const result = await ch.query({
      query: `SELECT toUInt8(cityHash64(toUUID({receiptId:String})) % 64) AS bucket`,
      query_params: { receiptId },
      format: 'JSONEachRow',
    });
    const rows = await result.json<{ bucket: number }>();
    const bucket = Number(rows[0]?.bucket);
    if (!Number.isInteger(bucket) || bucket < 0 || bucket >= 64) {
      throw new Error(`receipt scan bucket gecersiz: ${String(rows[0]?.bucket)}`);
    }
    return bucket;
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

  it('gec kalan dusuk fence writer canli yarista daha yuksek fence sahibini ezemez', async () => {
    const initial = await createReceipt(ch, receipt());
    let releaseInsert: (() => void) | undefined;
    let markIntercepted: (() => void) | undefined;
    const insertGate = new Promise<void>((resolve) => { releaseInsert = resolve; });
    const intercepted = new Promise<void>((resolve) => { markIntercepted = resolve; });
    const delayed = new Proxy(ch, {
      get(target, property) {
        if (property === 'insert') return async (options: Parameters<ClickHouseClient['insert']>[0]) => {
          if (options.table === 'message_receipts') {
            markIntercepted?.();
            await insertGate;
          }
          return target.insert(options);
        };
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const staleWrite = appendReceiptVersion(delayed, {
      expectedVersion: initial.receipt_version,
      next: {
        ...initial,
        state: 'claimed',
        claim_owner: 'worker-stale',
        claim_fence: '3',
        claim_expires_at: '2026-08-14T12:01:00.000Z',
      },
    });
    await intercepted;
    const current = await appendReceiptVersion(ch, {
      expectedVersion: initial.receipt_version,
      next: {
        ...initial,
        state: 'claimed',
        claim_owner: 'worker-current',
        claim_fence: '4',
        claim_expires_at: '2026-08-14T12:02:00.000Z',
      },
    });
    releaseInsert?.();

    await expect(staleWrite).resolves.toEqual(current);
    expect(await getLatestReceipt(ch, initial.project_id, initial.receipt_id)).toEqual(current);
  });

  it('max receipt version sonra max claim fence katlamasi fiziksel siradan ve OPTIMIZEdan bagimsizdir', async () => {
    for (const order of ['stale-first', 'current-first'] as const) {
      const initial = await createReceipt(ch, receipt());
      const stale: MessageReceiptRow = {
        ...initial,
        receipt_version: '2',
        state: 'claimed',
        claim_owner: 'worker-stale',
        claim_fence: '8',
        claim_expires_at: '2026-08-14T12:01:00.000Z',
      };
      const current: MessageReceiptRow = {
        ...stale,
        claim_owner: 'worker-current',
        claim_fence: '9',
        claim_expires_at: '2026-08-14T12:02:00.000Z',
      };
      await ch.insert({
        table: 'message_receipts',
        values: (order === 'stale-first' ? [stale, current] : [current, stale])
          .map(storedReceipt),
        format: 'JSONEachRow',
      });
      expect(await getLatestReceipt(ch, initial.project_id, initial.receipt_id)).toEqual(current);
      await ch.command({ query: 'OPTIMIZE TABLE message_receipts FINAL' });
      expect(await getLatestReceipt(ch, initial.project_id, initial.receipt_id)).toEqual(current);
    }
  });

  it.skipIf(!redisAvailable)(
    'Redis kaybi sonrasi durable minimum floor ile ayni receipt surumunu yuksek fence reclaim eder',
    async () => {
      const redis = await createRedis();
      const initial = await createReceipt(ch, receipt());
      const lockKey = receiptLockKey(initial.receipt_id);
      try {
        const firstLease = await acquireFencedLease(redis, lockKey, 'worker-a', 10_000, '0');
        expect(firstLease?.fence).toBe('1');
        const claimed = await appendReceiptVersion(ch, {
          expectedVersion: initial.receipt_version,
          next: {
            ...initial,
            state: 'claimed',
            claim_owner: firstLease!.owner,
            claim_fence: firstLease!.fence,
            claim_expires_at: '2026-08-14T12:01:00.000Z',
          },
        });
        await redis.del(lockKey, leaseFenceKey(lockKey));
        const recovered = await acquireFencedLease(
          redis,
          lockKey,
          'worker-b',
          10_000,
          claimed.claim_fence,
        );
        expect(recovered?.fence).toBe('2');

        const reclaimed = await appendReceiptVersion(ch, {
          expectedVersion: initial.receipt_version,
          next: {
            ...initial,
            state: 'claimed',
            claim_owner: recovered!.owner,
            claim_fence: recovered!.fence,
            claim_expires_at: '2026-08-14T12:02:00.000Z',
          },
        });
        expect(reclaimed).toMatchObject({
          receipt_version: claimed.receipt_version,
          claim_owner: 'worker-b',
          claim_fence: '2',
        });
        await expect(appendReceiptVersion(ch, {
          expectedVersion: initial.receipt_version,
          next: { ...claimed, state: 'processed' },
        })).rejects.toBeInstanceOf(RepositoryConflictError);
        expect(await getLatestReceipt(ch, initial.project_id, initial.receipt_id)).toEqual(reclaimed);
        expect(await releaseFencedLease(redis, recovered!)).toBe(true);
      } finally {
        await redis.del(lockKey, leaseFenceKey(lockKey));
        redis.destroy();
      }
    },
  );

  it('due scan tum fiziksel satirlari once katlar, zamani uygular ve deterministik sinirlar', async () => {
    const recipientId = randomUUID();
    const make = async (
      recipientId: string,
      createdAt: string,
    ): Promise<MessageReceiptRow> => createReceipt(ch, {
      ...receipt(),
      recipient_id: recipientId,
      recipient_snapshot: { type: 'agent', id: recipientId },
      created_at: createdAt,
    });
    const enqueued = await make(recipientId, '2026-08-14T12:00:00.000Z');
    const retryDueInitial = await make(recipientId, '2026-08-14T12:01:00.000Z');
    const retryDue = await appendReceiptVersion(ch, {
      expectedVersion: retryDueInitial.receipt_version,
      next: {
        ...retryDueInitial,
        state: 'retry_scheduled',
        retry_count: 1,
        next_attempt_at: '2026-08-14T12:04:00.000Z',
      },
    });
    const retryFutureInitial = await make(recipientId, '2026-08-14T12:02:00.000Z');
    await appendReceiptVersion(ch, {
      expectedVersion: retryFutureInitial.receipt_version,
      next: {
        ...retryFutureInitial,
        state: 'retry_scheduled',
        retry_count: 1,
        next_attempt_at: '2026-08-14T12:06:00.000Z',
      },
    });
    const expiredInitial = await make(recipientId, '2026-08-14T12:03:00.000Z');
    const expired = await appendReceiptVersion(ch, {
      expectedVersion: expiredInitial.receipt_version,
      next: {
        ...expiredInitial,
        state: 'claimed',
        claim_owner: 'worker-expired',
        claim_fence: '1',
        claim_expires_at: '2026-08-14T12:04:59.000Z',
      },
    });
    const liveInitial = await make(recipientId, '2026-08-14T12:04:00.000Z');
    await appendReceiptVersion(ch, {
      expectedVersion: liveInitial.receipt_version,
      next: {
        ...liveInitial,
        state: 'claimed',
        claim_owner: 'worker-live',
        claim_fence: '1',
        claim_expires_at: '2026-08-14T12:05:01.000Z',
      },
    });
    const processedInitial = await make(recipientId, '2026-08-14T12:05:00.000Z');
    await appendReceiptVersion(ch, {
      expectedVersion: processedInitial.receipt_version,
      next: { ...processedInitial, state: 'processed' },
    });

    const options = {
      now: '2026-08-14T12:05:00.000Z',
      recipientId,
      limit: 100,
    } as const;
    const dueBeforeConflict = new Map<string, MessageReceiptRow>();
    for (let poll = 0; poll < 130 && dueBeforeConflict.size < 3; poll += 1) {
      for (const candidate of await listDueMessageReceipts(ch, options)) {
        dueBeforeConflict.set(candidate.receipt_id, candidate);
      }
    }
    expect([...dueBeforeConflict.keys()].sort()).toEqual([
      enqueued.receipt_id,
      retryDue.receipt_id,
      expired.receipt_id,
    ].sort());
    const bounded = await listDueMessageReceipts(ch, { ...options, limit: 1 });
    expect(bounded.length).toBeLessThanOrEqual(1);
    expect(bounded.every((candidate) => dueBeforeConflict.has(candidate.receipt_id))).toBe(true);
    await expect(listDueMessageReceipts(ch, { ...options, limit: 0 }))
      .rejects.toBeInstanceOf(StoredRecordError);
    await expect(listDueMessageReceipts(ch, { ...options, limit: 1_001 }))
      .rejects.toBeInstanceOf(StoredRecordError);

    await ch.insert({
      table: 'message_receipts',
      values: [storedReceipt({ ...retryDue, error: 'divergent max-fence tie' })],
      format: 'JSONEachRow',
    });
    const validAfterConflict = new Map<string, MessageReceiptRow>();
    let conflict: Awaited<ReturnType<typeof listDueMessageReceiptCandidates>>['invalid'][number]
      | undefined;
    for (let poll = 0; poll < 130 && (
      validAfterConflict.size < 2 || conflict === undefined
    ); poll += 1) {
      const page = await listDueMessageReceiptCandidates(ch, options);
      for (const candidate of page.valid) validAfterConflict.set(candidate.receipt_id, candidate);
      conflict ??= page.invalid.find((candidate) => candidate.receiptId === retryDue.receipt_id);
    }
    expect([...validAfterConflict.keys()].sort()).toEqual([
      enqueued.receipt_id,
      expired.receipt_id,
    ].sort());
    expect(conflict).toEqual(expect.objectContaining({
      code: 'latest_candidate_conflict',
      projectId: retryDue.project_id,
      receiptId: retryDue.receipt_id,
      messageId: retryDue.message_id,
    }));
    expect(conflict?.candidateId).toMatch(/^[a-f0-9]{64}$/);
  });

  it('bozuk due receipt saglikli kaydi ve kayip-wakeup durable taramasini engellemez', async () => {
    const recipientId = randomUUID();
    const malformed = receipt();
    await ch.insert({
      table: 'message_receipts',
      values: [{
        receipt_id: malformed.receipt_id,
        message_id: malformed.message_id,
        project_id: malformed.project_id,
        recipient_id: recipientId,
        recipient_snapshot_json: '{bad-json',
        receipt_version: '1',
        state: 'enqueued',
        claim_owner: '',
        claim_fence: '0',
        claim_expires_at: null,
        retry_count: 0,
        next_attempt_at: null,
        error: '',
        created_at: '2026-08-14T11:59:00.000Z',
      }],
      format: 'JSONEachRow',
    });
    const healthy = await createReceipt(ch, {
      ...receipt(),
      recipient_id: recipientId,
      recipient_snapshot: { type: 'agent', id: recipientId },
      created_at: '2026-08-14T12:00:00.000Z',
    });

    const options = {
      now: '2026-08-14T12:01:00.000Z',
      recipientId,
      limit: 1,
    } as const;
    let healthySeen = false;
    let malformedEvidence: Awaited<ReturnType<
      typeof listDueMessageReceiptCandidates
    >>['invalid'][number] | undefined;
    for (let poll = 0; poll < 130 && (!healthySeen || malformedEvidence === undefined); poll += 1) {
      const candidates = await listDueMessageReceiptCandidates(ch, options);
      healthySeen ||= candidates.valid.some((candidate) => candidate.receipt_id === healthy.receipt_id);
      malformedEvidence ??= candidates.invalid.find((candidate) => (
        candidate.receiptId === malformed.receipt_id
      ));
    }
    expect(healthySeen).toBe(true);
    expect(malformedEvidence).toEqual(expect.objectContaining({
      code: 'stored_record_invalid',
      projectId: malformed.project_id,
      receiptId: malformed.receipt_id,
      messageId: malformed.message_id,
      summary: 'latest receipt candidate failed stored-record validation',
    }));
  });

  it('invalid-only bucketi ayni cagrida gecip valid adayi bulur ve cursoru guvenle ilerletir', async () => {
    const recipientId = randomUUID();
    const malformedId = randomUUID();
    const malformedBucket = await receiptScanBucket(malformedId);
    let healthyId = randomUUID();
    let healthyBucket = await receiptScanBucket(healthyId);
    while (healthyBucket === malformedBucket) {
      healthyId = randomUUID();
      healthyBucket = await receiptScanBucket(healthyId);
    }
    const malformed = {
      ...receipt(malformedId),
      recipient_id: recipientId,
      recipient_snapshot: { type: 'agent' as const, id: recipientId },
      created_at: '2026-08-14T11:59:00.000Z',
    };
    await ch.insert({
      table: 'message_receipts',
      values: [{
        receipt_id: malformed.receipt_id,
        message_id: malformed.message_id,
        project_id: malformed.project_id,
        recipient_id: recipientId,
        recipient_snapshot_json: '{bad-json',
        receipt_version: '1',
        state: 'enqueued',
        claim_owner: '',
        claim_fence: '0',
        claim_expires_at: null,
        retry_count: 0,
        next_attempt_at: null,
        error: '',
        created_at: malformed.created_at,
      }],
      format: 'JSONEachRow',
    });
    const healthy = await createReceipt(ch, {
      ...receipt(healthyId),
      recipient_id: recipientId,
      recipient_snapshot: { type: 'agent', id: recipientId },
      created_at: '2026-08-14T12:00:00.000Z',
    });
    await ch.insert({
      table: 'message_receipt_scan_cursors',
      values: [{
        scan_recipient_id: recipientId,
        generation: '0',
        cursor_bucket: malformedBucket,
        cursor_created_at: '1970-01-01T00:00:00.000Z',
        cursor_project_id: NIL_UUID,
        cursor_receipt_id: NIL_UUID,
      }],
      format: 'JSONEachRow',
    });
    let bucketReads = 0;
    const observed = new Proxy(ch, {
      get(target, property) {
        if (property === 'query') return (options: Parameters<ClickHouseClient['query']>[0]) => {
          if (String(options.query).includes('FROM recipient_message_receipts')) bucketReads += 1;
          return target.query(options);
        };
        const member: unknown = Reflect.get(target, property, target);
        return typeof member === 'function' ? member.bind(target) : member;
      },
    });

    const candidates = await listDueMessageReceiptCandidates(observed, {
      now: '2026-08-14T12:01:00.000Z',
      recipientId,
      limit: 1,
    });

    expect(candidates.valid).toEqual([healthy]);
    expect(candidates.invalid).toMatchObject([{
      code: 'stored_record_invalid',
      receiptId: malformed.receipt_id,
    }]);
    expect(bucketReads).toBeGreaterThanOrEqual(1);
    expect(bucketReads).toBeLessThanOrEqual(2);
    const cursor = await ch.query({
      query: `SELECT cursor_bucket, cursor_receipt_id
        FROM message_receipt_scan_cursors
        PREWHERE scan_recipient_id = {recipientId:UUID}
        ORDER BY generation DESC, cursor_bucket DESC, cursor_created_at DESC,
          cursor_project_id DESC, cursor_receipt_id DESC
        LIMIT 1`,
      query_params: { recipientId },
      format: 'JSONEachRow',
    });
    expect(await cursor.json()).toEqual([{
      cursor_bucket: healthyBucket,
      cursor_receipt_id: healthy.receipt_id,
    }]);
  });

  it('empty ve post-history idle scan cursor disinda en fazla iki mirror sayfasi okur', async () => {
    const recipientId = randomUUID();
    let pageQueries = 0;
    const observed = new Proxy(ch, {
      get(target, property) {
        if (property === 'query') return (options: Parameters<ClickHouseClient['query']>[0]) => {
          if (String(options.query).includes('FROM recipient_message_receipts')) pageQueries += 1;
          return target.query(options);
        };
        const member: unknown = Reflect.get(target, property, target);
        return typeof member === 'function' ? member.bind(target) : member;
      },
    });
    const options = {
      now: '2026-08-14T12:01:00.000Z',
      recipientId,
      limit: 1,
    } as const;

    expect(await listDueMessageReceiptCandidates(observed, options))
      .toEqual({ valid: [], invalid: [] });
    expect(pageQueries).toBeLessThanOrEqual(2);

    const initial = await createReceipt(ch, {
      ...receipt(),
      recipient_id: recipientId,
      recipient_snapshot: { type: 'agent', id: recipientId },
    });
    await appendReceiptVersion(ch, {
      expectedVersion: initial.receipt_version,
      next: { ...initial, state: 'processed' },
    });
    await listDueMessageReceiptCandidates(observed, options);
    pageQueries = 0;

    expect(await listDueMessageReceiptCandidates(observed, options))
      .toEqual({ valid: [], invalid: [] });
    expect(pageQueries).toBeLessThanOrEqual(2);
  });

  it('buyuk receipt historysini Nodea tasimadan SQLde latest version ve fence adayina indirger', async () => {
    const input = receipt();
    const initial = await createReceipt(ch, input);
    await ch.insert({
      table: 'message_receipts',
      values: Array.from({ length: 250 }, (_, index) => storedReceipt({
        ...initial,
        receipt_version: String(index + 2),
        claim_fence: String(index + 1),
      })),
      format: 'JSONEachRow',
    });
    const observedQueries: string[] = [];
    const observed = new Proxy(ch, {
      get(target, property) {
        if (property === 'query') return (options: Parameters<ClickHouseClient['query']>[0]) => {
          observedQueries.push(String(options.query));
          return target.query(options);
        };
        const member: unknown = Reflect.get(target, property, target);
        return typeof member === 'function' ? member.bind(target) : member;
      },
    });

    const due = await listDueMessageReceipts(observed, {
      now: '2026-08-14T12:01:00.000Z',
      recipientId: initial.recipient_id,
      limit: 1,
    });
    expect(due).toMatchObject([{
      receipt_id: initial.receipt_id,
      receipt_version: '251',
      claim_fence: '250',
    }]);
    expect(observedQueries.some((query) => (
      query.includes('FROM recipient_message_receipts') &&
      query.includes('LIMIT {candidateLimit:UInt32}')
    ))).toBe(true);
    expect(observedQueries.some((query) => query.includes('max(receipt_version) OVER'))).toBe(true);
    expect(observedQueries.some((query) => query.includes('max(claim_fence) OVER'))).toBe(true);
  });

  it('message receipt snapshotini fold edip tam ve bounded olarak dondurur', async () => {
    const projectId = randomUUID();
    const messageId = randomUUID();
    const first = await createReceipt(ch, {
      ...receipt(),
      project_id: projectId,
      message_id: messageId,
    });
    const second = await createReceipt(ch, {
      ...receipt(),
      project_id: projectId,
      message_id: messageId,
    });
    const processed = await appendReceiptVersion(ch, {
      expectedVersion: first.receipt_version,
      next: { ...first, state: 'processed' },
    });
    await createReceipt(ch, { ...receipt(), project_id: projectId });

    const expected = [processed, second].sort((left, right) => (
      left.recipient_id.localeCompare(right.recipient_id) ||
      left.receipt_id.localeCompare(right.receipt_id)
    ));
    expect(await listLatestReceiptsByMessage(ch, projectId, messageId)).toEqual(expected);
    await expect(listLatestReceiptsByMessage(ch, projectId, messageId, { limit: 1 }))
      .rejects.toBeInstanceOf(RepositoryConflictError);

    await ch.insert({
      table: 'message_receipts',
      values: [storedReceipt({ ...second, error: 'divergent max-fence tie' })],
      format: 'JSONEachRow',
    });
    await expect(listLatestReceiptsByMessage(ch, projectId, messageId))
      .rejects.toBeInstanceOf(RepositoryConflictError);
  });

  it('message snapshot buyuk fiziksel historyyi SQLde latest/fence ve logical LIMITe indirger', async () => {
    const projectId = randomUUID();
    const messageId = randomUUID();
    const initial = await createReceipt(ch, {
      ...receipt(),
      project_id: projectId,
      message_id: messageId,
    });
    await ch.insert({
      table: 'message_receipts',
      values: Array.from({ length: 300 }, (_, index) => storedReceipt({
        ...initial,
        receipt_version: String(index + 2),
        claim_fence: String(index + 1),
      })),
      format: 'JSONEachRow',
    });
    const second = await createReceipt(ch, {
      ...receipt(),
      project_id: projectId,
      message_id: messageId,
    });
    const observedQueries: string[] = [];
    let returnedPhysicalRows = 0;
    const observed = new Proxy(ch, {
      get(target, property) {
        if (property === 'query') return async (options: Parameters<ClickHouseClient['query']>[0]) => {
          observedQueries.push(String(options.query));
          const result = await target.query(options);
          return new Proxy(result, {
            get(queryResult, queryProperty) {
              if (queryProperty !== 'json') {
                const member: unknown = Reflect.get(queryResult, queryProperty, queryResult);
                return typeof member === 'function' ? member.bind(queryResult) : member;
              }
              return async () => {
                const rows = await queryResult.json<unknown>();
                returnedPhysicalRows = rows.length;
                return rows;
              };
            },
          });
        };
        const member: unknown = Reflect.get(target, property, target);
        return typeof member === 'function' ? member.bind(target) : member;
      },
    });

    const latest = await listLatestReceiptsByMessage(observed, projectId, messageId, { limit: 2 });
    expect(latest).toHaveLength(2);
    expect(latest).toContainEqual(expect.objectContaining({
      receipt_id: initial.receipt_id,
      receipt_version: '301',
      claim_fence: '300',
    }));
    expect(latest).toContainEqual(second);
    expect(returnedPhysicalRows).toBe(2);
    const observedQuery = observedQueries.join('\n');
    expect(observedQuery).toContain('max(receipt_version) OVER');
    expect(observedQuery).toContain('max(claim_fence) OVER');
    expect(observedQuery).toContain('LIMIT {candidateLimit:UInt32}');
    expect(observedQuery).not.toContain(' FINAL');
  });

  it('recipient due hot path multi-granule veride primary-key pruning kullanir', async () => {
    const targetRecipient = '88888888-8888-4888-8888-888888888888';
    const beforeRecipient = '11111111-1111-4111-8111-111111111111';
    const afterRecipient = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const targetReceiptId = randomUUID();
    const rows = Array.from({ length: 18_001 }, (_, index) => {
      const recipientId = index === 9_000
        ? targetRecipient
        : index < 9_000 ? beforeRecipient : afterRecipient;
      return {
        receipt_id: index === 9_000 ? targetReceiptId : randomUUID(),
        message_id: randomUUID(),
        project_id: randomUUID(),
        recipient_id: recipientId,
        recipient_snapshot_json: canonicalJsonV1({ type: 'agent', id: recipientId }),
        receipt_version: '1',
        state: 'enqueued',
        claim_owner: '',
        claim_fence: '0',
        claim_expires_at: null,
        retry_count: 0,
        next_attempt_at: null,
        error: '',
        created_at: '2026-08-14T12:00:00.000Z',
      };
    });
    await ch.insert({ table: 'message_receipts', values: rows, format: 'JSONEachRow' });
    const observedQueries: string[] = [];
    const observed = new Proxy(ch, {
      get(target, property) {
        if (property === 'query') return (options: Parameters<ClickHouseClient['query']>[0]) => {
          observedQueries.push(String(options.query));
          return target.query(options);
        };
        const member: unknown = Reflect.get(target, property, target);
        return typeof member === 'function' ? member.bind(target) : member;
      },
    });
    expect(await listDueMessageReceipts(observed, {
      now: '2026-08-14T12:01:00.000Z',
      recipientId: targetRecipient,
      limit: 1,
    })).toMatchObject([{ receipt_id: targetReceiptId }]);
    expect(observedQueries.some((query) => (
      query.includes('FROM recipient_message_receipts') &&
      query.includes('PREWHERE recipient_id = {recipientId:UUID}') &&
      query.includes('tuple(scan_bucket, created_at, project_id, receipt_id) >')
    ))).toBe(true);
    expect(observedQueries.every((query) => !query.includes(' FINAL'))).toBe(true);

    const explanation = await ch.query({
      query: `EXPLAIN indexes = 1
        SELECT project_id, receipt_id
        FROM recipient_message_receipts
        PREWHERE recipient_id = {recipientId:UUID}
          AND tuple(scan_bucket, created_at, project_id, receipt_id) >
            tuple(toUInt8(0), toDateTime64('2026-08-14 00:00:00.000', 3, 'UTC'),
              toUUID('00000000-0000-0000-0000-000000000000'),
              toUUID('00000000-0000-0000-0000-000000000000'))
        ORDER BY recipient_id, scan_bucket, created_at, project_id, receipt_id,
          receipt_version, claim_fence
        LIMIT 101`,
      query_params: { recipientId: targetRecipient, receiptId: targetReceiptId },
      format: 'JSONEachRow',
    });
    const explainText = (await explanation.json<{ explain: string }>())
      .map((row) => row.explain)
      .join('\n');
    expect(explainText).toContain('recipient_message_receipts');
    expect(explainText).toContain('PrimaryKey');
    const granules = [...explainText.matchAll(/Granules: (\d+)\/(\d+)/g)]
      .map((match) => ({ selected: Number(match[1]), total: Number(match[2]) }));
    expect(granules.some(({ selected, total }) => total >= 2 && selected < total)).toBe(true);
  }, 30_000);

  it('global due cursor 50k veride bounded ilerler ve primary-key granullerini budar', async () => {
    await ch.command({ query: 'TRUNCATE TABLE message_receipt_scan_cursors' });
    const recipientId = randomUUID();
    const rows = Array.from({ length: 50_001 }, (_, index) => {
      const receiptId = randomUUID();
      return {
        receipt_id: receiptId,
        message_id: randomUUID(),
        project_id: randomUUID(),
        recipient_id: recipientId,
        recipient_snapshot_json: canonicalJsonV1({ type: 'agent', id: recipientId }),
        receipt_version: '1',
        state: 'enqueued',
        claim_owner: '',
        claim_fence: '0',
        claim_expires_at: null,
        retry_count: 0,
        next_attempt_at: null,
        error: '',
        created_at: new Date(Date.parse('2020-01-01T00:00:00.000Z') + index).toISOString(),
      };
    });
    await ch.insert({ table: 'message_receipts', values: rows, format: 'JSONEachRow' });

    const first = await listDueMessageReceipts(ch, {
      now: '2026-08-14T12:01:00.000Z',
      limit: 1,
    });
    const restarted = createCh({ database: db });
    const second = await listDueMessageReceipts(restarted, {
      now: '2026-08-14T12:01:00.000Z',
      limit: 1,
    });
    await restarted.close();
    const third = await listDueMessageReceipts(ch, {
      now: '2026-08-14T12:01:00.000Z',
      limit: 1,
    });
    const observedReceiptIds = [first[0]?.receipt_id, second[0]?.receipt_id, third[0]?.receipt_id];
    expect(new Set(observedReceiptIds).size).toBe(3);
    expect(observedReceiptIds.every((receiptId) => (
      rows.some((row) => row.receipt_id === receiptId)
    ))).toBe(true);

    const explanation = await ch.query({
      query: `EXPLAIN indexes = 1
        SELECT project_id, receipt_id FROM global_message_receipts
        PREWHERE scan_bucket >= {scanBucket:UInt8}
          AND tuple(scan_bucket, created_at, project_id, receipt_id) >
          tuple({scanBucket:UInt8}, {cursorCreatedAt:DateTime64(3, 'UTC')},
            {cursorProjectId:UUID}, {cursorReceiptId:UUID})
        ORDER BY scan_bucket, created_at, project_id, receipt_id, receipt_version, claim_fence
        LIMIT 101`,
      query_params: {
        cursorCreatedAt: rows[25_000]!.created_at.replace('T', ' ').replace('Z', ''),
        scanBucket: 32,
        cursorProjectId: rows[25_000]!.project_id,
        cursorReceiptId: rows[25_000]!.receipt_id,
      },
      format: 'JSONEachRow',
    });
    const explainText = (await explanation.json<{ explain: string }>())
      .map((row) => row.explain)
      .join('\n');
    const granules = [...explainText.matchAll(/Granules: (\d+)\/(\d+)/g)]
      .map((match) => ({ selected: Number(match[1]), total: Number(match[2]) }));
    expect(
      granules.some(({ selected, total }) => total >= 6 && selected < total),
      explainText,
    ).toBe(true);
  }, 30_000);

  it('cursor concurrent poller, accepted-timeout, restart ve wrap generationini uzlastirir', async () => {
    const concurrentRecipient = randomUUID();
    const concurrentRows = [0, 1].map((index) => ({
      ...receipt(),
      recipient_id: concurrentRecipient,
      recipient_snapshot: { type: 'agent' as const, id: concurrentRecipient },
      created_at: new Date(Date.parse('2030-01-01T00:00:00.000Z') + index).toISOString(),
    }));
    for (const input of concurrentRows) await createReceipt(ch, input);

    let cursorArrivals = 0;
    let releaseCursorWrites: (() => void) | undefined;
    const cursorGate = new Promise<void>((resolve) => { releaseCursorWrites = resolve; });
    const concurrent = new Proxy(ch, {
      get(target, property) {
        if (property === 'insert') return async (options: Parameters<ClickHouseClient['insert']>[0]) => {
          if (options.table === 'message_receipt_scan_cursors') {
            cursorArrivals += 1;
            if (cursorArrivals === 2) releaseCursorWrites?.();
            await cursorGate;
          }
          return target.insert(options);
        };
        const member: unknown = Reflect.get(target, property, target);
        return typeof member === 'function' ? member.bind(target) : member;
      },
    });
    const concurrentOptions = {
      now: '2030-01-01T00:01:00.000Z',
      recipientId: concurrentRecipient,
      limit: 1,
    } as const;
    const simultaneous = await Promise.all([
      listDueMessageReceipts(concurrent, concurrentOptions),
      listDueMessageReceipts(concurrent, concurrentOptions),
    ]);
    expect(concurrentRows.some((row) => row.receipt_id === simultaneous[0]?.[0]?.receipt_id))
      .toBe(true);
    expect(simultaneous[1]?.[0]?.receipt_id).toBe(simultaneous[0]?.[0]?.receipt_id);
    const firstConcurrentReceiptId = simultaneous[0]![0]!.receipt_id;

    let threwAfterAcceptedCursor = false;
    const acceptedTimeout = new Proxy(ch, {
      get(target, property) {
        if (property === 'insert') return async (options: Parameters<ClickHouseClient['insert']>[0]) => {
          await target.insert(options);
          if (options.table === 'message_receipt_scan_cursors' && !threwAfterAcceptedCursor) {
            threwAfterAcceptedCursor = true;
            throw new Error('accepted cursor timeout');
          }
        };
        const member: unknown = Reflect.get(target, property, target);
        return typeof member === 'function' ? member.bind(target) : member;
      },
    });
    expect(await listDueMessageReceipts(acceptedTimeout, concurrentOptions))
      .toMatchObject([{ receipt_id: concurrentRows.find((row) => (
        row.receipt_id !== firstConcurrentReceiptId
      ))!.receipt_id }]);
    expect(threwAfterAcceptedCursor).toBe(true);

    const repairRecipient = randomUUID();
    const initial = await createReceipt(ch, {
      ...receipt(),
      recipient_id: repairRecipient,
      recipient_snapshot: { type: 'agent', id: repairRecipient },
      created_at: '2031-01-01T00:00:00.000Z',
    });
    const processed = await appendReceiptVersion(ch, {
      expectedVersion: initial.receipt_version,
      next: { ...initial, state: 'processed' },
    });
    const repairOptions = {
      now: '2031-01-01T00:01:00.000Z',
      recipientId: repairRecipient,
      limit: 1,
    } as const;
    expect(await listDueMessageReceipts(ch, repairOptions)).toEqual([]);
    const repaired = await appendReceiptVersion(ch, {
      expectedVersion: processed.receipt_version,
      next: {
        ...processed,
        state: 'retry_scheduled',
        retry_count: 1,
        next_attempt_at: '2031-01-01T00:00:30.000Z',
      },
    });
    const restarted = createCh({ database: db });
    expect(await listDueMessageReceipts(restarted, repairOptions)).toEqual([repaired]);
    await restarted.close();
    await ch.insert({
      table: 'message_receipt_scan_cursors',
      values: [{
        scan_recipient_id: repairRecipient,
        generation: '0',
        cursor_bucket: 63,
        cursor_created_at: '2099-01-01T00:00:00.000Z',
        cursor_project_id: randomUUID(),
        cursor_receipt_id: randomUUID(),
      }],
      format: 'JSONEachRow',
    });
    const beforeCursor = await createReceipt(ch, {
      ...receipt(),
      recipient_id: repairRecipient,
      recipient_snapshot: { type: 'agent', id: repairRecipient },
      created_at: '2030-12-31T23:59:59.000Z',
    });
    const afterCursor = await createReceipt(ch, {
      ...receipt(),
      recipient_id: repairRecipient,
      recipient_snapshot: { type: 'agent', id: repairRecipient },
      created_at: '2031-01-01T00:00:01.000Z',
    });
    const discovered = new Set<string>();
    for (let poll = 0; poll < 130 && discovered.size < 2; poll += 1) {
      for (const candidate of await listDueMessageReceipts(ch, repairOptions)) {
        if (candidate.receipt_id === beforeCursor.receipt_id ||
          candidate.receipt_id === afterCursor.receipt_id) {
          discovered.add(candidate.receipt_id);
        }
      }
    }
    expect(discovered).toEqual(new Set([beforeCursor.receipt_id, afterCursor.receipt_id]));
    const cursor = await ch.query({
      query: `SELECT toString(max(generation)) AS generation
        FROM message_receipt_scan_cursors
        PREWHERE scan_recipient_id = {recipientId:UUID}`,
      query_params: { recipientId: repairRecipient },
      format: 'JSONEachRow',
    });
    const cursorRows = await cursor.json<{ generation: string }>();
    expect(BigInt(cursorRows[0]!.generation)).toBeGreaterThanOrEqual(1n);
  }, 30_000);

  it('terminal event taramasi yalniz authoritative processed/failed receiptleri dondurur', async () => {
    await ch.command({ query: 'TRUNCATE TABLE global_message_receipts' });
    await ch.command({ query: 'TRUNCATE TABLE message_receipt_scan_cursors' });
    await ch.command({ query: 'TRUNCATE TABLE terminal_receipt_event_scan_cursors' });
    const due = await createReceipt(ch, receipt());
    const processedInitial = await createReceipt(ch, receipt());
    const processed = await appendReceiptVersion(ch, {
      expectedVersion: processedInitial.receipt_version,
      next: { ...processedInitial, state: 'processed' },
    });
    const failedInitial = await createReceipt(ch, receipt());
    const failed = await appendReceiptVersion(ch, {
      expectedVersion: failedInitial.receipt_version,
      next: { ...failedInitial, state: 'failed', error: 'terminal failure' },
    });
    const repairedInitial = await createReceipt(ch, receipt());
    const repairedProcessed = await appendReceiptVersion(ch, {
      expectedVersion: repairedInitial.receipt_version,
      next: { ...repairedInitial, state: 'processed' },
    });
    const noLongerTerminal = await appendReceiptVersion(ch, {
      expectedVersion: repairedProcessed.receipt_version,
      next: {
        ...repairedProcessed,
        state: 'retry_scheduled',
        retry_count: 1,
        next_attempt_at: '2026-08-14T12:01:00.000Z',
      },
    });

    const terminal = await listTerminalReceiptEventCandidates(ch, { limit: 10 });
    expect(terminal.map((candidate) => candidate.receipt_id).sort()).toEqual([
      processed.receipt_id,
      failed.receipt_id,
    ].sort());
    expect(terminal).toContainEqual(processed);
    expect(terminal).toContainEqual(failed);
    expect(terminal).not.toContainEqual(expect.objectContaining({
      receipt_id: noLongerTerminal.receipt_id,
    }));
    expect(await listDueMessageReceipts(ch, {
      now: '2026-08-14T12:02:00.000Z',
      limit: 10,
    })).toEqual(expect.arrayContaining([due, noLongerTerminal]));

    const cursorScopes = await ch.query({
      query: `SELECT
          (SELECT count() FROM message_receipt_scan_cursors) AS delivery,
          (SELECT count() FROM terminal_receipt_event_scan_cursors) AS terminal`,
      format: 'JSONEachRow',
    });
    expect(await cursorScopes.json()).toEqual([{ delivery: '1', terminal: '1' }]);
  });

  it('system recipient due ve terminal repair cursorlarini ters bucketlarda fiziksel ayirir', async () => {
    await ch.command({ query: 'TRUNCATE TABLE global_message_receipts' });
    await ch.command({ query: 'TRUNCATE TABLE message_receipt_scan_cursors' });
    await ch.command({ query: 'TRUNCATE TABLE terminal_receipt_event_scan_cursors' });
    let dueReceiptId = randomUUID();
    let dueBucket = await receiptScanBucket(dueReceiptId);
    while (dueBucket >= 16) {
      dueReceiptId = randomUUID();
      dueBucket = await receiptScanBucket(dueReceiptId);
    }
    let terminalReceiptId = randomUUID();
    let terminalBucket = await receiptScanBucket(terminalReceiptId);
    while (terminalBucket < 48) {
      terminalReceiptId = randomUUID();
      terminalBucket = await receiptScanBucket(terminalReceiptId);
    }
    const systemDue = await createReceipt(ch, {
      ...receipt(dueReceiptId),
      recipient_id: SYSTEM_SENTINEL,
      recipient_snapshot: { type: 'system', id: SYSTEM_SENTINEL },
      created_at: '2031-06-01T00:00:00.000Z',
    });
    const terminalInitial = await createReceipt(ch, {
      ...receipt(terminalReceiptId),
      created_at: '2031-06-01T00:00:01.000Z',
    });
    const terminal = await appendReceiptVersion(ch, {
      expectedVersion: terminalInitial.receipt_version,
      next: { ...terminalInitial, state: 'processed' },
    });

    let arrivals = 0;
    let releaseWrites: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { releaseWrites = resolve; });
    const concurrent = new Proxy(ch, {
      get(target, property) {
        if (property === 'insert') return async (options: Parameters<ClickHouseClient['insert']>[0]) => {
          if (
            options.table === 'message_receipt_scan_cursors' ||
            options.table === 'terminal_receipt_event_scan_cursors'
          ) {
            arrivals += 1;
            if (arrivals === 2) releaseWrites?.();
            await gate;
          }
          return target.insert(options);
        };
        const member: unknown = Reflect.get(target, property, target);
        return typeof member === 'function' ? member.bind(target) : member;
      },
    });
    const [due, terminalCandidates] = await Promise.all([
      listDueMessageReceipts(concurrent, {
        now: '2031-06-01T00:01:00.000Z',
        recipientId: SYSTEM_SENTINEL,
        limit: 1,
      }),
      listTerminalReceiptEventCandidates(concurrent, { limit: 1 }),
    ]);
    expect(due).toEqual([systemDue]);
    expect(terminalCandidates).toEqual([terminal]);

    const deliveryCursor = await ch.query({
      query: `SELECT count() AS physical, max(cursor_bucket) AS cursor_bucket
        FROM message_receipt_scan_cursors
        PREWHERE scan_recipient_id = {systemRecipientId:UUID}`,
      query_params: { systemRecipientId: SYSTEM_SENTINEL },
      format: 'JSONEachRow',
    });
    const terminalCursor = await ch.query({
      query: `SELECT count() AS physical, max(cursor_bucket) AS cursor_bucket
        FROM terminal_receipt_event_scan_cursors
        PREWHERE scan_recipient_id = {scanScope:UUID}`,
      query_params: { scanScope: NIL_UUID },
      format: 'JSONEachRow',
    });
    expect(await deliveryCursor.json()).toEqual([{ physical: '1', cursor_bucket: dueBucket }]);
    expect(await terminalCursor.json()).toEqual([{
      physical: '1',
      cursor_bucket: terminalBucket,
    }]);
  });

  it('terminal event cursoru concurrent poll, accepted-timeout, restart ve wrapi uzlastirir', async () => {
    await ch.command({ query: 'TRUNCATE TABLE global_message_receipts' });
    await ch.command({ query: 'TRUNCATE TABLE terminal_receipt_event_scan_cursors' });
    const terminalRows: MessageReceiptRow[] = [];
    for (let index = 0; index < 2; index += 1) {
      const initial = await createReceipt(ch, {
        ...receipt(),
        created_at: new Date(Date.parse('2032-01-01T00:00:00.000Z') + index).toISOString(),
      });
      terminalRows.push(await appendReceiptVersion(ch, {
        expectedVersion: initial.receipt_version,
        next: { ...initial, state: index === 0 ? 'processed' : 'failed' },
      }));
    }

    let cursorArrivals = 0;
    let releaseCursorWrites: (() => void) | undefined;
    const cursorGate = new Promise<void>((resolve) => { releaseCursorWrites = resolve; });
    const concurrent = new Proxy(ch, {
      get(target, property) {
        if (property === 'insert') return async (options: Parameters<ClickHouseClient['insert']>[0]) => {
          if (options.table === 'terminal_receipt_event_scan_cursors') {
            cursorArrivals += 1;
            if (cursorArrivals === 2) releaseCursorWrites?.();
            await cursorGate;
          }
          return target.insert(options);
        };
        const member: unknown = Reflect.get(target, property, target);
        return typeof member === 'function' ? member.bind(target) : member;
      },
    });
    const simultaneous = await Promise.all([
      listTerminalReceiptEventCandidates(concurrent, { limit: 1 }),
      listTerminalReceiptEventCandidates(concurrent, { limit: 1 }),
    ]);
    expect(simultaneous[0]).toHaveLength(1);
    expect(simultaneous[1]).toEqual(simultaneous[0]);

    let threwAfterAcceptedCursor = false;
    const acceptedTimeout = new Proxy(ch, {
      get(target, property) {
        if (property === 'insert') return async (options: Parameters<ClickHouseClient['insert']>[0]) => {
          await target.insert(options);
          if (
            options.table === 'terminal_receipt_event_scan_cursors' &&
            !threwAfterAcceptedCursor
          ) {
            threwAfterAcceptedCursor = true;
            throw new Error('accepted terminal cursor timeout');
          }
        };
        const member: unknown = Reflect.get(target, property, target);
        return typeof member === 'function' ? member.bind(target) : member;
      },
    });
    const second = await listTerminalReceiptEventCandidates(acceptedTimeout, { limit: 1 });
    expect(second).toHaveLength(1);
    expect(second[0]?.receipt_id).not.toBe(simultaneous[0]?.[0]?.receipt_id);
    expect(terminalRows).toContainEqual(second[0]);
    expect(threwAfterAcceptedCursor).toBe(true);
    const restarted = createCh({ database: db });
    expect(await listTerminalReceiptEventCandidates(restarted, { limit: 1 })).toHaveLength(1);
    await restarted.close();

    await ch.command({ query: 'TRUNCATE TABLE global_message_receipts' });
    await ch.command({ query: 'TRUNCATE TABLE terminal_receipt_event_scan_cursors' });
    const repairInitial = await createReceipt(ch, {
      ...receipt(),
      created_at: '2033-01-01T00:00:00.000Z',
    });
    expect(await listTerminalReceiptEventCandidates(ch, { limit: 1 })).toEqual([]);
    const repaired = await appendReceiptVersion(ch, {
      expectedVersion: repairInitial.receipt_version,
      next: { ...repairInitial, state: 'processed' },
    });
    const repairRestart = createCh({ database: db });
    expect(await listTerminalReceiptEventCandidates(repairRestart, { limit: 1 }))
      .toEqual([repaired]);
    await repairRestart.close();
    const cursor = await ch.query({
      query: `SELECT toString(max(generation)) AS generation
        FROM terminal_receipt_event_scan_cursors`,
      format: 'JSONEachRow',
    });
    const cursorRows = await cursor.json<{ generation: string }>();
    expect(BigInt(cursorRows[0]!.generation)).toBeGreaterThanOrEqual(1n);
  }, 30_000);

  it('terminal event taramasi 50k veride bounded global mirror ve PK pruning kullanir', async () => {
    await ch.command({ query: 'TRUNCATE TABLE global_message_receipts' });
    await ch.command({ query: 'TRUNCATE TABLE terminal_receipt_event_scan_cursors' });
    const markerInitial = await createReceipt(ch, receipt());
    await appendReceiptVersion(ch, {
      expectedVersion: markerInitial.receipt_version,
      next: { ...markerInitial, state: 'processed' },
    });
    await listTerminalReceiptEventCandidates(ch, { limit: 1 });
    const scopeResult = await ch.query({
      query: `SELECT scan_recipient_id
        FROM terminal_receipt_event_scan_cursors
        ORDER BY generation DESC, cursor_bucket DESC, cursor_created_at DESC,
          cursor_project_id DESC, cursor_receipt_id DESC
        LIMIT 1`,
      format: 'JSONEachRow',
    });
    const scope = (await scopeResult.json<{ scan_recipient_id: string }>())[0]!
      .scan_recipient_id;
    await ch.command({ query: 'TRUNCATE TABLE global_message_receipts' });
    await ch.command({ query: 'TRUNCATE TABLE terminal_receipt_event_scan_cursors' });

    let targetReceiptId = randomUUID();
    let targetBucket = await receiptScanBucket(targetReceiptId);
    while (targetBucket < 48) {
      targetReceiptId = randomUUID();
      targetBucket = await receiptScanBucket(targetReceiptId);
    }
    const recipientId = randomUUID();
    const rows = Array.from({ length: 50_000 }, (_, index) => ({
      receipt_id: index === 0 ? targetReceiptId : randomUUID(),
      message_id: randomUUID(),
      project_id: randomUUID(),
      recipient_id: recipientId,
      recipient_snapshot_json: canonicalJsonV1({ type: 'agent', id: recipientId }),
      receipt_version: '1',
      state: index === 0 ? 'processed' : 'enqueued',
      claim_owner: '',
      claim_fence: '0',
      claim_expires_at: null,
      retry_count: 0,
      next_attempt_at: null,
      error: '',
      created_at: new Date(Date.parse('2040-01-01T00:00:00.000Z') + index).toISOString(),
    }));
    await ch.insert({ table: 'message_receipts', values: rows, format: 'JSONEachRow' });
    await ch.insert({
      table: 'terminal_receipt_event_scan_cursors',
      values: [{
        scan_recipient_id: scope,
        generation: '0',
        cursor_bucket: targetBucket,
        cursor_created_at: '1970-01-01T00:00:00.000Z',
        cursor_project_id: NIL_UUID,
        cursor_receipt_id: NIL_UUID,
      }],
      format: 'JSONEachRow',
    });
    const observedQueries: string[] = [];
    const observed = new Proxy(ch, {
      get(target, property) {
        if (property === 'query') return (options: Parameters<ClickHouseClient['query']>[0]) => {
          observedQueries.push(String(options.query));
          return target.query(options);
        };
        const member: unknown = Reflect.get(target, property, target);
        return typeof member === 'function' ? member.bind(target) : member;
      },
    });
    expect(await listTerminalReceiptEventCandidates(observed, { limit: 1 }))
      .toMatchObject([{ receipt_id: targetReceiptId, state: 'processed' }]);
    expect(observedQueries.some((query) => (
      query.includes('FROM global_message_receipts') &&
      query.includes('LIMIT {candidateLimit:UInt32}')
    ))).toBe(true);
    expect(observedQueries.every((query) => !query.includes(' FINAL'))).toBe(true);

    const explanation = await ch.query({
      query: `EXPLAIN indexes = 1
        SELECT project_id, receipt_id FROM global_message_receipts
        PREWHERE scan_bucket >= {scanBucket:UInt8}
          AND tuple(scan_bucket, created_at, project_id, receipt_id) >
          tuple({scanBucket:UInt8}, {cursorCreatedAt:DateTime64(3, 'UTC')},
            {cursorProjectId:UUID}, {cursorReceiptId:UUID})
        ORDER BY scan_bucket, created_at, project_id, receipt_id, receipt_version, claim_fence
        LIMIT 101`,
      query_params: {
        scanBucket: targetBucket,
        cursorCreatedAt: '1970-01-01 00:00:00.000',
        cursorProjectId: NIL_UUID,
        cursorReceiptId: NIL_UUID,
      },
      format: 'JSONEachRow',
    });
    const explainText = (await explanation.json<{ explain: string }>())
      .map((row) => row.explain)
      .join('\n');
    const granules = [...explainText.matchAll(/Granules: (\d+)\/(\d+)/g)]
      .map((match) => ({ selected: Number(match[1]), total: Number(match[2]) }));
    expect(
      granules.some(({ selected, total }) => total >= 6 && selected < total),
      explainText,
    ).toBe(true);
  }, 30_000);

  it('append receipt kimlik alanlarini degistiremez', async () => {
    const initial = await createReceipt(ch, receipt());
    await expect(appendReceiptVersion(ch, {
      expectedVersion: initial.receipt_version,
      next: { ...initial, message_id: randomUUID(), state: 'processed' },
    })).rejects.toBeInstanceOf(RepositoryConflictError);
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
