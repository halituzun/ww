import type { ClickHouseClient } from '@clickhouse/client';
import {
  BROADCAST_SENTINEL,
  MESSAGE_KINDS,
  MESSAGE_PRIORITIES,
  NIL_UUID,
  SYSTEM_SENTINEL,
  USER_SENTINEL,
  AuthenticatedPrincipalSnapshotV1Schema,
  MessagePayloadV1Schema,
  PartyRefV1Schema,
  ProvenanceV1Schema,
  canonicalJsonV1,
  canonicalSha256V1,
  parseAgentMessageEnvelopeV1,
  type AgentMessageEnvelopeV1,
  type EntityId,
  type PartyRefV1,
} from '@ww/shared';
import {
  concreteEntityId,
  optionalEntityId,
  storedUuid,
  type StoredOptionalEntityId,
} from './identifiers.js';
import {
  EmptyAcknowledgedWriteVerificationError,
  RepositoryConflictError,
  RepositoryWriteError,
  StoredRecordError,
  acknowledgedWriteVerificationError,
  readAfterAcknowledgedWrite,
  readAfterUncertainWrite,
  storedDateTime,
  storedEnum,
  storedJsonValue,
  storedRecord,
  storedString,
  storedUnsignedInteger,
  uncertainWriteError,
} from './types.js';
import {
  listDueMessageReceipts,
  listLatestReceiptsByState,
  type ListDueMessageReceiptsOptions,
  type MessageReceiptRow,
} from './receipts.js';
import { getLatestEffect } from './effects.js';

export interface AppendMessageInput {
  readonly envelope: AgentMessageEnvelopeV1;
  /** Actual RouteResult.usedRef, never the requested alias. */
  readonly actualModelRef?: string;
}

export interface ProtocolV1MessageRecord {
  readonly protocolVersion: 1;
  readonly payloadVersion: 1;
  readonly envelope: AgentMessageEnvelopeV1;
  readonly content: string;
  readonly actualModelRef: string;
  readonly payloadJson: string;
  readonly payloadHash: string;
  readonly envelopeHash: string;
}

export interface LegacyMessageProjection {
  readonly protocolVersion: 0;
  readonly messageId: EntityId;
  readonly projectId: EntityId;
  readonly sessionId: EntityId;
  readonly taskId: StoredOptionalEntityId;
  readonly fromId: string;
  readonly toId: string;
  readonly kind: string;
  readonly content: string;
  readonly modelRef: string;
  readonly createdAt: string;
}

export type MessageRecord = ProtocolV1MessageRecord | LegacyMessageProjection;

export interface DueInboxItemRecord {
  readonly message: ProtocolV1MessageRecord;
  readonly receipt: MessageReceiptRow;
}

export type ListDueInboxItemsOptions = ListDueMessageReceiptsOptions;

interface StoredMessageRow {
  readonly message_id: string;
  readonly project_id: string;
  readonly session_id: string;
  readonly task_id: string;
  readonly from_agent_id: string;
  readonly to_agent_id: string;
  readonly kind: string;
  readonly content: string;
  readonly model_ref: string;
  readonly created_at: string;
  readonly protocol_version: number;
  readonly payload_version: number;
  readonly payload_json: string;
  readonly payload_hash: string;
  readonly envelope_hash: string;
  readonly reply_to_message_id: string;
  readonly correlation_id: string;
  readonly causation_id: string;
  readonly idempotency_key: string;
  readonly task_brief_id: string;
  readonly assignment_attempt_id: string;
  readonly invocation_id: string;
  readonly prompt_input_snapshot_id: string;
  readonly deadline_at: string | null;
  readonly priority: string;
  readonly authenticated_principal_json: string;
  readonly provenance_json: string;
}

interface MessageNamespaceRows {
  readonly byMessageId: readonly MessageRecord[];
  readonly byIdempotencyKey: readonly MessageRecord[];
}

const MESSAGE_COLUMNS = `message_id, project_id, session_id, task_id, from_agent_id,
  to_agent_id, kind, content, model_ref, created_at, protocol_version,
  payload_version, payload_json, payload_hash, envelope_hash, reply_to_message_id,
  correlation_id, causation_id, idempotency_key, task_brief_id,
  assignment_attempt_id, invocation_id, prompt_input_snapshot_id, deadline_at,
  priority, authenticated_principal_json, provenance_json`;
const ALIASED_MESSAGE_COLUMNS = `m.message_id, m.project_id, m.session_id, m.task_id,
  m.from_agent_id, m.to_agent_id, m.kind, m.content, m.model_ref, m.created_at,
  m.protocol_version, m.payload_version, m.payload_json, m.payload_hash,
  m.envelope_hash, m.reply_to_message_id, m.correlation_id, m.causation_id,
  m.idempotency_key, m.task_brief_id, m.assignment_attempt_id, m.invocation_id,
  m.prompt_input_snapshot_id, m.deadline_at, m.priority,
  m.authenticated_principal_json, m.provenance_json`;
