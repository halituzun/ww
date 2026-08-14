import type { ClickHouseClient } from '@clickhouse/client';
import {
  MESSAGE_RECEIPT_STATES,
  PartyRefV1Schema,
  canonicalJsonV1,
  canonicalSha256V1,
  type EntityId,
  type MessageReceiptState,
  type PartyRefV1,
} from '@ww/shared';
import { concreteEntityId, storedUuid } from './identifiers.js';
import {
  RepositoryConflictError,
  RepositoryNotFoundError,
  RepositoryWriteError,
  StoredRecordError,
  assertExpectedVersion,
  nextRepositoryVersion,
  readRowsAfterAcknowledgedWrite,
  readAfterUncertainWrite,
  storedDateTime,
  storedEnum,
  storedJsonValue,
  storedRecord,
  storedString,
  storedUInt64,
  storedUnsignedInteger,
  uncertainWriteError,
  type UInt64String,
} from './types.js';

export interface MessageReceiptRow {
  readonly receipt_id: EntityId;
  readonly message_id: EntityId;
  readonly project_id: EntityId;
  readonly recipient_id: string;
  readonly recipient_snapshot: PartyRefV1;
  readonly receipt_version: UInt64String;
  readonly state: MessageReceiptState;
  readonly claim_owner: string;
  readonly claim_fence: UInt64String;
  readonly claim_expires_at?: string;
  readonly retry_count: number;
  readonly next_attempt_at?: string;
  readonly error: string;
  readonly created_at: string;
}

export type CreateMessageReceiptInput = Omit<MessageReceiptRow, 'receipt_version'>;

export interface AppendMessageReceiptVersionInput {
  readonly expectedVersion: UInt64String;
  readonly next: Omit<MessageReceiptRow, 'receipt_version'>;
}

interface StoredReceiptRow {
  readonly receipt_id: string;
  readonly message_id: string;
  readonly project_id: string;
  readonly recipient_id: string;
  readonly recipient_snapshot_json: string;
  readonly receipt_version: UInt64String;
  readonly state: string;
  readonly claim_owner: string;
  readonly claim_fence: UInt64String;
  readonly claim_expires_at: string | null;
  readonly retry_count: number;
  readonly next_attempt_at: string | null;
  readonly error: string;
  readonly created_at: string;
}

const RECEIPT_COLUMNS = `receipt_id, message_id, project_id, recipient_id,
  recipient_snapshot_json, receipt_version, state, claim_owner, claim_fence,
  claim_expires_at, retry_count, next_attempt_at, error, created_at`;

function optionalDateTime(value: unknown, context: string): string | undefined {
  return value === null ? undefined : storedDateTime(value, context);
}

function validateState(row: MessageReceiptRow): MessageReceiptRow {
  if (
    row.state === 'claimed' &&
    (row.claim_owner.length === 0 || row.claim_fence === '0' || row.claim_expires_at === undefined)
  ) {
    throw new StoredRecordError('message_receipts claimed state', row);
  }
  if (
    row.state === 'retry_scheduled' &&
    (row.retry_count === 0 || row.next_attempt_at === undefined)
  ) {
    throw new StoredRecordError('message_receipts retry_scheduled state', row);
  }
  return row;
}

