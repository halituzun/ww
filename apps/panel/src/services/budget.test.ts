import { describe, expect, it, vi } from 'vitest';
import { fetchBudgetReport, formatUsd, budgetTone } from './budget.js';
import { DEFAULT_API_BASE } from './http.js';

const jsonResponse = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' }, ...init });

const report = {
  projectId: 'p1',
  totals: { costUsd: 3.5, promptTokens: 1700, completionTokens: 800, calls: 3, errors: 1 },
  daily: [{ day: '2026-08-16', costUsd: 2, calls: 2 }],
  byModel: [{ providerId: 'deepseek', model: 'deepseek-chat', costUsd: 3, calls: 2 }],
  topTasks: [{ taskId: 't1', costUsd: 3, calls: 2 }],
  budget: { state: 'ok', ratio: 0.35, spentUsd: 3.5, limitUsd: 10 },
  windowDays: 30,
};

describe('fetchBudgetReport', () => {
  it('proje kapsamlı raporu çeker', async () => {
    const mock = vi.fn(async () => jsonResponse(report));
    await expect(fetchBudgetReport('p1', { fetchImpl: mock as unknown as typeof fetch }))
      .resolves.toEqual(report);
    expect((mock.mock.calls[0] as unknown as [string])[0])
      .toBe(`${DEFAULT_API_BASE}/projects/p1/budget`);
  });

  // DEĞİŞTİ: eskiden okuma hatasında BOŞ RAPOR dönüyordu ve panel
  // "0 harcandı" gösteriyordu. Para söz konusuyken bu tehlikeli bir yalan:
  // kullanıcı hiçbir şey çalışmıyor sanar. Veri gelmemesiyle sıfır harcama
  // aynı şey değildir; hata çağırana bildirilir ve panelde görünür.
  it('okuma hatasini YUTMAZ, cagirana bildirir', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bozuk', { status: 500 })));
    await expect(fetchBudgetReport('p1')).rejects.toBeTruthy();
  });

  it('proje kimliğini URL için kodlar', async () => {
    const mock = vi.fn(async () => jsonResponse(report));
    await fetchBudgetReport('a/b', { fetchImpl: mock as unknown as typeof fetch });
    expect((mock.mock.calls[0] as unknown as [string])[0]).toContain('/projects/a%2Fb/budget');
  });
});

describe('formatUsd', () => {
  it('küçük tutarlarda kuruş hassasiyetini korur', () => {
    expect(formatUsd(0.0042)).toBe('$0.0042');
    expect(formatUsd(0)).toBe('$0.00');
  });

  it('büyük tutarları iki basamağa yuvarlar', () => {
    expect(formatUsd(12.3456)).toBe('$12.35');
  });
});

describe('budgetTone', () => {
  // Durum rengi + metin birlikte gider; renk tek başına anlam taşımaz.
  it('bütçe durumunu okunabilir etiket ve duruma çevirir', () => {
    expect(budgetTone('ok')).toMatchObject({ tone: 'good', label: expect.any(String) });
    expect(budgetTone('warning').tone).toBe('warning');
    expect(budgetTone('exceeded').tone).toBe('critical');
    expect(budgetTone('unlimited').tone).toBe('neutral');
  });

  it('etiketler boş değildir', () => {
    for (const state of ['ok', 'warning', 'exceeded', 'unlimited'] as const) {
      expect(budgetTone(state).label.length).toBeGreaterThan(0);
    }
  });
});
