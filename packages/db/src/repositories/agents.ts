import type { ClickHouseClient } from '@clickhouse/client';
import {
  AGENT_GROUPS,
  AGENT_ROLES,
  AGENT_STATUSES,
  canonicalSha256V1,
  type AgentGroup,
  type AgentRole,
  type AgentStatus,
  type EntityId,
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
  storedUInt64,
  storedUnsignedInteger,
  uncertainWriteError,
  type UInt64String,
} from './types.js';

export interface AgentRow {
  readonly agent_id: EntityId;
  readonly project_id: EntityId;
  readonly role: AgentRole;
  readonly group: AgentGroup;
  readonly name: string;
  readonly model_ref: string;
  readonly parent_agent_id: StoredOptionalEntityId;
  readonly clone_of: StoredOptionalEntityId;
  readonly status: AgentStatus;
  readonly current_task_id: StoredOptionalEntityId;
  readonly prompt_name: string;
  readonly prompt_version: number;
  readonly tasks_done: number;
  readonly tasks_rejected: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly version: UInt64String;
}

export type CreateAgentInput = Omit<AgentRow, 'version'>;

export interface AppendAgentVersionInput {
  readonly expectedVersion: UInt64String;
  readonly next: Omit<AgentRow, 'version'>;
}

const AGENT_COLUMNS = `agent_id, project_id, role, \`group\`, name, model_ref,
  parent_agent_id, clone_of, status, current_task_id, prompt_name, prompt_version,
  tasks_done, tasks_rejected, created_at, updated_at, version, row_hash`;
const ROW_HASH = /^[0-9a-f]{64}$/;

function agentRowHash(row: AgentRow): string {
  return canonicalSha256V1([
    row.agent_id,
    row.project_id,
    row.role,
    row.group,
    row.name,
    row.model_ref,
    row.parent_agent_id,
    row.clone_of,
    row.status,
    row.current_task_id,
    row.prompt_name,
    row.prompt_version,
    row.tasks_done,
    row.tasks_rejected,
    row.created_at,
    row.updated_at,
    row.version,
  ]);
}

function parseAgentRow(value: unknown): AgentRow {
  const row = storedRecord(value, 'agents');
  const parsed: AgentRow = Object.freeze({
    agent_id: concreteEntityId(storedUuid(row['agent_id'], 'agents.agent_id'), 'agents.agent_id'),
    project_id: concreteEntityId(
      storedUuid(row['project_id'], 'agents.project_id'),
      'agents.project_id',
    ),
    role: storedEnum(row['role'], AGENT_ROLES, 'agents.role'),
    group: storedEnum(row['group'], AGENT_GROUPS, 'agents.group'),
    name: storedString(row['name'], 'agents.name'),
    model_ref: storedString(row['model_ref'], 'agents.model_ref'),
    parent_agent_id: optionalEntityId(
      storedUuid(row['parent_agent_id'], 'agents.parent_agent_id'),
      'agents.parent_agent_id',
    ),
    clone_of: optionalEntityId(storedUuid(row['clone_of'], 'agents.clone_of'), 'agents.clone_of'),
    status: storedEnum(row['status'], AGENT_STATUSES, 'agents.status'),
    current_task_id: optionalEntityId(
      storedUuid(row['current_task_id'], 'agents.current_task_id'),
      'agents.current_task_id',
    ),
    prompt_name: storedString(row['prompt_name'], 'agents.prompt_name'),
    prompt_version: storedUnsignedInteger(
      row['prompt_version'],
      'agents.prompt_version',
      4_294_967_295,
    ),
    tasks_done: storedUnsignedInteger(row['tasks_done'], 'agents.tasks_done', 4_294_967_295),
    tasks_rejected: storedUnsignedInteger(
      row['tasks_rejected'],
      'agents.tasks_rejected',
      4_294_967_295,
    ),
    created_at: storedDateTime(row['created_at'], 'agents.created_at'),
    updated_at: storedDateTime(row['updated_at'], 'agents.updated_at'),
    version: storedUInt64(row['version'], 'agents.version'),
  });
  if (row['row_hash'] !== undefined) {
    const hash = storedString(row['row_hash'], 'agents.row_hash');
    if (hash !== '' && (!ROW_HASH.test(hash) || hash !== agentRowHash(parsed))) {
      throw new StoredRecordError('agents.row_hash integrity', { hash, row: parsed });
    }
  }
  return parsed;
}

function toInsertRow(row: AgentRow): Record<string, unknown> {
  return { ...row, row_hash: agentRowHash(row) };
}

async function readAgentVersion(
  ch: ClickHouseClient,
  projectId: EntityId,
  agentId: EntityId,
  version: UInt64String,
): Promise<AgentRow[]> {
  const result = await ch.query({
    query: `SELECT ${AGENT_COLUMNS} FROM agents
      WHERE project_id = {projectId:UUID} AND agent_id = {agentId:UUID}
        AND version = {version:UInt64}`,
    query_params: { projectId, agentId, version },
    format: 'JSONEachRow',
  });
  return (await result.json<unknown>()).map(parseAgentRow);
}

