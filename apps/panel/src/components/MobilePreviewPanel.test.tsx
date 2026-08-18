// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MobilePreviewPanel } from './MobilePreviewPanel.js';

afterEach(cleanup);

const ports = (over: Record<string, unknown> = {}) => ({
  fetchTargets: vi.fn(async () => ({ avds: ['Pixel_8'], devices: ['127.0.0.1:26624'] })),
  openSession: vi.fn(async () => ({ sessionId: 's1', avd: '127.0.0.1:26624' })),
  fetchFrame: vi.fn(async () => ({ sessionId: 's1', pngBase64: 'AAA' })),
  stopSession: vi.fn(async () => ({ stopped: 's1' })),
  pollMs: 60_000,
  ...over,
} as never);

describe('MobilePreviewPanel', () => {
  it('bagli cihazlari ve AVDleri listeler', async () => {
    render(<MobilePreviewPanel ports={ports()} />);
    await waitFor(() => expect(screen.getByText('127.0.0.1:26624')).toBeTruthy());
    expect(screen.getByText('Pixel_8')).toBeTruthy();
  });

  it('acinca ekran goruntusunu ALT metniyle gosterir', async () => {
    render(<MobilePreviewPanel ports={ports()} />);
    await waitFor(() => expect(screen.getByText('127.0.0.1:26624')).toBeTruthy());
    fireEvent.click(screen.getAllByText('Aç')[0]!);
    await waitFor(() => expect(screen.getByAltText('Cihaz ekranı')).toBeTruthy());
  });

  // Sunucu "Android SDK kurulu mu?" diyor; o sebep gösterilmezse kullanıcı
  // neyi kuracağını bilemez.
  it('hedef yoksa sunucunun sebebini gosterir', async () => {
    render(<MobilePreviewPanel ports={ports({
      fetchTargets: vi.fn(async () => { throw new Error('emülatör araçları bulunamadı (Android SDK kurulu mu?)'); }),
    })} />);
    await waitFor(() => expect(screen.getByRole('alert').textContent)
      .toContain('Android SDK kurulu mu'));
  });

  it('hata yokken ve hedef yokken bos durumu soyler', async () => {
    render(<MobilePreviewPanel ports={ports({
      fetchTargets: vi.fn(async () => ({ avds: [], devices: [] })),
    })} />);
    await waitFor(() => expect(screen.getByText(/bulunamadı/i)).toBeTruthy());
  });

  // docs/11 Faz 6 "temel etkileşim". Dokunuş CİHAZ koordinatına çevrilmeli;
  // ölçek atlanırsa dokunuş yanlış yere gider — bir şey olur ama beklenen
  // şey olmaz.
  it('karede tiklaninca cihaz koordinatiyla dokunur', async () => {
    const tapSession = vi.fn(async () => ({ sessionId: 's1', x: 0, y: 0 }));
    render(<MobilePreviewPanel ports={ports({ tapSession })} />);
    await waitFor(() => expect(screen.getByText('127.0.0.1:26624')).toBeTruthy());
    fireEvent.click(screen.getAllByText('Aç')[0]!);
    const image = await screen.findByAltText('Cihaz ekranı');

    // jsdom görüntü boyutu vermez; doğal boyutu ve çerçeveyi taklit ediyoruz.
    Object.defineProperty(image, 'naturalWidth', { value: 2560 });
    Object.defineProperty(image, 'naturalHeight', { value: 1440 });
    image.getBoundingClientRect = () => (
      { left: 0, top: 0, width: 320, height: 180 } as DOMRect
    );

    fireEvent.click(image, { clientX: 160, clientY: 90 });
    await waitFor(() => expect(tapSession).toHaveBeenCalledWith('s1', { x: 1280, y: 720 }));
  });

  // Görüntü henüz yüklenmediyse doğal boyut 0'dır; NaN koordinat adb'de
  // sessizce düşer, o yüzden HİÇ gönderilmez.
  it('gorsel yuklenmediyse dokunus GONDERMEZ', async () => {
    const tapSession = vi.fn(async () => ({ sessionId: 's1', x: 0, y: 0 }));
    render(<MobilePreviewPanel ports={ports({ tapSession })} />);
    await waitFor(() => expect(screen.getByText('127.0.0.1:26624')).toBeTruthy());
    fireEvent.click(screen.getAllByText('Aç')[0]!);
    const image = await screen.findByAltText('Cihaz ekranı');

    fireEvent.click(image, { clientX: 10, clientY: 10 });
    await new Promise((resolve) => { setTimeout(resolve, 10); });
    expect(tapSession).not.toHaveBeenCalled();
  });
});
