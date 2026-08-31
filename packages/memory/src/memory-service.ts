import type { ClickHouseClient } from '@ww/db';
import {
  EntityIdSchema,
  NIL_UUID,
  canonicalSha256V1,
  type EntityId,
} from '@ww/shared';
import { getFileIndex, getLatestProjectMapSnapshotAsOf, getPlanAsOf, getTaskAsOf, listFileIndex, listFileIndexAsOf, listLatestKnowledgeByStatus, listLatestKnowledgeByStatusAsOf, listRecentMessages, listRecentSummaries, upsertFileIndex, type FileIndexLayer, type KnowledgeRow, type ProjectMapSnapshotRow } from '@ww/db';

export interface MemoryChunk {
  readonly sourceTable: 'plans' | 'knowledge' | 'summaries' | 'file_index' | 'project_maps' | 'messages';
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
  readonly sourceTable: 'plans' | 'knowledge' | 'summaries' | 'file_index' | 'project_maps' | 'messages';
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
/** docs/06 "son N görev özeti"; N burada sabittir, bütçe zaten kırpar. */
const RECENT_SUMMARY_COUNT = 5;
const RECENT_SUMMARY_SCORE = 0.5;

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

function projectMapText(row: ProjectMapSnapshotRow): string {
  const map = row.map_json as {
    readonly fileCount?: unknown;
    readonly functionCount?: unknown;
    readonly routeCount?: unknown;
    readonly routes?: readonly {
      readonly httpMethod?: unknown;
      readonly routePath?: unknown;
      readonly filePath?: unknown;
      readonly line?: unknown;
      readonly controller?: unknown;
      readonly methodName?: unknown;
    }[];
    readonly functions?: readonly {
      readonly name?: unknown;
      readonly filePath?: unknown;
      readonly line?: unknown;
      readonly parent?: unknown;
      readonly exported?: unknown;
    }[];
  };
  const routes = Array.isArray(map.routes) ? map.routes : [];
  const functions = Array.isArray(map.functions) ? map.functions : [];
  const routeLines = routes.slice(0, 20).map((route) => [
    typeof route.httpMethod === 'string' ? route.httpMethod : '',
    typeof route.routePath === 'string' ? route.routePath : '',
    '->',
    `${typeof route.filePath === 'string' ? route.filePath : ''}:${typeof route.line === 'number' ? route.line : '?'}`,
    `(${typeof route.controller === 'string' ? route.controller : ''}.${typeof route.methodName === 'string' ? route.methodName : ''})`,
  ].filter(Boolean).join(' '));
  const functionLines = functions
    .filter((item) => item.exported === true)
    .slice(0, 40)
    .map((item) => [
      typeof item.parent === 'string' && item.parent !== '' ? `${item.parent}.` : '',
      typeof item.name === 'string' ? item.name : '',
      '->',
      `${typeof item.filePath === 'string' ? item.filePath : ''}:${typeof item.line === 'number' ? item.line : '?'}`,
    ].join(''));
  return [
    `Dosya: ${String(map.fileCount ?? row.file_count)} · Fonksiyon: ${String(map.functionCount ?? row.function_count)} · Route: ${String(map.routeCount ?? row.route_count)}`,
    routeLines.length === 0 ? '' : `Route haritası:\n${routeLines.join('\n')}`,
    functionLines.length === 0 ? '' : `Export haritası:\n${functionLines.join('\n')}`,
  ].filter((line) => line !== '').join('\n');
}

function validCutoff(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error('cutoffAt gecerli bir tarih olmalidir');
  return new Date(timestamp).toISOString();
}

/** Terimin samanlıkta kaç kez geçtiği; boş terim sayılmaz. */
function occurrences(haystack: string, term: string): number {
  if (term === '') return 0;
  let count = 0;
  let index = haystack.indexOf(term);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(term, index + term.length);
  }
  return count;
}

/** Skorlanmamış aday: metni ve skorlamada kullanılacak küçük harfli samanlığı. */
export interface MemoryCandidate {
  readonly chunk: Omit<MemoryChunk, 'score'>;
  readonly haystack: string;
}