function parseReceiptRow(value: unknown): MessageReceiptRow {
  const row = storedRecord(value, 'message_receipts');
  try {
    const recipientId = storedUuid(row['recipient_id'], 'message_receipts.recipient_id');
    const recipientSnapshotJson = storedString(
      row['recipient_snapshot_json'],
      'message_receipts.recipient_snapshot_json',
    );
    const recipientSnapshot = PartyRefV1Schema.parse(storedJsonValue(
      recipientSnapshotJson,
      'message_receipts.recipient_snapshot_json',
    ));
    if (recipientSnapshotJson !== canonicalJsonV1(recipientSnapshot)) {
      throw new StoredRecordError('message_receipts recipient snapshot canonical', row);
    }
    if (recipientSnapshot.id !== recipientId) {
      throw new StoredRecordError('message_receipts recipient snapshot', row);
    }
    const claimExpiresAt = optionalDateTime(
      row['claim_expires_at'],
      'message_receipts.claim_expires_at',
    );
    const nextAttemptAt = optionalDateTime(
      row['next_attempt_at'],
      'message_receipts.next_attempt_at',
    );
    return validateState(Object.freeze({
      receipt_id: concreteEntityId(
        storedUuid(row['receipt_id'], 'message_receipts.receipt_id'),
        'message_receipts.receipt_id',
      ),
      message_id: concreteEntityId(
        storedUuid(row['message_id'], 'message_receipts.message_id'),
        'message_receipts.message_id',
      ),
      project_id: concreteEntityId(
        storedUuid(row['project_id'], 'message_receipts.project_id'),
        'message_receipts.project_id',
      ),
      recipient_id: recipientId,
      recipient_snapshot: recipientSnapshot,
      receipt_version: storedUInt64(
        row['receipt_version'],
        'message_receipts.receipt_version',
      ),
      state: storedEnum(row['state'], MESSAGE_RECEIPT_STATES, 'message_receipts.state'),
      claim_owner: storedString(row['claim_owner'], 'message_receipts.claim_owner'),
      claim_fence: storedUInt64(row['claim_fence'], 'message_receipts.claim_fence'),
      ...(claimExpiresAt === undefined ? {} : { claim_expires_at: claimExpiresAt }),
      retry_count: storedUnsignedInteger(
        row['retry_count'],
        'message_receipts.retry_count',
        4_294_967_295,
      ),
      ...(nextAttemptAt === undefined ? {} : { next_attempt_at: nextAttemptAt }),
      error: storedString(row['error'], 'message_receipts.error'),
      created_at: storedDateTime(row['created_at'], 'message_receipts.created_at'),
    }));
  } catch (error) {
    if (error instanceof StoredRecordError) throw error;
    throw new StoredRecordError('message_receipts', error);
  }
}

function toStoredRow(
  input: Omit<MessageReceiptRow, 'receipt_version'>,
  receiptVersion: UInt64String,
): StoredReceiptRow {
  const parsed = parseReceiptRow({
    ...input,
    recipient_snapshot_json: canonicalJsonV1(input.recipient_snapshot),
    receipt_version: receiptVersion,
    claim_expires_at: input.claim_expires_at ?? null,
    next_attempt_at: input.next_attempt_at ?? null,
  });
  return {
    receipt_id: parsed.receipt_id,
    message_id: parsed.message_id,
    project_id: parsed.project_id,
    recipient_id: parsed.recipient_id,
    recipient_snapshot_json: canonicalJsonV1(parsed.recipient_snapshot),
    receipt_version: parsed.receipt_version,
    state: parsed.state,
    claim_owner: parsed.claim_owner,
    claim_fence: parsed.claim_fence,
    claim_expires_at: parsed.claim_expires_at ?? null,
    retry_count: parsed.retry_count,
    next_attempt_at: parsed.next_attempt_at ?? null,
    error: parsed.error,
    created_at: parsed.created_at,
  };
}

async function readReceiptVersion(
  ch: ClickHouseClient,
  projectId: EntityId,
  receiptId: EntityId,
  receiptVersion: UInt64String,
): Promise<MessageReceiptRow[]> {
  const result = await ch.query({
    query: `SELECT ${RECEIPT_COLUMNS} FROM message_receipts
      WHERE project_id = {projectId:UUID} AND receipt_id = {receiptId:UUID}
        AND receipt_version = {receiptVersion:UInt64}`,
    query_params: { projectId, receiptId, receiptVersion },
    format: 'JSONEachRow',
  });
  return (await result.json<unknown>()).map(parseReceiptRow);
}

function reconcileReceipt(
  expected: MessageReceiptRow,
  observed: readonly MessageReceiptRow[],
): MessageReceiptRow {
  if (observed.length === 0) {
    throw new RepositoryWriteError(`receipt:${expected.receipt_id} yazimi yeniden okunamadi`);
  }
  const expectedHash = canonicalSha256V1(expected);
  if (observed.some((row) => canonicalSha256V1(row) !== expectedHash)) {
    throw new RepositoryConflictError(
      `receipt:${expected.receipt_id} ayni surum icin farkli icerik barindiriyor`,
    );
  }
  return expected;
}

