import type { ClickHouseClient } from '@clickhouse/client';
import {
  VersionedSourceRefV1Schema,
  canonicalSha256V1,
  type EntityId,
  type JsonValue,
  type VersionedSourceRefV1,
} from '@ww/shared';
import { concreteEntityId, storedUuid } from './identifiers.js';
import {
  RepositoryConflictError,
  StoredRecordError,
  nextRepositoryVersion,
  readRowsAfterAcknowledgedWrite,
  serializeJsonValue,
  storedDateTime,
  storedJsonValue,
  storedRecord,
  storedString,
  storedUInt64,
  storedUnsignedInteger,
  uncertainWriteError,
  type UInt64String,
} from './types.js';

export interface ProjectMapSnapshotRow {
  readonly project_map_id: EntityId;
  readonly project_id: EntityId;
  readonly map_json: JsonValue;
  readonly file_count: number;
  readonly function_count: number;
  readonly route_count: number;
  readonly generated_at: string;
  readonly created_at: string;
  readonly version: UInt64String;
}

export type CreateProjectMapSnapshotInput = Omit<ProjectMapSnapshotRow, 'version'>;

const ROW_HASH = /^[0-9a-f]{64}$/;
const COLUMNS = `project_map_id, project_id, map_json, file_count, function_count,
  route_count, generated_at, created_at, version, row_hash`;

function projectMapRowHash(row: ProjectMapSnapshotRow): string {
  return canonicalSha256V1([
    row.project_map_id,
    row.project_id,
    row.map_json,
    row.file_count,
    row.function_count,
    row.route_count,
    row.generated_at,
    row.created_at,
    row.version,
  ]);
}

function parseProjectMapSnapshot(value: unknown): ProjectMapSnapshotRow {
  const row = storedRecord(value, 'project_maps');
  const parsed: ProjectMapSnapshotRow = Object.freeze({
    project_map_id: concreteEntityId(storedUuid(row['project_map_id'], 'project_maps.project_map_id'), 'project_maps.project_map_id'),
    project_id: concreteEntityId(storedUuid(row['project_id'], 'project_maps.project_id'), 'project_maps.project_id'),
    map_json: storedJsonValue(row['map_json'], 'project_maps.map_json'),
    file_count: storedUnsignedInteger(row['file_count'], 'project_maps.file_count', 4_294_967_295),
    function_count: storedUnsignedInteger(row['function_count'], 'project_maps.function_count', 4_294_967_295),
    route_count: storedUnsignedInteger(row['route_count'], 'project_maps.route_count', 4_294_967_295),
    generated_at: storedDateTime(row['generated_at'], 'project_maps.generated_at'),
    created_at: storedDateTime(row['created_at'], 'project_maps.created_at'),
    version: storedUInt64(row['version'], 'project_maps.version'),
  });
  if (row['row_hash'] !== undefined) {
    const hash = storedString(row['row_hash'], 'project_maps.row_hash');
    if (hash !== '' && (!ROW_HASH.test(hash) || hash !== projectMapRowHash(parsed))) {
      throw new StoredRecordError('project_maps.row_hash integrity', { hash, row: parsed });
    }
  }
  return parsed;
}

function toInsertRow(row: ProjectMapSnapshotRow): Record<string, unknown> {
  return {
    ...row,
    map_json: serializeJsonValue(row.map_json, 'project_maps.map_json'),
    row_hash: projectMapRowHash(row),
  };
}

async function readProjectMapVersion(
  ch: ClickHouseClient,
  projectId: EntityId,
  projectMapId: EntityId,
  version: UInt64String,
): Promise<ProjectMapSnapshotRow[]> {
  const result = await ch.query({
    query: `SELECT ${COLUMNS} FROM project_maps
      WHERE project_id = {projectId:UUID}
        AND project_map_id = {projectMapId:UUID}
        AND version = {version:UInt64}
      ORDER BY created_at, project_map_id`,
    query_params: { projectId, projectMapId, version },
    format: 'JSONEachRow',
  });
  return (await result.json<unknown>()).map(parseProjectMapSnapshot);
}