/**
 * docs/06 arama katmanı: TÜM kaynaklar (karar, fihrist, özet) aynı terazide
 * tartılır ve tek listede sıralanır.
 *
 * Eskiden özetler yalnızca knowledge VE file_index hiç eşleşmediğinde
 * bakılan bir son çareydi: eşleşen tek bir karar, piramidin orta katmanını
 * tamamen görünmez yapıyordu. Özet yazıcısı bağlandığından beri bu, yazılan
 * ama okunmayan bir katman demekti.
 */
export function rankMemoryCandidates(
  candidates: readonly MemoryCandidate[],
  terms: readonly string[],
  limit: number,
): readonly MemoryChunk[] {
  return candidates
    .map((candidate) => ({
      ...candidate.chunk,
      // Terim başına GEÇİŞ SAYISI: iki kez geçen aday, bir kez geçenden
      // önce gelir. Eski hâli yalnızca "geçiyor mu" diye bakıyordu.
      score: terms.reduce((total, term) => total + occurrences(candidate.haystack, term), 0),
    }))
    .filter((chunk) => chunk.score > 0)
    // Eşit skorda kaynak tablo + kimlik ile deterministik sıra: aynı sorgu
    // aynı bağlamı üretmezse, bir koşuyu tekrar etmek imkânsız olur.
    .sort((left, right) => right.score - left.score
      || left.sourceTable.localeCompare(right.sourceTable)
      || left.sourceId.localeCompare(right.sourceId))
    .slice(0, limit)
    .map((chunk) => Object.freeze(chunk));
}

/** Fihrist ilişkilerinde tutulan azami kimlik sayısı. */
export const MAX_FILE_RELATIONS = 50;

/**
 * docs/08 fihristi: "İlişkili işler: #T-142 · #T-98". Bir dosyanın geçmişi
 * BİRİKİR.
 *
 * NEDEN VAR: `updateFileIndex` ilişkileri her yazımda ÜZERİNE yazıyordu.
 * Canlı veride ölçüldü: iki ayrı görevde değiştirilmiş bir dosyanın
 * (change_count=2) fihristinde yalnızca bir görev kimliği kalmıştı —
 * dosyanın geçmişi her commit'te siliniyordu.
 */
