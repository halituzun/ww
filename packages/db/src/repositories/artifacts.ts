import type { ClickHouseClient } from '@clickhouse/client';
import {
  ARTIFACT_TYPES,
  canonicalSha256V1,
  type ArtifactType,
  type EntityId,
} from '@ww/shared';
import { concreteEntityId, storedUuid } from './identifiers.js';
import {
  RepositoryConflictError,
  RepositoryWriteError,
  readRowsAfterAcknowledgedWrite,
  readAfterUncertainWrite,
  storedDateTime,
  storedEnum,
  storedRecord,
  storedString,
  storedUnsignedInteger,
  uncertainWriteError,
} from './types.js';

export interface ArtifactRow {
  readonly artifact_id: EntityId;
  readonly project_id: EntityId;
  readonly task_id: EntityId;
  readonly agent_id: EntityId;
  readonly artifact_type: ArtifactType;
  readonly name: string;
  readonly path: string;
  readonly summary: string;
  readonly commit_hash: string;
  readonly created_at: string;
}

export type AppendArtifactInput = ArtifactRow;

const ARTIFACT_COLUMNS = `artifact_id, project_id, task_id, agent_id,
  artifact_type, name, path, summary, commit_hash, created_at`;

function parseArtifact(value: unknown): ArtifactRow {
  const row = storedRecord(value, 'artifacts');
  return Object.freeze({
    artifact_id: concreteEntityId(storedUuid(row['artifact_id'], 'artifacts.artifact_id'), 'artifacts.artifact_id'),
    project_id: concreteEntityId(storedUuid(row['project_id'], 'artifacts.project_id'), 'artifacts.project_id'),
    task_id: concreteEntityId(storedUuid(row['task_id'], 'artifacts.task_id'), 'artifacts.task_id'),
    agent_id: concreteEntityId(storedUuid(row['agent_id'], 'artifacts.agent_id'), 'artifacts.agent_id'),
    artifact_type: storedEnum(row['artifact_type'], ARTIFACT_TYPES, 'artifacts.artifact_type'),
    name: storedString(row['name'], 'artifacts.name'),
    path: storedString(row['path'], 'artifacts.path'),
    summary: storedString(row['summary'], 'artifacts.summary'),
    commit_hash: storedString(row['commit_hash'], 'artifacts.commit_hash'),
    created_at: storedDateTime(row['created_at'], 'artifacts.created_at'),
  });
}

async function readArtifactRows(ch: ClickHouseClient, artifactId: EntityId): Promise<ArtifactRow[]> {
  const result = await ch.query({
    query: `SELECT ${ARTIFACT_COLUMNS} FROM artifacts WHERE artifact_id = {artifactId:UUID}`,
    query_params: { artifactId },
    format: 'JSONEachRow',
  });
  const physical = (await result.json<unknown>()).map(parseArtifact);
  const logical = new Map<string, ArtifactRow>();
  for (const row of physical) {
    const prior = logical.get(row.artifact_id);
    logical.set(row.artifact_id, prior === undefined ? row : reconcileArtifact(row, [prior]));
  }
  return [...logical.values()];
}

function reconcileArtifact(expected: ArtifactRow, rows: readonly ArtifactRow[]): ArtifactRow {
  if (rows.length === 0) throw new RepositoryWriteError(`artifact:${expected.artifact_id} yazimi yeniden okunamadi`);
  const hash = canonicalSha256V1(expected);
  if (rows.some((row) => canonicalSha256V1(row) !== hash)) {
    throw new RepositoryConflictError(`artifact:${expected.artifact_id} immutable kimlik/hash catismasi`);
  }
  return rows[0]!;
}

export async function getArtifact(ch: ClickHouseClient, artifactId: string): Promise<ArtifactRow | null> {
  const id = concreteEntityId(artifactId, 'artifactId');
  const rows = await readArtifactRows(ch, id);
  return rows.length === 0 ? null : reconcileArtifact(rows[0]!, rows);
}

export async function listTaskArtifacts(
  ch: ClickHouseClient,
  projectId: string,
  taskId: string,
  limitValue = 100,
): Promise<ArtifactRow[]> {
  const project = concreteEntityId(projectId, 'projectId');
  const task = concreteEntityId(taskId, 'taskId');
  const limit = storedUnsignedInteger(limitValue, 'artifacts.limit', 1_000);
  const result = await ch.query({
    query: `SELECT ${ARTIFACT_COLUMNS} FROM artifacts
      WHERE project_id = {projectId:UUID} AND task_id = {taskId:UUID}
        AND artifact_id IN (
          SELECT artifact_id FROM artifacts
          WHERE project_id = {projectId:UUID} AND task_id = {taskId:UUID}
          GROUP BY artifact_id
          ORDER BY min(created_at) ASC, artifact_id ASC
          LIMIT {limit:UInt32}
        )
      ORDER BY created_at ASC, artifact_id ASC`,
    query_params: { projectId: project, taskId: task, limit },
    format: 'JSONEachRow',
  });
  const physical = (await result.json<unknown>()).map(parseArtifact);
  const logical = new Map<string, ArtifactRow>();
  for (const row of physical) {
    const prior = logical.get(row.artifact_id);
    logical.set(row.artifact_id, prior === undefined ? row : reconcileArtifact(row, [prior]));
  }
  return [...logical.values()].slice(0, limit);
}

export async function appendArtifact(
  ch: ClickHouseClient,
  input: AppendArtifactInput,
): Promise<ArtifactRow> {
  const artifact = parseArtifact(input);
  const prior = await readArtifactRows(ch, artifact.artifact_id);
  if (prior.length > 0) return reconcileArtifact(artifact, prior);
  try {
    await ch.insert({ table: 'artifacts', values: [artifact], format: 'JSONEachRow' });
  } catch (error) {
    const entity = `artifact:${artifact.artifact_id}`;
    const observed = await readAfterUncertainWrite(
      entity,
      error,
      () => readArtifactRows(ch, artifact.artifact_id),
    );
    if (observed.length > 0) return reconcileArtifact(artifact, observed);
    throw uncertainWriteError(entity, error);
  }
  const observed = await readRowsAfterAcknowledgedWrite(
    `artifact:${artifact.artifact_id}`,
    artifact,
    () => readArtifactRows(ch, artifact.artifact_id),
  );
  return reconcileArtifact(artifact, observed);
}