function receiptContentHash(row: MessageReceiptRow): string {
  return canonicalSha256V1({
    receipt_id: row.receipt_id,
    message_id: row.message_id,
    project_id: row.project_id,
    recipient_id: row.recipient_id,
    recipient_snapshot: row.recipient_snapshot,
    state: row.state,
    claim_owner: row.claim_owner,
    claim_fence: row.claim_fence,
    ...(row.claim_expires_at === undefined ? {} : {
      claim_expires_at: row.claim_expires_at,
    }),
    retry_count: row.retry_count,
    ...(row.next_attempt_at === undefined ? {} : { next_attempt_at: row.next_attempt_at }),
    error: row.error,
    created_at: row.created_at,
  });
}

function receiptIdentityHash(row: MessageReceiptRow): string {
  return canonicalSha256V1({
    receipt_id: row.receipt_id,
    message_id: row.message_id,
    project_id: row.project_id,
    recipient_id: row.recipient_id,
    recipient_snapshot: row.recipient_snapshot,
    created_at: row.created_at,
  });
}

async function insertAndReconcile(
  ch: ClickHouseClient,
  stored: StoredReceiptRow,
  expected: MessageReceiptRow,
): Promise<MessageReceiptRow> {
  const entity = `receipt:${expected.receipt_id}`;
  const read = (): Promise<MessageReceiptRow[]> => readReceiptVersion(
    ch,
    expected.project_id,
    expected.receipt_id,
    expected.receipt_version,
  );
  try {
    await ch.insert({ table: 'message_receipts', values: [stored], format: 'JSONEachRow' });
  } catch (error) {
    const observed = await readAfterUncertainWrite(entity, error, read);
    if (observed.length === 0) throw uncertainWriteError(entity, error);
    return reconcileReceipt(expected, observed);
  }
  const observed = await readRowsAfterAcknowledgedWrite(entity, expected, read);
  return reconcileReceipt(expected, observed);
}

export async function getLatestReceipt(
  ch: ClickHouseClient,
  projectId: string,
  receiptId: string,
): Promise<MessageReceiptRow | null> {
  const project = concreteEntityId(projectId, 'projectId');
  const receipt = concreteEntityId(receiptId, 'receiptId');
  const result = await ch.query({
    query: `SELECT ${RECEIPT_COLUMNS} FROM message_receipts
      WHERE project_id = {projectId:UUID} AND receipt_id = {receiptId:UUID}`,
    query_params: { projectId: project, receiptId: receipt },
    format: 'JSONEachRow',
  });
  const rows = (await result.json<unknown>()).map(parseReceiptRow);
  if (rows.length === 0) return null;
  const identityHash = receiptIdentityHash(rows[0]!);
  if (rows.some((row) => receiptIdentityHash(row) !== identityHash)) {
    throw new RepositoryConflictError(`receipt:${receipt} gecmisinde kimlik catismasi var`);
  }
  const maximum = rows.reduce(
    (max, row) => BigInt(row.receipt_version) > max ? BigInt(row.receipt_version) : max,
    0n,
  ).toString();
  const latest = rows.filter((row) => row.receipt_version === maximum);
  return reconcileReceipt(latest[0]!, latest);
}

