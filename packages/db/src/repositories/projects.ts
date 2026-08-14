import type { ClickHouseClient } from '@clickhouse/client';
import {
  PROJECT_STATUSES,
  PROJECT_TYPES,
  canonicalSha256V1,
  type EntityId,
  type JsonObject,
  type ProjectStatus,
  type ProjectType,
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
  serializeJsonObject,
  storedDateTime,
  storedEnum,
  storedJsonObject,
  storedNonnegativeFiniteNumber,
  storedRecord,
  storedString,
  storedUInt64,
  uncertainWriteError,
  type UInt64String,
} from './types.js';

export interface ProjectRow {
  readonly project_id: EntityId;
  readonly name: string;
  readonly slug: string;
  readonly type: ProjectType;
  readonly status: ProjectStatus;
  readonly description: string;
  readonly workspace_path: string;
  readonly budget_usd_limit: number;
  readonly settings: JsonObject;
  readonly active_plan_id: StoredOptionalEntityId;
  readonly created_at: string;
  readonly updated_at: string;
  readonly version: UInt64String;
}

export type CreateProjectInput = Omit<ProjectRow, 'version'>;

export interface AppendProjectVersionInput {
  readonly expectedVersion: UInt64String;
  readonly next: Omit<ProjectRow, 'version'>;
}

const PROJECT_COLUMNS = `project_id, name, slug, type, status, description,
  workspace_path, budget_usd_limit, settings, active_plan_id, created_at,
  updated_at, version, row_hash`;
const ROW_HASH = /^[0-9a-f]{64}$/;

function projectRowHash(row: ProjectRow): string {
  return canonicalSha256V1([
    row.project_id,
    row.name,
    row.slug,
    row.type,
    row.status,
    row.description,
    row.workspace_path,
    row.budget_usd_limit,
    row.settings,
    row.active_plan_id,
    row.created_at,
    row.updated_at,
    row.version,
  ]);
}

function parseProjectRow(value: unknown): ProjectRow {
  const row = storedRecord(value, 'projects');
  const parsed: ProjectRow = Object.freeze({
    project_id: concreteEntityId(storedUuid(row['project_id'], 'projects.project_id'), 'projects.project_id'),
    name: storedString(row['name'], 'projects.name'),
    slug: storedString(row['slug'], 'projects.slug'),
    type: storedEnum(row['type'], PROJECT_TYPES, 'projects.type'),
    status: storedEnum(row['status'], PROJECT_STATUSES, 'projects.status'),
    description: storedString(row['description'], 'projects.description'),
    workspace_path: storedString(row['workspace_path'], 'projects.workspace_path'),
    budget_usd_limit: storedNonnegativeFiniteNumber(
      row['budget_usd_limit'],
      'projects.budget_usd_limit',
    ),
    settings: storedJsonObject(row['settings'], 'projects.settings'),
    active_plan_id: optionalEntityId(
      storedUuid(row['active_plan_id'], 'projects.active_plan_id'),
      'projects.active_plan_id',
    ),
    created_at: storedDateTime(row['created_at'], 'projects.created_at'),
    updated_at: storedDateTime(row['updated_at'], 'projects.updated_at'),
    version: storedUInt64(row['version'], 'projects.version'),
  });
  if (row['row_hash'] !== undefined) {
    const hash = storedString(row['row_hash'], 'projects.row_hash');
    if (hash !== '' && (!ROW_HASH.test(hash) || hash !== projectRowHash(parsed))) {
      throw new StoredRecordError('projects.row_hash integrity', { hash, row: parsed });
    }
  }
  return parsed;
}

function toInsertRow(row: ProjectRow): Record<string, unknown> {
  return {
    ...row,
    settings: serializeJsonObject(row.settings, 'projects.settings'),
    row_hash: projectRowHash(row),
  };
}

async function readProjectVersion(
  ch: ClickHouseClient,
  projectId: EntityId,
  version: UInt64String,
): Promise<ProjectRow[]> {
  const result = await ch.query({
    query: `SELECT ${PROJECT_COLUMNS} FROM projects
      WHERE project_id = {projectId:UUID} AND version = {version:UInt64}`,
    query_params: { projectId, version },
    format: 'JSONEachRow',
  });
  const rows = await result.json<unknown>();
  return rows.map(parseProjectRow);
}

export async function getLatestProject(
  ch: ClickHouseClient,
  projectId: string,
): Promise<ProjectRow | null> {
  const id = concreteEntityId(projectId, 'projectId');
  const result = await ch.query({
    query: `SELECT ${PROJECT_COLUMNS} FROM projects
      WHERE project_id = {projectId:UUID}
      ORDER BY version DESC`,
    query_params: { projectId: id },
    format: 'JSONEachRow',
  });
  const rows = (await result.json<unknown>()).map(parseProjectRow);
  if (rows.length === 0) return null;
  const maximum = rows[0]!.version;
  return reconcileVersionedWrite(
    `project:${id}`,
    rows[0]!,
    rows.filter((row) => row.version === maximum),
  );
}

