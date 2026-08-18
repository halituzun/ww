import { describe, expect, it } from 'vitest';
import { compareCursors, parseCursor } from './cursor-order.js';

describe('imleç sıralaması', () => {
  // Metinsel karşılaştırma "9" > "10" der; bu deponun plan sürümlerinde
  // yaşadığı kusurun aynısı.
  it('SAYISAL siralar, metinsel degil', () => {
    expect(compareCursors('9', '10')).toBeLessThan(0);
    expect(compareCursors('10', '9')).toBeGreaterThan(0);
    expect(compareCursors('10', '10')).toBe(0);
  });

  // 2^53 üstünde Number'a düşmek iki farklı olayı EŞİT yapardı; canlı veride
  // olayların %65'i o sınırın üstünde.
  it('2^53 ustundeki komsu degerleri ayirt eder', () => {
    expect(compareCursors('1152376219910902321', '1152376219910902322')).toBeLessThan(0);
  });

  it('gecersiz imleci sessizce 0 saymaz', () => {
    expect(() => parseCursor('bozuk')).toThrow(/geçersiz imleç/);
  });
});
