// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { EMPTY_BUDGET_REPORT, type BudgetReport } from '../services/budget.js';
import { useBudgetViewModel } from './useBudgetViewModel.js';

afterEach(cleanup);

const report = (): BudgetReport => ({
  ...EMPTY_BUDGET_REPORT,
  totals: { ...EMPTY_BUDGET_REPORT.totals, costUsd: 4.2 },
});

describe('useBudgetViewModel', () => {
  it('raporu servisten yukler', async () => {
    const fetchReport = vi.fn(async () => report());
    const { result } = renderHook(() =>
      useBudgetViewModel('p1', { fetchReport, pollMs: 1_000_000 } as never));

    await waitFor(() => expect(result.current.report.totals.costUsd).toBe(4.2));
    expect(fetchReport).toHaveBeenCalledWith('p1');
  });

  it('proje secili degilken istek atmaz', () => {
    const fetchReport = vi.fn(async () => report());
    renderHook(() => useBudgetViewModel('', { fetchReport } as never));
    expect(fetchReport).not.toHaveBeenCalled();
  });

  // Kontör panosu canlıdır: yoklama durursa kullanıcı eski maliyeti gerçek sanır.
  it('belirlenen aralikta yoklamaya devam eder', async () => {
    const fetchReport = vi.fn(async () => report());
    renderHook(() => useBudgetViewModel('p1', { fetchReport, pollMs: 10 } as never));
    await waitFor(() => expect(fetchReport.mock.calls.length).toBeGreaterThan(1));
  });

  it('sokulunce yoklamayi durdurur', async () => {
    const fetchReport = vi.fn(async () => report());
    const { unmount } = renderHook(() =>
      useBudgetViewModel('p1', { fetchReport, pollMs: 10 } as never));
    await waitFor(() => expect(fetchReport).toHaveBeenCalled());
    unmount();
    const after = fetchReport.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(fetchReport.mock.calls.length).toBe(after);
  });
});
