import { describe, expect, it } from 'vitest';
import {
  mergeFileRelations, rankMemoryCandidates, selectMemoryChunks,
} from './memory-service.js';

const chunk = (sourceId: string, text: string, score: number) => ({
  sourceTable: 'knowledge' as const,
  sourceId: sourceId as never,
  text,
  label: `[knowledge #${sourceId}]`,
  score,
});

describe('Phase 2 memory budget', () => {
  it('whole chunks kullanir, duplicate kaynagi eler ve deterministic siralar', () => {
    const result = selectMemoryChunks([
      chunk('00000000-0000-0000-0000-000000000002', 'low priority context', 1),
      chunk('00000000-0000-0000-0000-000000000001', 'high priority decision', 4),
      chunk('00000000-0000-0000-0000-000000000001', 'high priority decision', 4),
    ], 5);
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]?.sourceId).toBe('00000000-0000-0000-0000-000000000001');
    expect(result.estimatedTokens).toBeGreaterThan(0);
  });

  it('gecersiz ve asiri token butcesini fail-closed reddeder', () => {
    expect(() => selectMemoryChunks([], 0)).toThrow(/token budget/);
    expect(() => selectMemoryChunks([], 100_001)).toThrow(/token budget/);
  });
});

// docs/06: arama SONUCU özet + karar + fihristten oluşur. Eski `query` özetleri
// yalnızca knowledge VE file_index hiç eşleşmediğinde bakılan bir son çare
// olarak sorguluyordu — yani piramidin orta katmanı, tek bir eşleşen karar
// yüzünden tamamen görünmez oluyordu.
describe('bellek adaylarını sıralama', () => {
  const candidate = (table: 'knowledge' | 'summaries' | 'file_index', id: string, text: string) => ({
    chunk: { sourceTable: table, sourceId: id as never, text, label: `[${table} #${id}]` },
    haystack: text.toLocaleLowerCase('tr-TR'),
  });

  it('ozet adayi, bilgi adayi eslesse bile sonuca girer', () => {
    const ranked = rankMemoryCandidates([
      candidate('knowledge', '00000000-0000-0000-0000-000000000001', 'renk paleti karari'),
      candidate('summaries', '00000000-0000-0000-0000-000000000002', 'renk paleti gorevi bitti'),
    ], ['renk'], 12);
    expect(ranked.map((chunk) => chunk.sourceTable)).toEqual(
      expect.arrayContaining(['knowledge', 'summaries']),
    );
  });

  it('eslesmeyen adayi eler ve limiti uygular', () => {
    const ranked = rankMemoryCandidates([
      candidate('knowledge', '00000000-0000-0000-0000-000000000001', 'renk renk paleti'),
      candidate('summaries', '00000000-0000-0000-0000-000000000002', 'renk gorevi'),
      candidate('file_index', '00000000-0000-0000-0000-000000000003', 'alakasiz dosya'),
    ], ['renk'], 1);
    expect(ranked).toHaveLength(1);
    // Terim iki kez geçen aday daha yüksek skorludur.
    expect(ranked[0]?.sourceTable).toBe('knowledge');
  });

  it('skor esitliginde deterministik siralar', () => {
    const terms = ['renk'];
    const first = rankMemoryCandidates([
      candidate('summaries', '00000000-0000-0000-0000-000000000002', 'renk'),
      candidate('knowledge', '00000000-0000-0000-0000-000000000001', 'renk'),
    ], terms, 12);
    const second = rankMemoryCandidates([
      candidate('knowledge', '00000000-0000-0000-0000-000000000001', 'renk'),
      candidate('summaries', '00000000-0000-0000-0000-000000000002', 'renk'),
    ], terms, 12);
    expect(first.map((chunk) => chunk.sourceId)).toEqual(second.map((chunk) => chunk.sourceId));
  });
});

// ASIL KUSUR (canlı veride ölçüldü, 2026-08-18): `Counter.tsx` iki ayrı
// görevde değiştirilmişti (change_count=2) ama fihristte YALNIZ BİR görev
// kimliği duruyordu. `updateFileIndex` ilişkileri her yazımda üzerine
// yazıyordu, yani docs/08'in "İlişkili işler: #T-142 · #T-98" satırı
// yapısal olarak imkânsızdı: dosyanın geçmişi her commit'te siliniyordu.
describe('fihrist ilişkilerini birleştirme', () => {
  it('yeni kimlikleri mevcutlarin uzerine EKLER', () => {
    expect(mergeFileRelations(['a', 'b'], ['c'], 10)).toEqual(['a', 'b', 'c']);
  });

  it('tekrari eler ve sirayi korur', () => {
    expect(mergeFileRelations(['a', 'b'], ['b', 'a', 'c'], 10)).toEqual(['a', 'b', 'c']);
  });

  // Sınırsız büyüyen bir dizi satırı ve prompt'u şişirir; EN YENİLER kalır
  // çünkü "bu dosyayı en son kim değiştirdi" daha sık sorulan sorudur.
  it('sinira uyar ve en yenileri tutar', () => {
    expect(mergeFileRelations(['a', 'b', 'c'], ['d'], 2)).toEqual(['c', 'd']);
  });

  it('gecersiz siniri fail-closed reddeder', () => {
    expect(() => mergeFileRelations([], [], 0)).toThrow(/sinir/);
  });

// ÇEKİRDEK REZERVASYONU (docs/06 1. katman "HER ZAMAN").
//
// Eskiden seçim tek bir skor sıralamasıydı: çekirdek yığınların skoru SABİT
// (plan 4, görev 4, gereksinim 3, standart 2), anahtar kelime eşleşmelerinin
// skoru ise ham terim SAYIMI ve sınırsız. "renk" kelimesini dokuz kez içeren
// bir dosya özeti 9 puan alıp planı bütçeden ATABİLİYORDU — sessizce.
describe('sabit çekirdek rezervasyonu', () => {
  const chunk = (over: Partial<Parameters<typeof selectMemoryChunks>[0][number]> & { sourceId: string }) => ({
    sourceTable: 'knowledge' as const,
    sourceId: over.sourceId as never,
    text: over.text ?? 'metin',
    label: over.label ?? `[${over.sourceId}]`,
    score: over.score ?? 1,
    ...(over.required === undefined ? {} : { required: over.required }),
  });

  it('yuksek skorlu gurultu cekirdegi disari itemez', () => {
    const gurultu = chunk({ sourceId: 'noise', score: 99, text: 'x '.repeat(40) });
    const plan = chunk({ sourceId: 'plan', score: 4, required: true, text: 'plan '.repeat(20) });

    const result = selectMemoryChunks([gurultu, plan], 40);
    expect(result.chunks.map((c) => c.sourceId)).toContain('plan');
    expect(result.droppedRequired).toEqual([]);
  });

  it('cekirdek bile sigmazsa SESSIZ kalmaz', () => {
    const kocaman = chunk({ sourceId: 'plan', score: 4, required: true, text: 'kelime '.repeat(500), label: '[plan]' });
    const result = selectMemoryChunks([kocaman], 10);
    expect(result.chunks).toHaveLength(0);
    expect(result.droppedRequired).toEqual(['[plan]']);
  });

  it('cekirdekten sonra kalan yeri opsiyoneller alir', () => {
    const plan = chunk({ sourceId: 'plan', score: 4, required: true, text: 'plan' });
    const ek = chunk({ sourceId: 'ek', score: 9, text: 'ek' });
    const result = selectMemoryChunks([ek, plan], 100);
    expect(result.chunks.map((c) => c.sourceId).sort()).toEqual(['ek', 'plan']);
  });
});
});
