import type { ClickHouseClient } from '@clickhouse/client';
import {
  KNOWLEDGE_KINDS,
  VersionedSourceRefV1Schema,
  canonicalSha256V1,
  type EntityId,
  type KnowledgeKind,
  type VersionedSourceRefV1,
} from '@ww/shared';
import { concreteEntityId, optionalEntityId, storedUuid, type StoredOptionalEntityId } from './identifiers.js';
import {
  RepositoryConflictError,
  RepositoryNotFoundError,
  RepositoryWriteError,
  StoredRecordError,
  nextRepositoryVersion,
  readRowsAfterAcknowledgedWrite,
  readAfterUncertainWrite,
  storedDateTime,
  storedEnum,
  storedRecord,
  storedString,
  storedStringArray,
  storedUInt64,
  uncertainWriteError,
  type UInt64String,
} from './types.js';

export const KNOWLEDGE_STATUSES = ['active', 'superseded'] as const;
export type KnowledgeStatus = (typeof KNOWLEDGE_STATUSES)[number];

export interface KnowledgeRow {
  readonly knowledge_id: EntityId;
  readonly project_id: EntityId;
  readonly kind: KnowledgeKind;
  readonly title: string;
  readonly content: string;
  readonly tags: readonly string[];
  readonly source_task_id: StoredOptionalEntityId;
  readonly source_message_id: StoredOptionalEntityId;
  readonly status: KnowledgeStatus;
  readonly superseded_by: StoredOptionalEntityId;
  readonly created_at: string;
  readonly observed_at: string;
  readonly version: UInt64String;
}

export type AppendKnowledgeVersionInput = Omit<KnowledgeRow, 'version' | 'observed_at'>;

const KNOWLEDGE_COLUMNS = `knowledge_id, project_id, kind, title, content, tags,
  source_task_id, source_message_id, status, superseded_by, created_at,
  observed_at, version, row_hash`;
const ROW_HASH = /^[0-9a-f]{64}$/;
const EPOCH = '1970-01-01T00:00:00.000Z';

function knowledgeRowHash(row: KnowledgeRow): string {
  return canonicalSha256V1([
    row.knowledge_id,
    row.project_id,
    row.kind,
    row.title,
    row.content,
    [...row.tags],
    row.source_task_id,
    row.source_message_id,
    row.status,
    row.superseded_by,
    row.created_at,
    row.observed_at,
    row.version,
  ]);
}

function knowledgeCallerContentHash(row: KnowledgeRow): string {
  return canonicalSha256V1([
    row.knowledge_id,
    row.project_id,
    row.kind,
    row.title,
    row.content,
    [...row.tags],
    row.source_task_id,
    row.source_message_id,
    row.status,
    row.superseded_by,
    row.created_at,
  ]);
}

function knowledgeSourceHash(row: KnowledgeRow): string {
  return canonicalSha256V1([
    row.knowledge_id,
    row.project_id,
    row.kind,
    row.title,
    row.content,
    [...row.tags],
    row.source_task_id,
    row.source_message_id,
    row.status,
    row.superseded_by,
    row.created_at,
    row.version,
  ]);
}

function nextKnowledgeObservedAt(prior?: string): string {
  const priorFloor = prior === undefined ? 0 : Date.parse(prior) + 1;
  return new Date(Math.max(Date.now(), priorFloor)).toISOString();
}

function reconcileKnowledgeVersion(
  entity: string,
  observed: readonly KnowledgeRow[],
  expected?: KnowledgeRow,
): KnowledgeRow {
  if (observed.length === 0) {
    throw new RepositoryWriteError(`${entity} yazimi yeniden okunamadi`);
  }
  const baseline = expected ?? observed[0]!;
  const callerContentHash = knowledgeCallerContentHash(baseline);
  if (observed.some((row) => (
    row.version !== baseline.version ||
    knowledgeCallerContentHash(row) !== callerContentHash
  ))) {
    throw new RepositoryConflictError(
      `${entity} ayni kimlik ve surum icin farkli caller icerigi barindiriyor`,
    );
  }
  return [...observed].sort((left, right) => {
    const byObservedAt = left.observed_at.localeCompare(right.observed_at);
    if (byObservedAt !== 0) return byObservedAt;
    return canonicalSha256V1(left).localeCompare(canonicalSha256V1(right));
  })[0]!;
}

