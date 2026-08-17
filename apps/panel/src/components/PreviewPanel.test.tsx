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
});
