import type { ClickHouseClient } from '@clickhouse/client';
import {
  JsonValueSchema,
  OpaqueIdentifierSchema,
  TOOL_REPLAY_SAFETY,
  canonicalJsonV1,
  canonicalSha256V1,
  type EntityId,
  type JsonValue,
  type OpaqueIdentifier,
} from '@ww/shared';
import {
  concreteEntityId,
  optionalEntityId,
  storedUuid,
  type StoredOptionalEntityId,
} from './identifiers.js';
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
  uncertainWriteError,
  type UInt64String,
} from './types.js';

export const EFFECT_STATES = ['pending', 'succeeded', 'failed', 'uncertain'] as const;
export type EffectState = (typeof EFFECT_STATES)[number];
export type EffectReplaySafety = (typeof TOOL_REPLAY_SAFETY)[number];

export interface EffectLedgerRow {
  readonly causation_id: EntityId;
  readonly stable_effect_id: OpaqueIdentifier;
  readonly project_id: EntityId;
  readonly task_id: StoredOptionalEntityId;
  readonly assignment_attempt_id: StoredOptionalEntityId;
  readonly effect_type: string;
  readonly request_hash: string;
  readonly replay_safety: EffectReplaySafety;
  readonly state: EffectState;
  readonly result: JsonValue;
  readonly error: string;
  readonly effect_version: UInt64String;
  readonly created_at: string;
}

export interface ReserveEffectInput {
  readonly causation_id: string;
  readonly stable_effect_id: string;
  readonly project_id: string;
  readonly task_id?: string;
  readonly assignment_attempt_id?: string;
  readonly effect_type: string;
  readonly request: unknown;
  readonly replay_safety: EffectReplaySafety;
  readonly created_at: string;
}

export interface AppendEffectVersionInput {
  readonly causation_id: string;
  readonly stable_effect_id: string;
  readonly expectedVersion: UInt64String;
  readonly state: EffectState;
  readonly result: unknown;
  readonly error: string;
  readonly created_at: string;
}

interface StoredEffectRow {
  readonly causation_id: string;
  readonly stable_effect_id: string;
  readonly project_id: string;
  readonly task_id: string;
  readonly assignment_attempt_id: string;
  readonly effect_type: string;
  readonly request_hash: string;
  readonly replay_safety: string;
  readonly state: string;
  readonly result_json: string;
  readonly error: string;
  readonly effect_version: UInt64String;
  readonly created_at: string;
}

const EFFECT_COLUMNS = `causation_id, stable_effect_id, project_id, task_id,
  assignment_attempt_id, effect_type, request_hash, replay_safety, state,
  result_json, error, effect_version, created_at`;
const SHA256 = /^[a-f0-9]{64}$/;

function nonempty(value: unknown, context: string): string {
  const text = storedString(value, context).trim();
  if (text.length === 0) throw new StoredRecordError(context, value);
  return text;
}

function opaqueIdentifier(value: unknown, context: string): OpaqueIdentifier {
  const parsed = OpaqueIdentifierSchema.safeParse(value);
  if (!parsed.success) throw new StoredRecordError(context, parsed.error);
  return parsed.data;
}

