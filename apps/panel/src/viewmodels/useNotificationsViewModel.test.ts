// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { NotificationSignals } from '../services/notifications.js';
import { useNotificationsViewModel } from './useNotificationsViewModel.js';

afterEach(cleanup);

// Kapalı sağlayıcı kritik bildirim üretir; bütçe uyarısı ise uyarı tonundadır.
const criticalSignals: NotificationSignals = {
  providers: [{ provider_id: 'deepseek', health_status: 'down', enabled: true }],
};

const ports = (over: Parameters<typeof useNotificationsViewModel>[1] = {}) => ({
  announce: vi.fn(),
  loadSeenIds: () => new Set<string>(),
  saveSeenIds: vi.fn(),
  ...over,
});

describe('useNotificationsViewModel', () => {
  it('sinyallerden bildirim turetir', () => {
    const { result } = renderHook(() =>
      useNotificationsViewModel(criticalSignals, ports() as never));
    expect(result.current.notifications.length).toBeGreaterThan(0);
    expect(result.current.unseen).toBe(result.current.notifications.length);
  });

  it('bildirim yoksa sayaci sifirdir', () => {
    const { result } = renderHook(() => useNotificationsViewModel({}, ports() as never));
    expect(result.current.notifications).toHaveLength(0);
    expect(result.current.unseen).toBe(0);
  });

  // Kritik olmayan her olayı duyurmak paneli gürültüye boğuyordu.
  it('yalniz kritik bildirimi duyurur', () => {
    const announce = vi.fn();
    const p = ports({ announce });
    renderHook(() => useNotificationsViewModel(criticalSignals, p as never));
    for (const call of announce.mock.calls) {
      expect((call[0] as { tone: string }).tone).toBe('critical');
    }
    expect(announce).toHaveBeenCalled();
  });

  // Aynı bildirimi her çizimde yeniden duyurmak, kullanıcıyı bildirimle bombalar.
  it('ayni bildirimi iki kez duyurmaz', () => {
    const announce = vi.fn();
    const p = ports({ announce });
    const { rerender } = renderHook(() =>
      useNotificationsViewModel(criticalSignals, p as never));
    const first = announce.mock.calls.length;
    rerender();
    rerender();
    expect(announce.mock.calls.length).toBe(first);
  });

  // Görüldü işareti KALICI olmalı: yoksa panel her açılışta aynı uyarıyı gösterir.
  it('gorulduyu kalici olarak yazar', () => {
    const saveSeenIds = vi.fn();
    const p = ports({ saveSeenIds });
    const { result } = renderHook(() =>
      useNotificationsViewModel(criticalSignals, p as never));

    act(() => { result.current.markAllSeen(); });
    expect(saveSeenIds).toHaveBeenCalledTimes(1);
    expect(result.current.unseen).toBe(0);
  });

  // Daha önce görülmüş bildirim yeniden duyurulmamalı.
  it('onceden gorulmus bildirimi duyurmaz', () => {
    const seen = new Set<string>();
    const probe = renderHook(() =>
      useNotificationsViewModel(criticalSignals, ports() as never));
    for (const notification of probe.result.current.notifications) seen.add(notification.id);
    probe.unmount();

    const announce = vi.fn();
    renderHook(() => useNotificationsViewModel(
      criticalSignals, ports({ loadSeenIds: () => seen, announce }) as never));
    expect(announce).not.toHaveBeenCalled();
  });

  it('menu acilis durumunu tutar', () => {
    const { result } = renderHook(() =>
      useNotificationsViewModel(criticalSignals, ports() as never));
    expect(result.current.open).toBe(false);
    act(() => { result.current.setOpen(true); });
    expect(result.current.open).toBe(true);
  });
});
