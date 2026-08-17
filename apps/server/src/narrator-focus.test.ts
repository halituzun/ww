import { describe, expect, it } from 'vitest';
import { collapseRepeats, focusEvidence, subjectsOf } from './narrator-focus.js';

const entry = (summary: string, over: Partial<{ taskId: string; raw: string }> = {}) => ({
  source: `event:${summary}`, summary, createdAt: '2026-08-18T00:00:00.000Z', ...over,
});

describe('subjectsOf', () => {
  it('sorudaki dosya yolunu bulur', () => {
    expect(subjectsOf('src/viewmodels/useTodos.ts nasıl oluşturuldu?'))
      .toContain('src/viewmodels/useTodos.ts');
  });

  it('sorudaki gorev kimligini bulur', () => {
    expect(subjectsOf('8248aa61-b756-47b3-8c19-5858dc1ecadd nasıl bitti?'))
      .toContain('8248aa61-b756-47b3-8c19-5858dc1ecadd');
  });

  it('konu yoksa bos doner', () => {
    expect(subjectsOf('bu projede neler oldu?')).toEqual([]);
  });
});

describe('collapseRepeats', () => {
  // ASIL KUSUR: "kurtarma turu tamamlandı" cevabın içinde yedi kez geçiyordu
  // ve gerçek hikâyeyi boğuyordu.
  it('ardisik tekrarlari sayiya cevirir', () => {
    const out = collapseRepeats([entry('kurtarma'), entry('kurtarma'), entry('kurtarma')]);
    expect(out).toHaveLength(1);
    expect(out[0]!.summary).toBe('kurtarma (3 kez)');
  });

  // Tekrar bilgisini SİLMEK, gerçekten tekrarlanan olayı tek seferlik
  // göstermek olurdu.
  it('tekrar bilgisini silmez', () => {
    expect(collapseRepeats([entry('a'), entry('a')])[0]!.summary).toContain('2 kez');
  });

  it('ardisik olmayan tekrari birlestirmez', () => {
    const out = collapseRepeats([entry('a'), entry('b'), entry('a')]);
    expect(out.map((e) => e.summary)).toEqual(['a', 'b', 'a']);
  });

  it('tek ogeyi oldugu gibi birakir', () => {
    expect(collapseRepeats([entry('a')]).map((e) => e.summary)).toEqual(['a']);
  });

  it('bos girdide bos doner', () => {
    expect(collapseRepeats([])).toEqual([]);
  });
});

describe('focusEvidence', () => {
  const evidence = [
    entry('kurtarma turu tamamlandı'),
    entry('dosya kilidi alındı: src/types.ts', { taskId: 't1', raw: 'src/types.ts' }),
    entry('görev working durumuna geçti', { taskId: 't1' }),
    entry('başka projede iş', { taskId: 't2' }),
  ];

  // ASIL KUSUR: sorulan dosya yok sayılıp tüm proje dökülüyordu.
  it('soruda gecen dosyaya degen kanitlari secer', () => {
    const out = focusEvidence(evidence, 'src/types.ts nasıl oluşturuldu?');
    expect(out.map((e) => e.summary)).not.toContain('başka projede iş');
    expect(out.map((e) => e.summary)).not.toContain('kurtarma turu tamamlandı');
  });

  // Dosyaya değen olayın GÖREVİNİN diğer adımları da hikâyenin parçasıdır.
  it('ayni gorevin diger adimlarini da tutar', () => {
    const out = focusEvidence(evidence, 'src/types.ts nasıl oluşturuldu?');
    expect(out.map((e) => e.summary)).toContain('görev working durumuna geçti');
  });

  // Boş cevap vermek "kanıt yok" ile "seçemedim"i karıştırmak olurdu.
  it('hicbir sey eslesmezse tumunu doner', () => {
    const out = focusEvidence(evidence, 'src/olmayan.ts nasıl oluşturuldu?');
    expect(out.length).toBeGreaterThan(0);
  });

  it('konu yoksa tumunu sikistirarak doner', () => {
    const out = focusEvidence([entry('a'), entry('a'), entry('b')], 'neler oldu?');
    expect(out.map((e) => e.summary)).toEqual(['a (2 kez)', 'b']);
  });
});
