// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { PreviewPanel } from './PreviewPanel.js';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const respond = (body: unknown) => ({
  ok: true, status: 200,
  headers: new Headers({ 'content-type': 'application/json' }),
  text: async () => JSON.stringify(body),
});

describe('PreviewPanel', () => {
  it('kapaliyken baslat dugmesi gosterir', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(respond({
      projectId: 'p1', running: false, hasIndexHtml: false, logs: [],
    }) as never);

    render(<PreviewPanel projectId="p1" />);
    await waitFor(() => expect(screen.getByText('Başlat')).toBeDefined());
    expect(screen.getByText('kapalı')).toBeDefined();
  });

  it('calisirken url ve durdur dugmesi gosterir', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(respond({
      projectId: 'p1', running: true, port: 42000, url: 'http://localhost:42000/',
      hasIndexHtml: true, logs: ['onizleme sunucusu hazir: 42000'],
    }) as never);

    render(<PreviewPanel projectId="p1" />);
    await waitFor(() => expect(screen.getByText(/localhost:42000/)).toBeDefined());
    expect(screen.getByText('Durdur')).toBeDefined();
  });

  // Sahte bir "uygulama çalışıyor" görüntüsü vermemek için sınır açıkça yazılır.
  it('index.html yoksa sinirini acikca soyler', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(respond({
      projectId: 'p1', running: true, port: 42000, url: 'http://localhost:42000/',
      hasIndexHtml: false, logs: [],
    }) as never);

    render(<PreviewPanel projectId="p1" />);
    await waitFor(() => expect(screen.getByText(/dosya listesini gösteriyor/)).toBeDefined());
  });

  it('surec gunlugunu gosterir', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(respond({
      projectId: 'p1', running: true, port: 42000, url: 'http://localhost:42000/',
      hasIndexHtml: true, logs: ['GET /index.html 200'],
    }) as never);

    render(<PreviewPanel projectId="p1" />);
    await waitFor(() => expect(screen.getByText(/Süreç günlüğü \(1 satır\)/)).toBeDefined());
  });

  // docs/10: "süreç çökerse panelde rozet". Çöküş ile kullanıcının
  // durdurması ikisi de "kapalı" görünüyordu; kullanıcı işin kendiliğinden
  // öldüğünü fark edemiyordu.
  it('cokmus surec icin rozet gosterir', () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(respond({
      projectId: 'p1', running: false, hasIndexHtml: false,
      crashed: true, exitCode: 137, logs: [],
    }) as never);

    render(<PreviewPanel projectId="p1" />);
    // Rozet role="alert" taşır: ekran okuyucu da duyar (yalnız renk değil).
    return screen.findByRole('alert').then((node) => {
      expect(node.textContent).toContain('çöktü');
      expect(node.textContent).toContain('137');
    });
  });

  it('kullanici durdurdugunda cokme rozeti YOK', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(respond({
      projectId: 'p1', running: false, hasIndexHtml: false,
      crashed: false, exitCode: null, logs: [],
    }) as never);

    render(<PreviewPanel projectId="p1" />);
    await screen.findByText(/kapalı/);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
