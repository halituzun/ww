// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
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

describe('useBudgetViewModel — bütçe düzenleme', () => {
  const ports = (over: Record<string, unknown> = {}) => ({
    fetchReport: vi.fn(async () => report()),
    saveLimit: vi.fn(async () => ({ limitUsd: 5, spentUsd: 1.5, alreadyExceeded: false })),
    pollMs: 1_000_000,
    ...over,
  });

  // docs/08 "bütçe düzenleme": limit yalnızca proje oluşturulurken
  // verilebiliyordu; sınırsız açılmış projeye fren kurulamıyordu.
  it('limiti servise gonderir', async () => {
    const p = ports();
    const { result } = renderHook(() => useBudgetViewModel('p1', p as never));

    act(() => { result.current.setLimitDraft('5'); });
    await act(async () => { await result.current.saveLimit(); });

    expect(p.saveLimit).toHaveBeenCalledWith('p1', 5);
    expect(result.current.limitNote).toMatch(/kaydedildi/);
  });

  // Boş/geçersiz girdiyi 0'a (SINIRSIZ) çevirmek, kullanıcının koyduğunu
  // sandığı freni sessizce kaldırırdı.
  it('gecersiz limiti gondermez', async () => {
    const p = ports();
    const { result } = renderHook(() => useBudgetViewModel('p1', p as never));

    act(() => { result.current.setLimitDraft('abc'); });
    await act(async () => { await result.current.saveLimit(); });

    expect(p.saveLimit).not.toHaveBeenCalled();
    expect(result.current.limitError).toMatch(/sayı olmalıdır/);
  });

  // Sonucu söylemezsek kullanıcı projenin neden durduğunu aramak zorunda kalır.
  it('limit harcamanin altindaysa acikca uyarir', async () => {
    const p = ports({
      saveLimit: vi.fn(async () => ({ limitUsd: 0.001, spentUsd: 1.5, alreadyExceeded: true })),
    });
    const { result } = renderHook(() => useBudgetViewModel('p1', p as never));

    act(() => { result.current.setLimitDraft('0.001'); });
    await act(async () => { await result.current.saveLimit(); });

    expect(result.current.limitNote).toMatch(/proje duracak/);
  });

  it('servis hatasini yutmaz', async () => {
    const p = ports({ saveLimit: vi.fn(async () => { throw new Error('sunucu düştü'); }) });
    const { result } = renderHook(() => useBudgetViewModel('p1', p as never));

    act(() => { result.current.setLimitDraft('5'); });
    await act(async () => { await result.current.saveLimit(); });

    expect(result.current.limitError).toMatch(/sunucu düştü/);
  });
});
