import { describe, expect, it } from 'vitest';
import { buildTaskSummary } from './task-summary.js';

const base = {
  title: 'Satranç tahtası bileşeni',
  resultSummary: 'tahta çizimi eklendi',
  commitHash: 'affa20b2f8c54b812b51852f8f6742871809bb93',
  targetFiles: ['src/Board.tsx', 'src/viewmodels/useBoard.ts'],
  attempts: 2,
};

describe('buildTaskSummary (docs/06 özet katmanı)', () => {
  it('gorev basligini ve sonucunu tasir', () => {
    const text = buildTaskSummary(base);
    expect(text).toContain('Satranç tahtası bileşeni');
    expect(text).toContain('tahta çizimi eklendi');
  });

  // Commit KISALTILIR: tam hash özet metnini şişirir ve okunurluğu düşürür,
  // ama izlenebilirlik için ilk 7 karakter yeterlidir (git kuralı).
  it('commiti kisaltarak yazar', () => {
    expect(buildTaskSummary(base)).toContain('affa20b');
    expect(buildTaskSummary(base)).not.toContain(base.commitHash);
  });

  it('dokunulan dosyalari sayar', () => {
    expect(buildTaskSummary(base)).toContain('src/Board.tsx');
    expect(buildTaskSummary(base)).toContain('src/viewmodels/useBoard.ts');
  });

  // Kaç denemede bittiği BAĞLAM taşır: sonraki agent "bu iş zordu" bilgisini
  // ancak böyle görür.
  it('deneme sayisini bildirir', () => {
    expect(buildTaskSummary(base)).toMatch(/2\. denemede/);
    expect(buildTaskSummary({ ...base, attempts: 1 })).toMatch(/ilk denemede/);
  });

  // Boş sonuç özeti UYDURULMAZ: olmayan bir sonucu varmış gibi yazmak,
  // hafıza katmanını yanlış bilgiyle doldurur.
  it('bos sonuc ozetini uydurmaz', () => {
    const text = buildTaskSummary({ ...base, resultSummary: '   ' });
    expect(text).toContain('(worker sonuç özeti bırakmadı)');
  });

  it('hedef dosyasi yoksa acikca soyler', () => {
    expect(buildTaskSummary({ ...base, targetFiles: [] })).toContain('(dosya bildirilmedi)');
  });
});