const MAX_MESSAGE_NAMESPACE_CANDIDATES = 100;

function optionalId(value: unknown, context: string): StoredOptionalEntityId {
  return optionalEntityId(storedUuid(value, context), context);
}

function optionalDateTime(value: unknown, context: string): string | undefined {
  if (value === null) return undefined;
  return storedDateTime(value, context);
}

function partyFromStoredId(value: unknown): PartyRefV1 {
  const id = storedUuid(value, 'messages.to_agent_id');
  if (id === USER_SENTINEL) return PartyRefV1Schema.parse({ type: 'user', id });
  if (id === SYSTEM_SENTINEL) return PartyRefV1Schema.parse({ type: 'system', id });
  if (id === BROADCAST_SENTINEL) return PartyRefV1Schema.parse({ type: 'broadcast', id });
  return PartyRefV1Schema.parse({
    type: 'agent',
    id: concreteEntityId(id, 'messages.to_agent_id'),
  });
}

function parseProtocolV1(row: Record<string, unknown>): ProtocolV1MessageRecord {
  const payloadVersion = storedUnsignedInteger(
    row['payload_version'],
    'messages.payload_version',
    65_535,
  );
  if (payloadVersion !== 1) {
    throw new StoredRecordError('messages.payload_version', payloadVersion);
  }

  try {
    const payloadJson = storedString(row['payload_json'], 'messages.payload_json');
    const payload = MessagePayloadV1Schema.parse(
      storedJsonValue(payloadJson, 'messages.payload_json'),
    );
    const authenticatedPrincipalJson = storedString(
      row['authenticated_principal_json'],
      'messages.authenticated_principal_json',
    );
    const authenticatedPrincipal = AuthenticatedPrincipalSnapshotV1Schema.parse(
      storedJsonValue(authenticatedPrincipalJson, 'messages.authenticated_principal_json'),
    );
    const provenanceJson = storedString(row['provenance_json'], 'messages.provenance_json');
    const provenance = ProvenanceV1Schema.parse(
      storedJsonValue(provenanceJson, 'messages.provenance_json'),
    );
    const taskId = optionalId(row['task_id'], 'messages.task_id');
    const taskBriefId = optionalId(row['task_brief_id'], 'messages.task_brief_id');
    const assignmentAttemptId = optionalId(
      row['assignment_attempt_id'],
      'messages.assignment_attempt_id',
    );
    const replyToMessageId = optionalId(
      row['reply_to_message_id'],
      'messages.reply_to_message_id',
    );
    const causationId = optionalId(row['causation_id'], 'messages.causation_id');
    const invocationId = optionalId(row['invocation_id'], 'messages.invocation_id');
    const promptInputSnapshotId = optionalId(
      row['prompt_input_snapshot_id'],
      'messages.prompt_input_snapshot_id',
    );
    const deadlineAt = optionalDateTime(row['deadline_at'], 'messages.deadline_at');

    const envelope = parseAgentMessageEnvelopeV1({
      protocolVersion: 1,
      messageId: concreteEntityId(
        storedUuid(row['message_id'], 'messages.message_id'),
        'messages.message_id',
      ),
      projectId: concreteEntityId(
        storedUuid(row['project_id'], 'messages.project_id'),
        'messages.project_id',
      ),
      sessionId: concreteEntityId(
        storedUuid(row['session_id'], 'messages.session_id'),
        'messages.session_id',
      ),
      ...(taskId === NIL_UUID ? {} : { taskId }),
      ...(taskBriefId === NIL_UUID ? {} : { taskBriefId }),
      ...(assignmentAttemptId === NIL_UUID ? {} : { assignmentAttemptId }),
      senderPrincipalId: storedUuid(row['from_agent_id'], 'messages.from_agent_id'),
      authenticatedPrincipal,
      recipient: partyFromStoredId(row['to_agent_id']),
      kind: storedEnum(row['kind'], MESSAGE_KINDS, 'messages.kind'),
      payload,
      ...(replyToMessageId === NIL_UUID ? {} : { replyToMessageId }),
      correlationId: concreteEntityId(
        storedUuid(row['correlation_id'], 'messages.correlation_id'),
        'messages.correlation_id',
      ),
      ...(causationId === NIL_UUID ? {} : { causationId }),
      idempotencyKey: storedString(row['idempotency_key'], 'messages.idempotency_key'),
      ...(invocationId === NIL_UUID ? {} : { invocationId }),
      ...(promptInputSnapshotId === NIL_UUID ? {} : { promptInputSnapshotId }),
      provenance,
      priority: storedEnum(row['priority'], MESSAGE_PRIORITIES, 'messages.priority'),
      createdAt: storedDateTime(row['created_at'], 'messages.created_at'),
      ...(deadlineAt === undefined ? {} : { deadlineAt }),
    });
    const canonicalPayload = canonicalJsonV1(envelope.payload);
    const payloadHash = storedString(row['payload_hash'], 'messages.payload_hash');
    const envelopeHash = storedString(row['envelope_hash'], 'messages.envelope_hash');
    const content = storedString(row['content'], 'messages.content');
    const actualModelRef = storedString(row['model_ref'], 'messages.model_ref');
    if (payloadJson !== canonicalPayload || payloadHash !== canonicalSha256V1(envelope.payload)) {
      throw new StoredRecordError('messages.payload integrity', row);
    }
    if (
      authenticatedPrincipalJson !== canonicalJsonV1(envelope.authenticatedPrincipal) ||
      provenanceJson !== canonicalJsonV1(envelope.provenance) ||
      envelopeHash !== canonicalSha256V1(envelope)
    ) {
      throw new StoredRecordError('messages.envelope integrity', row);
    }
    return Object.freeze({
      protocolVersion: 1,
      payloadVersion: 1,
      envelope,
      content,
      actualModelRef,
      payloadJson,
      payloadHash,
      envelopeHash,
    });
  } catch (error) {
    if (error instanceof StoredRecordError) throw error;
    throw new StoredRecordError('messages protocol v1', error);
  }
}

