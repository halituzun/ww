import type { ClickHouseClient } from '@clickhouse/client';
import {
  AGENT_GROUPS,
  TASK_STATUSES,
  canonicalSha256V1,
  type AgentGroup,
  type EntityId,
  type TaskStatus,
} from '@ww/shared';
import {
  concreteEntityId,
  optionalEntityId,
  storedEntityIdArray,
  storedUuid,
  type StoredOptionalEntityId,
} from './identifiers.js';
import {
  RepositoryConflictError,
  RepositoryNotFoundError,
  StoredRecordError,
  assertExpectedVersion,
  nextRepositoryVersion,
  readRowsAfterAcknowledgedWrite,
  readAfterUncertainWrite,
  reconcileVersionedWrite,
  storedDateTime,
  storedEnum,
  storedRecord,
  storedString,
  storedStringArray,
  storedUInt64,
  storedUnsignedInteger,
  uncertainWriteError,
  type UInt64String,
} from './types.js';

export interface TaskRow {
  readonly task_id: EntityId;
  readonly project_id: EntityId;
  readonly plan_id: StoredOptionalEntityId;
  readonly parent_task_id: StoredOptionalEntityId;
  readonly title: string;
  readonly description: string;
  readonly status: TaskStatus;
  readonly priority: number;
  readonly issuer_agent_id: EntityId;
  readonly worker_agent_id: StoredOptionalEntityId;
  readonly verifier_agent_id: StoredOptionalEntityId;
  readonly group: AgentGroup;
  readonly depends_on: readonly EntityId[];
  readonly target_files: readonly string[];
  readonly attempt: number;
  readonly max_attempts: number;
  readonly delegation_depth: number;
  readonly token_budget: number;
  readonly tokens_spent: UInt64String;
  readonly commit_hash: string;
  readonly result_summary: string;
  readonly reject_reason: string;
  readonly task_brief_id: StoredOptionalEntityId;
  readonly assignment_attempt_id: StoredOptionalEntityId;
  readonly created_at: string;
  readonly updated_at: string;
  readonly version: UInt64String;
}

export type CreateTaskInput = Omit<TaskRow, 'version'>;

export interface AppendTaskVersionInput {
  readonly expectedVersion: UInt64String;
  readonly next: Omit<TaskRow, 'version'>;
}

const TASK_COLUMNS = `task_id, project_id, plan_id, parent_task_id, title,
  description, status, priority, issuer_agent_id, worker_agent_id,
  verifier_agent_id, \`group\`, depends_on, target_files, attempt, max_attempts,
  delegation_depth, token_budget, tokens_spent, commit_hash, result_summary,
  reject_reason, task_brief_id, assignment_attempt_id, created_at, updated_at,
  version, row_hash`;
const ROW_HASH = /^[0-9a-f]{64}$/;

function taskRowHash(row: TaskRow): string {
  return canonicalSha256V1([
    row.task_id,
    row.project_id,
    row.plan_id,
    row.parent_task_id,
    row.title,
    row.description,
    row.status,
    row.priority,
    row.issuer_agent_id,
    row.worker_agent_id,
    row.verifier_agent_id,
    row.group,
    [...row.depends_on],
    [...row.target_files],
    row.attempt,
    row.max_attempts,
    row.delegation_depth,
    row.token_budget,
    row.tokens_spent,
    row.commit_hash,
    row.result_summary,
    row.reject_reason,
    row.task_brief_id,
    row.assignment_attempt_id,
    row.created_at,
    row.updated_at,
    row.version,
  ]);
}

