// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { EMPTY_AUDIT_REPORT, type AuditReport } from '../services/audit.js';
import { useAuditViewModel } from './useAuditViewModel.js';

afterEach(cleanup);

const report = (over: Partial<AuditReport> = {}): AuditReport => ({
  ...EMPTY_AUDIT_REPORT,
  counts: { ...EMPTY_AUDIT_REPORT.counts, open: 2, correction_pending: 1, resolved: 4 },
  ...over,
});

const ports = (over: Parameters<typeof useAuditViewModel>[1] = {}) => ({
  fetchReport: vi.fn(async () => report()),
  resolve: vi.fn(async () => undefined),
  pollMs: 1_000_000,
  ...over,
});

describe('useAuditViewModel', () => {
  it('acilista raporu servisten yukler', async () => {
    const p = ports();
    const { result } = renderHook(() => useAuditViewModel('p1', p as never));

    await waitFor(() => expect(result.current.report.counts.resolved).toBe(4));
    expect(p.fetchReport).toHaveBeenCalledWith('p1');
  });

  it('acik bulgu sayisini duzeltme bekleyenlerle birlikte sayar', async () => {
    const { result } = renderHook(() => useAuditViewModel('p1', ports() as never));
    await waitFor(() => expect(result.current.openCount).toBe(3));
  });

  // Proje seçilmeden istek atmak, panel açılışında anlamsız 404 üretiyordu.
  it('proje secili degilken istek atmaz', () => {
    const p = ports();
    renderHook(() => useAuditViewModel('', p as never));
    expect(p.fetchReport).not.toHaveBeenCalled();
  });

  // Gerekçesiz kapatmayı sunucu da reddeder; kullanıcıya burada söylenir.
  it('gerekcesiz kapatmayi engeller ve servise gitmez', async () => {
    const p = ports();
    const { result } = renderHook(() => useAuditViewModel('p1', p as never));

    await act(async () => { await result.current.decide('f1', 'resolved'); });
    expect(p.resolve).not.toHaveBeenCalled();
    expect(result.current.error).toMatch(/gerekçe/i);
  });

  it('gerekce girilince karari servise iletir', async () => {
    const p = ports();
    const { result } = renderHook(() => useAuditViewModel('p1', p as never));

    act(() => { result.current.setNote('f1', 'yanlis alarm'); });
    await act(async () => { await result.current.decide('f1', 'dismissed'); });

    expect(p.resolve).toHaveBeenCalledWith('p1', 'f1', {
      status: 'dismissed', resolution: 'yanlis alarm',
    });
  });

  // ASIL RİSK: hata yutulursa kullanıcı bulguyu kapattığını sanır.
  it('servis hatasini yutmaz', async () => {
    const p = ports({ resolve: vi.fn(async () => { throw new Error('sunucu düştü'); }) });
    const { result } = renderHook(() => useAuditViewModel('p1', p as never));

    act(() => { result.current.setNote('f1', 'gerekce'); });
    await act(async () => { await result.current.decide('f1', 'resolved'); });

    expect(result.current.error).toMatch(/sunucu düştü/);
  });

  it('basarili karardan sonra raporu tazeler', async () => {
    const p = ports();
    const { result } = renderHook(() => useAuditViewModel('p1', p as never));
    await waitFor(() => expect(p.fetchReport).toHaveBeenCalledTimes(1));

    act(() => { result.current.setNote('f1', 'gerekce'); });
    await act(async () => { await result.current.decide('f1', 'resolved'); });

    expect(p.fetchReport).toHaveBeenCalledTimes(2);
    expect(result.current.error).toBe('');
  });

  // Sökülen bileşenin zamanlayıcısı çalışmaya devam ederse panel kapandıktan
  // sonra da istek atar ve React uyarısı üretir.
  it('sokulunce yoklamayi durdurur', async () => {
    const fetchReport = vi.fn(async () => report());
    const p = ports({ pollMs: 10, fetchReport });
    const { unmount } = renderHook(() => useAuditViewModel('p1', p as never));
    await waitFor(() => expect(fetchReport).toHaveBeenCalled());
    unmount();
    const afterUnmount = fetchReport.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(fetchReport.mock.calls.length).toBe(afterUnmount);
  });
});