export async function listLatestReceiptsByState(
  ch: ClickHouseClient,
  projectId: string,
  recipientId: string,
  state: MessageReceiptState,
): Promise<MessageReceiptRow[]> {
  const project = concreteEntityId(projectId, 'projectId');
  const recipient = storedUuid(recipientId, 'recipientId');
  const receiptState = storedEnum(state, MESSAGE_RECEIPT_STATES, 'receiptState');
  const result = await ch.query({
    query: `SELECT ${RECEIPT_COLUMNS} FROM message_receipts
      WHERE project_id = {projectId:UUID} AND recipient_id = {recipientId:UUID}
        AND (receipt_id, receipt_version) IN (
          SELECT receipt_id, max(receipt_version) FROM message_receipts
          WHERE project_id = {projectId:UUID} AND recipient_id = {recipientId:UUID}
          GROUP BY receipt_id
        )
      ORDER BY receipt_id`,
    query_params: { projectId: project, recipientId: recipient },
    format: 'JSONEachRow',
  });
  const grouped = new Map<string, MessageReceiptRow[]>();
  for (const row of (await result.json<unknown>()).map(parseReceiptRow)) {
    const rows = grouped.get(row.receipt_id) ?? [];
    rows.push(row);
    grouped.set(row.receipt_id, rows);
  }
  return [...grouped.values()]
    .map((rows) => reconcileReceipt(rows[0]!, rows))
    .filter((row) => row.state === receiptState);
}

export async function createReceipt(
  ch: ClickHouseClient,
  input: CreateMessageReceiptInput,
): Promise<MessageReceiptRow> {
  const projectId = concreteEntityId(input.project_id, 'projectId');
  const receiptId = concreteEntityId(input.receipt_id, 'receiptId');
  if (
    input.state !== 'enqueued' || input.claim_owner !== '' || input.claim_fence !== '0' ||
    input.claim_expires_at !== undefined || input.retry_count !== 0 ||
    input.next_attempt_at !== undefined || input.error !== ''
  ) {
    throw new StoredRecordError('receipt initial state', input);
  }
  const current = await getLatestReceipt(ch, projectId, receiptId);
  if (current !== null) {
    const desired = parseReceiptRow(toStoredRow(
      { ...input, project_id: projectId, receipt_id: receiptId },
      current.receipt_version,
    ));
    if (receiptIdentityHash(current) === receiptIdentityHash(desired)) return current;
    throw new RepositoryConflictError(`receipt zaten farkli icerikle var: ${receiptId}`);
  }
  const stored = toStoredRow(
    { ...input, project_id: projectId, receipt_id: receiptId },
    nextRepositoryVersion(),
  );
  const expected = parseReceiptRow(stored);
  return insertAndReconcile(ch, stored, expected);
}

export async function appendReceiptVersion(
  ch: ClickHouseClient,
  input: AppendMessageReceiptVersionInput,
): Promise<MessageReceiptRow> {
  const projectId = concreteEntityId(input.next.project_id, 'projectId');
  const receiptId = concreteEntityId(input.next.receipt_id, 'receiptId');
  const current = await getLatestReceipt(ch, projectId, receiptId);
  if (current === null) throw new RepositoryNotFoundError(`receipt bulunamadi: ${receiptId}`);
  const expectedVersion = storedUInt64(input.expectedVersion, 'expectedVersion');
  if (current.receipt_version !== expectedVersion) {
    if (BigInt(current.receipt_version) < BigInt(expectedVersion)) {
      assertExpectedVersion(`receipt:${receiptId}`, current.receipt_version, expectedVersion);
    }
    const desired = parseReceiptRow(toStoredRow(
      { ...input.next, project_id: projectId, receipt_id: receiptId },
      current.receipt_version,
    ));
    if (
      receiptContentHash(current) === receiptContentHash(desired)
    ) return current;
    assertExpectedVersion(`receipt:${receiptId}`, current.receipt_version, expectedVersion);
  }
  const stored = toStoredRow(
    { ...input.next, project_id: projectId, receipt_id: receiptId },
    nextRepositoryVersion(current.receipt_version),
  );
  const expected = parseReceiptRow(stored);
  if (
    expected.message_id !== current.message_id ||
    expected.recipient_id !== current.recipient_id ||
    canonicalSha256V1(expected.recipient_snapshot) !==
      canonicalSha256V1(current.recipient_snapshot) ||
    expected.created_at !== current.created_at
  ) {
    throw new RepositoryConflictError(`receipt kimlik snapshotu degistirilemez: ${receiptId}`);
  }
  return insertAndReconcile(ch, stored, expected);
}
