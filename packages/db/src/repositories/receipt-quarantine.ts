import type { ClickHouseClient } from '@clickhouse/client';
import { EntityIdSchema, canonicalSha256V1, type EntityId } from '@ww/shared';
import {
  INVALID_DUE_RECEIPT_CODES,
  dueMessageReceiptCandidateId,
  type InvalidDueMessageReceiptCandidate,
} from './receipts.js';
import { concreteEntityId, storedUuid } from './identifiers.js';
import {
  RepositoryConflictError,
  RepositoryWriteError,
  StoredRecordError,
  readRowsAfterAcknowledgedWrite,
  readAfterUncertainWrite,
  storedDateTime,
  storedEnum,
  storedRecord,
  storedString,
  storedUInt64,
  uncertainWriteError,
  type UInt64String,
} from './types.js';

export interface DueMessageReceiptQuarantineRecord {
  readonly quarantineId: EntityId;
  readonly projectId: EntityId;
  readonly receiptId: EntityId;
  readonly messageId: EntityId;
  readonly receiptVersion: UInt64String;
  readonly claimFence: UInt64String;
  readonly candidateId: string;
  readonly reasonCode: (typeof INVALID_DUE_RECEIPT_CODES)[number];
  readonly summary: string;
  readonly quarantinedAt: string;
}

const QUARANTINE_COLUMNS = `quarantine_id, project_id, receipt_id, message_id,
  receipt_version, claim_fence, candidate_id, reason_code, summary, quarantined_at`;
const SUMMARY_BY_CODE = Object.freeze({
  stored_record_invalid: 'latest receipt candidate failed stored-record validation',
  latest_candidate_conflict: 'latest receipt candidate has conflicting rows',
});