function parseTaskRow(value: unknown): TaskRow {
  const row = storedRecord(value, 'tasks');
  const parsed: TaskRow = Object.freeze({
    task_id: concreteEntityId(storedUuid(row['task_id'], 'tasks.task_id'), 'tasks.task_id'),
    project_id: concreteEntityId(
      storedUuid(row['project_id'], 'tasks.project_id'),
      'tasks.project_id',
    ),
    plan_id: optionalEntityId(storedUuid(row['plan_id'], 'tasks.plan_id'), 'tasks.plan_id'),
    parent_task_id: optionalEntityId(
      storedUuid(row['parent_task_id'], 'tasks.parent_task_id'),
      'tasks.parent_task_id',
    ),
    title: storedString(row['title'], 'tasks.title'),
    description: storedString(row['description'], 'tasks.description'),
    status: storedEnum(row['status'], TASK_STATUSES, 'tasks.status'),
    priority: storedUnsignedInteger(row['priority'], 'tasks.priority', 9),
    issuer_agent_id: concreteEntityId(
      storedUuid(row['issuer_agent_id'], 'tasks.issuer_agent_id'),
      'tasks.issuer_agent_id',
    ),
    worker_agent_id: optionalEntityId(
      storedUuid(row['worker_agent_id'], 'tasks.worker_agent_id'),
      'tasks.worker_agent_id',
    ),
    verifier_agent_id: optionalEntityId(
      storedUuid(row['verifier_agent_id'], 'tasks.verifier_agent_id'),
      'tasks.verifier_agent_id',
    ),
    group: storedEnum(row['group'], AGENT_GROUPS, 'tasks.group'),
    depends_on: storedEntityIdArray(row['depends_on'], 'tasks.depends_on'),
    target_files: storedStringArray(row['target_files'], 'tasks.target_files'),
    attempt: storedUnsignedInteger(row['attempt'], 'tasks.attempt', 255),
    max_attempts: storedUnsignedInteger(row['max_attempts'], 'tasks.max_attempts', 255),
    delegation_depth: storedUnsignedInteger(
      row['delegation_depth'],
      'tasks.delegation_depth',
      255,
    ),
    token_budget: storedUnsignedInteger(row['token_budget'], 'tasks.token_budget', 4_294_967_295),
    tokens_spent: storedUInt64(row['tokens_spent'], 'tasks.tokens_spent'),
    commit_hash: storedString(row['commit_hash'], 'tasks.commit_hash'),
    result_summary: storedString(row['result_summary'], 'tasks.result_summary'),
    reject_reason: storedString(row['reject_reason'], 'tasks.reject_reason'),
    task_brief_id: optionalEntityId(
      storedUuid(row['task_brief_id'], 'tasks.task_brief_id'),
      'tasks.task_brief_id',
    ),
    assignment_attempt_id: optionalEntityId(
      storedUuid(row['assignment_attempt_id'], 'tasks.assignment_attempt_id'),
      'tasks.assignment_attempt_id',
    ),
    created_at: storedDateTime(row['created_at'], 'tasks.created_at'),
    updated_at: storedDateTime(row['updated_at'], 'tasks.updated_at'),
    version: storedUInt64(row['version'], 'tasks.version'),
  });
  if (row['row_hash'] !== undefined) {
    const hash = storedString(row['row_hash'], 'tasks.row_hash');
    if (hash !== '' && (!ROW_HASH.test(hash) || hash !== taskRowHash(parsed))) {
      throw new StoredRecordError('tasks.row_hash integrity', { hash, row: parsed });
    }
  }
  return parsed;
}

function toInsertRow(row: TaskRow): Record<string, unknown> {
  return { ...row, row_hash: taskRowHash(row) };
}

async function readTaskVersion(
  ch: ClickHouseClient,
  projectId: EntityId,
  taskId: EntityId,
  version: UInt64String,
): Promise<TaskRow[]> {
  const result = await ch.query({
    query: `SELECT ${TASK_COLUMNS} FROM tasks
      WHERE project_id = {projectId:UUID} AND task_id = {taskId:UUID}
        AND version = {version:UInt64}`,
    query_params: { projectId, taskId, version },
    format: 'JSONEachRow',
  });
  return (await result.json<unknown>()).map(parseTaskRow);
}

export async function getLatestTask(
  ch: ClickHouseClient,
  projectId: string,
  taskId: string,
): Promise<TaskRow | null> {
  const project = concreteEntityId(projectId, 'projectId');
  const task = concreteEntityId(taskId, 'taskId');
  const result = await ch.query({
    query: `SELECT ${TASK_COLUMNS} FROM tasks
      WHERE project_id = {projectId:UUID} AND task_id = {taskId:UUID}
      ORDER BY version DESC`,
    query_params: { projectId: project, taskId: task },
    format: 'JSONEachRow',
  });
  const rows = (await result.json<unknown>()).map(parseTaskRow);
  if (rows.length === 0) return null;
  const maximum = rows[0]!.version;
  return reconcileVersionedWrite(
    `task:${task}`,
    rows[0]!,
    rows.filter((row) => row.version === maximum),
  );
}

