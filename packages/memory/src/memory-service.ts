import type { ClickHouseClient } from '@ww/db';
import {
  EntityIdSchema,
  canonicalSha256V1,
  type EntityId,
} from '@ww/shared';
import { getTaskAsOf, listFileIndex, listLatestKnowledgeByStatus, upsertFileIndex, type FileIndexLayer, type KnowledgeRow } from '@ww/db';

export interface MemoryChunk {
  readonly sourceTable: 'knowledge' | 'summaries' | 'file_index' | 'messages';
  readonly sourceId: EntityId;
  readonly text: string;
  readonly label: string;
  readonly score: number;
}

export interface ContextPack {
  readonly contextPackId: EntityId;
  readonly cutoffAt: string;
  readonly estimatedTokens: number;
  readonly chunks: readonly MemoryChunk[];
}

export interface ContextPackInput {
  readonly projectId: EntityId;
  readonly taskId: EntityId;
  readonly cutoffAt: string;
  readonly tokenBudget: number;
  readonly query?: string;
  readonly knowledgeKinds?: readonly ('requirement' | 'decision' | 'constraint' | 'standard' | 'concept' | 'glossary')[];
}

export interface MemoryQueryInput {
  readonly projectId: EntityId;
  readonly query: string;
  readonly limit?: number;
  readonly cutoffAt?: string;
}

export interface SummaryInput {
  readonly projectId: EntityId;
  readonly scope: 'task' | 'phase' | 'day' | 'council' | 'agent_session';
  readonly refId: EntityId;
  readonly content: string;
  readonly createdByAgentId: EntityId;
  readonly createdAt: string;
}

export interface EmbeddingInput {
  readonly projectId: EntityId;
  readonly sourceTable: 'knowledge' | 'summaries' | 'file_index' | 'messages';
  readonly sourceId: EntityId;
  readonly chunkIndex: number;
  readonly text: string;
  readonly vector: readonly number[];
  readonly embeddingModel: string;
  readonly createdAt: string;
}

export interface FileIndexInput {
  readonly projectId: EntityId;
  readonly filePath: string;
  readonly summary: string;
  readonly layer: FileIndexLayer;
  readonly exports?: readonly string[];
  readonly relatedTaskIds?: readonly EntityId[];
  readonly relatedArtifactIds?: readonly EntityId[];
  readonly relatedKnowledgeIds?: readonly EntityId[];
  readonly lastCommitHash?: string;
  readonly updatedAt: string;
}

const MAX_TOKEN_BUDGET = 100_000;
const MAX_QUERY_LIMIT = 100;

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.trim().split(/\s+/u).filter(Boolean).length * 1.3));
}

function id(namespace: string, value: unknown): EntityId {
  const hash = canonicalSha256V1({ namespace, value });
  return EntityIdSchema.parse(`${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`);
}

function knowledgeChunk(row: KnowledgeRow, score: number): MemoryChunk {
  return Object.freeze({
    sourceTable: 'knowledge',
    sourceId: row.knowledge_id,
    text: `${row.title}\n${row.content}`,
    label: `[knowledge:${row.kind} #${row.knowledge_id}]`,
    score,
  });
}