function parseMessageRow(value: unknown): MessageRecord {
  const row = storedRecord(value, 'messages');
  const protocolVersion = storedUnsignedInteger(
    row['protocol_version'],
    'messages.protocol_version',
    65_535,
  );
  if (protocolVersion === 1) return parseProtocolV1(row);
  if (protocolVersion !== 0) throw new StoredRecordError('messages.protocol_version', protocolVersion);
  return Object.freeze({
    protocolVersion: 0,
    messageId: concreteEntityId(
      storedUuid(row['message_id'], 'messages.message_id'),
      'messages.message_id',
    ),
    projectId: concreteEntityId(
      storedUuid(row['project_id'], 'messages.project_id'),
      'messages.project_id',
    ),
    sessionId: concreteEntityId(
      storedUuid(row['session_id'], 'messages.session_id'),
      'messages.session_id',
    ),
    taskId: optionalId(row['task_id'], 'messages.task_id'),
    fromId: storedUuid(row['from_agent_id'], 'messages.from_agent_id'),
    toId: storedUuid(row['to_agent_id'], 'messages.to_agent_id'),
    kind: storedString(row['kind'], 'messages.kind'),
    content: storedString(row['content'], 'messages.content'),
    modelRef: storedString(row['model_ref'], 'messages.model_ref'),
    createdAt: storedDateTime(row['created_at'], 'messages.created_at'),
  });
}

function contentProjection(envelope: AgentMessageEnvelopeV1): string {
  switch (envelope.payload.type) {
    case 'question':
    case 'answer':
    case 'user_command': return envelope.payload.text;
    case 'order': return envelope.payload.instruction;
    case 'proposal':
    case 'objection':
    case 'synthesis': return envelope.payload.markdown;
    case 'report': return envelope.payload.summary;
    case 'escalation': return envelope.payload.reason;
    case 'verdict': return canonicalJsonV1(envelope.payload.verdict);
  }
}

function persistedMessageHash(record: ProtocolV1MessageRecord): string {
  return canonicalSha256V1(record);
}

function assertMessageProjection(record: ProtocolV1MessageRecord): void {
  if (record.content !== contentProjection(record.envelope)) {
    throw new StoredRecordError('messages.content projection', record);
  }
}

function normalizeEnvelope(input: AgentMessageEnvelopeV1): AgentMessageEnvelopeV1 {
  const envelope = parseAgentMessageEnvelopeV1(input);
  return parseAgentMessageEnvelopeV1({
    ...envelope,
    createdAt: storedDateTime(envelope.createdAt, 'message.createdAt'),
    ...(envelope.deadlineAt === undefined ? {} : {
      deadlineAt: storedDateTime(envelope.deadlineAt, 'message.deadlineAt'),
    }),
  });
}