export function mergeFileRelations(
  current: readonly string[],
  incoming: readonly string[],
  limit: number = MAX_FILE_RELATIONS,
): readonly string[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error('fihrist ilişki siniri gecersiz');
  }
  const merged = [...new Set([...current, ...incoming])];
  // Sınır aşılırsa EN YENİLER kalır: "bu dosyayı en son kim değiştirdi"
  // daha sık sorulan sorudur.
  return Object.freeze(merged.slice(Math.max(0, merged.length - limit)));
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
    const knowledge = cutoff === undefined
      ? await listLatestKnowledgeByStatus(this.#ch, projectId, 'active')
      : await listLatestKnowledgeByStatusAsOf(this.#ch, projectId, 'active', cutoff);
    const files = cutoff === undefined
      ? await listFileIndex(this.#ch, projectId, Math.min(1_000, limit * 20))
      : await listFileIndexAsOf(this.#ch, projectId, cutoff, Math.min(1_000, limit * 20));
    // ÖZETLER ARTIK BİRİNCİ SINIF KAYNAK. Eskiden yalnızca knowledge ve
    // file_index HİÇ eşleşmediğinde sorgulanıyordu; eşleşen tek bir karar
    // piramidin orta katmanını tamamen görünmez yapıyordu.
    const summaries = await listRecentSummaries(this.#ch, projectId, 200, cutoff);
    const messages = await listRecentMessages(this.#ch, projectId, 200, cutoff);
    const terms = query.toLocaleLowerCase('tr-TR').split(/\s+/u).filter(Boolean);
    const candidates: MemoryCandidate[] = [
      ...knowledge
        .map((row) => ({
          chunk: {
            sourceTable: 'knowledge' as const,
            sourceId: row.knowledge_id as EntityId,
            text: `${row.title}\n${row.content}`,
            label: `[knowledge:${row.kind} #${row.knowledge_id}]`,
          },
          haystack: `${row.title} ${row.content} ${row.tags.join(' ')}`.toLocaleLowerCase('tr-TR'),
        })),
      ...files.map((row) => ({
        chunk: {
          sourceTable: 'file_index' as const,
          sourceId: id('file-index', { projectId, path: row.file_path }),
          text: `${row.file_path}\n${row.summary}`,
          label: `[file:${row.file_path}]`,
        },
        haystack: `${row.file_path} ${row.summary} ${row.exports.join(' ')}`.toLocaleLowerCase('tr-TR'),
      })),
      ...summaries.map((row) => ({
        chunk: {
          sourceTable: 'summaries' as const,
          sourceId: EntityIdSchema.parse(row.summary_id),
          text: row.content,
          label: `[summary:${row.scope} #${row.summary_id}]`,
        },
        haystack: row.content.toLocaleLowerCase('tr-TR'),
      })),
      ...messages.map((row) => ({
        chunk: {
          sourceTable: 'messages' as const,
          sourceId: row.protocolVersion === 1 ? row.envelope.messageId : row.messageId,
          text: row.content,
          label: `[message:${row.protocolVersion === 1 ? row.envelope.kind : row.kind}]`,
        },
        haystack: row.content.toLocaleLowerCase('tr-TR'),
      })),
    ];
    return rankMemoryCandidates(candidates, terms, limit);
  }

  async buildContextPack(input: ContextPackInput): Promise<ContextPack> {
    if (!Number.isSafeInteger(input.tokenBudget) || input.tokenBudget < 1 || input.tokenBudget > MAX_TOKEN_BUDGET) throw new Error('context token budget gecersiz');
    const cutoffAt = validCutoff(input.cutoffAt);
    const task = await getTaskAsOf(this.#ch, input.projectId, input.taskId, cutoffAt);
    if (task === null) throw new Error(`context task bulunamadi: ${input.taskId}`);
    const plan = await getPlanAsOf(this.#ch, input.projectId, task.plan_id, cutoffAt);
    // Eski/süren görevlerde henüz maddileşmiş plan olmayabilir; görev yine
    // de kullanılabilir. Mühürlü brief'ler her zaman plan taşır ve aşağıdaki
    // zengin plan chunk'ını alır.
    const planChunk = plan === null ? [] : [Object.freeze({
      sourceTable: 'plans' as const,
      sourceId: plan.plan_id,
      text: `${plan.title}\n${plan.content_md}`,
      label: `[plan:${plan.plan_version} #${plan.plan_id}]`,
      score: 4,
    })];
    const taskText = `${task.title}\n${task.description}\nKabul: ${task.acceptance_criteria.join('; ')}`;
    // Hedef dosyalar mühürlü görev sözleşmesinin parçasıdır; açıkça
    // eklenmelidir. Amaç "özelliği uygula" dediğinde anahtar kelime
    // eşleşmesine güvenmek dosya fihristini sessizce düşürür.
    const targetPaths = new Set(task.target_files);
    const targetFileChunks = (await listFileIndexAsOf(
      this.#ch,
      input.projectId,
      cutoffAt,
      Math.min(1_000, Math.max(1, targetPaths.size * 2)),
    ))
      .filter((row) => targetPaths.has(row.file_path))
      .map((row) => Object.freeze({
        sourceTable: 'file_index' as const,
        sourceId: id('file-index', { projectId: input.projectId, path: row.file_path }),
        text: `${row.file_path}\n${row.summary}`,
        label: `[file:${row.file_path}]`,
        score: 3,
      }));
    const requiredKinds = new Set(input.knowledgeKinds ?? ['requirement', 'standard', 'decision']);
    const knowledge = (await listLatestKnowledgeByStatusAsOf(this.#ch, input.projectId, 'active', cutoffAt))
      .filter((row) => requiredKinds.has(row.kind))
      .map((row) => knowledgeChunk(row, row.kind === 'requirement' ? 3 : row.kind === 'standard' ? 2 : 1));
    // docs/06 Context Builder 4. katman "Taze gelişmeler": projenin SON N
    // görev özeti, kronolojik farkındalık için. Bu katman hiç yoktu — sorgu
    // vermeyen bir görev, projede az önce ne olduğunu HİÇ göremiyordu.
    //
    // Skoru sorgu eşleşmelerinin (>=1) ALTINDA tutulur: taze olmak, ilgili
    // olmaktan önce gelmemeli; bütçe dolduğunda ilk elenen bunlar olur.
    const recent = (await listRecentSummaries(this.#ch, input.projectId, RECENT_SUMMARY_COUNT, cutoffAt))
      .map((row) => Object.freeze({
        sourceTable: 'summaries' as const,
        sourceId: EntityIdSchema.parse(row.summary_id),
        text: row.content,
        label: `[summary:${row.scope} #${row.summary_id}]`,
        score: RECENT_SUMMARY_SCORE,
      }));
    // Bağımlılık ve üst görev özetleri "son zamanlar" bağlamı değil, görev
    // bağlamıdır: bir bağımlılık projenin en yeni beş özetinden eski olabilir
    // ve yine de sonraki görev tarafından görülebilmelidir.
    const relatedTaskIds = new Set([
      ...(task.parent_task_id === NIL_UUID ? [] : [task.parent_task_id]),
      ...task.depends_on,
    ]);
    const relatedSummaries = relatedTaskIds.size === 0
      ? []
      : (await listRecentSummaries(this.#ch, input.projectId, 200, cutoffAt))
        .filter((row) => relatedTaskIds.has(row.ref_id))
        .map((row) => Object.freeze({
          sourceTable: 'summaries' as const,
          sourceId: EntityIdSchema.parse(row.summary_id),
          text: row.content,
          label: `[summary:${row.scope} #${row.summary_id}]`,
          score: 3,
        }));
    const recentMessages = (await listRecentMessages(this.#ch, input.projectId, 5, cutoffAt))
      .map((row) => Object.freeze({
        sourceTable: 'messages' as const,
        sourceId: row.protocolVersion === 1 ? row.envelope.messageId : row.messageId,
        text: row.content,
        label: `[message:${row.protocolVersion === 1 ? row.envelope.kind : row.kind}]`,
        score: RECENT_SUMMARY_SCORE,
      }));
    const projectMap = await getLatestProjectMapSnapshotAsOf(this.#ch, input.projectId, cutoffAt);
    const projectMapChunks = projectMap === null ? [] : [Object.freeze({
      sourceTable: 'project_maps' as const,
      sourceId: projectMap.project_map_id,
      text: projectMapText(projectMap),
      label: `[project-map #${projectMap.project_map_id}]`,
      score: 3,
    })];
    const chunks = [
      ...planChunk,
      { sourceTable: 'summaries' as const, sourceId: input.taskId, text: taskText, label: `[task #${input.taskId}]`, score: 4 },
      ...knowledge,
      ...targetFileChunks,
      ...projectMapChunks,
      ...(input.query === undefined ? [] : await this.query({ projectId: input.projectId, query: input.query, cutoffAt, limit: 12 })),
      ...relatedSummaries,
      ...recent,
      ...recentMessages,
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
    // İLİŞKİLER BİRİKİR, ÜZERİNE YAZILMAZ. Dosyanın hangi işlerde
    // değiştiğini bilmek fihristin varlık sebebidir; her commit'te listeyi
    // sıfırlamak "bu dosyayı kim, neden değiştirdi" sorusunu son commit'e
    // indirger.
    const current = await getFileIndex(this.#ch, input.projectId, input.filePath);
    const row = await upsertFileIndex(this.#ch, {
      project_id: input.projectId,
      file_path: input.filePath,
      summary: input.summary,
      layer: input.layer,
      exports: input.exports ?? [],
      related_task_ids: mergeFileRelations(
        current?.related_task_ids ?? [], input.relatedTaskIds ?? [],
      ) as EntityId[],
      related_artifact_ids: mergeFileRelations(
        current?.related_artifact_ids ?? [], input.relatedArtifactIds ?? [],
      ) as EntityId[],
      related_knowledge_ids: mergeFileRelations(
        current?.related_knowledge_ids ?? [], input.relatedKnowledgeIds ?? [],
      ) as EntityId[],
      last_commit_hash: input.lastCommitHash ?? '',
      updated_at: input.updatedAt,
    });
    return id('file-index-row', row);
  }
}
