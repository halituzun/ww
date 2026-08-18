// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { useMobilePreviewViewModel } from './useMobilePreviewViewModel.js';

afterEach(cleanup);

const targets = { avds: ['Pixel_8'], devices: ['127.0.0.1:26624'] };

const ports = (over: Record<string, unknown> = {}) => ({
  fetchTargets: vi.fn(async () => targets),
  openSession: vi.fn(async () => ({ sessionId: 's1', avd: '127.0.0.1:26624' })),
  fetchFrame: vi.fn(async () => ({ sessionId: 's1', pngBase64: 'AAA' })),
  stopSession: vi.fn(async () => ({ stopped: 's1' })),
  pollMs: 60_000,
  ...over,
} as never);

describe('useMobilePreviewViewModel', () => {
  it('hedefleri yukler', async () => {
    const { result } = renderHook(() => useMobilePreviewViewModel(ports()));
    await waitFor(() => expect(result.current.targets.devices).toEqual(['127.0.0.1:26624']));
  });

  // Hedef bulunamadığında sunucu SEBEBİYLE 503 döner ("Android SDK kurulu
  // mu?"). O sebebi göstermek, kullanıcının neyi kuracağını bilmesini sağlar;
  // boş liste göstermek onu karanlıkta bırakır.
  it('hedef yoksa sunucunun SEBEBINI gosterir', async () => {
    const { result } = renderHook(() => useMobilePreviewViewModel(ports({
      fetchTargets: vi.fn(async () => { throw new Error('emülatör araçları bulunamadı'); }),
    })));
    await waitFor(() => expect(result.current.error).toContain('emülatör araçları bulunamadı'));
  });

  it('oturum acar ve kareyi ceker', async () => {
    const injected = ports();
    const { result } = renderHook(() => useMobilePreviewViewModel(injected));
    await waitFor(() => expect(result.current.targets.devices.length).toBe(1));

    await result.current.open('127.0.0.1:26624');
    await waitFor(() => expect(result.current.frameDataUrl).toContain('data:image/png;base64,AAA'));
  });

  // Oturum kapatılınca kare TEMİZLENİR: eski kareyi göstermeye devam etmek
  // "hâlâ canlı" yalanını söyler.
  it('durdurunca kareyi temizler', async () => {
    const { result } = renderHook(() => useMobilePreviewViewModel(ports()));
    await waitFor(() => expect(result.current.targets.devices.length).toBe(1));
    await result.current.open('127.0.0.1:26624');
    await waitFor(() => expect(result.current.frameDataUrl).not.toBe(''));

    await result.current.stop();
    await waitFor(() => expect(result.current.frameDataUrl).toBe(''));
  });
});