function toStoredRow(input: AppendMessageInput): StoredMessageRow {
  const envelope = normalizeEnvelope(input.envelope);
  const payloadJson = canonicalJsonV1(envelope.payload);
  return {
    message_id: envelope.messageId,
    project_id: envelope.projectId,
    session_id: envelope.sessionId,
    task_id: envelope.taskId ?? NIL_UUID,
    from_agent_id: envelope.senderPrincipalId,
    to_agent_id: envelope.recipient.id,
    kind: envelope.kind,
    content: contentProjection(envelope),
    model_ref: input.actualModelRef ?? '',
    created_at: envelope.createdAt,
    protocol_version: 1,
    payload_version: 1,
    payload_json: payloadJson,
    payload_hash: canonicalSha256V1(envelope.payload),
    envelope_hash: canonicalSha256V1(envelope),
    reply_to_message_id: envelope.replyToMessageId ?? NIL_UUID,
    correlation_id: envelope.correlationId,
    causation_id: envelope.causationId ?? NIL_UUID,
    idempotency_key: envelope.idempotencyKey,
    task_brief_id: envelope.taskBriefId ?? NIL_UUID,
    assignment_attempt_id: envelope.assignmentAttemptId ?? NIL_UUID,
    invocation_id: envelope.invocationId ?? NIL_UUID,
    prompt_input_snapshot_id: envelope.promptInputSnapshotId ?? NIL_UUID,
    deadline_at: envelope.deadlineAt ?? null,
    priority: envelope.priority,
    authenticated_principal_json: canonicalJsonV1(envelope.authenticatedPrincipal),
    provenance_json: canonicalJsonV1(envelope.provenance),
  };
}

async function rowsByMessageId(
  ch: ClickHouseClient,
  projectId: EntityId,
  messageId: EntityId,
): Promise<MessageRecord[]> {
  const result = await ch.query({
    query: `SELECT ${MESSAGE_COLUMNS} FROM identity_messages
      PREWHERE project_id = {projectId:UUID} AND message_id = {messageId:UUID}
      LIMIT {candidateLimit:UInt32}`,
    query_params: {
      projectId,
      messageId,
      candidateLimit: MAX_MESSAGE_NAMESPACE_CANDIDATES + 1,
    },
    format: 'JSONEachRow',
  });
  const records = (await result.json<unknown>()).map(parseMessageRow);
  if (records.length > MAX_MESSAGE_NAMESPACE_CANDIDATES) {
    throw new RepositoryConflictError(`message:${messageId} aday sinirini asti`);
  }
  return records;
}

function reconcileMessage(
  expected: ProtocolV1MessageRecord,
  records: readonly MessageRecord[],
  context: string,
): ProtocolV1MessageRecord {
  if (records.length === 0) throw new RepositoryWriteError(`${context} yazimi yeniden okunamadi`);
  const expectedHash = persistedMessageHash(expected);
  for (const record of records) {
    if (
      record.protocolVersion !== 1 ||
      record.envelopeHash !== expected.envelopeHash ||
      persistedMessageHash(record) !== expectedHash
    ) {
      throw new RepositoryConflictError(`${context} kimlik veya hash catismasi`);
    }
  }
  assertMessageProjection(expected);
  return expected;
}

function reconcileStoredMessages(
  records: readonly MessageRecord[],
  context: string,
): MessageRecord {
  if (records.length === 0) throw new RepositoryWriteError(`${context} yazimi yeniden okunamadi`);
  const first = records[0]!;
  if (first.protocolVersion === 1) {
    return reconcileMessage(first, records, context);
  }
  const firstHash = canonicalSha256V1(first);
  if (
    records.some((record) => (
      record.protocolVersion !== 0 || canonicalSha256V1(record) !== firstHash
    ))
  ) {
    throw new RepositoryConflictError(`${context} legacy kimlik veya icerik catismasi`);
  }
  return first;
}

export async function findMessageByIdempotencyKey(
  ch: ClickHouseClient,
  projectId: string,
  idempotencyKey: string,
): Promise<ProtocolV1MessageRecord | null> {
  const project = concreteEntityId(projectId, 'projectId');
  const key = idempotencyKey.trim();
  if (key.length === 0) throw new StoredRecordError('idempotencyKey', idempotencyKey);
  const record = reconcileIdempotencyRows(await rowsByIdempotencyKey(ch, project, key), key);
  if (record === null) return null;
  return reconcileMessageNamespaces(record, await rowsByMessageNamespaces(
    ch,
    project,
    record.envelope.messageId,
    key,
  ));
}

async function rowsByIdempotencyKey(
  ch: ClickHouseClient,
  projectId: EntityId,
  key: string,
): Promise<MessageRecord[]> {
  const result = await ch.query({
    query: `SELECT ${MESSAGE_COLUMNS} FROM idempotency_messages
      PREWHERE project_id = {projectId:UUID}
        AND idempotency_key = {idempotencyKey:String}
      LIMIT {candidateLimit:UInt32}`,
    query_params: {
      projectId,
      idempotencyKey: key,
      candidateLimit: MAX_MESSAGE_NAMESPACE_CANDIDATES + 1,
    },
    format: 'JSONEachRow',
  });
  const records = (await result.json<unknown>()).map(parseMessageRow);
  if (records.length > MAX_MESSAGE_NAMESPACE_CANDIDATES) {
    throw new RepositoryConflictError(`message idempotency:${key} aday sinirini asti`);
  }
  return records;
}

