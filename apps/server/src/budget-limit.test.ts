import { describe, expect, it } from 'vitest';
import { BudgetLimitError, decideBudgetLimit, parseBudgetLimit } from './budget-limit.js';

describe('parseBudgetLimit', () => {
  it('gecerli limiti kabul eder', () => {
    expect(parseBudgetLimit(12.5)).toBe(12.5);
  });

  // Sıfır "sınırsız" demektir ve geçerli bir seçimdir.
  it('sifiri sinirsiz olarak kabul eder', () => {
    expect(parseBudgetLimit(0)).toBe(0);
  });

  // Sessiz çevirim, kullanıcının koyduğunu sandığı freni yok ederdi.
  it('gecersiz degeri sessizce sifira cevirmez', () => {
    expect(() => parseBudgetLimit('5')).toThrow(BudgetLimitError);
    expect(() => parseBudgetLimit(Number.NaN)).toThrow(BudgetLimitError);
    expect(() => parseBudgetLimit(undefined)).toThrow(BudgetLimitError);
  });

  it('negatif limiti reddeder', () => {
    expect(() => parseBudgetLimit(-1)).toThrow(/negatif/);
  });

  it('asiri yuksek limiti reddeder', () => {
    expect(() => parseBudgetLimit(2_000_000)).toThrow(/çok yüksek/);
  });

  // Kuruş altı hassasiyet "limit aşıldı mı" sorusunu belirsizleştirir.
  it('dort ondaliga yuvarlar', () => {
    expect(parseBudgetLimit(1.234567)).toBe(1.2346);
  });
});

describe('decideBudgetLimit', () => {
  it('limit harcamanin ustundeyse asilmis saymaz', () => {
    expect(decideBudgetLimit(10, 4).alreadyExceeded).toBe(false);
  });

  // Kullanıcı kasıtlı olarak durdurmak isteyebilir, ama sonucu SÖYLENMELİ.
  it('limit mevcut harcamanin altindaysa bunu bildirir', () => {
    expect(decideBudgetLimit(1, 4).alreadyExceeded).toBe(true);
  });

  it('sinirsizda asilmis saymaz', () => {
    expect(decideBudgetLimit(0, 999).alreadyExceeded).toBe(false);
  });

  it('bozuk harcamayi sifir sayar', () => {
    expect(decideBudgetLimit(5, Number.NaN).alreadyExceeded).toBe(false);
  });
});

describe('checkTaskTokenBudget — C3 Token Bütçesi Guard', () => {
  it('token limiti asilmadiginda izin verir', async () => {
    const { checkTaskTokenBudget } = await import('./budget-limit.js');
    const res = checkTaskTokenBudget(1000, 2000, 32000);
    expect(res.allowed).toBe(true);
    expect(res.totalTokens).toBe(3000);
  });

  it('token limiti asildiginda reddeder ve neden bildirir', async () => {
    const { checkTaskTokenBudget } = await import('./budget-limit.js');
    const res = checkTaskTokenBudget(20000, 15000, 32000);
    expect(res.allowed).toBe(false);
    expect(res.reason).toContain('Görev token bütçesi aşıldı');
  });
});