function validCutoff(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error('cutoffAt gecerli bir tarih olmalidir');
  return new Date(timestamp).toISOString();
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function selectMemoryChunks(
  chunks: readonly MemoryChunk[],
  tokenBudget: number,
): { readonly chunks: readonly MemoryChunk[]; readonly estimatedTokens: number } {
  if (!Number.isSafeInteger(tokenBudget) || tokenBudget < 1 || tokenBudget > MAX_TOKEN_BUDGET) throw new Error('context token budget gecersiz');
  const seen = new Set<string>();
  const selected: MemoryChunk[] = [];
  let used = 0;
  for (const chunk of chunks.slice().sort((left, right) => right.score - left.score || left.sourceId.localeCompare(right.sourceId))) {
    const key = `${chunk.sourceTable}:${chunk.sourceId}:${chunk.text}`;
    if (seen.has(key)) continue;
    const tokens = estimateTokens(chunk.text);
    if (used + tokens > tokenBudget) continue;
    seen.add(key);
    used += tokens;
    selected.push(Object.freeze(chunk));
  }
  return Object.freeze({ chunks: Object.freeze(selected), estimatedTokens: used });
}

/**
 * Phase 2 memory service. It deliberately uses bounded SQL reads and a
 * deterministic whole-chunk budget. Semantic providers can be plugged in
 * through embeddings later without changing the public pack contract.
 */
export class MemoryService {
  readonly #ch: ClickHouseClient;

  constructor(ch: ClickHouseClient) {
    this.#ch = ch;
  }

  async query(input: MemoryQueryInput): Promise<readonly MemoryChunk[]> {
    const limit = input.limit ?? 12;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_QUERY_LIMIT) throw new Error('memory query limiti gecersiz');
    const projectId = EntityIdSchema.parse(input.projectId);
    const query = input.query.trim();
    if (query.length === 0) throw new Error('memory query bos olamaz');
    const cutoff = input.cutoffAt === undefined ? undefined : validCutoff(input.cutoffAt);
    const knowledge = await listLatestKnowledgeByStatus(this.#ch, projectId, 'active');
    const files = await listFileIndex(this.#ch, projectId, Math.min(1_000, limit * 20));
    const terms = query.toLocaleLowerCase('tr-TR').split(/\s+/u).filter(Boolean);
    const scored = knowledge
      .filter((row) => cutoff === undefined || Date.parse(row.created_at) <= Date.parse(cutoff))
      .map((row) => {
        const haystack = `${row.title} ${row.content} ${row.tags.join(' ')}`.toLocaleLowerCase('tr-TR');
        const score = terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
        return { row, score };
      })
      .filter(({ score }) => score > 0)
      .sort((left, right) => right.score - left.score || left.row.knowledge_id.localeCompare(right.row.knowledge_id))
      .slice(0, limit)
      .map(({ row, score }) => knowledgeChunk(row, score));
    const fileScored = files
      .map((row) => ({ row, score: terms.reduce((total, term) => total + (`${row.file_path} ${row.summary} ${row.exports.join(' ')}`.toLocaleLowerCase('tr-TR').includes(term) ? 1 : 0), 0) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || a.row.file_path.localeCompare(b.row.file_path))
      .slice(0, limit)
      .map(({ row, score }) => ({ sourceTable: 'file_index' as const, sourceId: id('file-index', { projectId, path: row.file_path }), text: `${row.file_path}\n${row.summary}`, label: `[file:${row.file_path}]`, score }));
    if (fileScored.length > 0) return [...scored, ...fileScored].sort((a, b) => b.score - a.score).slice(0, limit);
    if (scored.length > 0) return scored;

    const result = await this.#ch.query({
      query: `SELECT summary_id, content, created_at FROM summaries
        WHERE project_id = {projectId:UUID} AND positionCaseInsensitive(content, {query:String}) > 0
        ${cutoff === undefined ? '' : 'AND created_at <= {cutoff:DateTime64(3)}'}
        ORDER BY created_at DESC, summary_id ASC LIMIT {limit:UInt32}`,
      query_params: {
        projectId,
        query,
        limit,
        ...(cutoff === undefined ? {} : { cutoff: cutoff.replace('T', ' ').replace('Z', '') }),
      },
      format: 'JSONEachRow',
    });
    return (await result.json<unknown>()).flatMap((value): MemoryChunk[] => {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
      const row = value as Record<string, unknown>;
      const sourceId = typeof row['summary_id'] === 'string' ? row['summary_id'] : undefined;
      const text = asText(row['content']);
      if (sourceId === undefined || text.length === 0) return [];
      return [{ sourceTable: 'summaries', sourceId: EntityIdSchema.parse(sourceId), text, label: `[summary #${sourceId}]`, score: 1 }];
    });
  }

  async buildContextPack(input: ContextPackInput): Promise<ContextPack> {
    if (!Number.isSafeInteger(input.tokenBudget) || input.tokenBudget < 1 || input.tokenBudget > MAX_TOKEN_BUDGET) throw new Error('context token budget gecersiz');
    const cutoffAt = validCutoff(input.cutoffAt);
    const task = await getTaskAsOf(this.#ch, input.projectId, input.taskId, cutoffAt);
    if (task === null) throw new Error(`context task bulunamadi: ${input.taskId}`);
    const taskText = `${task.title}\n${task.description}\nKabul: ${task.acceptance_criteria.join('; ')}`;
    const requiredKinds = new Set(input.knowledgeKinds ?? ['requirement', 'standard', 'decision']);
    const knowledge = (await listLatestKnowledgeByStatus(this.#ch, input.projectId, 'active'))
      .filter((row) => requiredKinds.has(row.kind) && Date.parse(row.created_at) <= Date.parse(cutoffAt))
      .map((row) => knowledgeChunk(row, row.kind === 'requirement' ? 3 : row.kind === 'standard' ? 2 : 1));
    const chunks = [
      { sourceTable: 'summaries' as const, sourceId: input.taskId, text: taskText, label: `[task #${input.taskId}]`, score: 4 },
      ...knowledge,
      ...(input.query === undefined ? [] : await this.query({ projectId: input.projectId, query: input.query, cutoffAt, limit: 12 })),
    ];
    const selected = selectMemoryChunks(chunks, input.tokenBudget);
    return Object.freeze({
      contextPackId: id('memory-context-pack-v2', { projectId: input.projectId, taskId: input.taskId, cutoffAt, chunks: selected.chunks.map((chunk) => [chunk.sourceTable, chunk.sourceId]) }),
      cutoffAt,
      estimatedTokens: selected.estimatedTokens,
      chunks: selected.chunks,
    });
  }

  async appendSummary(input: SummaryInput): Promise<EntityId> {
    const summaryId = id('summary-v1', input);
    // Kolonlar AÇIKÇA eşlenir. Eskiden `{ summary_id, ...input }` yazılıyordu
    // ve `input` alanları camelCase (projectId/refId/...), tablo ise
    // snake_case ister: satır yazılıyor ama kimlik kolonları BOŞ kalıyordu.
    // Hangi göreve ait olduğu bilinmeyen özet, hafızada işe yaramaz.
    //
    // Bu fonksiyonun ne bir çağıranı ne de bir entegrasyon testi vardı; bu
    // yüzden gerçek tabloya hiç yazılmadığı fark edilmemişti.
    await this.#ch.insert({
      table: 'summaries',
      values: [{
        summary_id: summaryId,
        project_id: input.projectId,
        scope: input.scope,
        ref_id: input.refId,
        content: input.content,
        created_by_agent_id: input.createdByAgentId,
        created_at: input.createdAt,
      }],
      format: 'JSONEachRow',
    });
    return summaryId;
  }

  async appendEmbedding(input: EmbeddingInput): Promise<EntityId> {
    if (input.vector.length === 0 || input.vector.length > 16_384) throw new Error('embedding vector boyutu gecersiz');
    const embeddingId = id('embedding-v1', input);
    await this.#ch.insert({ table: 'embeddings', values: [{ embedding_id: embeddingId, project_id: input.projectId, source_table: input.sourceTable, source_id: input.sourceId, chunk_index: input.chunkIndex, text: input.text, vector: [...input.vector], embedding_model: input.embeddingModel, created_at: input.createdAt }], format: 'JSONEachRow' });
    return embeddingId;
  }

  async updateFileIndex(input: FileIndexInput): Promise<EntityId> {
    const row = await upsertFileIndex(this.#ch, {
      project_id: input.projectId,
      file_path: input.filePath,
      summary: input.summary,
      layer: input.layer,
      exports: input.exports ?? [],
      related_task_ids: input.relatedTaskIds ?? [],
      related_artifact_ids: input.relatedArtifactIds ?? [],
      related_knowledge_ids: input.relatedKnowledgeIds ?? [],
      last_commit_hash: input.lastCommitHash ?? '',
      updated_at: input.updatedAt,
    });
    return id('file-index-row', row);
  }
}