async function rowsByMessageNamespaces(
  ch: ClickHouseClient,
  projectId: EntityId,
  messageId: EntityId,
  idempotencyKey: string,
): Promise<MessageNamespaceRows> {
  const result = await ch.query({
    query: `SELECT 'message_id' AS namespace, ${MESSAGE_COLUMNS} FROM
      (
        SELECT ${MESSAGE_COLUMNS} FROM identity_messages
        PREWHERE project_id = {projectId:UUID} AND message_id = {messageId:UUID}
        LIMIT {candidateLimit:UInt32}
      )
      UNION ALL
      SELECT 'idempotency_key' AS namespace, ${MESSAGE_COLUMNS} FROM
      (
        SELECT ${MESSAGE_COLUMNS} FROM idempotency_messages
        PREWHERE project_id = {projectId:UUID}
          AND idempotency_key = {idempotencyKey:String}
        LIMIT {candidateLimit:UInt32}
      )`,
    query_params: {
      projectId,
      messageId,
      idempotencyKey,
      candidateLimit: MAX_MESSAGE_NAMESPACE_CANDIDATES + 1,
    },
    format: 'JSONEachRow',
  });
  const storedRows = await result.json<unknown>();
  const messageRows = storedRows.filter((row) => (
    storedRecord(row, 'message namespace row')['namespace'] === 'message_id'
  ));
  const idempotencyRows = storedRows.filter((row) => (
    storedRecord(row, 'message namespace row')['namespace'] === 'idempotency_key'
  ));
  if (messageRows.length > MAX_MESSAGE_NAMESPACE_CANDIDATES) {
    throw new RepositoryConflictError(`message:${messageId} aday sinirini asti`);
  }
  if (idempotencyRows.length > MAX_MESSAGE_NAMESPACE_CANDIDATES) {
    throw new RepositoryConflictError(`message idempotency:${idempotencyKey} aday sinirini asti`);
  }
  const records = storedRows.map(parseMessageRow);
  const byMessageId = records.filter((record) => (
      record.protocolVersion === 1
        ? record.envelope.messageId === messageId
        : record.messageId === messageId
    ));
  const byIdempotencyKey = records.filter((record) => (
      record.protocolVersion === 1 && record.envelope.idempotencyKey === idempotencyKey
    ));
  return Object.freeze({ byMessageId, byIdempotencyKey });
}

function reconcileMessageNamespaces(
  expected: ProtocolV1MessageRecord,
  rows: MessageNamespaceRows,
): ProtocolV1MessageRecord {
  validatePresentMessageNamespaces(expected, rows);
  if (rows.byMessageId.length === 0) {
    throw new RepositoryWriteError(
      `message:${expected.envelope.messageId} yazimi yeniden okunamadi`,
    );
  }
  if (rows.byIdempotencyKey.length === 0) {
    throw new RepositoryWriteError(
      `message idempotency:${expected.envelope.idempotencyKey} yazimi yeniden okunamadi`,
    );
  }
  return expected;
}

function validatePresentMessageNamespaces(
  expected: ProtocolV1MessageRecord,
  rows: MessageNamespaceRows,
): void {
  if (rows.byMessageId.length > 0) {
    reconcileMessage(
      expected,
      rows.byMessageId,
      `message:${expected.envelope.messageId}`,
    );
  }
  if (rows.byIdempotencyKey.length > 0) {
    reconcileMessage(
      expected,
      rows.byIdempotencyKey,
      `message idempotency:${expected.envelope.idempotencyKey}`,
    );
  }
}

function messageNamespacesAreEmpty(rows: MessageNamespaceRows): boolean {
  return rows.byMessageId.length === 0 && rows.byIdempotencyKey.length === 0;
}

function messageRecordId(record: MessageRecord): EntityId {
  return record.protocolVersion === 1 ? record.envelope.messageId : record.messageId;
}

async function assertMessageOwnership(
  ch: ClickHouseClient,
  projectId: EntityId,
  targets: readonly MessageRecord[],
): Promise<void> {
  if (targets.length === 0) return;
  const messageIds = [...new Set(targets.map(messageRecordId))];
  const idempotencyKeys = [...new Set(targets.flatMap((record) => (
    record.protocolVersion === 1 ? [record.envelope.idempotencyKey] : []
  )))];
  const result = await ch.query({
    query: `SELECT ${MESSAGE_COLUMNS} FROM messages
      WHERE project_id = {projectId:UUID}
        AND (
          message_id IN ({messageIds:Array(UUID)})
          OR (
            protocol_version = 1
            AND idempotency_key IN ({idempotencyKeys:Array(String)})
          )
        )`,
    query_params: { projectId, messageIds, idempotencyKeys },
    format: 'JSONEachRow',
  });
  const ownership = (await result.json<unknown>()).map(parseMessageRow);
  const byMessageId = new Map<string, MessageRecord[]>();
  const byIdempotencyKey = new Map<string, MessageRecord[]>();
  for (const record of ownership) {
    const messageId = messageRecordId(record);
    const messageRows = byMessageId.get(messageId) ?? [];
    messageRows.push(record);
    byMessageId.set(messageId, messageRows);
    if (record.protocolVersion === 1) {
      const key = record.envelope.idempotencyKey;
      const keyRows = byIdempotencyKey.get(key) ?? [];
      keyRows.push(record);
      byIdempotencyKey.set(key, keyRows);
    }
  }
  for (const target of targets) {
    const messageId = messageRecordId(target);
    const messageRows = byMessageId.get(messageId) ?? [];
    if (target.protocolVersion === 1) {
      const key = target.envelope.idempotencyKey;
      reconcileMessageNamespaces(target, {
        byMessageId: messageRows,
        byIdempotencyKey: byIdempotencyKey.get(key) ?? [],
      });
      continue;
    }
    const stored = reconcileStoredMessages(messageRows, `message:${messageId}`);
    if (
      stored.protocolVersion !== 0 ||
      canonicalSha256V1(stored) !== canonicalSha256V1(target)
    ) {
      throw new RepositoryConflictError(`message:${messageId} legacy ownership catismasi`);
    }
  }
}