function parseKnowledge(value: unknown): KnowledgeRow {
  const row = storedRecord(value, 'knowledge');
  const createdAt = storedDateTime(row['created_at'], 'knowledge.created_at');
  const storedObservedAt = row['observed_at'] === undefined
    ? EPOCH
    : storedDateTime(row['observed_at'], 'knowledge.observed_at');
  const parsed: KnowledgeRow = Object.freeze({
    knowledge_id: concreteEntityId(storedUuid(row['knowledge_id'], 'knowledge.knowledge_id'), 'knowledge.knowledge_id'),
    project_id: concreteEntityId(storedUuid(row['project_id'], 'knowledge.project_id'), 'knowledge.project_id'),
    kind: storedEnum(row['kind'], KNOWLEDGE_KINDS, 'knowledge.kind'),
    title: storedString(row['title'], 'knowledge.title'),
    content: storedString(row['content'], 'knowledge.content'),
    tags: storedStringArray(row['tags'], 'knowledge.tags'),
    source_task_id: optionalEntityId(storedUuid(row['source_task_id'], 'knowledge.source_task_id'), 'knowledge.source_task_id'),
    source_message_id: optionalEntityId(storedUuid(row['source_message_id'], 'knowledge.source_message_id'), 'knowledge.source_message_id'),
    status: storedEnum(row['status'], KNOWLEDGE_STATUSES, 'knowledge.status'),
    superseded_by: optionalEntityId(storedUuid(row['superseded_by'], 'knowledge.superseded_by'), 'knowledge.superseded_by'),
    created_at: createdAt,
    observed_at: storedObservedAt === EPOCH ? createdAt : storedObservedAt,
    version: storedUInt64(row['version'], 'knowledge.version'),
  });
  if (row['row_hash'] !== undefined) {
    const hash = storedString(row['row_hash'], 'knowledge.row_hash');
    if (hash !== '' && (!ROW_HASH.test(hash) || hash !== knowledgeRowHash(parsed))) {
      throw new StoredRecordError('knowledge.row_hash integrity', { hash, row: parsed });
    }
  }
  return parsed;
}

function toInsertRow(row: KnowledgeRow): Record<string, unknown> {
  return { ...row, row_hash: knowledgeRowHash(row) };
}

async function readKnowledgeVersionRows(
  ch: ClickHouseClient,
  projectId: EntityId,
  knowledgeId: EntityId,
  version: UInt64String,
): Promise<KnowledgeRow[]> {
  const result = await ch.query({
    query: `SELECT ${KNOWLEDGE_COLUMNS} FROM knowledge
      WHERE project_id = {projectId:UUID} AND knowledge_id = {knowledgeId:UUID}
        AND version = {version:UInt64}`,
    query_params: { projectId, knowledgeId, version },
    format: 'JSONEachRow',
  });
  return (await result.json<unknown>()).map(parseKnowledge);
}

export async function getLatestKnowledge(
  ch: ClickHouseClient,
  projectId: string,
  knowledgeId: string,
): Promise<KnowledgeRow | null> {
  const project = concreteEntityId(projectId, 'projectId');
  const knowledge = concreteEntityId(knowledgeId, 'knowledgeId');
  const result = await ch.query({
    query: `SELECT ${KNOWLEDGE_COLUMNS} FROM knowledge
      WHERE project_id = {projectId:UUID} AND knowledge_id = {knowledgeId:UUID}
      ORDER BY version DESC`,
    query_params: { projectId: project, knowledgeId: knowledge },
    format: 'JSONEachRow',
  });
  const rows = await result.json<unknown>();
  if (rows.length === 0) return null;
  const parsed = rows.map(parseKnowledge);
  const maximum = parsed[0]!.version;
  return reconcileKnowledgeVersion(
    `knowledge:${knowledge}`,
    parsed.filter((row) => row.version === maximum),
  );
}

export async function getKnowledgeAsOf(
  ch: ClickHouseClient,
  projectId: string,
  knowledgeId: string,
  cutoffAt: string,
): Promise<KnowledgeRow | null> {
  const project = concreteEntityId(projectId, 'projectId');
  const knowledge = concreteEntityId(knowledgeId, 'knowledgeId');
  const cutoff = storedDateTime(cutoffAt, 'cutoffAt').replace('T', ' ').replace('Z', '');
  const result = await ch.query({
    query: `SELECT ${KNOWLEDGE_COLUMNS} FROM knowledge
      WHERE project_id = {projectId:UUID} AND knowledge_id = {knowledgeId:UUID}
        AND if(
          observed_at = toDateTime64(0, 3, 'UTC'),
          created_at,
          observed_at
        ) <= {cutoffAt:DateTime64(3, 'UTC')}
      ORDER BY version DESC`,
    query_params: { projectId: project, knowledgeId: knowledge, cutoffAt: cutoff },
    format: 'JSONEachRow',
  });
  const rows = await result.json<unknown>();
  if (rows.length === 0) return null;
  const parsed = rows.map(parseKnowledge);
  const maximum = parsed[0]!.version;
  return reconcileKnowledgeVersion(
    `knowledge:${knowledge}@asOf`,
    parsed.filter((row) => row.version === maximum),
  );
}

