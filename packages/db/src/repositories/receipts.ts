import type { ClickHouseClient } from '@clickhouse/client';
import {
  MESSAGE_RECEIPT_STATES,
  NIL_UUID,
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

export interface ListDueMessageReceiptsOptions {
  readonly now: string;
  readonly recipientId?: string;
  readonly limit?: number;
}

export interface ListLatestReceiptsByMessageOptions {
  readonly limit?: number;
}

export interface ListTerminalReceiptEventCandidatesOptions {
  readonly limit?: number;
}

export const INVALID_DUE_RECEIPT_CODES = [
  'stored_record_invalid',
  'latest_candidate_conflict',
] as const;

export type InvalidDueMessageReceiptCode = (typeof INVALID_DUE_RECEIPT_CODES)[number];

export interface InvalidDueMessageReceiptCandidate {
  readonly code: InvalidDueMessageReceiptCode;
  readonly projectId: EntityId;
  readonly receiptId: EntityId;
  readonly messageId: EntityId;
  readonly receiptVersion: UInt64String;
  readonly claimFence: UInt64String;
  readonly observationHash: string;
  readonly candidateId: string;
  readonly summary: string;
}

export interface DueMessageReceiptCandidates {
  readonly valid: readonly MessageReceiptRow[];
  readonly invalid: readonly InvalidDueMessageReceiptCandidate[];
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
const DEFAULT_RECEIPT_READ_LIMIT = 100;
const MAX_RECEIPT_READ_LIMIT = 1_000;
const INVALID_RECEIPT_SCAN_BUFFER = 100;
const RECEIPT_SCAN_EPOCH = '1970-01-01T00:00:00.000Z';
const RECEIPT_SCAN_BUCKETS = 64;
const MAX_RECEIPT_SCAN_PAGES = 2;

type ReceiptScanCursorTable =
  | 'message_receipt_scan_cursors'
  | 'terminal_receipt_event_scan_cursors';

const DELIVERY_RECEIPT_SCAN_CURSOR_TABLE = 'message_receipt_scan_cursors';
const TERMINAL_RECEIPT_EVENT_SCAN_CURSOR_TABLE = 'terminal_receipt_event_scan_cursors';

interface ReceiptScanKey {
  readonly scanBucket: number;
  readonly createdAt: string;
  readonly projectId: string;
  readonly receiptId: string;
}

interface ReceiptScanCursor extends ReceiptScanKey {
  readonly generation: UInt64String;
}

function receiptReadLimit(value: number | undefined): number {
  const limit = storedUnsignedInteger(
    value ?? DEFAULT_RECEIPT_READ_LIMIT,
    'message_receipts.limit',
    MAX_RECEIPT_READ_LIMIT,
  );
  if (limit === 0) throw new StoredRecordError('message_receipts.limit', value);
  return limit;
}

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

function foldReceiptRows(
  receiptId: EntityId,
  rows: readonly MessageReceiptRow[],
): MessageReceiptRow {
  if (rows.length === 0) {
    throw new RepositoryWriteError(`receipt:${receiptId} yazimi yeniden okunamadi`);
  }
  const identityHash = receiptIdentityHash(rows[0]!);
  if (rows.some((row) => (
    row.receipt_id !== receiptId || receiptIdentityHash(row) !== identityHash
  ))) {
    throw new RepositoryConflictError(`receipt:${receiptId} gecmisinde kimlik catismasi var`);
  }
  const maximumVersion = rows.reduce(
    (max, row) => BigInt(row.receipt_version) > max ? BigInt(row.receipt_version) : max,
    0n,
  );
  const atVersion = rows.filter((row) => BigInt(row.receipt_version) === maximumVersion);
  const maximumFence = atVersion.reduce(
    (max, row) => BigInt(row.claim_fence) > max ? BigInt(row.claim_fence) : max,
    0n,
  );
  const candidates = atVersion.filter((row) => BigInt(row.claim_fence) === maximumFence);
  return reconcileReceipt(candidates[0]!, candidates);
}

function reconcileReceiptWrite(
  expected: MessageReceiptRow,
  observed: readonly MessageReceiptRow[],
): MessageReceiptRow {
  const winner = foldReceiptRows(expected.receipt_id, observed);
  return BigInt(winner.claim_fence) > BigInt(expected.claim_fence)
    ? winner
    : reconcileReceipt(
      expected,
      observed.filter((row) => row.claim_fence === expected.claim_fence),
    );
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
    return reconcileReceiptWrite(expected, observed);
  }
  const observed = await readRowsAfterAcknowledgedWrite(entity, expected, read);
  return reconcileReceiptWrite(expected, observed);
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
  return foldReceiptRows(receipt, rows);
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
      WHERE project_id = {projectId:UUID}
        AND receipt_id IN (
          SELECT receipt_id FROM message_receipts
          WHERE project_id = {projectId:UUID} AND recipient_id = {recipientId:UUID}
          GROUP BY receipt_id
        )
      ORDER BY receipt_id, receipt_version, claim_fence`,
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
    .map((rows) => foldReceiptRows(rows[0]!.receipt_id, rows))
    .filter((row) => row.recipient_id === recipient && row.state === receiptState);
}

function foldReceiptGroups(rows: readonly MessageReceiptRow[]): MessageReceiptRow[] {
  const grouped = new Map<string, MessageReceiptRow[]>();
  for (const row of rows) {
    const key = `${row.project_id}:${row.receipt_id}`;
    const duplicates = grouped.get(key) ?? [];
    duplicates.push(row);
    grouped.set(key, duplicates);
  }
  return [...grouped.values()].map((duplicates) => (
    foldReceiptRows(duplicates[0]!.receipt_id, duplicates)
  ));
}

function assertBoundedReceiptResult(
  rows: readonly MessageReceiptRow[],
  limit: number,
  context: string,
): MessageReceiptRow[] {
  if (rows.length > limit) {
    throw new RepositoryConflictError(
      `${context} sonucu ${limit} receipt sinirini asti`,
    );
  }
  return [...rows];
}

export async function listLatestReceiptsByMessage(
  ch: ClickHouseClient,
  projectId: string,
  messageId: string,
  options: ListLatestReceiptsByMessageOptions = {},
): Promise<MessageReceiptRow[]> {
  const project = concreteEntityId(projectId, 'projectId');
  const message = concreteEntityId(messageId, 'messageId');
  const limit = receiptReadLimit(options.limit);
  const candidateLimit = limit + 1;
  const result = await ch.query({
    query: `WITH message_receipt_keys AS
      (
        SELECT project_id, receipt_id
        FROM message_receipts
        PREWHERE message_id = {messageId:UUID}
        WHERE project_id = {projectId:UUID}
        GROUP BY project_id, receipt_id
      ),
      latest_receipt_candidates AS
      (
        SELECT * FROM
        (
          SELECT *, max(claim_fence) OVER
            (PARTITION BY project_id, receipt_id) AS maximum_claim_fence
          FROM
          (
            SELECT *, max(receipt_version) OVER
              (PARTITION BY project_id, receipt_id) AS maximum_receipt_version
            FROM receipt_message_receipts
            WHERE (project_id, receipt_id) IN
              (SELECT project_id, receipt_id FROM message_receipt_keys)
          )
          WHERE receipt_version = maximum_receipt_version
        )
        WHERE claim_fence = maximum_claim_fence
      ),
      bounded_receipt_keys AS
      (
        SELECT project_id, receipt_id
        FROM latest_receipt_candidates
        WHERE project_id = {projectId:UUID} AND message_id = {messageId:UUID}
        GROUP BY project_id, receipt_id
        ORDER BY min(recipient_id), receipt_id
        LIMIT {candidateLimit:UInt32}
      )
      SELECT ${RECEIPT_COLUMNS} FROM latest_receipt_candidates
      WHERE (project_id, receipt_id) IN
        (SELECT project_id, receipt_id FROM bounded_receipt_keys)
      ORDER BY recipient_id, receipt_id, receipt_version, claim_fence`,
    query_params: { projectId: project, messageId: message, candidateLimit },
    format: 'JSONEachRow',
  });
  const rows = foldReceiptGroups((await result.json<unknown>()).map(parseReceiptRow))
    .filter((row) => row.message_id === message);
  rows.sort((left, right) => (
    left.recipient_id.localeCompare(right.recipient_id) ||
    left.receipt_id.localeCompare(right.receipt_id)
  ));
  return assertBoundedReceiptResult(rows, limit, `message:${message}`);
}

function receiptIsDue(row: MessageReceiptRow, nowMs: number): boolean {
  if (row.state === 'enqueued') return true;
  if (row.state === 'retry_scheduled') {
    return row.next_attempt_at !== undefined && Date.parse(row.next_attempt_at) <= nowMs;
  }
  if (row.state === 'claimed') {
    return row.claim_expires_at !== undefined && Date.parse(row.claim_expires_at) <= nowMs;
  }
  return false;
}

function candidateEntityId(value: unknown, context: string): EntityId {
  return concreteEntityId(storedUuid(value, context), context);
}

export function dueMessageReceiptCandidateId(input: Omit<
  InvalidDueMessageReceiptCandidate,
  'candidateId' | 'summary'
>): string {
  const code = storedEnum(input.code, INVALID_DUE_RECEIPT_CODES, 'invalid receipt code');
  const projectId = concreteEntityId(input.projectId, 'invalid receipt projectId');
  const receiptId = concreteEntityId(input.receiptId, 'invalid receipt receiptId');
  const messageId = concreteEntityId(input.messageId, 'invalid receipt messageId');
  const receiptVersion = storedUInt64(input.receiptVersion, 'invalid receipt receiptVersion');
  const claimFence = storedUInt64(input.claimFence, 'invalid receipt claimFence');
  const observationHash = storedString(input.observationHash, 'invalid receipt observationHash');
  if (!/^[a-f0-9]{64}$/.test(observationHash)) {
    throw new StoredRecordError('invalid receipt observationHash', observationHash);
  }
  return canonicalSha256V1({
    scope: 'due-message-receipt-candidate-v1',
    code,
    projectId,
    receiptId,
    messageId,
    receiptVersion,
    claimFence,
    observationHash,
  });
}

function invalidReceiptCandidate(
  rows: readonly unknown[],
  error: unknown,
): InvalidDueMessageReceiptCandidate {
  const first = rows[0];
  const record = first !== null && typeof first === 'object' && !Array.isArray(first)
    ? first as Record<string, unknown>
    : {};
  const projectId = candidateEntityId(record['project_id'], 'message_receipts.project_id');
  const receiptId = candidateEntityId(record['receipt_id'], 'message_receipts.receipt_id');
  const messageId = candidateEntityId(record['message_id'], 'message_receipts.message_id');
  const receiptVersion = storedUInt64(
    record['receipt_version'],
    'message_receipts.receipt_version',
  );
  const claimFence = storedUInt64(record['claim_fence'], 'message_receipts.claim_fence');
  const code: InvalidDueMessageReceiptCode = error instanceof RepositoryConflictError
    ? 'latest_candidate_conflict'
    : 'stored_record_invalid';
  const observationHash = canonicalSha256V1(rows
    .map((row) => canonicalSha256V1(row))
    .sort());
  const identity = Object.freeze({
    code,
    projectId,
    receiptId,
    messageId,
    receiptVersion,
    claimFence,
    observationHash,
  });
  return Object.freeze({
    ...identity,
    candidateId: dueMessageReceiptCandidateId(identity),
    summary: code === 'latest_candidate_conflict'
      ? 'latest receipt candidate has conflicting rows'
      : 'latest receipt candidate failed stored-record validation',
  });
}

function receiptScanKeyId(key: ReceiptScanKey): string {
  return canonicalJsonV1([key.projectId, key.receiptId]);
}

function initialReceiptScanCursor(): ReceiptScanCursor {
  return Object.freeze({
    generation: '0',
    scanBucket: 0,
    createdAt: RECEIPT_SCAN_EPOCH,
    projectId: NIL_UUID,
    receiptId: NIL_UUID,
  });
}

function parseReceiptScanKey(value: unknown): ReceiptScanKey {
  const row = storedRecord(value, 'message receipt scan key');
  return Object.freeze({
    scanBucket: storedUnsignedInteger(
      row['scan_bucket'],
      'message receipt scan bucket',
      RECEIPT_SCAN_BUCKETS - 1,
    ),
    createdAt: storedDateTime(row['created_at'], 'message receipt scan created_at'),
    projectId: candidateEntityId(row['project_id'], 'message receipt scan project_id'),
    receiptId: candidateEntityId(row['receipt_id'], 'message receipt scan receipt_id'),
  });
}

function parseReceiptScanCursor(value: unknown): ReceiptScanCursor {
  const row = storedRecord(value, 'message receipt scan cursor');
  return Object.freeze({
    generation: storedUInt64(row['generation'], 'message receipt scan generation'),
    scanBucket: storedUnsignedInteger(
      row['cursor_bucket'],
      'message receipt scan cursor_bucket',
      RECEIPT_SCAN_BUCKETS - 1,
    ),
    createdAt: storedDateTime(
      row['cursor_created_at'],
      'message receipt scan cursor_created_at',
    ),
    projectId: storedUuid(row['cursor_project_id'], 'message receipt scan cursor_project_id'),
    receiptId: storedUuid(row['cursor_receipt_id'], 'message receipt scan cursor_receipt_id'),
  });
}

function compareReceiptScanCursor(
  left: ReceiptScanCursor,
  right: ReceiptScanCursor,
): number {
  const generation = BigInt(left.generation) - BigInt(right.generation);
  if (generation !== 0n) return generation > 0n ? 1 : -1;
  return left.scanBucket - right.scanBucket ||
    left.createdAt.localeCompare(right.createdAt) ||
    left.projectId.localeCompare(right.projectId) ||
    left.receiptId.localeCompare(right.receiptId);
}

async function readReceiptScanCursor(
  ch: ClickHouseClient,
  scanRecipientId: string,
  table: ReceiptScanCursorTable = DELIVERY_RECEIPT_SCAN_CURSOR_TABLE,
): Promise<ReceiptScanCursor> {
  const result = await ch.query({
    query: `SELECT toString(generation) AS generation, cursor_bucket, cursor_created_at,
        cursor_project_id, cursor_receipt_id
      FROM ${table}
      PREWHERE scan_recipient_id = {scanRecipientId:UUID}
      ORDER BY generation DESC, cursor_bucket DESC, cursor_created_at DESC,
        cursor_project_id DESC, cursor_receipt_id DESC
      LIMIT 1`,
    query_params: { scanRecipientId },
    format: 'JSONEachRow',
  });
  const rows = await result.json<unknown>();
  return rows.length === 0 ? initialReceiptScanCursor() : parseReceiptScanCursor(rows[0]);
}

async function writeReceiptScanCursor(
  ch: ClickHouseClient,
  scanRecipientId: string,
  cursor: ReceiptScanCursor,
  table: ReceiptScanCursorTable = DELIVERY_RECEIPT_SCAN_CURSOR_TABLE,
): Promise<void> {
  try {
    await ch.insert({
      table,
      values: [{
        scan_recipient_id: scanRecipientId,
        generation: cursor.generation,
        cursor_bucket: cursor.scanBucket,
        cursor_created_at: cursor.createdAt,
        cursor_project_id: cursor.projectId,
        cursor_receipt_id: cursor.receiptId,
      }],
      format: 'JSONEachRow',
    });
  } catch (error) {
    const context = `message receipt scan cursor:${table}:${scanRecipientId}`;
    const observed = await readAfterUncertainWrite(
      context,
      error,
      () => readReceiptScanCursor(ch, scanRecipientId, table),
    );
    if (compareReceiptScanCursor(observed, cursor) < 0) {
      throw uncertainWriteError(context, error);
    }
  }
}

async function readReceiptScanPage(
  ch: ClickHouseClient,
  cursor: ReceiptScanCursor,
  recipientId: string | undefined,
  candidateLimit: number,
  wrapEnd?: ReceiptScanKey,
): Promise<readonly ReceiptScanKey[]> {
  const keyTuple = 'tuple(scan_bucket, created_at, project_id, receipt_id)';
  const result = await ch.query({
    query: `SELECT scan_bucket, created_at, project_id, receipt_id
      FROM ${recipientId === undefined ? 'global_message_receipts' : 'recipient_message_receipts'}
      PREWHERE ${recipientId === undefined ? '' : 'recipient_id = {recipientId:UUID} AND '}
        scan_bucket >= {cursorBucket:UInt8} AND
        ${keyTuple} > tuple({cursorBucket:UInt8},
          {cursorCreatedAt:DateTime64(3, 'UTC')}, {cursorProjectId:UUID},
          {cursorReceiptId:UUID})
      ${wrapEnd === undefined ? '' : `WHERE scan_bucket <= {wrapBucket:UInt8} AND
        ${keyTuple} <= tuple({wrapBucket:UInt8},
        {wrapCreatedAt:DateTime64(3, 'UTC')}, {wrapProjectId:UUID},
        {wrapReceiptId:UUID})`}
      ORDER BY ${recipientId === undefined ? '' : 'recipient_id,'}
        scan_bucket, created_at, project_id, receipt_id, receipt_version, claim_fence
      LIMIT {candidateLimit:UInt32}`,
    query_params: {
      cursorCreatedAt: cursor.createdAt.replace('T', ' ').replace('Z', ''),
      cursorBucket: cursor.scanBucket,
      cursorProjectId: cursor.projectId,
      cursorReceiptId: cursor.receiptId,
      candidateLimit,
      ...(recipientId === undefined ? {} : { recipientId }),
      ...(wrapEnd === undefined ? {} : {
        wrapBucket: wrapEnd.scanBucket,
        wrapCreatedAt: wrapEnd.createdAt.replace('T', ' ').replace('Z', ''),
        wrapProjectId: wrapEnd.projectId,
        wrapReceiptId: wrapEnd.receiptId,
      }),
    },
    format: 'JSONEachRow',
  });
  const distinct = new Map<string, ReceiptScanKey>();
  for (const key of (await result.json<unknown>()).map(parseReceiptScanKey)) {
    distinct.set(receiptScanKeyId(key), key);
  }
  return Object.freeze([...distinct.values()]);
}

function receiptKeyPredicate(keys: readonly ReceiptScanKey[]): Readonly<{
  query: string;
  params: Readonly<Record<string, string>>;
}> {
  const params: Record<string, string> = {};
  const query = keys.map((key, index) => {
    params[`candidateProject${index}`] = key.projectId;
    params[`candidateReceipt${index}`] = key.receiptId;
    return `(project_id = {candidateProject${index}:UUID}
      AND receipt_id = {candidateReceipt${index}:UUID})`;
  }).join(' OR ');
  return Object.freeze({ query, params: Object.freeze(params) });
}

async function readLatestReceiptScanCandidates(
  ch: ClickHouseClient,
  keys: readonly ReceiptScanKey[],
): Promise<ReadonlyMap<string, readonly unknown[]>> {
  if (keys.length === 0) return new Map();
  const predicate = receiptKeyPredicate(keys);
  const result = await ch.query({
    query: `WITH latest_receipt_candidates AS
      (
        SELECT * FROM
        (
          SELECT *, max(claim_fence) OVER
            (PARTITION BY project_id, receipt_id) AS maximum_claim_fence
          FROM
          (
            SELECT *, max(receipt_version) OVER
              (PARTITION BY project_id, receipt_id) AS maximum_receipt_version
            FROM receipt_message_receipts
            PREWHERE ${predicate.query}
          )
          WHERE receipt_version = maximum_receipt_version
        )
        WHERE claim_fence = maximum_claim_fence
      )
      SELECT ${RECEIPT_COLUMNS} FROM
      (
        SELECT DISTINCT ${RECEIPT_COLUMNS}
        FROM latest_receipt_candidates
        WHERE (project_id, receipt_id, receipt_version, claim_fence) NOT IN
        (
          SELECT project_id, receipt_id, receipt_version, claim_fence
          FROM message_receipt_quarantine
          PREWHERE ${predicate.query}
        )
      )
      ORDER BY created_at, project_id, receipt_id, receipt_version, claim_fence
      LIMIT 2 BY project_id, receipt_id`,
    query_params: predicate.params,
    format: 'JSONEachRow',
  });
  const grouped = new Map<string, unknown[]>();
  for (const row of await result.json<unknown>()) {
    const record = storedRecord(row, 'message receipt scan candidate');
    const key = canonicalJsonV1([record['project_id'], record['receipt_id']]);
    const values = grouped.get(key) ?? [];
    values.push(row);
    grouped.set(key, values);
  }
  return grouped;
}

/**
 * Reads only latest-version/latest-fence candidates in ClickHouse. Candidate ties
 * remain visible for fail-closed folding, while malformed logical receipts are
 * isolated as bounded quarantine evidence instead of blocking healthy receipts.
 */
export async function listDueMessageReceiptCandidates(
  ch: ClickHouseClient,
  options: ListDueMessageReceiptsOptions,
): Promise<DueMessageReceiptCandidates> {
  const now = storedDateTime(options.now, 'message_receipts.now');
  const limit = receiptReadLimit(options.limit);
  const candidateLimit = limit + INVALID_RECEIPT_SCAN_BUFFER;
  const recipientId = options.recipientId === undefined
    ? undefined
    : storedUuid(options.recipientId, 'recipientId');
  const scanRecipientId = recipientId ?? NIL_UUID;
  const currentCursor = await readReceiptScanCursor(ch, scanRecipientId);
  let scanCursor = currentCursor;
  let wrapEnd: ReceiptScanKey | undefined;
  const valid: MessageReceiptRow[] = [];
  const invalid: InvalidDueMessageReceiptCandidate[] = [];
  const validKeys = new Set<string>();
  const invalidKeys = new Set<string>();
  let traversalLastExamined: ReceiptScanCursor | undefined;
  // One tuple-keyset query covers the cursor-to-end range across all buckets.
  // A second bounded page is available either for poison progress or for the
  // generation-advanced wrap range. Empty/steady-idle scans therefore stay O(1).
  for (let page = 0; page < MAX_RECEIPT_SCAN_PAGES; page += 1) {
    const scanKeys = await readReceiptScanPage(
      ch,
      scanCursor,
      recipientId,
      candidateLimit,
      wrapEnd,
    );
    if (scanKeys.length === 0) {
      if (wrapEnd !== undefined) break;
      wrapEnd = currentCursor;
      scanCursor = Object.freeze({
        ...initialReceiptScanCursor(),
        generation: nextRepositoryVersion(currentCursor.generation),
      });
      continue;
    }
    const storedCandidates = await readLatestReceiptScanCandidates(ch, scanKeys);
    let pageLastExamined: ReceiptScanCursor | undefined;
    for (const scanKey of scanKeys) {
      const examined = Object.freeze({
        generation: scanCursor.generation,
        ...scanKey,
      });
      traversalLastExamined = examined;
      pageLastExamined = examined;
      const candidateRows = storedCandidates.get(receiptScanKeyId(scanKey));
      if (candidateRows === undefined) continue;
      try {
        const parsed = candidateRows.map(parseReceiptRow);
        const receipt = foldReceiptRows(parsed[0]!.receipt_id, parsed);
        if (recipientId !== undefined && receipt.recipient_id !== recipientId) {
          throw new StoredRecordError('message_receipts recipient identity conflict', receipt);
        }
        const candidateKey = receiptScanKeyId(scanKey);
        if (
          valid.length < limit && receiptIsDue(receipt, Date.parse(now)) &&
          !validKeys.has(candidateKey)
        ) {
          valid.push(receipt);
          validKeys.add(candidateKey);
          if (valid.length === limit) break;
        }
      } catch (error) {
        const candidate = invalidReceiptCandidate(candidateRows, error);
        if (!invalidKeys.has(candidate.candidateId)) {
          invalid.push(candidate);
          invalidKeys.add(candidate.candidateId);
        }
      }
    }
    if (valid.length > 0) {
      traversalLastExamined = pageLastExamined ?? traversalLastExamined;
      break;
    }
    if (
      wrapEnd === undefined && scanKeys.length < candidateLimit
    ) {
      wrapEnd = currentCursor;
      scanCursor = Object.freeze({
        ...initialReceiptScanCursor(),
        generation: nextRepositoryVersion(currentCursor.generation),
      });
    } else if (pageLastExamined !== undefined) {
      scanCursor = pageLastExamined;
    }
  }
  if (traversalLastExamined !== undefined) {
    await writeReceiptScanCursor(ch, scanRecipientId, traversalLastExamined);
  }
  invalid.sort((left, right) => left.candidateId.localeCompare(right.candidateId));
  return Object.freeze({
    valid: Object.freeze(valid.slice(0, limit)),
    invalid: Object.freeze(invalid),
  });
}

export async function listDueMessageReceipts(
  ch: ClickHouseClient,
  options: ListDueMessageReceiptsOptions,
): Promise<MessageReceiptRow[]> {
  return [...(await listDueMessageReceiptCandidates(ch, options)).valid];
}

/**
 * Bounded durable scan for receipts whose authoritative latest state needs a
 * lifecycle event. The dedicated cursor scope prevents repair polling from
 * advancing either global or recipient due-delivery scans.
 */
export async function listTerminalReceiptEventCandidates(
  ch: ClickHouseClient,
  options: ListTerminalReceiptEventCandidatesOptions = {},
): Promise<readonly MessageReceiptRow[]> {
  const limit = receiptReadLimit(options.limit);
  const candidateLimit = limit + INVALID_RECEIPT_SCAN_BUFFER;
  const currentCursor = await readReceiptScanCursor(
    ch,
    NIL_UUID,
    TERMINAL_RECEIPT_EVENT_SCAN_CURSOR_TABLE,
  );
  let scanCursor = currentCursor;
  let wrapEnd: ReceiptScanKey | undefined;
  const candidates: MessageReceiptRow[] = [];
  const candidateKeys = new Set<string>();
  let traversalLastExamined: ReceiptScanCursor | undefined;

  for (let page = 0; page < MAX_RECEIPT_SCAN_PAGES; page += 1) {
    const scanKeys = await readReceiptScanPage(
      ch,
      scanCursor,
      undefined,
      candidateLimit,
      wrapEnd,
    );
    if (scanKeys.length === 0) {
      if (wrapEnd !== undefined) break;
      wrapEnd = currentCursor;
      scanCursor = Object.freeze({
        ...initialReceiptScanCursor(),
        generation: nextRepositoryVersion(currentCursor.generation),
      });
      continue;
    }
    const storedCandidates = await readLatestReceiptScanCandidates(ch, scanKeys);
    let pageLastExamined: ReceiptScanCursor | undefined;
    for (const scanKey of scanKeys) {
      const examined = Object.freeze({ generation: scanCursor.generation, ...scanKey });
      traversalLastExamined = examined;
      pageLastExamined = examined;
      const candidateRows = storedCandidates.get(receiptScanKeyId(scanKey));
      if (candidateRows === undefined) continue;
      try {
        const parsed = candidateRows.map(parseReceiptRow);
        const receipt = foldReceiptRows(parsed[0]!.receipt_id, parsed);
        const candidateKey = receiptScanKeyId(scanKey);
        if (
          candidates.length < limit &&
          (receipt.state === 'processed' || receipt.state === 'failed') &&
          !candidateKeys.has(candidateKey)
        ) {
          candidates.push(receipt);
          candidateKeys.add(candidateKey);
          if (candidates.length === limit) break;
        }
      } catch (error) {
        if (!(error instanceof StoredRecordError) && !(error instanceof RepositoryConflictError)) {
          throw error;
        }
        // Only canonical rows are repairable. The cursor still advances so one
        // malformed physical candidate cannot starve later healthy receipts.
      }
    }
    if (candidates.length > 0) {
      traversalLastExamined = pageLastExamined ?? traversalLastExamined;
      break;
    }
    if (wrapEnd === undefined && scanKeys.length < candidateLimit) {
      wrapEnd = currentCursor;
      scanCursor = Object.freeze({
        ...initialReceiptScanCursor(),
        generation: nextRepositoryVersion(currentCursor.generation),
      });
    } else if (pageLastExamined !== undefined) {
      scanCursor = pageLastExamined;
    }
  }
  if (traversalLastExamined !== undefined) {
    await writeReceiptScanCursor(
      ch,
      NIL_UUID,
      traversalLastExamined,
      TERMINAL_RECEIPT_EVENT_SCAN_CURSOR_TABLE,
    );
  }
  return Object.freeze(candidates.slice(0, limit));
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
  const desiredAtCurrentVersion = parseReceiptRow(toStoredRow(
    { ...input.next, project_id: projectId, receipt_id: receiptId },
    current.receipt_version,
  ));
  if (receiptIdentityHash(current) !== receiptIdentityHash(desiredAtCurrentVersion)) {
    throw new RepositoryConflictError(`receipt kimlik snapshotu degistirilemez: ${receiptId}`);
  }
  if (BigInt(desiredAtCurrentVersion.claim_fence) < BigInt(current.claim_fence)) {
    throw new RepositoryConflictError(`receipt claim fence stale: ${receiptId}`);
  }
  if (current.receipt_version !== expectedVersion) {
    if (BigInt(current.receipt_version) < BigInt(expectedVersion)) {
      assertExpectedVersion(`receipt:${receiptId}`, current.receipt_version, expectedVersion);
    }
    if (
      current.receipt_version === nextRepositoryVersion(expectedVersion) &&
      BigInt(desiredAtCurrentVersion.claim_fence) > BigInt(current.claim_fence)
    ) return insertAndReconcile(ch, toStoredRow(
      desiredAtCurrentVersion,
      current.receipt_version,
    ), desiredAtCurrentVersion);
    if (
      receiptContentHash(current) === receiptContentHash(desiredAtCurrentVersion)
    ) return current;
    assertExpectedVersion(`receipt:${receiptId}`, current.receipt_version, expectedVersion);
  }
  const stored = toStoredRow(
    { ...input.next, project_id: projectId, receipt_id: receiptId },
    nextRepositoryVersion(current.receipt_version),
  );
  const expected = parseReceiptRow(stored);
  if (receiptIdentityHash(expected) !== receiptIdentityHash(current)) {
    throw new RepositoryConflictError(`receipt kimlik snapshotu degistirilemez: ${receiptId}`);
  }
  return insertAndReconcile(ch, stored, expected);
}