function reconcileIdempotencyRows(
  records: readonly MessageRecord[],
  key: string,
): ProtocolV1MessageRecord | null {
  if (records.length === 0) return null;
  const first = records[0];
  if (first?.protocolVersion !== 1) {
    throw new StoredRecordError('messages idempotency protocol', first);
  }
  return reconcileMessage(first, records, `message idempotency:${key}`);
}

export async function getMessage(
  ch: ClickHouseClient,
  projectId: string,
  messageId: string,
): Promise<MessageRecord | null> {
  const project = concreteEntityId(projectId, 'projectId');
  const message = concreteEntityId(messageId, 'messageId');
  const records = await rowsByMessageId(ch, project, message);
  if (records.length === 0) return null;
  const record = reconcileStoredMessages(records, `message:${message}`);
  if (record.protocolVersion === 1) {
    return reconcileMessageNamespaces(record, await rowsByMessageNamespaces(
      ch,
      project,
      message,
      record.envelope.idempotencyKey,
    ));
  }
  return record;
}

export async function listMessagesBySession(
  ch: ClickHouseClient,
  projectId: string,
  sessionId: string,
): Promise<MessageRecord[]> {
  const project = concreteEntityId(projectId, 'projectId');
  const session = concreteEntityId(sessionId, 'sessionId');
  const result = await ch.query({
    query: `SELECT ${MESSAGE_COLUMNS} FROM messages
      WHERE project_id = {projectId:UUID} AND session_id = {sessionId:UUID}
      ORDER BY created_at, message_id`,
    query_params: { projectId: project, sessionId: session },
    format: 'JSONEachRow',
  });
  const grouped = new Map<string, MessageRecord[]>();
  for (const record of (await result.json<unknown>()).map(parseMessageRow)) {
    const messageId = record.protocolVersion === 1
      ? record.envelope.messageId
      : record.messageId;
    const rows = grouped.get(messageId) ?? [];
    rows.push(record);
    grouped.set(messageId, rows);
  }
  const logical = [...grouped.entries()].map(([messageId, records]) => (
    reconcileStoredMessages(records, `message:${messageId}`)
  ));
  await assertMessageOwnership(ch, project, logical);
  return logical;
}

export async function listProtocolV1RepliesToMessage(
  ch: ClickHouseClient,
  projectId: string,
  replyToMessageId: string,
): Promise<ProtocolV1MessageRecord[]> {
  const project = concreteEntityId(projectId, 'projectId');
  const replyTo = concreteEntityId(replyToMessageId, 'replyToMessageId');
  const result = await ch.query({
    query: `SELECT ${MESSAGE_COLUMNS} FROM messages
      WHERE project_id = {projectId:UUID}
        AND reply_to_message_id = {replyToMessageId:UUID}
      ORDER BY created_at, message_id`,
    query_params: { projectId: project, replyToMessageId: replyTo },
    format: 'JSONEachRow',
  });
  const grouped = new Map<string, MessageRecord[]>();
  for (const record of (await result.json<unknown>()).map(parseMessageRow)) {
    const messageId = messageRecordId(record);
    const rows = grouped.get(messageId) ?? [];
    rows.push(record);
    grouped.set(messageId, rows);
  }
  const replies = [...grouped.entries()].map(([messageId, rows]) => {
    const record = reconcileStoredMessages(rows, `message:${messageId}`);
    if (record.protocolVersion !== 1) {
      throw new StoredRecordError('reply message protocol', record);
    }
    return record;
  });
  await assertMessageOwnership(ch, project, replies);
  replies.sort((left, right) => (
    left.envelope.createdAt.localeCompare(right.envelope.createdAt) ||
    left.envelope.messageId.localeCompare(right.envelope.messageId)
  ));
  return replies;
}