export async function listLatestTasksByStatus(
  ch: ClickHouseClient,
  projectId: string,
  status: TaskStatus,
): Promise<TaskRow[]> {
  const project = concreteEntityId(projectId, 'projectId');
  const state = storedEnum(status, TASK_STATUSES, 'taskStatus');
  const result = await ch.query({
    query: `SELECT ${TASK_COLUMNS} FROM tasks
      WHERE project_id = {projectId:UUID}
        AND (task_id, version) IN (
          SELECT task_id, max(version) FROM tasks
          WHERE project_id = {projectId:UUID}
          GROUP BY task_id
        )
      ORDER BY task_id`,
    query_params: { projectId: project },
    format: 'JSONEachRow',
  });
  const grouped = new Map<string, TaskRow[]>();
  for (const row of (await result.json<unknown>()).map(parseTaskRow)) {
    const rows = grouped.get(row.task_id) ?? [];
    rows.push(row);
    grouped.set(row.task_id, rows);
  }
  return [...grouped.values()]
    .map((rows) => reconcileVersionedWrite(`task:${rows[0]!.task_id}`, rows[0]!, rows))
    .filter((row) => row.status === state);
}

export async function createTask(ch: ClickHouseClient, input: CreateTaskInput): Promise<TaskRow> {
  const projectId = concreteEntityId(input.project_id, 'projectId');
  const taskId = concreteEntityId(input.task_id, 'taskId');
  const current = await getLatestTask(ch, projectId, taskId);
  if (current !== null) {
    const desired = parseTaskRow({
      ...input,
      project_id: projectId,
      task_id: taskId,
      version: current.version,
    });
    if (canonicalSha256V1(current) === canonicalSha256V1(desired)) return current;
    throw new RepositoryConflictError(`task zaten var: ${taskId}`);
  }
  const row = parseTaskRow({
    ...input,
    project_id: projectId,
    task_id: taskId,
    version: nextRepositoryVersion(),
  });
  try {
    await ch.insert({ table: 'tasks', values: [toInsertRow(row)], format: 'JSONEachRow' });
  } catch (error) {
    const observed = await readAfterUncertainWrite(
      `task:${taskId}`,
      error,
      () => readTaskVersion(ch, projectId, taskId, row.version),
    );
    if (observed.length > 0) return reconcileVersionedWrite(`task:${taskId}`, row, observed);
    throw uncertainWriteError(`task:${taskId}`, error);
  }
  const observed = await readRowsAfterAcknowledgedWrite(
    `task:${taskId}`,
    row,
    () => readTaskVersion(ch, projectId, taskId, row.version),
  );
  return reconcileVersionedWrite(`task:${taskId}`, row, observed);
}

export async function appendTaskVersion(
  ch: ClickHouseClient,
  input: AppendTaskVersionInput,
): Promise<TaskRow> {
  const projectId = concreteEntityId(input.next.project_id, 'projectId');
  const taskId = concreteEntityId(input.next.task_id, 'taskId');
  const current = await getLatestTask(ch, projectId, taskId);
  if (current === null) throw new RepositoryNotFoundError(`task bulunamadi: ${taskId}`);
  const expectedVersion = storedUInt64(input.expectedVersion, 'expectedVersion');
  if (current.version !== expectedVersion) {
    if (BigInt(current.version) < BigInt(expectedVersion)) {
      assertExpectedVersion(`task:${taskId}`, current.version, expectedVersion);
    }
    const desired = parseTaskRow({
      ...input.next,
      project_id: projectId,
      task_id: taskId,
      version: current.version,
    });
    if (
      canonicalSha256V1(current) === canonicalSha256V1(desired)
    ) return current;
    assertExpectedVersion(`task:${taskId}`, current.version, expectedVersion);
  }
  const row = parseTaskRow({
    ...input.next,
    project_id: projectId,
    task_id: taskId,
    version: nextRepositoryVersion(current.version),
  });
  if (row.created_at !== current.created_at) {
    throw new RepositoryConflictError(`task created_at degistirilemez: ${taskId}`);
  }
  try {
    await ch.insert({ table: 'tasks', values: [toInsertRow(row)], format: 'JSONEachRow' });
  } catch (error) {
    const observed = await readAfterUncertainWrite(
      `task:${taskId}`,
      error,
      () => readTaskVersion(ch, projectId, taskId, row.version),
    );
    if (observed.length > 0) return reconcileVersionedWrite(`task:${taskId}`, row, observed);
    throw uncertainWriteError(`task:${taskId}`, error);
  }
  const observed = await readRowsAfterAcknowledgedWrite(
    `task:${taskId}`,
    row,
    () => readTaskVersion(ch, projectId, taskId, row.version),
  );
  return reconcileVersionedWrite(`task:${taskId}`, row, observed);
}
