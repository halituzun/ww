// docs/06 hafıza piramidi, ORTA katman okuyucusu.
//
// NEDEN VAR: `summaries` yazıcısı bağlandı ama okunacak tek yol
// `MemoryService.query` içindeki gömülü SQL'di ve o da özetleri yalnızca
// diğer kaynaklar HİÇ eşleşmediğinde bakılan bir SON ÇARE olarak
// sorguluyordu. Özet katmanı, kendi piramidinde ikinci sınıftı.
import type { ClickHouseClient } from '../client.js';
import { concreteEntityId } from './identifiers.js';

export interface SummaryRow {
  readonly summary_id: string;
  readonly project_id: string;
  readonly scope: string;
  readonly ref_id: string;
  readonly content: string;
  readonly created_at: string;
}

// Takma ad `created_at` OLAMAZ: ClickHouse WHERE içindeki `created_at`'i
// SELECT takma adına çözer ve kesme karşılaştırması String ile DateTime64
// arasında kalır ("No operation lessOrEquals between String and DateTime64").
const COLUMNS = "summary_id, project_id, scope, ref_id, content, formatDateTime(created_at, '%Y-%m-%dT%H:%i:%SZ') AS created_at_text";

function parse(value: unknown): SummaryRow {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('summaries satiri okunamadi');
  }
  const row = value as Record<string, unknown>;
  const text = (key: string): string => (typeof row[key] === 'string' ? row[key] : '');
  return Object.freeze({
    summary_id: text('summary_id'),
    project_id: text('project_id'),
    scope: text('scope'),
    ref_id: text('ref_id'),
    content: text('content'),
    created_at: text('created_at_text'),
  });
}

/**
 * Projenin en YENİ özetleri (kronolojik farkındalık, docs/06 "taze
 * gelişmeler"). `cutoffAt` verilirse o andan sonra yazılanlar elenir:
 * yeniden koşan bir görev, kendisinden sonra oluşmuş bilgiyi görmemelidir.
 */
/**
 * Son N özet. `LIMIT 1 BY summary_id` NEDEN VAR: tablo `MergeTree` (yani
 * ReplacingMergeTree DEĞİL) ve `summary_id` üzerinde benzersizlik yok. Aynı
 * özet iki kez yazılırsa kopya kalıcıdır; bağlam paketi son beş özeti aldığı
 * için kopyalar o pencereyi doldurup gerçek geçmişi dışarı iterdi.
 */
export async function listRecentSummaries(
  ch: ClickHouseClient,
  projectId: string,
  limit = 200,
  cutoffAt?: string,
): Promise<readonly SummaryRow[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error('summaries limiti gecersiz');
  }
  const id = concreteEntityId(projectId, 'projectId');
  const result = await ch.query({
    query: `SELECT ${COLUMNS} FROM summaries WHERE project_id = {projectId:UUID}
      ${cutoffAt === undefined ? '' : 'AND created_at <= parseDateTime64BestEffort({cutoff:String}, 3)'}
      ORDER BY created_at DESC, summary_id ASC
      LIMIT 1 BY summary_id
      LIMIT {limit:UInt32}`,
    query_params: {
      projectId: id,
      limit,
      // ISO metni DateTime64 parametresine BAĞLANMAZ ("No operation
      // lessOrEquals between String and DateTime64"); ayrıştırma SQL
      // tarafında yapılır. Eski gömülü sorgu bu hatayı taşıyordu ve hiçbir
      // test o yolu çalıştırmadığı için görünmemişti.
      ...(cutoffAt === undefined ? {} : { cutoff: cutoffAt }),
    },
    format: 'JSONEachRow',
  });
  return (await result.json<unknown>()).map(parse);
}