export async function listLatestProjectsByStatus(
  ch: ClickHouseClient,
  status: ProjectStatus,
): Promise<ProjectRow[]> {
  const state = storedEnum(status, PROJECT_STATUSES, 'projectStatus');
  const result = await ch.query({
    query: `SELECT ${PROJECT_COLUMNS} FROM projects
      WHERE (project_id, version) IN (
        SELECT project_id, max(version) FROM projects GROUP BY project_id
      )
      ORDER BY project_id`,
    format: 'JSONEachRow',
  });
  const grouped = new Map<string, ProjectRow[]>();
  for (const row of (await result.json<unknown>()).map(parseProjectRow)) {
    const rows = grouped.get(row.project_id) ?? [];
    rows.push(row);
    grouped.set(row.project_id, rows);
  }
  return [...grouped.values()]
    .map((rows) => reconcileVersionedWrite(`project:${rows[0]!.project_id}`, rows[0]!, rows))
    .filter((row) => row.status === state);
}

export async function createProject(
  ch: ClickHouseClient,
  input: CreateProjectInput,
): Promise<ProjectRow> {
  const projectId = concreteEntityId(input.project_id, 'projectId');
  const current = await getLatestProject(ch, projectId);
  if (current !== null) {
    const desired = parseProjectRow({
      ...input,
      project_id: projectId,
      settings: serializeJsonObject(input.settings, 'projects.settings'),
      version: current.version,
    });
    if (canonicalSha256V1(current) === canonicalSha256V1(desired)) return current;
    throw new RepositoryConflictError(`project zaten var: ${projectId}`);
  }

  const row = parseProjectRow({
    ...input,
    project_id: projectId,
    settings: serializeJsonObject(input.settings, 'projects.settings'),
    version: nextRepositoryVersion(),
  });
  try {
    await ch.insert({ table: 'projects', values: [toInsertRow(row)], format: 'JSONEachRow' });
  } catch (error) {
    const observed = await readAfterUncertainWrite(
      `project:${projectId}`,
      error,
      () => readProjectVersion(ch, projectId, row.version),
    );
    if (observed.length > 0) return reconcileVersionedWrite(`project:${projectId}`, row, observed);
    throw uncertainWriteError(`project:${projectId}`, error);
  }
  const observed = await readRowsAfterAcknowledgedWrite(
    `project:${projectId}`,
    row,
    () => readProjectVersion(ch, projectId, row.version),
  );
  return reconcileVersionedWrite(`project:${projectId}`, row, observed);
}

export async function appendProjectVersion(
  ch: ClickHouseClient,
  input: AppendProjectVersionInput,
): Promise<ProjectRow> {
  const projectId = concreteEntityId(input.next.project_id, 'projectId');
  const current = await getLatestProject(ch, projectId);
  if (current === null) throw new RepositoryNotFoundError(`project bulunamadi: ${projectId}`);
  const expectedVersion = storedUInt64(input.expectedVersion, 'expectedVersion');
  if (current.version !== expectedVersion) {
    if (BigInt(current.version) < BigInt(expectedVersion)) {
      assertExpectedVersion(`project:${projectId}`, current.version, expectedVersion);
    }
    const desired = parseProjectRow({
      ...input.next,
      project_id: projectId,
      settings: serializeJsonObject(input.next.settings, 'projects.settings'),
      version: current.version,
    });
    if (
      canonicalSha256V1(current) === canonicalSha256V1(desired)
    ) return current;
    assertExpectedVersion(`project:${projectId}`, current.version, expectedVersion);
  }

  const row = parseProjectRow({
    ...input.next,
    project_id: projectId,
    settings: serializeJsonObject(input.next.settings, 'projects.settings'),
    version: nextRepositoryVersion(current.version),
  });
  if (row.created_at !== current.created_at) {
    throw new RepositoryConflictError(`project created_at degistirilemez: ${projectId}`);
  }
  try {
    await ch.insert({ table: 'projects', values: [toInsertRow(row)], format: 'JSONEachRow' });
  } catch (error) {
    const observed = await readAfterUncertainWrite(
      `project:${projectId}`,
      error,
      () => readProjectVersion(ch, projectId, row.version),
    );
    if (observed.length > 0) return reconcileVersionedWrite(`project:${projectId}`, row, observed);
    throw uncertainWriteError(`project:${projectId}`, error);
  }
  const observed = await readRowsAfterAcknowledgedWrite(
    `project:${projectId}`,
    row,
    () => readProjectVersion(ch, projectId, row.version),
  );
  return reconcileVersionedWrite(`project:${projectId}`, row, observed);
}
