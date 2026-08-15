import type { ClickHouseClient } from '@clickhouse/client';
import {
  NIL_UUID,
  OpaqueIdentifierSchema,
  TaskCausalCursorV1Schema,
  canonicalSha256V1,
  type EntityId,
  type TaskCausalCursorV1,
} from '@ww/shared';
import { concreteEntityId, optionalEntityId, storedUuid, type StoredOptionalEntityId } from './identifiers.js';
import {
  EmptyAcknowledgedWriteVerificationError,
  RepositoryConflictError,
  RepositoryWriteError,
  StoredRecordError,
  acknowledgedWriteVerificationError,
  readAfterAcknowledgedWrite,
  readAfterUncertainWrite,
  storedDateTime,
  storedRecord,
  storedString,
  storedUInt64,
  uncertainWriteError,
  type UInt64String,
} from './types.js';

export interface TaskCausalEntryRow {
  readonly task_id: EntityId;
  readonly task_brief_id: EntityId;
  readonly assignment_attempt_id: EntityId;
  readonly handoff_id: StoredOptionalEntityId;
  readonly ordinal: number;
  readonly entry_id: EntityId;
  readonly source_type: string;
  readonly source_id: string;
  readonly causation_id: StoredOptionalEntityId;
  readonly lease_fence: UInt64String;
  readonly created_at: string;
}

export type AppendTaskCausalEntryInput = Omit<TaskCausalEntryRow, 'entry_id' | 'ordinal'>;

interface CausalEntryNamespaceRows {
  readonly byEntryId: readonly TaskCausalEntryRow[];
  readonly byOrdinal: readonly TaskCausalEntryRow[];
}

const CAUSAL_COLUMNS = `task_id, task_brief_id, assignment_attempt_id,
  handoff_id, ordinal, entry_id, source_type, source_id, causation_id,
  lease_fence, created_at`;
const SOURCE_TYPE = /^[a-z][a-z0-9_]*$/;

function safeOrdinal(value: unknown, context: string): number {
  const parsed = BigInt(storedUInt64(value, context));
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) throw new StoredRecordError(context, value);
  return Number(parsed);
}

function sourceType(value: unknown): string {
  const parsed = storedString(value, 'task_causal_entries.source_type');
  if (!SOURCE_TYPE.test(parsed)) throw new StoredRecordError('task_causal_entries.source_type', value);
  return parsed;
}

function sourceId(value: unknown): string {
  const parsed = OpaqueIdentifierSchema.safeParse(value);
  if (!parsed.success) throw new StoredRecordError('task_causal_entries.source_id', parsed.error);
  return parsed.data;
}

function parseCausalEntry(value: unknown): TaskCausalEntryRow {
  const row = storedRecord(value, 'task_causal_entries');
  return Object.freeze({
    task_id: concreteEntityId(storedUuid(row['task_id'], 'task_causal_entries.task_id'), 'task_causal_entries.task_id'),
    task_brief_id: concreteEntityId(storedUuid(row['task_brief_id'], 'task_causal_entries.task_brief_id'), 'task_causal_entries.task_brief_id'),
    assignment_attempt_id: concreteEntityId(storedUuid(row['assignment_attempt_id'], 'task_causal_entries.assignment_attempt_id'), 'task_causal_entries.assignment_attempt_id'),
    handoff_id: optionalEntityId(storedUuid(row['handoff_id'], 'task_causal_entries.handoff_id'), 'task_causal_entries.handoff_id'),
    ordinal: safeOrdinal(row['ordinal'], 'task_causal_entries.ordinal'),
    entry_id: concreteEntityId(storedUuid(row['entry_id'], 'task_causal_entries.entry_id'), 'task_causal_entries.entry_id'),
    source_type: sourceType(row['source_type']),
    source_id: sourceId(row['source_id']),
    causation_id: optionalEntityId(storedUuid(row['causation_id'], 'task_causal_entries.causation_id'), 'task_causal_entries.causation_id'),
    lease_fence: storedUInt64(row['lease_fence'], 'task_causal_entries.lease_fence'),
    created_at: storedDateTime(row['created_at'], 'task_causal_entries.created_at'),
  });
}

function normalizeInput(input: AppendTaskCausalEntryInput): AppendTaskCausalEntryInput {
  return Object.freeze({
    task_id: concreteEntityId(input.task_id, 'taskId'),
    task_brief_id: concreteEntityId(input.task_brief_id, 'taskBriefId'),
    assignment_attempt_id: concreteEntityId(input.assignment_attempt_id, 'assignmentAttemptId'),
    handoff_id: optionalEntityId(input.handoff_id, 'handoffId'),
    source_type: sourceType(input.source_type),
    source_id: sourceId(input.source_id),
    causation_id: optionalEntityId(input.causation_id, 'causationId'),
    lease_fence: storedUInt64(input.lease_fence, 'leaseFence'),
    created_at: storedDateTime(input.created_at, 'createdAt'),
  });
}