export async function createProjectMapSnapshot(
  ch: ClickHouseClient,
  input: CreateProjectMapSnapshotInput,
): Promise<ProjectMapSnapshotRow> {
  const projectId = concreteEntityId(input.project_id, 'projectId');
  const projectMapId = concreteEntityId(input.project_map_id, 'projectMapId');
  const row = parseProjectMapSnapshot({
    ...input,
    project_id: projectId,
    project_map_id: projectMapId,
    map_json: serializeJsonValue(input.map_json, 'project_maps.map_json'),
    version: nextRepositoryVersion(),
  });
  try {
    await ch.insert({ table: 'project_maps', values: [toInsertRow(row)], format: 'JSONEachRow' });
  } catch (error) {
    throw uncertainWriteError(`project-map:${projectId}:${projectMapId}`, error);
  }
  const observed = await readRowsAfterAcknowledgedWrite(
    `project-map:${projectId}:${projectMapId}`,
    row,
    () => readProjectMapVersion(ch, projectId, projectMapId, row.version),
  );
  return observed[0]!;
}

export async function getLatestProjectMapSnapshot(
  ch: ClickHouseClient,
  projectId: string,
): Promise<ProjectMapSnapshotRow | null> {
  const id = concreteEntityId(projectId, 'projectId');
  const result = await ch.query({
    query: `SELECT ${COLUMNS} FROM project_maps
      WHERE project_id = {projectId:UUID}
      ORDER BY created_at DESC, version DESC
      LIMIT 1`,
    query_params: { projectId: id },
    format: 'JSONEachRow',
  });
  return (await result.json<unknown>()).map(parseProjectMapSnapshot)[0] ?? null;
}

export async function getLatestProjectMapSnapshotAsOf(
  ch: ClickHouseClient,
  projectId: string,
  cutoffAt: string,
): Promise<ProjectMapSnapshotRow | null> {
  const id = concreteEntityId(projectId, 'projectId');
  const result = await ch.query({
    query: `SELECT ${COLUMNS} FROM project_maps
      WHERE project_id = {projectId:UUID}
        AND created_at <= parseDateTime64BestEffort({cutoffAt:String}, 3)
      ORDER BY created_at DESC, version DESC
      LIMIT 1`,
    query_params: { projectId: id, cutoffAt },
    format: 'JSONEachRow',
  });
  return (await result.json<unknown>()).map(parseProjectMapSnapshot)[0] ?? null;
}

export function projectMapSourceHash(row: ProjectMapSnapshotRow): string {
  return canonicalSha256V1(row);
}

export async function getProjectMapSourceRef(
  ch: ClickHouseClient,
  projectId: string,
  projectMapId: string,
): Promise<VersionedSourceRefV1 | null> {
  const id = concreteEntityId(projectId, 'projectId');
  const mapId = concreteEntityId(projectMapId, 'projectMapId');
  const result = await ch.query({
    query: `SELECT ${COLUMNS} FROM project_maps
      WHERE project_id = {projectId:UUID}
        AND project_map_id = {projectMapId:UUID}
      ORDER BY version DESC
      LIMIT 1`,
    query_params: { projectId: id, projectMapId: mapId },
    format: 'JSONEachRow',
  });
  const row = (await result.json<unknown>()).map(parseProjectMapSnapshot)[0];
  if (row === undefined) return null;
  const version = Number(row.version);
  if (!Number.isSafeInteger(version)) {
    throw new RepositoryConflictError(`project_map source version guvenli degil: ${row.version}`);
  }
  return VersionedSourceRefV1Schema.parse({
    sourceType: 'project_map',
    sourceId: row.project_map_id,
    version,
    hash: projectMapSourceHash(row),
  });
}

export async function getLatestProjectMapSourceRefAsOf(
  ch: ClickHouseClient,
  projectId: string,
  cutoffAt: string,
): Promise<VersionedSourceRefV1 | null> {
  const row = await getLatestProjectMapSnapshotAsOf(ch, projectId, cutoffAt);
  if (row === null) return null;
  const version = Number(row.version);
  if (!Number.isSafeInteger(version)) {
    throw new RepositoryConflictError(`project_map source version guvenli degil: ${row.version}`);
  }
  return VersionedSourceRefV1Schema.parse({
    sourceType: 'project_map',
    sourceId: row.project_map_id,
    version,
    hash: projectMapSourceHash(row),
  });
}
