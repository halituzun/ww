// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { AgentCanvas } from './AgentCanvas.js';

// React Flow ölçüm için ResizeObserver ister; jsdom'da yoktur ve eksikliği
// testleri geçirse bile koşuyu yakalanmamış hatayla düşürür.
class ResizeObserverStub {
  observe(): void { /* ölçüm gerekmiyor */ }
  unobserve(): void { /* ölçüm gerekmiyor */ }
  disconnect(): void { /* ölçüm gerekmiyor */ }
}
globalThis.ResizeObserver ??= ResizeObserverStub as never;

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const respond = (body: unknown) => ({
  ok: true, status: 200,
  headers: new Headers({ 'content-type': 'application/json' }),
  text: async () => JSON.stringify(body),
});

describe('AgentCanvas', () => {
  it('agent yoksa bunu acikca soyler', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(respond({ nodes: [], edges: [] }) as never);
    render(<AgentCanvas projectId="p1" />);
    await waitFor(() => expect(screen.getByText(/agent yok/i)).toBeDefined());
  });

  // Hata yutulursa boş tuval "hiç agent yok" yalanını söyler.
  it('hata durumunda bos tuval gostermez', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false, status: 500,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({ message: 'sunucu düştü' }),
    } as never);

    render(<AgentCanvas projectId="p1" />);
    await waitFor(() => expect(screen.getByText(/sunucu düştü|Tuval/)).toBeDefined());
  });

  // Durum yalnız renkle gösterilirse renk körü kullanıcı ayırt edemez.
  it('agent durumunu metinle de yazar', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(respond({
      nodes: [{
        id: 'a1', label: 'Worker 1', role: 'worker', group: 'coding',
        modelRef: 'deepseek:deepseek-chat', status: 'busy',
      }],
      edges: [],
    }) as never);

    render(<AgentCanvas projectId="p1" />);
    await waitFor(() => expect(screen.getByText(/worker · busy/)).toBeDefined());
  });
});

describe('AgentCanvas — canlılık', () => {
  // Kaydedilmiş durum tek başına yalan söyleyebilir: süreç ölünce satır
  // 'busy' kalır ve tuval çalışmayan bir agent'ı çalışıyor gösterir.
  it('yanit vermeyen agenti metinle bildirir', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(respond({
      nodes: [{
        id: 'a1', label: 'Worker 1', role: 'worker', group: 'coding',
        modelRef: 'deepseek:deepseek-chat', status: 'busy', unresponsive: true,
      }],
      edges: [],
    }) as never);

    render(<AgentCanvas projectId="p1" />);
    await waitFor(() => expect(screen.getByText(/yanıt vermiyor/)).toBeDefined());
  });
});