export async function listLatestKnowledgeByStatus(
  ch: ClickHouseClient,
  projectId: string,
  status: KnowledgeStatus,
): Promise<KnowledgeRow[]> {
  const project = concreteEntityId(projectId, 'projectId');
  const state = storedEnum(status, KNOWLEDGE_STATUSES, 'knowledgeStatus');
  const result = await ch.query({
    query: `SELECT ${KNOWLEDGE_COLUMNS} FROM knowledge
      WHERE project_id = {projectId:UUID}
      ORDER BY knowledge_id ASC, version DESC`,
    query_params: { projectId: project },
    format: 'JSONEachRow',
  });
  const physical = (await result.json<unknown>()).map(parseKnowledge);
  const grouped = new Map<string, KnowledgeRow[]>();
  for (const row of physical) {
    const rows = grouped.get(row.knowledge_id) ?? [];
    rows.push(row);
    grouped.set(row.knowledge_id, rows);
  }
  const logical: KnowledgeRow[] = [];
  for (const rows of grouped.values()) {
    const maximum = rows[0]!.version;
    logical.push(reconcileKnowledgeVersion(
      `knowledge:${rows[0]!.knowledge_id}`,
      rows.filter((row) => row.version === maximum),
    ));
  }
  return logical.filter((row) => row.status === state);
}

/**
 * Kesit anında (cutoff) geçerli en güncel mantıksal sürümü döndürür. Önce
 * güncel sürümü filtrelemek replay için yanlıştır: sonradan gelen ve eski
 * kaydı geçersiz kılan sürüm, görev mühürlendiğinde geçerli olan satırı
 * gizlerdi.
 */
export async function listLatestKnowledgeByStatusAsOf(
  ch: ClickHouseClient,
  projectId: string,
  status: KnowledgeStatus,
  cutoffAt: string,
): Promise<KnowledgeRow[]> {
  const project = concreteEntityId(projectId, 'projectId');
  const state = storedEnum(status, KNOWLEDGE_STATUSES, 'knowledgeStatus');
  const cutoff = storedDateTime(cutoffAt, 'cutoffAt').replace('T', ' ').replace('Z', '');
  const result = await ch.query({
    query: `SELECT ${KNOWLEDGE_COLUMNS} FROM knowledge
      WHERE project_id = {projectId:UUID}
        AND if(observed_at = toDateTime64(0, 3, 'UTC'), created_at, observed_at)
          <= {cutoffAt:DateTime64(3, 'UTC')}
      ORDER BY knowledge_id ASC, version DESC`,
    query_params: { projectId: project, cutoffAt: cutoff },
    format: 'JSONEachRow',
  });
  const physical = (await result.json<unknown>()).map(parseKnowledge);
  const grouped = new Map<string, KnowledgeRow[]>();
  for (const row of physical) {
    const rows = grouped.get(row.knowledge_id) ?? [];
    rows.push(row);
    grouped.set(row.knowledge_id, rows);
  }
  const logical: KnowledgeRow[] = [];
  for (const rows of grouped.values()) {
    const maximum = rows[0]!.version;
    logical.push(reconcileKnowledgeVersion(
      `knowledge:${rows[0]!.knowledge_id}@asOf`,
      rows.filter((row) => row.version === maximum),
    ));
  }
  return logical.filter((row) => row.status === state);
}

