import { describe, expect, it } from 'vitest';
import {
  MIN_CONTEXT_TOKENS,
  contextTokenBudget,
  describeTaskBudget,
  effectiveTaskBudget,
} from './context-budget.js';

/**
 * ÜRETİM DEĞERİNİN MÜHÜRÜ.
 *
 * Eski hesap `max(500, floor((tokenBudget ?? 4000) / 4))` idi ve üretimde HER
 * görev için 500'e çöküyordu: `tasks.token_budget` şeması DEFAULT 0 ve her
 * üretim yolu sıfır yazıyor; `0` nullish olmadığı için `?? 4000` hiç devreye
 * girmiyordu. Hiçbir test bunu yakalamıyordu çünkü entegrasyon testleri
 * açıkça 4_000/8_000 veriyor — üretim değerini koşan test yoktu.
 */
describe('görev bağlam bütçesi', () => {
  it('SIFIR bütçede 500 token a ÇÖKMEZ', () => {
    // Üretimde gelen gerçek değer budur.
    expect(contextTokenBudget(0, 'worker')).toBeGreaterThan(500);
    expect(contextTokenBudget(0, 'worker')).toBeGreaterThanOrEqual(MIN_CONTEXT_TOKENS);
  });

  it('sıfır "belirtilmedi" demektir, sınırsız değil', () => {
    expect(effectiveTaskBudget(0, 'worker')).toBe(24_000);
    expect(describeTaskBudget(0)).toContain('varsayılan');
    expect(describeTaskBudget(0)).not.toContain('sınırsız');
  });

  it('rol başına varsayılan uygular (docs/06: worker 24k)', () => {
    expect(effectiveTaskBudget(undefined, 'worker')).toBe(24_000);
    expect(effectiveTaskBudget(undefined, 'verifier')).toBe(16_000);
    // Bilinmeyen rol sessizce sıfırlanmaz.
    expect(effectiveTaskBudget(undefined, 'creator')).toBeGreaterThan(0);
  });

  it('açık bütçeye saygı duyar', () => {
    expect(effectiveTaskBudget(9_000, 'worker')).toBe(9_000);
    expect(describeTaskBudget(9_000)).toBe('9000');
  });

  it('bağlam payı görevin tamamını yemez', () => {
    const budget = 24_000;
    const context = contextTokenBudget(budget, 'worker');
    expect(context).toBeLessThan(budget);
    // Ama alt sınırın da altına inmez: sabit çekirdek buna sığmalı.
    expect(context).toBeGreaterThanOrEqual(MIN_CONTEXT_TOKENS);
  });

  it('çok küçük bütçede bile alt sınırı korur', () => {
    expect(contextTokenBudget(100, 'worker')).toBe(MIN_CONTEXT_TOKENS);
  });
});
