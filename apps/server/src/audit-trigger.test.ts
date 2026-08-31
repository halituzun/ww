import { describe, expect, it } from 'vitest';
import { DEFAULT_AUDIT_INTERVAL, shouldRunStandardsAudit } from './audit-trigger.js';

describe('shouldRunStandardsAudit (docs/09: "her N görev tamamlanışında, varsayılan 5")', () => {
  it('varsayilan aralik 5tir', () => {
    expect(DEFAULT_AUDIT_INTERVAL).toBe(5);
  });

  it('her Nnci tamamlanmada tetikler', () => {
    const hits = [1, 2, 3, 4, 5, 6, 9, 10].filter((n) => shouldRunStandardsAudit(n));
    expect(hits).toEqual([5, 10]);
  });

  // Sıfırıncı tamamlanma diye bir şey yok: 0 % 5 === 0 saf modülo ile
  // "tetikle" derdi ve hiç iş bitmeden denetim koşardı.
  it('hic gorev bitmediyse tetiklemez', () => {
    expect(shouldRunStandardsAudit(0)).toBe(false);
  });

  it('gecersiz sayimda tetiklemez', () => {
    expect(shouldRunStandardsAudit(-3)).toBe(false);
    expect(shouldRunStandardsAudit(1.5)).toBe(false);
    expect(shouldRunStandardsAudit(Number.NaN)).toBe(false);
  });

  it('aralik ayarlanabilir', () => {
    expect(shouldRunStandardsAudit(3, 3)).toBe(true);
    expect(shouldRunStandardsAudit(4, 3)).toBe(false);
  });

  // Bozuk aralık denetimi SESSİZCE kapatmamalı; varsayılana düşer.
  it('gecersiz aralikta varsayilana duser', () => {
    expect(shouldRunStandardsAudit(5, 0)).toBe(true);
    expect(shouldRunStandardsAudit(5, -1)).toBe(true);
    expect(shouldRunStandardsAudit(4, 0)).toBe(false);
  });
});