export async function getLatestAgent(
  ch: ClickHouseClient,
  projectId: string,
  agentId: string,
): Promise<AgentRow | null> {
  const project = concreteEntityId(projectId, 'projectId');
  const agent = concreteEntityId(agentId, 'agentId');
  const result = await ch.query({
    query: `SELECT ${AGENT_COLUMNS} FROM agents
      WHERE project_id = {projectId:UUID} AND agent_id = {agentId:UUID}
      ORDER BY version DESC`,
    query_params: { projectId: project, agentId: agent },
    format: 'JSONEachRow',
  });
  const rows = (await result.json<unknown>()).map(parseAgentRow);
  if (rows.length === 0) return null;
  const maximum = rows[0]!.version;
  return reconcileVersionedWrite(
    `agent:${agent}`,
    rows[0]!,
    rows.filter((row) => row.version === maximum),
  );
}

export async function listLatestAgentsByStatus(
  ch: ClickHouseClient,
  projectId: string,
  status: AgentStatus,
): Promise<AgentRow[]> {
  const project = concreteEntityId(projectId, 'projectId');
  const state = storedEnum(status, AGENT_STATUSES, 'agentStatus');
  const result = await ch.query({
    query: `SELECT ${AGENT_COLUMNS} FROM agents
      WHERE project_id = {projectId:UUID}
        AND (agent_id, version) IN (
          SELECT agent_id, max(version) FROM agents
          WHERE project_id = {projectId:UUID}
          GROUP BY agent_id
        )
      ORDER BY agent_id`,
    query_params: { projectId: project },
    format: 'JSONEachRow',
  });
  const grouped = new Map<string, AgentRow[]>();
  for (const row of (await result.json<unknown>()).map(parseAgentRow)) {
    const rows = grouped.get(row.agent_id) ?? [];
    rows.push(row);
    grouped.set(row.agent_id, rows);
  }
  return [...grouped.values()]
    .map((rows) => reconcileVersionedWrite(`agent:${rows[0]!.agent_id}`, rows[0]!, rows))
    .filter((row) => row.status === state);
}

export async function createAgent(
  ch: ClickHouseClient,
  input: CreateAgentInput,
): Promise<AgentRow> {
  const projectId = concreteEntityId(input.project_id, 'projectId');
  const agentId = concreteEntityId(input.agent_id, 'agentId');
  const current = await getLatestAgent(ch, projectId, agentId);
  if (current !== null) {
    const desired = parseAgentRow({
      ...input,
      project_id: projectId,
      agent_id: agentId,
      version: current.version,
    });
    if (canonicalSha256V1(current) === canonicalSha256V1(desired)) return current;
    throw new RepositoryConflictError(`agent zaten var: ${agentId}`);
  }
  const row = parseAgentRow({
    ...input,
    project_id: projectId,
    agent_id: agentId,
    version: nextRepositoryVersion(),
  });
  try {
    await ch.insert({ table: 'agents', values: [toInsertRow(row)], format: 'JSONEachRow' });
  } catch (error) {
    const observed = await readAfterUncertainWrite(
      `agent:${agentId}`,
      error,
      () => readAgentVersion(ch, projectId, agentId, row.version),
    );
    if (observed.length > 0) return reconcileVersionedWrite(`agent:${agentId}`, row, observed);
    throw uncertainWriteError(`agent:${agentId}`, error);
  }
  const observed = await readRowsAfterAcknowledgedWrite(
    `agent:${agentId}`,
    row,
    () => readAgentVersion(ch, projectId, agentId, row.version),
  );
  return reconcileVersionedWrite(`agent:${agentId}`, row, observed);
}

export async function appendAgentVersion(
  ch: ClickHouseClient,
  input: AppendAgentVersionInput,
): Promise<AgentRow> {
  const projectId = concreteEntityId(input.next.project_id, 'projectId');
  const agentId = concreteEntityId(input.next.agent_id, 'agentId');
  const current = await getLatestAgent(ch, projectId, agentId);
  if (current === null) throw new RepositoryNotFoundError(`agent bulunamadi: ${agentId}`);
  const expectedVersion = storedUInt64(input.expectedVersion, 'expectedVersion');
  if (current.version !== expectedVersion) {
    if (BigInt(current.version) < BigInt(expectedVersion)) {
      assertExpectedVersion(`agent:${agentId}`, current.version, expectedVersion);
    }
    const desired = parseAgentRow({
      ...input.next,
      project_id: projectId,
      agent_id: agentId,
      version: current.version,
    });
    if (
      canonicalSha256V1(current) === canonicalSha256V1(desired)
    ) return current;
    assertExpectedVersion(`agent:${agentId}`, current.version, expectedVersion);
  }
  const row = parseAgentRow({
    ...input.next,
    project_id: projectId,
    agent_id: agentId,
    version: nextRepositoryVersion(current.version),
  });
  if (row.created_at !== current.created_at) {
    throw new RepositoryConflictError(`agent created_at degistirilemez: ${agentId}`);
  }
  try {
    await ch.insert({ table: 'agents', values: [toInsertRow(row)], format: 'JSONEachRow' });
  } catch (error) {
    const observed = await readAfterUncertainWrite(
      `agent:${agentId}`,
      error,
      () => readAgentVersion(ch, projectId, agentId, row.version),
    );
    if (observed.length > 0) return reconcileVersionedWrite(`agent:${agentId}`, row, observed);
    throw uncertainWriteError(`agent:${agentId}`, error);
  }
  const observed = await readRowsAfterAcknowledgedWrite(
    `agent:${agentId}`,
    row,
    () => readAgentVersion(ch, projectId, agentId, row.version),
  );
  return reconcileVersionedWrite(`agent:${agentId}`, row, observed);
}