function parseEffectRow(value: unknown): EffectLedgerRow {
  const row = storedRecord(value, 'effect_ledger');
  try {
    const resultJson = storedString(row['result_json'], 'effect_ledger.result_json');
    const result = storedJsonValue(resultJson, 'effect_ledger.result_json');
    if (resultJson !== canonicalJsonV1(result)) {
      throw new StoredRecordError('effect_ledger.result_json canonical', resultJson);
    }
    const requestHash = storedString(row['request_hash'], 'effect_ledger.request_hash');
    if (!SHA256.test(requestHash)) {
      throw new StoredRecordError('effect_ledger.request_hash', requestHash);
    }
    return Object.freeze({
      causation_id: concreteEntityId(
        storedUuid(row['causation_id'], 'effect_ledger.causation_id'),
        'effect_ledger.causation_id',
      ),
      stable_effect_id: opaqueIdentifier(
        row['stable_effect_id'],
        'effect_ledger.stable_effect_id',
      ),
      project_id: concreteEntityId(
        storedUuid(row['project_id'], 'effect_ledger.project_id'),
        'effect_ledger.project_id',
      ),
      task_id: optionalEntityId(
        storedUuid(row['task_id'], 'effect_ledger.task_id'),
        'effect_ledger.task_id',
      ),
      assignment_attempt_id: optionalEntityId(
        storedUuid(row['assignment_attempt_id'], 'effect_ledger.assignment_attempt_id'),
        'effect_ledger.assignment_attempt_id',
      ),
      effect_type: nonempty(row['effect_type'], 'effect_ledger.effect_type'),
      request_hash: requestHash,
      replay_safety: storedEnum(
        row['replay_safety'],
        TOOL_REPLAY_SAFETY,
        'effect_ledger.replay_safety',
      ),
      state: storedEnum(row['state'], EFFECT_STATES, 'effect_ledger.state'),
      result,
      error: storedString(row['error'], 'effect_ledger.error'),
      effect_version: storedUInt64(row['effect_version'], 'effect_ledger.effect_version'),
      created_at: storedDateTime(row['created_at'], 'effect_ledger.created_at'),
    });
  } catch (error) {
    if (error instanceof StoredRecordError) throw error;
    throw new StoredRecordError('effect_ledger', error);
  }
}

function toStoredRow(row: EffectLedgerRow): StoredEffectRow {
  return {
    causation_id: row.causation_id,
    stable_effect_id: row.stable_effect_id,
    project_id: row.project_id,
    task_id: row.task_id,
    assignment_attempt_id: row.assignment_attempt_id,
    effect_type: row.effect_type,
    request_hash: row.request_hash,
    replay_safety: row.replay_safety,
    state: row.state,
    result_json: canonicalJsonV1(row.result),
    error: row.error,
    effect_version: row.effect_version,
    created_at: row.created_at,
  };
}

async function readEffectVersion(
  ch: ClickHouseClient,
  causationId: EntityId,
  stableEffectId: OpaqueIdentifier,
  effectVersion: UInt64String,
): Promise<EffectLedgerRow[]> {
  const result = await ch.query({
    query: `SELECT ${EFFECT_COLUMNS} FROM effect_ledger
      WHERE causation_id = {causationId:UUID}
        AND stable_effect_id = {stableEffectId:String}
        AND effect_version = {effectVersion:UInt64}`,
    query_params: { causationId, stableEffectId, effectVersion },
    format: 'JSONEachRow',
  });
  return (await result.json<unknown>()).map(parseEffectRow);
}

function reconcileEffect(
  expected: EffectLedgerRow,
  observed: readonly EffectLedgerRow[],
): EffectLedgerRow {
  if (observed.length === 0) {
    throw new RepositoryWriteError(
      `effect:${expected.causation_id}:${expected.stable_effect_id} yazimi yeniden okunamadi`,
    );
  }
  const expectedHash = canonicalSha256V1(expected);
  if (observed.some((row) => canonicalSha256V1(row) !== expectedHash)) {
    throw new RepositoryConflictError(
      `effect:${expected.causation_id}:${expected.stable_effect_id} surum catismasi`,
    );
  }
  return expected;
}

function effectContentHash(row: EffectLedgerRow): string {
  return canonicalSha256V1({
    causation_id: row.causation_id,
    stable_effect_id: row.stable_effect_id,
    project_id: row.project_id,
    task_id: row.task_id,
    assignment_attempt_id: row.assignment_attempt_id,
    effect_type: row.effect_type,
    request_hash: row.request_hash,
    replay_safety: row.replay_safety,
    state: row.state,
    result: row.result,
    error: row.error,
    created_at: row.created_at,
  });
}

