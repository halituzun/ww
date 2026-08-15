import type { ClickHouseClient } from '@clickhouse/client';
import { canonicalSha256V1, type EntityId } from '@ww/shared';
import { concreteEntityId, storedUuid } from './identifiers.js';
import { nextRepositoryVersion, readAfterUncertainWrite, readRowsAfterAcknowledgedWrite, uncertainWriteError, RepositoryConflictError, StoredRecordError, storedString, storedStringArray, storedUInt64, storedDateTime, storedRecord, type UInt64String } from './types.js';

export const FILE_INDEX_LAYERS = ['view', 'viewmodel', 'model', 'service', 'repository', 'controller', 'config', 'test', 'other'] as const;
export type FileIndexLayer = (typeof FILE_INDEX_LAYERS)[number];
export interface FileIndexRow { readonly project_id: EntityId; readonly file_path: string; readonly summary: string; readonly layer: FileIndexLayer; readonly exports: readonly string[]; readonly related_task_ids: readonly EntityId[]; readonly related_artifact_ids: readonly EntityId[]; readonly related_knowledge_ids: readonly EntityId[]; readonly last_commit_hash: string; readonly change_count: number; readonly updated_at: string; readonly version: UInt64String; }
export type UpsertFileIndexInput = Omit<FileIndexRow, 'version' | 'change_count'> & { readonly change_count?: number };
const COLUMNS = 'project_id,file_path,summary,layer,exports,related_task_ids,related_artifact_ids,related_knowledge_ids,last_commit_hash,change_count,updated_at,version';

function parse(value: unknown): FileIndexRow {
  const row = storedRecord(value, 'file_index');
  const layer = storedString(row['layer'], 'file_index.layer');
  if (!(FILE_INDEX_LAYERS as readonly string[]).includes(layer)) throw new StoredRecordError('file_index.layer', layer);
  const changeCount = Number(row['change_count']);
  if (!Number.isSafeInteger(changeCount) || changeCount < 0) throw new StoredRecordError('file_index.change_count', row['change_count']);
  return Object.freeze({
    project_id: concreteEntityId(storedUuid(row['project_id'], 'file_index.project_id'), 'file_index.project_id'),
    file_path: storedString(row['file_path'], 'file_index.file_path'), summary: storedString(row['summary'], 'file_index.summary'), layer: layer as FileIndexLayer,
    exports: storedStringArray(row['exports'], 'file_index.exports'), related_task_ids: storedStringArray(row['related_task_ids'], 'file_index.related_task_ids') as EntityId[], related_artifact_ids: storedStringArray(row['related_artifact_ids'], 'file_index.related_artifact_ids') as EntityId[], related_knowledge_ids: storedStringArray(row['related_knowledge_ids'], 'file_index.related_knowledge_ids') as EntityId[], last_commit_hash: storedString(row['last_commit_hash'], 'file_index.last_commit_hash'), change_count: changeCount, updated_at: storedDateTime(row['updated_at'], 'file_index.updated_at'), version: storedUInt64(row['version'], 'file_index.version'),
  });
}

async function readRows(ch: ClickHouseClient, projectId: EntityId, filePath: string): Promise<FileIndexRow[]> {
  const result = await ch.query({ query: `SELECT ${COLUMNS} FROM file_index WHERE project_id = {projectId:UUID} AND file_path = {filePath:String} ORDER BY version DESC`, query_params: { projectId, filePath }, format: 'JSONEachRow' });
  return (await result.json<unknown>()).map(parse);
}

export async function getFileIndex(ch: ClickHouseClient, projectId: string, filePath: string): Promise<FileIndexRow | null> {
  const rows = await readRows(ch, concreteEntityId(projectId, 'projectId'), filePath);
  return rows[0] ?? null;
}

export async function listFileIndex(ch: ClickHouseClient, projectId: string, limit = 1_000): Promise<readonly FileIndexRow[]> {
  const id = concreteEntityId(projectId, 'projectId');
  const result = await ch.query({ query: `SELECT ${COLUMNS} FROM file_index WHERE project_id = {projectId:UUID} AND (project_id,file_path,version) IN (SELECT project_id,file_path,max(version) FROM file_index WHERE project_id = {projectId:UUID} GROUP BY project_id,file_path) ORDER BY file_path LIMIT {limit:UInt32}`, query_params: { projectId: id, limit }, format: 'JSONEachRow' });
  return (await result.json<unknown>()).map(parse);
}

export async function upsertFileIndex(ch: ClickHouseClient, input: UpsertFileIndexInput): Promise<FileIndexRow> {
  const projectId = concreteEntityId(input.project_id, 'projectId');
  const path = input.file_path.trim();
  if (path.length === 0 || path.startsWith('/') || path.split('/').includes('..')) throw new Error('file_index yolu workspace goreli olmalidir');
  const current = await getFileIndex(ch, projectId, path);
  const row: FileIndexRow = Object.freeze({ ...input, project_id: projectId, file_path: path, change_count: input.change_count ?? (current?.change_count ?? 0) + 1, version: nextRepositoryVersion(current?.version) });
  if (current !== null && canonicalSha256V1({ ...current, version: '0' }) === canonicalSha256V1({ ...row, version: '0' })) return current;
  try { await ch.insert({ table: 'file_index', values: [row], format: 'JSONEachRow' }); } catch (error) {
    const observed = await readAfterUncertainWrite(`file-index:${projectId}:${path}`, error, () => readRows(ch, projectId, path));
    if (observed.length > 0) return observed[0]!;
    throw uncertainWriteError(`file-index:${projectId}:${path}`, error);
  }
  const observed = await readRowsAfterAcknowledgedWrite(`file-index:${projectId}:${path}`, row, () => readRows(ch, projectId, path));
  if (observed.length === 0) throw new RepositoryConflictError(`file_index yazimi okunamadi: ${path}`);
  return observed[0]!;
}