export async function appendKnowledgeVersion(
  ch: ClickHouseClient,
  input: AppendKnowledgeVersionInput,
  expectedVersion?: UInt64String,
): Promise<KnowledgeRow> {
  const projectId = concreteEntityId(input.project_id, 'projectId');
  const knowledgeId = concreteEntityId(input.knowledge_id, 'knowledgeId');
  const current = await getLatestKnowledge(ch, projectId, knowledgeId);
  if (current === null && expectedVersion !== undefined) {
    throw new RepositoryNotFoundError(`knowledge bulunamadi: ${knowledgeId}`);
  }
  if (current !== null) {
    if (expectedVersion === undefined) {
      const desired = parseKnowledge({
        ...input,
        project_id: projectId,
        knowledge_id: knowledgeId,
        observed_at: current.observed_at,
        version: current.version,
      });
      const sameContent = knowledgeCallerContentHash(current) ===
        knowledgeCallerContentHash(desired);
      if (sameContent) return current;
      throw new RepositoryConflictError(`knowledge expectedVersion gerektirir: ${knowledgeId}`);
    }
    const normalizedExpected = storedUInt64(expectedVersion, 'expectedVersion');
    if (normalizedExpected !== current.version) {
      if (BigInt(current.version) < BigInt(normalizedExpected)) {
        throw new RepositoryConflictError(`knowledge surum catismasi: ${knowledgeId}`);
      }
      const desired = parseKnowledge({
        ...input,
        project_id: projectId,
        knowledge_id: knowledgeId,
        observed_at: current.observed_at,
        version: current.version,
      });
      if (knowledgeCallerContentHash(current) === knowledgeCallerContentHash(desired)) {
        return current;
      }
      throw new RepositoryConflictError(`knowledge surum catismasi: ${knowledgeId}`);
    }
  }
  const row = parseKnowledge({
    ...input,
    project_id: projectId,
    knowledge_id: knowledgeId,
    observed_at: nextKnowledgeObservedAt(current?.observed_at),
    version: nextRepositoryVersion(current?.version),
  });
  try {
    await ch.insert({ table: 'knowledge', values: [toInsertRow(row)], format: 'JSONEachRow' });
  } catch (error) {
    const entity = `knowledge:${knowledgeId}`;
    const observed = await readAfterUncertainWrite(
      entity,
      error,
      () => readKnowledgeVersionRows(ch, projectId, knowledgeId, row.version),
    );
    if (observed.length > 0) {
      return reconcileKnowledgeVersion(`knowledge:${knowledgeId}`, observed, row);
    }
    throw uncertainWriteError(entity, error);
  }
  const observed = await readRowsAfterAcknowledgedWrite(
    `knowledge:${knowledgeId}`,
    row,
    () => readKnowledgeVersionRows(ch, projectId, knowledgeId, row.version),
  );
  return reconcileKnowledgeVersion(`knowledge:${knowledgeId}`, observed, row);
}

export async function getKnowledgeSourceRefAsOf(
  ch: ClickHouseClient,
  projectId: string,
  knowledgeId: string,
  cutoffAt: string,
): Promise<VersionedSourceRefV1 | null> {
  const row = await getKnowledgeAsOf(ch, projectId, knowledgeId, cutoffAt);
  if (row === null) return null;
  const version = Number(row.version);
  if (!Number.isSafeInteger(version)) throw new RepositoryConflictError(`knowledge source version guvenli degil: ${row.version}`);
  return VersionedSourceRefV1Schema.parse({
    sourceType: 'knowledge',
    sourceId: row.knowledge_id,
    version,
    hash: knowledgeSourceHash(row),
  });
}

/**
 * Bir görevin DOĞURDUĞU bilgi kayıtlarının kimlikleri (docs/08 fihristi:
 * "Kararlar: [K-12 fiyat yuvarlama]").
 *
 * NEDEN VAR: `file_index.related_knowledge_ids` canlı veride HER SATIRDA
 * boştu — kolon ve panel satırı vardı, doldurulan yer yoktu. Kaynağı olan
 * bilgi zaten `source_task_id` taşıyor; bağ buradan kurulur.
 */
export async function listKnowledgeIdsBySourceTask(
  ch: ClickHouseClient,
  projectId: string,
  sourceTaskId: string,
): Promise<readonly string[]> {
  const project = concreteEntityId(projectId, 'projectId');
  const task = concreteEntityId(sourceTaskId, 'sourceTaskId');
  const result = await ch.query({
    query: `SELECT DISTINCT knowledge_id FROM knowledge
      WHERE project_id = {projectId:UUID} AND source_task_id = {taskId:UUID}
      ORDER BY knowledge_id ASC LIMIT 100`,
    query_params: { projectId: project, taskId: task },
    format: 'JSONEachRow',
  });
  return (await result.json<Record<string, unknown>>())
    .map((row) => String(row['knowledge_id']))
    .filter((value) => value.length > 0);
}
