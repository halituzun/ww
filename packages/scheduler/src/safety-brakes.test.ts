import { describe, expect, it } from 'vitest';
import { BrakeError, assertCostBudget, assertLoopSimilarity, assertTokenBudget, assertWallClock } from './safety-brakes.js';

describe('scheduler safety brakes', () => {
  it('enforces token and cost budgets', () => {
    expect(() => assertTokenBudget({ spent: 9, requested: 2, budget: 10 })).toThrow(BrakeError);
    expect(() => assertCostBudget({ spentUsd: 1, requestedUsd: 0.2, budgetUsd: 1 })).toThrow(BrakeError);
  });
  it('stops wall clock overruns and repeated loops', () => {
    expect(() => assertWallClock({ startedAtMs: 0, nowMs: 11, deadlineAtMs: 10 })).toThrow(BrakeError);
    expect(() => assertLoopSimilarity(['same answer', 'same answer', 'same answer'])).toThrow(BrakeError);
    expect(() => assertLoopSimilarity(['one', 'two', 'three'])).not.toThrow();
  });

  // ASIL KUSUR: duvar saati, görevin kullanıcı cevabı BEKLEYEREK geçirdiği
  // süreyi de sayıyordu. docs/07 bu freni "sonsuz sürünme önleme" diye
  // tanımlar — yani İŞİN süresi. Canlıda görev bir saat cevap bekledi,
  // cevap gelince ilk turda fren attı: soru sorma özelliği kendi kendini
  // öldürür hale gelmişti.
  it('kullanici cevabi beklenen sureyi duvar saatinden duser', () => {
    expect(() => assertWallClock({
      startedAtMs: 0, nowMs: 100, deadlineAtMs: 10, pausedMs: 95,
    })).not.toThrow();
  });

  it('duraklama dususunden sonra hala asiliyorsa fren atar', () => {
    expect(() => assertWallClock({
      startedAtMs: 0, nowMs: 100, deadlineAtMs: 10, pausedMs: 80,
    })).toThrow(BrakeError);
  });

  // Duraklama süresi tavanı sınırsız yapmamalı: bozuk/negatif değer
  // sessizce "hiç beklemedi" sayılır, freni devre dışı bırakamaz.
  it('gecersiz duraklama suresi freni devre disi birakmaz', () => {
    for (const pausedMs of [-5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => assertWallClock({
        startedAtMs: 0, nowMs: 100, deadlineAtMs: 10, pausedMs,
      })).toThrow(BrakeError);
    }
  });

  it('duraklama verilmezse eski davranisi korur', () => {
    expect(() => assertWallClock({ startedAtMs: 0, nowMs: 5, deadlineAtMs: 10 })).not.toThrow();
    expect(() => assertWallClock({ startedAtMs: 0, nowMs: 11, deadlineAtMs: 10 })).toThrow(BrakeError);
  });
});
