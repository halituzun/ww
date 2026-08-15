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
  readonly lease_fence: UInt64String;
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
  readonly lease_fence: UInt64String;
  readonly created_at: string;
}

export interface AppendEffectVersionInput {
  readonly causation_id: string;
  readonly stable_effect_id: string;
  readonly expectedVersion: UInt64String;
  readonly state: EffectState;
  readonly result: unknown;
  readonly error: string;
  readonly lease_fence: UInt64String;
  readonly created_at: string;
}

export interface EffectReservationEvidence {
  readonly row: EffectLedgerRow;
  readonly hadPriorReservation: boolean;
  readonly priorMaxLeaseFence: UInt64String;
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
  readonly lease_fence: UInt64String;
  readonly created_at: string;
}

const EFFECT_COLUMNS = `causation_id, stable_effect_id, project_id, task_id,
  assignment_attempt_id, effect_type, request_hash, replay_safety, state,
  result_json, error, effect_version, lease_fence, created_at`;
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
      lease_fence: storedUInt64(row['lease_fence'], 'effect_ledger.lease_fence'),
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
    lease_fence: row.lease_fence,
    created_at: row.created_at,
  };
}

async function readEffectRows(
  ch: ClickHouseClient,
  causationId: EntityId,
  stableEffectId: OpaqueIdentifier,
): Promise<EffectLedgerRow[]> {
  const result = await ch.query({
    query: `SELECT ${EFFECT_COLUMNS} FROM effect_ledger
      WHERE causation_id = {causationId:UUID}
        AND stable_effect_id = {stableEffectId:String}`,
    query_params: { causationId, stableEffectId },
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
    lease_fence: row.lease_fence,
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

function foldEffectRows(rows: readonly EffectLedgerRow[]): EffectLedgerRow {
  const maximumFence = rows.reduce(
    (max, row) => BigInt(row.lease_fence) > max ? BigInt(row.lease_fence) : max,
    0n,
  );
  const atFence = rows.filter((row) => BigInt(row.lease_fence) === maximumFence);
  const maximumVersion = atFence.reduce(
    (max, row) => BigInt(row.effect_version) > max ? BigInt(row.effect_version) : max,
    0n,
  );
  const candidates = atFence.filter((row) => BigInt(row.effect_version) === maximumVersion);
  const identityHash = effectIdentityHash(candidates[0]!);
  if (candidates.some((row) => effectIdentityHash(row) !== identityHash)) {
    throw new RepositoryConflictError('effect ayni surum/fence icinde request catismasi');
  }
  return reconcileEffect(candidates[0]!, candidates);
}

function effectAuthorityCompare(left: EffectLedgerRow, right: EffectLedgerRow): number {
  const fence = BigInt(left.lease_fence) - BigInt(right.lease_fence);
  if (fence !== 0n) return fence > 0n ? 1 : -1;
  const version = BigInt(left.effect_version) - BigInt(right.effect_version);
  return version === 0n ? 0 : version > 0n ? 1 : -1;
}

function reconcileEffectWrite(
  expected: EffectLedgerRow,
  observed: readonly EffectLedgerRow[],
): EffectLedgerRow {
  const winner = foldEffectRows(observed);
  if (effectAuthorityCompare(winner, expected) > 0) return winner;
  return reconcileEffect(expected, observed.filter((row) => (
    row.lease_fence === expected.lease_fence &&
    row.effect_version === expected.effect_version
  )));
}

async function insertAndReconcile(
  ch: ClickHouseClient,
  expected: EffectLedgerRow,
): Promise<EffectLedgerRow> {
  const entity = `effect:${expected.causation_id}:${expected.stable_effect_id}`;
  const read = (): Promise<EffectLedgerRow[]> => readEffectRows(
    ch,
    expected.causation_id,
    expected.stable_effect_id,
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
    return reconcileEffectWrite(expected, observed);
  }
  const observed = await readRowsAfterAcknowledgedWrite(entity, expected, read);
  return reconcileEffectWrite(expected, observed);
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
  return foldEffectRows(rows);
}

/** Durable floor used before acquiring the Redis coordination lease. */
export async function getEffectDurableMaxLeaseFence(
  ch: ClickHouseClient,
  causationId: string,
  stableEffectId: string,
): Promise<UInt64String> {
  return (await getLatestEffect(ch, causationId, stableEffectId))?.lease_fence ?? '0';
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
    .map(foldEffectRows)
    .filter((row) => row.state === effectState);
}

/**
 * Reads only highest-fence/latest-version candidates for one durable task.
 * Candidate ties stay visible so the JS fold can reject divergent rows instead
 * of allowing SQL's physical row order to choose a winner.
 */
export async function listLatestTaskEffectsByStates(
  ch: ClickHouseClient,
  taskId: string,
  states: readonly EffectState[],
): Promise<EffectLedgerRow[]> {
  const task = concreteEntityId(taskId, 'taskId');
  if (states.length === 0) throw new StoredRecordError('effectStates', states);
  const requestedStates = new Set(states.map((state) => (
    storedEnum(state, EFFECT_STATES, 'effectState')
  )));
  const result = await ch.query({
    query: `SELECT ${EFFECT_COLUMNS} FROM
      (
        SELECT *, max(effect_version) OVER
          (PARTITION BY causation_id, stable_effect_id) AS maximum_effect_version
        FROM
        (
          SELECT *, max(lease_fence) OVER
            (PARTITION BY causation_id, stable_effect_id) AS maximum_lease_fence
          FROM task_effect_ledger
          PREWHERE task_id = {taskId:UUID}
        )
        WHERE lease_fence = maximum_lease_fence
      )
      WHERE effect_version = maximum_effect_version
      ORDER BY causation_id, stable_effect_id`,
    query_params: { taskId: task },
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
    .map(foldEffectRows)
    .filter((row) => requestedStates.has(row.state));
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
  const leaseFence = storedUInt64(input.lease_fence, 'leaseFence');
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
    if (BigInt(leaseFence) > BigInt(existing.lease_fence)) {
      return insertAndReconcile(ch, Object.freeze({
        ...existing,
        lease_fence: leaseFence,
      }));
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
    lease_fence: leaseFence,
    created_at: input.created_at,
  });
  return insertAndReconcile(ch, expected);
}

/**
 * Reserve under a freshly acquired effect lease and report whether any lower
 * durable fence had already prepared this effect. The post-reconciliation query
 * closes an initially stale pre-read; callers must serialize with effectLockKey.
 */
export async function reserveEffectWithEvidence(
  ch: ClickHouseClient,
  input: ReserveEffectInput,
): Promise<EffectReservationEvidence> {
  const row = await reserveEffect(ch, input);
  const result = await ch.query({
    query: `SELECT count() AS prior_count, toString(max(lease_fence)) AS prior_max_fence
      FROM effect_ledger
      WHERE causation_id = {causationId:UUID}
        AND stable_effect_id = {stableEffectId:String}
        AND lease_fence < {leaseFence:UInt64}`,
    query_params: {
      causationId: row.causation_id,
      stableEffectId: row.stable_effect_id,
      leaseFence: row.lease_fence,
    },
    format: 'JSONEachRow',
  });
  const evidence = storedRecord(
    (await result.json<unknown>())[0],
    'effect reservation evidence',
  );
  const priorCount = storedUInt64(evidence['prior_count'], 'effect prior count');
  const priorMaxLeaseFence = storedUInt64(
    evidence['prior_max_fence'],
    'effect prior max lease fence',
  );
  return Object.freeze({
    row,
    hadPriorReservation: BigInt(priorCount) > 0n,
    priorMaxLeaseFence,
  });
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
  const leaseFence = storedUInt64(input.lease_fence, 'leaseFence');
  if (BigInt(leaseFence) < BigInt(current.lease_fence)) {
    throw new RepositoryConflictError(
      `effect:${causationId}:${stableEffectId} eski lease fence ile yazilamaz`,
    );
  }
  if (current.effect_version !== expectedVersion) {
    if (BigInt(current.effect_version) < BigInt(expectedVersion)) {
      assertExpectedVersion(
        `effect:${causationId}:${stableEffectId}`,
        current.effect_version,
        expectedVersion,
      );
    }
    if (
      current.effect_version === nextRepositoryVersion(expectedVersion) &&
      BigInt(leaseFence) > BigInt(current.lease_fence)
    ) {
      return insertAndReconcile(ch, parseEffectRow({
        ...toStoredRow(current),
        state,
        result_json: canonicalJsonV1(result),
        error: storedString(input.error, 'effectError'),
        lease_fence: leaseFence,
        effect_version: current.effect_version,
        created_at: input.created_at,
      }));
    }
    const desired = parseEffectRow({
      ...toStoredRow(current),
      state,
      result_json: canonicalJsonV1(result),
      error: storedString(input.error, 'effectError'),
      lease_fence: current.lease_fence,
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
    lease_fence: leaseFence,
    created_at: input.created_at,
  });
  return insertAndReconcile(ch, expected);
}