export async function listProtocolV1AnswerRepliesToMessage(
  ch: ClickHouseClient,
  projectId: string,
  replyToMessageId: string,
): Promise<ProtocolV1MessageRecord[]> {
  return (await listProtocolV1RepliesToMessage(ch, projectId, replyToMessageId))
    .filter((record) => (
      record.envelope.kind === 'answer' && record.envelope.payload.type === 'answer'
    ));
}

/**
 * Resolves the only answer selected by the durable question-answer winner
 * effect. Arbitrary replies never count as answers, and a malformed winner is
 * rejected instead of being guessed from message order.
 */
export async function findAuthoritativeAnswerWinner(
  ch: ClickHouseClient,
  projectId: string,
  questionMessageId: string,
): Promise<ProtocolV1MessageRecord | null> {
  const project = concreteEntityId(projectId, 'projectId');
  const questionId = concreteEntityId(questionMessageId, 'questionMessageId');
  const question = await getMessage(ch, project, questionId);
  if (
    question === null ||
    question.protocolVersion !== 1 ||
    question.envelope.kind !== 'question' ||
    question.envelope.payload.type !== 'question'
  ) {
    throw new StoredRecordError('authoritative answer question', {
      projectId: project,
      questionMessageId: questionId,
    });
  }
  const winner = await getLatestEffect(ch, questionId, 'question-answer-winner');
  if (winner === null || winner.state === 'pending') return null;
  if (winner.project_id !== project || winner.state !== 'succeeded') {
    throw new RepositoryConflictError(
      `question:${questionId} authoritative answer winner terminal veya scope catismasi`,
    );
  }
  const winnerResult = winner.result as { readonly [key: string]: unknown };
  if (
    winner.result === null ||
    typeof winner.result !== 'object' ||
    Array.isArray(winner.result) ||
    Object.keys(winner.result).length !== 1 ||
    typeof winnerResult['answerMessageId'] !== 'string'
  ) {
    throw new StoredRecordError('authoritative answer winner result', winner.result);
  }
  const answerId = concreteEntityId(
    winnerResult['answerMessageId'] as string,
    'authoritative answer winner answerMessageId',
  );
  const answer = await getMessage(ch, project, answerId);
  if (
    answer === null ||
    answer.protocolVersion !== 1 ||
    answer.envelope.kind !== 'answer' ||
    answer.envelope.payload.type !== 'answer' ||
    answer.envelope.replyToMessageId !== questionId ||
    answer.envelope.projectId !== question.envelope.projectId ||
    answer.envelope.sessionId !== question.envelope.sessionId ||
    answer.envelope.taskId !== question.envelope.taskId ||
    answer.envelope.taskBriefId !== question.envelope.taskBriefId ||
    answer.envelope.assignmentAttemptId !== question.envelope.assignmentAttemptId
  ) {
    throw new StoredRecordError('authoritative answer winner message', {
      projectId: project,
      questionMessageId: questionId,
      answerMessageId: answerId,
    });
  }
  return answer;
}

/**
 * Projenin son mesajları (tüm oturumlar).
 *
 * NEDEN VAR: panelin PM sohbeti SALT-YAZMA idi — kullanıcı mesaj gönderiyor
 * ama konuşmayı okuyamıyordu. Oturuma göre listeleme burada işe yaramaz:
 * her kullanıcı komutu (yanıt değilse) YENİ oturum açar, dolayısıyla
 * oturum bazlı sorgu tek mesaj gösterir. Sohbetin okunabilmesi için proje
 * geneli, SINIRLI ve en yeniden eskiye bir görünüm gerekir.
 */
export async function listRecentMessages(
  ch: ClickHouseClient,
  projectId: string,
  limit = 100,
): Promise<MessageRecord[]> {
  const project = concreteEntityId(projectId, 'projectId');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error('listRecentMessages limiti 1-1000 araliginda olmalidir');
  }
  const result = await ch.query({
    query: `SELECT ${MESSAGE_COLUMNS} FROM messages
      WHERE project_id = {projectId:UUID}
      ORDER BY created_at DESC, message_id
      LIMIT {limit:UInt32}`,
    query_params: { projectId: project, limit },
    format: 'JSONEachRow',
  });
  const grouped = new Map<string, MessageRecord[]>();
  for (const record of (await result.json<unknown>()).map(parseMessageRow)) {
    const messageId = record.protocolVersion === 1
      ? record.envelope.messageId
      : record.messageId;
    const rows = grouped.get(messageId) ?? [];
    rows.push(record);
    grouped.set(messageId, rows);
  }
  return [...grouped.entries()].map(([messageId, records]) => (
    reconcileStoredMessages(records, `message:${messageId}`)
  ));
}

