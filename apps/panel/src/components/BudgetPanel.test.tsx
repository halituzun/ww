// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { BudgetPanel } from './BudgetPanel.js';
import { EMPTY_BUDGET_REPORT, type BudgetReport } from '../services/budget.js';

afterEach(cleanup);

const report = (over: Partial<BudgetReport> = {}): BudgetReport => ({
  ...EMPTY_BUDGET_REPORT, projectId: 'p1', ...over,
});

const mount = (load: () => Promise<BudgetReport>) => render(
  <BudgetPanel projectId="p1" ports={{ fetchReport: vi.fn(load), pollMs: 60_000 }} />,
);

describe('BudgetPanel', () => {
  it('harcamayi gosterir', async () => {
    mount(async () => report({
      totals: { costUsd: 5.47, promptTokens: 10, completionTokens: 5, calls: 3, errors: 0 },
      budget: { state: 'warning', ratio: 0.55, spentUsd: 5.47, limitUsd: 10 },
    }));
    // Tutar birden çok yerde geçer (toplam + bütçe kutusu); VARLIĞI aranır.
    await waitFor(() => expect(screen.getAllByText(/5\.47/).length).toBeGreaterThan(0));
  });

  // ASIL RİSK: rapor alınamadığında panel "0 harcandı" gösteriyordu. Para söz
  // konusuyken bu tehlikeli bir yalandır: kullanıcı hiçbir şey çalışmıyor
  // sanır. Veri gelmemesiyle sıfır harcama aynı şey DEĞİLDİR.
  it('rapor alinamazsa hatayi soyler, sifir harcama gibi davranmaz', async () => {
    mount(async () => { throw new Error('kontör raporu alınamadı'); });
    await waitFor(() => expect(screen.getByText(/kontör raporu alınamadı/)).toBeTruthy());
  });

  it('limit asildiginda uyari tonu kullanir', async () => {
    const { container } = mount(async () => report({
      budget: { state: 'exceeded', ratio: 1.2, spentUsd: 12, limitUsd: 10 },
    }));
    await waitFor(() => expect(container.textContent).toContain('12'));
    // Aşım kullanıcıya YALNIZ renkle değil, metinle de bildirilir.
    expect(container.textContent).toMatch(/aşıldı|aşım|limit/i);
  });
});