function effectIdentityHash(row: EffectLedgerRow): string {
  return canonicalSha256V1({
    causation_id: row.causation_id,
    stable_effect_id: row.stable_effect_id,
    project_id: row.project_id,
    task_id: row.task_id,
    assignment_attempt_id: row.assignment_attempt_id,
    effect_type: row.effect_type,
    request_hash: row.request_hash,
    replay_safety: row.replay_safety,
  });
}

async function insertAndReconcile(
  ch: ClickHouseClient,
  expected: EffectLedgerRow,
): Promise<EffectLedgerRow> {
  const entity = `effect:${expected.causation_id}:${expected.stable_effect_id}`;
  const read = (): Promise<EffectLedgerRow[]> => readEffectVersion(
    ch,
    expected.causation_id,
    expected.stable_effect_id,
    expected.effect_version,
  );
  try {
    await ch.insert({
      table: 'effect_ledger',
      values: [toStoredRow(expected)],
      format: 'JSONEachRow',
    });
  } catch (error) {
    const observed = await readAfterUncertainWrite(entity, error, read);
    if (observed.length === 0) throw uncertainWriteError(entity, error);
    return reconcileEffect(expected, observed);
  }
  const observed = await readRowsAfterAcknowledgedWrite(entity, expected, read);
  return reconcileEffect(expected, observed);
}

export async function getLatestEffect(
  ch: ClickHouseClient,
  causationId: string,
  stableEffectId: string,
): Promise<EffectLedgerRow | null> {
  const causation = concreteEntityId(causationId, 'causationId');
  const effect = opaqueIdentifier(stableEffectId, 'stableEffectId');
  const result = await ch.query({
    query: `SELECT ${EFFECT_COLUMNS} FROM effect_ledger
      WHERE causation_id = {causationId:UUID} AND stable_effect_id = {stableEffectId:String}`,
    query_params: { causationId: causation, stableEffectId: effect },
    format: 'JSONEachRow',
  });
  const rows = (await result.json<unknown>()).map(parseEffectRow);
  if (rows.length === 0) return null;
  const identityHash = effectIdentityHash(rows[0]!);
  if (rows.some((row) => effectIdentityHash(row) !== identityHash)) {
    throw new RepositoryConflictError(
      `effect:${causation}:${effect} gecmisinde farkli request kimligi var`,
    );
  }
  const maximum = rows.reduce(
    (max, row) => BigInt(row.effect_version) > max ? BigInt(row.effect_version) : max,
    0n,
  ).toString();
  const latest = rows.filter((row) => row.effect_version === maximum);
  return reconcileEffect(latest[0]!, latest);
}

export async function listLatestEffectsByState(
  ch: ClickHouseClient,
  projectId: string,
  state: EffectState,
): Promise<EffectLedgerRow[]> {
  const project = concreteEntityId(projectId, 'projectId');
  const effectState = storedEnum(state, EFFECT_STATES, 'effectState');
  const result = await ch.query({
    query: `SELECT ${EFFECT_COLUMNS} FROM effect_ledger
      WHERE project_id = {projectId:UUID}
        AND (causation_id, stable_effect_id, effect_version) IN (
          SELECT causation_id, stable_effect_id, max(effect_version)
          FROM effect_ledger
          WHERE project_id = {projectId:UUID}
          GROUP BY causation_id, stable_effect_id
        )
      ORDER BY causation_id, stable_effect_id`,
    query_params: { projectId: project },
    format: 'JSONEachRow',
  });
  const grouped = new Map<string, EffectLedgerRow[]>();
  for (const row of (await result.json<unknown>()).map(parseEffectRow)) {
    const key = canonicalJsonV1([row.causation_id, row.stable_effect_id]);
    const rows = grouped.get(key) ?? [];
    rows.push(row);
    grouped.set(key, rows);
  }
  return [...grouped.values()]
    .map((rows) => reconcileEffect(rows[0]!, rows))
    .filter((row) => row.state === effectState);
}

