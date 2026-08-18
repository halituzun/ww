import { describe, expect, it } from 'vitest';
import { compareCursors, highestCursor } from './cursor-order.js';

// Sunucu imleci (created_at, event_id) ikilisinden kodlar; sözlük sırası
// zaman sırasıyla aynıdır. Panel onu AYRIŞTIRMAZ, yalnız karşılaştırır.
const cursor = (ts: string, id = '00000000-0000-4000-8000-000000000001') => `${ts}|${id}`;

describe('imleç sıralaması', () => {
  it('zaman sirasina gore siralar', () => {
    expect(compareCursors(
      cursor('2026-08-18 09:00:00.000'), cursor('2026-08-18 09:00:01.000'),
    )).toBeLessThan(0);
  });

  it('ayni imlec esittir', () => {
    expect(compareCursors(cursor('2026-08-18 09:00:00.000'), cursor('2026-08-18 09:00:00.000')))
      .toBe(0);
  });

  // ÖNCEKİ KUSUR: imleç sayıya çevriliyordu ve 2^53 üstünde kırpılıyordu;
  // canlı veride olayların %65'i o sınırın üstündeydi. Metin karşılaştırması
  // bu sınıra hiç girmez.
  it('bos imlec her seyden kucuktur', () => {
    expect(compareCursors('', cursor('2026-08-18 09:00:00.000'))).toBeLessThan(0);
  });

  it('en buyuk imleci bulur ve bos degerleri atlar', () => {
    expect(highestCursor([
      cursor('2026-08-18 09:00:00.000'), '', cursor('2026-08-18 09:00:05.000'),
      cursor('2026-08-18 09:00:02.000'),
    ])).toBe(cursor('2026-08-18 09:00:05.000'));
  });

  it('hic olay yoksa bos doner: bastan basla demektir', () => {
    expect(highestCursor([])).toBe('');
  });
});