export async function listPendingInboxMessages(
  ch: ClickHouseClient,
  projectId: string,
  recipientId: string,
): Promise<MessageRecord[]> {
  const project = concreteEntityId(projectId, 'projectId');
  const recipient = storedUuid(recipientId, 'recipientId');
  const pendingReceipts = [
    ...await listLatestReceiptsByState(ch, project, recipient, 'enqueued'),
    ...await listLatestReceiptsByState(ch, project, recipient, 'retry_scheduled'),
  ];
  const messageIds = [...new Set(pendingReceipts.map((receipt) => receipt.message_id))];
  if (messageIds.length === 0) return [];
  const result = await ch.query({
    query: `SELECT ${ALIASED_MESSAGE_COLUMNS}
      FROM messages AS m
      WHERE m.project_id = {projectId:UUID} AND m.message_id IN ({messageIds:Array(UUID)})
      ORDER BY m.created_at, m.message_id`,
    query_params: { projectId: project, messageIds },
    format: 'JSONEachRow',
  });
  const grouped = new Map<string, MessageRecord[]>();
  for (const record of (await result.json<unknown>()).map(parseMessageRow)) {
    const messageId = record.protocolVersion === 1
      ? record.envelope.messageId
      : record.messageId;
    const rows = grouped.get(messageId) ?? [];
    rows.push(record);
    grouped.set(messageId, rows);
  }
  const missingMessageIds = messageIds.filter((messageId) => !grouped.has(messageId));
  if (missingMessageIds.length > 0) {
    throw new StoredRecordError('pending inbox receipt message reference', {
      projectId: project,
      missingMessageIds,
    });
  }
  const logical = [...grouped.entries()].map(([messageId, records]) => (
    reconcileStoredMessages(records, `message:${messageId}`)
  ));
  await assertMessageOwnership(ch, project, logical);
  return logical;
}

function assertInboxReceiptMatchesMessage(
  receipt: MessageReceiptRow,
  message: ProtocolV1MessageRecord,
): void {
  const envelope = message.envelope;
  if (
    envelope.messageId !== receipt.message_id ||
    envelope.projectId !== receipt.project_id ||
    receipt.recipient_snapshot.id !== receipt.recipient_id ||
    receipt.recipient_snapshot.type === 'broadcast' ||
    (
      envelope.recipient.type !== 'broadcast' &&
      (
        envelope.recipient.type !== receipt.recipient_snapshot.type ||
        envelope.recipient.id !== receipt.recipient_snapshot.id
      )
    )
  ) {
    throw new StoredRecordError('due inbox message receipt projection', {
      receipt,
      envelope,
    });
  }
}

export async function listDueInboxItems(
  ch: ClickHouseClient,
  options: ListDueInboxItemsOptions,
): Promise<DueInboxItemRecord[]> {
  const receipts = await listDueMessageReceipts(ch, options);
  const items: DueInboxItemRecord[] = [];
  for (const receipt of receipts) {
    const record = await getMessage(ch, receipt.project_id, receipt.message_id);
    if (record === null) {
      throw new StoredRecordError('due inbox receipt message reference', receipt);
    }
    if (record.protocolVersion !== 1) {
      throw new StoredRecordError('due inbox message protocol', record);
    }
    assertInboxReceiptMatchesMessage(receipt, record);
    items.push(Object.freeze({ message: record, receipt }));
  }
  return items;
}

export async function appendMessage(
  ch: ClickHouseClient,
  input: AppendMessageInput,
): Promise<ProtocolV1MessageRecord> {
  const row = toStoredRow(input);
  const parsedExpected = parseMessageRow(row);
  if (parsedExpected.protocolVersion !== 1) {
    throw new StoredRecordError('messages expected protocol', parsedExpected);
  }
  const expected = parsedExpected;
  const projectId = row.project_id as EntityId;
  const messageId = row.message_id as EntityId;
  const readNamespaces = (): Promise<MessageNamespaceRows> => rowsByMessageNamespaces(
    ch,
    projectId,
    messageId,
    row.idempotency_key,
  );
  const existing = await readNamespaces();
  if (!messageNamespacesAreEmpty(existing)) {
    return reconcileMessageNamespaces(expected, existing);
  }

  const entity = `message:${row.message_id}`;
  try {
    await ch.insert({ table: 'messages', values: [row], format: 'JSONEachRow' });
  } catch (error) {
    const observed = await readAfterUncertainWrite(entity, error, readNamespaces);
    validatePresentMessageNamespaces(expected, observed);
    if (
      observed.byMessageId.length === 0 ||
      observed.byIdempotencyKey.length === 0
    ) throw uncertainWriteError(entity, error);
    return expected;
  }
  const observed = await readAfterAcknowledgedWrite(
    entity,
    expected,
    readNamespaces,
  );
  validatePresentMessageNamespaces(expected, observed);
  if (observed.byMessageId.length === 0 || observed.byIdempotencyKey.length === 0) {
    throw acknowledgedWriteVerificationError(
      entity,
      expected,
      new EmptyAcknowledgedWriteVerificationError(entity),
    );
  }
  return expected;
}