/** Stable UUID derived only from the logical causal source identity. */
export function deterministicCausalEntryId(input: AppendTaskCausalEntryInput): EntityId {
  const normalized = normalizeInput(input);
  const hex = canonicalSha256V1({
    taskId: normalized.task_id,
    taskBriefId: normalized.task_brief_id,
    assignmentAttemptId: normalized.assignment_attempt_id,
    handoffId: normalized.handoff_id,
    sourceType: normalized.source_type,
    sourceId: normalized.source_id,
    causationId: normalized.causation_id,
  });
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return concreteEntityId(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`,
    'entryId',
  );
}

export function causalEntryHash(entry: TaskCausalEntryRow): string {
  return canonicalSha256V1(entry);
}

function causalEntryContentHash(entry: TaskCausalEntryRow): string {
  return canonicalSha256V1({
    task_id: entry.task_id,
    task_brief_id: entry.task_brief_id,
    assignment_attempt_id: entry.assignment_attempt_id,
    handoff_id: entry.handoff_id,
    ordinal: entry.ordinal,
    entry_id: entry.entry_id,
    source_type: entry.source_type,
    source_id: entry.source_id,
    causation_id: entry.causation_id,
    created_at: entry.created_at,
  });
}

function highestFenceRows(
  rows: readonly TaskCausalEntryRow[],
): readonly TaskCausalEntryRow[] {
  const maximum = rows.reduce(
    (current, row) => BigInt(row.lease_fence) > current
      ? BigInt(row.lease_fence)
      : current,
    0n,
  );
  return rows.filter((row) => BigInt(row.lease_fence) === maximum);
}

function reconcileEntry(
  expected: TaskCausalEntryRow,
  observed: readonly TaskCausalEntryRow[],
): TaskCausalEntryRow {
  if (observed.length === 0) throw new RepositoryWriteError(`causalEntry:${expected.entry_id} yazimi yeniden okunamadi`);
  const expectedHash = causalEntryHash(expected);
  if (observed.some((row) => causalEntryHash(row) !== expectedHash)) {
    throw new RepositoryConflictError(`causalEntry:${expected.entry_id} deterministic kimlik/hash catismasi`);
  }
  return observed[0]!;
}

function foldEntryRows(
  entryId: EntityId,
  rows: readonly TaskCausalEntryRow[],
): TaskCausalEntryRow {
  const logicalHash = causalEntryContentHash(rows[0]!);
  if (rows.some((row) => (
    row.entry_id !== entryId || causalEntryContentHash(row) !== logicalHash
  ))) {
    throw new RepositoryConflictError(
      `causalEntry:${entryId} deterministic kimlik/hash catismasi`,
    );
  }
  const candidates = highestFenceRows(rows);
  return reconcileEntry(candidates[0]!, candidates);
}

async function readAttemptRows(
  ch: ClickHouseClient,
  taskId: EntityId,
  assignmentAttemptId: EntityId,
): Promise<TaskCausalEntryRow[]> {
  const result = await ch.query({
    query: `SELECT ${CAUSAL_COLUMNS} FROM task_causal_entries
      WHERE task_id = {taskId:UUID} AND assignment_attempt_id = {assignmentAttemptId:UUID}
      ORDER BY ordinal ASC, entry_id ASC`,
    query_params: { taskId, assignmentAttemptId },
    format: 'JSONEachRow',
  });
  return (await result.json<unknown>()).map(parseCausalEntry);
}

async function readEntryNamespaces(
  ch: ClickHouseClient,
  expected: TaskCausalEntryRow,
): Promise<CausalEntryNamespaceRows> {
  const result = await ch.query({
    query: `SELECT ${CAUSAL_COLUMNS} FROM task_causal_entries
      WHERE task_id = {taskId:UUID}
        AND assignment_attempt_id = {assignmentAttemptId:UUID}
        AND (entry_id = {entryId:UUID} OR ordinal = {ordinal:UInt64})`,
    query_params: {
      taskId: expected.task_id,
      assignmentAttemptId: expected.assignment_attempt_id,
      entryId: expected.entry_id,
      ordinal: expected.ordinal,
    },
    format: 'JSONEachRow',
  });
  const rows = (await result.json<unknown>()).map(parseCausalEntry);
  return Object.freeze({
    byEntryId: rows.filter((row) => row.entry_id === expected.entry_id),
    byOrdinal: rows.filter((row) => row.ordinal === expected.ordinal),
  });
}

async function foldAttemptRows(
  taskId: EntityId,
  assignmentAttemptId: EntityId,
  physical: readonly TaskCausalEntryRow[],
): Promise<TaskCausalEntryRow[]> {
  const byEntryId = new Map<string, TaskCausalEntryRow[]>();
  for (const row of physical) {
    if (row.task_id !== taskId || row.assignment_attempt_id !== assignmentAttemptId) {
      throw new RepositoryConflictError(
        `causal stream kimlik catismasi: task=${taskId}, attempt=${assignmentAttemptId}`,
      );
    }
    const duplicates = byEntryId.get(row.entry_id) ?? [];
    duplicates.push(row);
    byEntryId.set(row.entry_id, duplicates);
  }
  const logical: TaskCausalEntryRow[] = [];
  for (const [entryId, duplicates] of byEntryId) {
    logical.push(foldEntryRows(concreteEntityId(entryId, 'entryId'), duplicates));
  }
  const byOrdinal = new Map<number, TaskCausalEntryRow[]>();
  for (const row of logical) {
    const entries = byOrdinal.get(row.ordinal) ?? [];
    entries.push(row);
    byOrdinal.set(row.ordinal, entries);
  }
  const folded: TaskCausalEntryRow[] = [];
  for (const [ordinal, rows] of byOrdinal) {
    const entryIds = new Set(rows.map((row) => row.entry_id));
    if (entryIds.size !== 1) {
      throw new RepositoryConflictError(
        `causal ordinal catismasi: attempt=${assignmentAttemptId}, ordinal=${ordinal}`,
      );
    }
    folded.push(rows[0]!);
  }
  folded.sort((left, right) => left.ordinal - right.ordinal || left.entry_id.localeCompare(right.entry_id));
  return folded;
}

export async function getTaskCausalEntry(
  ch: ClickHouseClient,
  taskId: string,
  assignmentAttemptId: string,
  entryId: string,
): Promise<TaskCausalEntryRow | null> {
  const task = concreteEntityId(taskId, 'taskId');
  const attempt = concreteEntityId(assignmentAttemptId, 'assignmentAttemptId');
  const entry = concreteEntityId(entryId, 'entryId');
  const stream = await foldAttemptRows(task, attempt, await readAttemptRows(ch, task, attempt));
  return stream.find((row) => row.entry_id === entry) ?? null;
}

export async function listTaskCausalEntries(
  ch: ClickHouseClient,
  taskId: string,
  assignmentAttemptId: string,
): Promise<TaskCausalEntryRow[]> {
  const task = concreteEntityId(taskId, 'taskId');
  const attempt = concreteEntityId(assignmentAttemptId, 'assignmentAttemptId');
  return foldAttemptRows(task, attempt, await readAttemptRows(ch, task, attempt));
}

function nextOrdinal(stream: readonly TaskCausalEntryRow[]): number {
  const maximum = stream.at(-1)?.ordinal;
  if (maximum === undefined) return 0;
  if (maximum === Number.MAX_SAFE_INTEGER) {
    throw new RepositoryConflictError('task causal ordinal guvenli tamsayi alanini tuketti');
  }
  return maximum + 1;
}

function assertOrdinalUniqueRows(
  expected: TaskCausalEntryRow,
  rows: readonly TaskCausalEntryRow[],
): TaskCausalEntryRow {
  if (rows.length === 0) {
    throw new RepositoryWriteError(
      `causal ordinal yeniden okunamadi: attempt=${expected.assignment_attempt_id}, ordinal=${expected.ordinal}`,
    );
  }
  const entryIds = new Set(rows.map((row) => row.entry_id));
  if (entryIds.size !== 1) {
    throw new RepositoryConflictError(
      `causal ordinal catismasi: attempt=${expected.assignment_attempt_id}, ordinal=${expected.ordinal}`,
    );
  }
  const winner = foldEntryRows(rows[0]!.entry_id, rows);
  if (
    winner.entry_id === expected.entry_id &&
    BigInt(winner.lease_fence) <= BigInt(expected.lease_fence) &&
    causalEntryHash(winner) !== causalEntryHash(expected)
  ) {
    throw new RepositoryConflictError(
      `causalEntry:${expected.entry_id} ordinal projection catismasi`,
    );
  }
  return winner;
}

async function validatePresentEntryNamespaces(
  expected: TaskCausalEntryRow,
  rows: CausalEntryNamespaceRows,
): Promise<TaskCausalEntryRow | null> {
  let entryWinner: TaskCausalEntryRow | undefined;
  if (rows.byEntryId.length > 0) {
    entryWinner = foldEntryRows(expected.entry_id, rows.byEntryId);
    if (
      causalEntryContentHash(entryWinner) !== causalEntryContentHash(expected)
    ) {
      throw new RepositoryConflictError(
        `causalEntry:${expected.entry_id} deterministic kimlik/hash catismasi`,
      );
    }
  }
  let ordinalWinner: TaskCausalEntryRow | undefined;
  if (rows.byOrdinal.length > 0) {
    ordinalWinner = assertOrdinalUniqueRows(expected, rows.byOrdinal);
  }
  if (
    entryWinner !== undefined && ordinalWinner !== undefined &&
    entryWinner.entry_id !== ordinalWinner.entry_id
  ) {
    throw new RepositoryConflictError(
      `causal ordinal catismasi: attempt=${expected.assignment_attempt_id}, ordinal=${expected.ordinal}`,
    );
  }
  return entryWinner ?? ordinalWinner ?? null;
}

export async function appendTaskCausalEntry(
  ch: ClickHouseClient,
  input: AppendTaskCausalEntryInput,
): Promise<TaskCausalEntryRow> {
  const normalized = normalizeInput(input);
  const entryId = deterministicCausalEntryId(normalized);
  const physical = await readAttemptRows(
    ch,
    normalized.task_id,
    normalized.assignment_attempt_id,
  );
  const stream = await foldAttemptRows(
    normalized.task_id,
    normalized.assignment_attempt_id,
    physical,
  );
  const priorRows = physical.filter((row) => row.entry_id === entryId);
  const priorEntry = priorRows.length === 0
    ? undefined
    : foldEntryRows(entryId, priorRows);
  if (priorEntry !== undefined) {
    const expected = { ...normalized, ordinal: priorEntry.ordinal, entry_id: entryId };
    if (causalEntryContentHash(expected) !== causalEntryContentHash(priorEntry)) {
      throw new RepositoryConflictError(
        `causalEntry:${entryId} deterministic kimlik/hash catismasi`,
      );
    }
    const ordinalWinner = stream.find((row) => row.ordinal === priorEntry.ordinal);
    if (
      ordinalWinner !== undefined && ordinalWinner.entry_id !== entryId
    ) {
      throw new RepositoryConflictError(
        `causal ordinal daha yeni fence tarafindan sahiplenildi: attempt=${normalized.assignment_attempt_id}, ordinal=${priorEntry.ordinal}`,
      );
    }
    if (
      ordinalWinner?.entry_id === entryId &&
      BigInt(normalized.lease_fence) <= BigInt(priorEntry.lease_fence)
    ) return priorEntry;
    return insertCausalEntry(ch, Object.freeze(expected));
  }

  const expected = Object.freeze({
    ...normalized,
    ordinal: nextOrdinal(stream),
    entry_id: entryId,
  });
  return insertCausalEntry(ch, expected);
}

async function insertCausalEntry(
  ch: ClickHouseClient,
  expected: TaskCausalEntryRow,
): Promise<TaskCausalEntryRow> {
  try {
    await ch.insert({ table: 'task_causal_entries', values: [expected], format: 'JSONEachRow' });
  } catch (error) {
    const entity = `causalEntry:${expected.entry_id}`;
    const observed = await readAfterUncertainWrite(
      entity,
      error,
      () => readEntryNamespaces(ch, expected),
    );
    const winner = await validatePresentEntryNamespaces(expected, observed);
    if (observed.byEntryId.length === 0 || observed.byOrdinal.length === 0) {
      throw uncertainWriteError(entity, error);
    }
    if (winner !== null && winner.entry_id !== expected.entry_id) {
      throw new RepositoryConflictError(
        `causal ordinal daha yeni fence tarafindan sahiplenildi: attempt=${expected.assignment_attempt_id}, ordinal=${expected.ordinal}`,
      );
    }
    return winner ?? expected;
  }
  const observed = await readAfterAcknowledgedWrite(
    `causalEntry:${expected.entry_id}`,
    expected,
    () => readEntryNamespaces(ch, expected),
  );
  const winner = await validatePresentEntryNamespaces(expected, observed);
  if (observed.byEntryId.length === 0 || observed.byOrdinal.length === 0) {
    const entity = `causalEntry:${expected.entry_id}`;
    throw acknowledgedWriteVerificationError(
      entity,
      expected,
      new EmptyAcknowledgedWriteVerificationError(entity),
    );
  }
  if (winner !== null && winner.entry_id !== expected.entry_id) {
    throw new RepositoryConflictError(
      `causal ordinal daha yeni fence tarafindan sahiplenildi: attempt=${expected.assignment_attempt_id}, ordinal=${expected.ordinal}`,
    );
  }
  return winner ?? expected;
}

export async function getTaskCausalCursor(
  ch: ClickHouseClient,
  taskId: string,
  assignmentAttemptId: string,
): Promise<TaskCausalCursorV1 | null> {
  const rows = await listTaskCausalEntries(ch, taskId, assignmentAttemptId);
  const latest = rows.at(-1);
  if (latest === undefined) return null;
  return TaskCausalCursorV1Schema.parse({
    assignmentAttemptId: latest.assignment_attempt_id,
    ...(latest.handoff_id === NIL_UUID ? {} : { handoffId: latest.handoff_id }),
    ordinal: latest.ordinal,
  });
}
