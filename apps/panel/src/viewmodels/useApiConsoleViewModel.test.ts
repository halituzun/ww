// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { SERVER_OFF_NOTE, useApiConsoleViewModel } from './useApiConsoleViewModel.js';

afterEach(cleanup);

const running = {
  projectId: 'p1', running: true, port: 42000, url: 'http://localhost:42000/',
  hasIndexHtml: true, logs: [],
};

describe('useApiConsoleViewModel', () => {
  // ASIL KUSUR: istek ww sunucusuna gidiyordu; ww'nin cevabı projenin
  // cevabıymış gibi gösteriliyordu.
  it('istegi projenin calisan sunucusuna atar', async () => {
    const send = vi.fn(async () => ({ status: 200, text: '{"ok":true}' }));
    const { result } = renderHook(() => useApiConsoleViewModel('p1', {
      fetchStatus: async () => running as never, send,
    }));

    act(() => { result.current.setPath('/health'); });
    await act(async () => { await result.current.run(); });

    expect(send).toHaveBeenCalledWith('http://localhost:42000/health');
    expect(result.current.result?.status).toBe(200);
    expect(result.current.result?.body).toBe('{"ok":true}');
  });

  // Sunucu kapalıyken başka bir sunucuya sormak, yanlış cevabı doğru sandırır.
  it('sunucu kapaliyken istek ATMAZ ve bunu soyler', async () => {
    const send = vi.fn(async () => ({ status: 200, text: 'x' }));
    const { result } = renderHook(() => useApiConsoleViewModel('p1', {
      fetchStatus: async () => ({ ...running, running: false, url: undefined }) as never,
      send,
    }));

    await act(async () => { await result.current.run(); });

    expect(send).not.toHaveBeenCalled();
    expect(result.current.error).toBe(SERVER_OFF_NOTE);
    expect(result.current.result).toBeUndefined();
  });

  it('hangi adrese gidildigini bildirir', async () => {
    const { result } = renderHook(() => useApiConsoleViewModel('p1', {
      fetchStatus: async () => running as never,
      send: async () => ({ status: 404, text: 'yok' }),
    }));

    act(() => { result.current.setPath('/api/todos'); });
    await act(async () => { await result.current.run(); });

    expect(result.current.result?.url).toBe('http://localhost:42000/api/todos');
    expect(result.current.result?.status).toBe(404);
  });

  it('hata durumunu yutmaz', async () => {
    const { result } = renderHook(() => useApiConsoleViewModel('p1', {
      fetchStatus: async () => running as never,
      send: async () => { throw new Error('baglanti reddedildi'); },
    }));

    await act(async () => { await result.current.run(); });
    expect(result.current.error).toMatch(/baglanti reddedildi/);
  });

  it('proje secili degilken istek atmaz', async () => {
    const send = vi.fn(async () => ({ status: 200, text: 'x' }));
    const { result } = renderHook(() => useApiConsoleViewModel('', { send }));
    await act(async () => { await result.current.run(); });
    expect(send).not.toHaveBeenCalled();
  });
});