function deterministicQuarantineId(candidateId: string): EntityId {
  const hex = canonicalSha256V1({
    namespace: 'message-receipt-quarantine-v1',
    candidateId,
  });
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return EntityIdSchema.parse(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`,
  );
}

function parseQuarantineRecord(value: unknown): DueMessageReceiptQuarantineRecord {
  const row = storedRecord(value, 'message_receipt_quarantine');
  const candidateId = storedString(row['candidate_id'], 'message_receipt_quarantine.candidate_id');
  if (!/^[a-f0-9]{64}$/.test(candidateId)) {
    throw new StoredRecordError('message_receipt_quarantine.candidate_id', candidateId);
  }
  return Object.freeze({
    quarantineId: concreteEntityId(
      storedUuid(row['quarantine_id'], 'message_receipt_quarantine.quarantine_id'),
      'message_receipt_quarantine.quarantine_id',
    ),
    projectId: concreteEntityId(
      storedUuid(row['project_id'], 'message_receipt_quarantine.project_id'),
      'message_receipt_quarantine.project_id',
    ),
    receiptId: concreteEntityId(
      storedUuid(row['receipt_id'], 'message_receipt_quarantine.receipt_id'),
      'message_receipt_quarantine.receipt_id',
    ),
    messageId: concreteEntityId(
      storedUuid(row['message_id'], 'message_receipt_quarantine.message_id'),
      'message_receipt_quarantine.message_id',
    ),
    receiptVersion: storedUInt64(
      row['receipt_version'],
      'message_receipt_quarantine.receipt_version',
    ),
    claimFence: storedUInt64(row['claim_fence'], 'message_receipt_quarantine.claim_fence'),
    candidateId,
    reasonCode: storedEnum(
      row['reason_code'],
      INVALID_DUE_RECEIPT_CODES,
      'message_receipt_quarantine.reason_code',
    ),
    summary: storedString(row['summary'], 'message_receipt_quarantine.summary'),
    quarantinedAt: storedDateTime(
      row['quarantined_at'],
      'message_receipt_quarantine.quarantined_at',
    ),
  });
}

function toStoredRecord(
  candidate: InvalidDueMessageReceiptCandidate,
  quarantinedAt: string,
): DueMessageReceiptQuarantineRecord {
  const expectedCandidateId = dueMessageReceiptCandidateId(candidate);
  if (candidate.candidateId !== expectedCandidateId) {
    throw new StoredRecordError('message receipt quarantine candidateId', candidate);
  }
  const expectedSummary = SUMMARY_BY_CODE[candidate.code];
  if (candidate.summary !== expectedSummary) {
    throw new StoredRecordError('message receipt quarantine summary', candidate.summary);
  }
  return Object.freeze({
    quarantineId: deterministicQuarantineId(candidate.candidateId),
    projectId: concreteEntityId(candidate.projectId, 'candidate.projectId'),
    receiptId: concreteEntityId(candidate.receiptId, 'candidate.receiptId'),
    messageId: concreteEntityId(candidate.messageId, 'candidate.messageId'),
    receiptVersion: storedUInt64(candidate.receiptVersion, 'candidate.receiptVersion'),
    claimFence: storedUInt64(candidate.claimFence, 'candidate.claimFence'),
    candidateId: candidate.candidateId,
    reasonCode: storedEnum(candidate.code, INVALID_DUE_RECEIPT_CODES, 'candidate.code'),
    summary: expectedSummary,
    quarantinedAt: storedDateTime(quarantinedAt, 'quarantinedAt'),
  });
}

function insertRow(record: DueMessageReceiptQuarantineRecord): Record<string, unknown> {
  return {
    quarantine_id: record.quarantineId,
    project_id: record.projectId,
    receipt_id: record.receiptId,
    message_id: record.messageId,
    receipt_version: record.receiptVersion,
    claim_fence: record.claimFence,
    candidate_id: record.candidateId,
    reason_code: record.reasonCode,
    summary: record.summary,
    quarantined_at: record.quarantinedAt,
  };
}

async function readQuarantineRows(
  ch: ClickHouseClient,
  quarantineId: EntityId,
): Promise<DueMessageReceiptQuarantineRecord[]> {
  const result = await ch.query({
    query: `SELECT ${QUARANTINE_COLUMNS} FROM message_receipt_quarantine
      WHERE quarantine_id = {quarantineId:UUID}`,
    query_params: { quarantineId },
    format: 'JSONEachRow',
  });
  return (await result.json<unknown>()).map(parseQuarantineRecord);
}

function reconcileQuarantine(
  expected: DueMessageReceiptQuarantineRecord,
  observed: readonly DueMessageReceiptQuarantineRecord[],
): DueMessageReceiptQuarantineRecord {
  if (observed.length === 0) {
    throw new RepositoryWriteError(`receipt quarantine:${expected.quarantineId} okunamadi`);
  }
  const evidenceHash = (record: DueMessageReceiptQuarantineRecord): string => (
    canonicalSha256V1({
      quarantineId: record.quarantineId,
      projectId: record.projectId,
      receiptId: record.receiptId,
      messageId: record.messageId,
      receiptVersion: record.receiptVersion,
      claimFence: record.claimFence,
      candidateId: record.candidateId,
      reasonCode: record.reasonCode,
      summary: record.summary,
    })
  );
  const hash = evidenceHash(expected);
  if (observed.some((record) => evidenceHash(record) !== hash)) {
    throw new RepositoryConflictError(
      `receipt quarantine:${expected.quarantineId} immutable kanit catismasi`,
    );
  }
  return observed.reduce((earliest, record) => (
    record.quarantinedAt < earliest.quarantinedAt ? record : earliest
  ));
}

export async function quarantineDueMessageReceiptCandidate(
  ch: ClickHouseClient,
  candidate: InvalidDueMessageReceiptCandidate,
  quarantinedAt: string,
): Promise<DueMessageReceiptQuarantineRecord> {
  const expected = toStoredRecord(candidate, quarantinedAt);
  const read = (): Promise<DueMessageReceiptQuarantineRecord[]> => (
    readQuarantineRows(ch, expected.quarantineId)
  );
  const existing = await read();
  if (existing.length > 0) return reconcileQuarantine(expected, existing);
  try {
    await ch.insert({
      table: 'message_receipt_quarantine',
      values: [insertRow(expected)],
      format: 'JSONEachRow',
    });
  } catch (error) {
    const observed = await readAfterUncertainWrite(
      `receipt quarantine:${expected.quarantineId}`,
      error,
      read,
    );
    if (observed.length === 0) {
      throw uncertainWriteError(`receipt quarantine:${expected.quarantineId}`, error);
    }
    return reconcileQuarantine(expected, observed);
  }
  return reconcileQuarantine(expected, await readRowsAfterAcknowledgedWrite(
    `receipt quarantine:${expected.quarantineId}`,
    expected,
    read,
  ));
}