export async function reserveEffect(
  ch: ClickHouseClient,
  input: ReserveEffectInput,
): Promise<EffectLedgerRow> {
  const causationId = concreteEntityId(input.causation_id, 'causationId');
  const stableEffectId = opaqueIdentifier(input.stable_effect_id, 'stableEffectId');
  const projectId = concreteEntityId(input.project_id, 'projectId');
  const taskId = input.task_id === undefined
    ? optionalEntityId(storedUuid('00000000-0000-0000-0000-000000000000', 'taskId'), 'taskId')
    : optionalEntityId(storedUuid(input.task_id, 'taskId'), 'taskId');
  const assignmentAttemptId = input.assignment_attempt_id === undefined
    ? optionalEntityId(
      storedUuid('00000000-0000-0000-0000-000000000000', 'assignmentAttemptId'),
      'assignmentAttemptId',
    )
    : optionalEntityId(storedUuid(input.assignment_attempt_id, 'assignmentAttemptId'), 'assignmentAttemptId');
  const request = JsonValueSchema.parse(input.request);
  const replaySafety = storedEnum(input.replay_safety, TOOL_REPLAY_SAFETY, 'replaySafety');
  const effectType = nonempty(input.effect_type, 'effectType');
  const requestHash = canonicalSha256V1(request);
  const existing = await getLatestEffect(ch, causationId, stableEffectId);
  if (existing !== null) {
    const same = existing.project_id === projectId &&
      existing.task_id === taskId &&
      existing.assignment_attempt_id === assignmentAttemptId &&
      existing.effect_type === effectType &&
      existing.request_hash === requestHash &&
      existing.replay_safety === replaySafety;
    if (!same) {
      throw new RepositoryConflictError(
        `effect anahtari farkli istekle kullanildi: ${causationId}:${stableEffectId}`,
      );
    }
    return existing;
  }
  const expected = parseEffectRow({
    causation_id: causationId,
    stable_effect_id: stableEffectId,
    project_id: projectId,
    task_id: taskId,
    assignment_attempt_id: assignmentAttemptId,
    effect_type: effectType,
    request_hash: requestHash,
    replay_safety: replaySafety,
    state: 'pending',
    result_json: '{}',
    error: '',
    effect_version: nextRepositoryVersion(),
    created_at: input.created_at,
  });
  return insertAndReconcile(ch, expected);
}

export async function appendEffectVersion(
  ch: ClickHouseClient,
  input: AppendEffectVersionInput,
): Promise<EffectLedgerRow> {
  const causationId = concreteEntityId(input.causation_id, 'causationId');
  const stableEffectId = opaqueIdentifier(input.stable_effect_id, 'stableEffectId');
  const current = await getLatestEffect(ch, causationId, stableEffectId);
  if (current === null) {
    throw new RepositoryNotFoundError(`effect bulunamadi: ${causationId}:${stableEffectId}`);
  }
  const state = storedEnum(input.state, EFFECT_STATES, 'effectState');
  const result = JsonValueSchema.parse(input.result);
  const expectedVersion = storedUInt64(input.expectedVersion, 'expectedVersion');
  if (current.effect_version !== expectedVersion) {
    if (BigInt(current.effect_version) < BigInt(expectedVersion)) {
      assertExpectedVersion(
        `effect:${causationId}:${stableEffectId}`,
        current.effect_version,
        expectedVersion,
      );
    }
    const desired = parseEffectRow({
      ...toStoredRow(current),
      state,
      result_json: canonicalJsonV1(result),
      error: storedString(input.error, 'effectError'),
      effect_version: current.effect_version,
      created_at: input.created_at,
    });
    if (
      effectContentHash(current) === effectContentHash(desired)
    ) return current;
    assertExpectedVersion(
      `effect:${causationId}:${stableEffectId}`,
      current.effect_version,
      expectedVersion,
    );
  }
  const expected = parseEffectRow({
    ...toStoredRow(current),
    state,
    result_json: canonicalJsonV1(result),
    error: storedString(input.error, 'effectError'),
    effect_version: nextRepositoryVersion(current.effect_version),
    created_at: input.created_at,
  });
  return insertAndReconcile(ch, expected);
}
