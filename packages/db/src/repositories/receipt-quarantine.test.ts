import { randomUUID } from 'node:crypto';
import type { ClickHouseClient } from '@clickhouse/client';
import { canonicalJsonV1 } from '@ww/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCh } from '../client.js';
import { runMigrations } from '../migrate.js';
import { clickhouseUp } from '../testutil.js';
import { quarantineDueMessageReceiptCandidate } from './receipt-quarantine.js';
import {
  createReceipt,
  listDueMessageReceiptCandidates,
  type CreateMessageReceiptInput,
} from './receipts.js';
import { RepositoryConflictError, StoredRecordError } from './types.js';

const up = await clickhouseUp();

describe.skipIf(!up)('message receipt quarantine repository', () => {
  const db = `ww_test_receipt_quarantine_${Date.now()}_${process.pid}`;
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

  function receipt(recipientId: string): CreateMessageReceiptInput {
    return {
      receipt_id: randomUUID(),
      message_id: randomUUID(),
      project_id: randomUUID(),
      recipient_id: recipientId,
      recipient_snapshot: { type: 'agent', id: recipientId },
      state: 'enqueued',
      claim_owner: '',
      claim_fence: '0',
      retry_count: 0,
      error: '',
      created_at: '2026-08-14T12:00:00.000Z',
    };
  }

  function malformedRow(input: CreateMessageReceiptInput, index = 0): Record<string, unknown> {
    return {
      receipt_id: input.receipt_id,
      message_id: input.message_id,
      project_id: input.project_id,
      recipient_id: input.recipient_id,
      recipient_snapshot_json: `{bad-json-${index}`,
      receipt_version: '1',
      state: 'enqueued',
      claim_owner: '',
      claim_fence: '0',
      claim_expires_at: null,
      retry_count: 0,
      next_attempt_at: null,
      error: '',
      created_at: input.created_at,
    };
  }

  it('150 poison adayi bounded turlarda quarantine ederek saglikli receipt icin ilerler', async () => {
    const recipientId = randomUUID();
    const poison = Array.from({ length: 150 }, (_, index) => {
      const input = { ...receipt(recipientId), created_at: '2026-08-14T11:59:00.000Z' };
      return malformedRow(input, index);
    });
    await ch.insert({ table: 'message_receipts', values: poison, format: 'JSONEachRow' });
    const healthy = await createReceipt(ch, receipt(recipientId));
    const options = {
      now: '2026-08-14T12:01:00.000Z',
      recipientId,
      limit: 1,
    } as const;

    const quarantined = new Set<string>();
    let healthySeen = false;
    for (let poll = 0; poll < 256 && (
      quarantined.size < poison.length || !healthySeen
    ); poll += 1) {
      const page = await listDueMessageReceiptCandidates(ch, options);
      healthySeen ||= page.valid.some((candidate) => candidate.receipt_id === healthy.receipt_id);
      for (const invalid of page.invalid) {
        await quarantineDueMessageReceiptCandidate(
          ch,
          invalid,
          '2026-08-14T12:01:01.000Z',
        );
        quarantined.add(invalid.candidateId);
      }
    }
    expect(quarantined.size).toBe(poison.length);
    expect(healthySeen).toBe(true);

    let healthySeenAgain = false;
    for (let poll = 0; poll < 70 && !healthySeenAgain; poll += 1) {
      const page = await listDueMessageReceiptCandidates(ch, options);
      expect(page.invalid).toEqual([]);
      healthySeenAgain ||= page.valid.some((candidate) => candidate.receipt_id === healthy.receipt_id);
    }
    expect(healthySeenAgain).toBe(true);
  }, 30_000);

  it('quarantine exact retryyi uzlastirir, forged evidence ve immutable collisioni reddeder', async () => {
    const recipientId = randomUUID();
    const input = receipt(recipientId);
    await ch.insert({
      table: 'message_receipts',
      values: [malformedRow(input)],
      format: 'JSONEachRow',
    });
    const candidate = (await listDueMessageReceiptCandidates(ch, {
      now: '2026-08-14T12:01:00.000Z',
      recipientId,
      limit: 1,
    })).invalid[0]!;
    expect(candidate).toMatchObject({ receiptVersion: '1', claimFence: '0' });
    expect(candidate.observationHash).toMatch(/^[a-f0-9]{64}$/);
    const at = '2026-08-14T12:01:00.000Z';
    const stored = await quarantineDueMessageReceiptCandidate(ch, candidate, at);
    expect(await quarantineDueMessageReceiptCandidate(ch, candidate, at)).toEqual(stored);
    expect(await quarantineDueMessageReceiptCandidate(
      ch,
      candidate,
      '2026-08-14T12:02:00.000Z',
    )).toEqual(stored);

    await expect(quarantineDueMessageReceiptCandidate(ch, {
      ...candidate,
      observationHash: '0'.repeat(64),
    }, at)).rejects.toBeInstanceOf(StoredRecordError);

    await ch.insert({
      table: 'message_receipt_quarantine',
      values: [{
        quarantine_id: stored.quarantineId,
        project_id: stored.projectId,
        receipt_id: stored.receiptId,
        message_id: stored.messageId,
        receipt_version: stored.receiptVersion,
        claim_fence: stored.claimFence,
        candidate_id: stored.candidateId,
        reason_code: stored.reasonCode,
        summary: 'divergent immutable evidence',
        quarantined_at: stored.quarantinedAt,
      }],
      format: 'JSONEachRow',
    });
    await expect(quarantineDueMessageReceiptCandidate(ch, candidate, at))
      .rejects.toBeInstanceOf(RepositoryConflictError);
  });

  it('quarantine yalniz exact version/fence adayini dislar; yeni valid surum yeniden girer', async () => {
    const recipientId = randomUUID();
    const input = receipt(recipientId);
    await ch.insert({
      table: 'message_receipts',
      values: [malformedRow(input)],
      format: 'JSONEachRow',
    });
    const options = {
      now: '2026-08-14T12:01:00.000Z',
      recipientId,
      limit: 10,
    } as const;
    const invalid = (await listDueMessageReceiptCandidates(ch, options)).invalid[0]!;
    await quarantineDueMessageReceiptCandidate(ch, invalid, options.now);
    expect(await listDueMessageReceiptCandidates(ch, options)).toEqual({ valid: [], invalid: [] });

    await ch.insert({
      table: 'message_receipts',
      values: [{
        ...malformedRow(input),
        recipient_snapshot_json: canonicalJsonV1(input.recipient_snapshot),
        receipt_version: '2',
      }],
      format: 'JSONEachRow',
    });
    await ch.command({ query: 'OPTIMIZE TABLE message_receipt_quarantine FINAL' });
    await ch.command({ query: 'OPTIMIZE TABLE recipient_message_receipts FINAL' });
    await ch.command({ query: 'OPTIMIZE TABLE receipt_message_receipts FINAL' });
    expect(await listDueMessageReceiptCandidates(ch, options)).toMatchObject({
      valid: [{ receipt_id: input.receipt_id, receipt_version: '2' }],
      invalid: [],
    });
  });
});
