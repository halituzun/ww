// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { useAgentDetailViewModel } from './useAgentDetailViewModel.js';

afterEach(cleanup);

const detail = (name: string) => ({
  agentId: 'a1', name, role: 'worker', status: 'idle', modelRef: 'deepseek:chat',
  tasks: [], messageCount: 0, calls: 0, promptTokens: 0, completionTokens: 0, costUsd: 0,
});

describe('useAgentDetailViewModel', () => {
  it('agent secilmediginde istek atmaz', () => {
    const load = vi.fn(async () => detail('x'));
    const { result } = renderHook(() =>
      useAgentDetailViewModel('p1', undefined, { load } as never));

    expect(load).not.toHaveBeenCalled();
    expect(result.current.detail).toBeUndefined();
  });

  it('secilen agentin gecmisini yukler', async () => {
    const load = vi.fn(async () => detail('Worker A'));
    const { result } = renderHook(() =>
      useAgentDetailViewModel('p1', 'a1', { load } as never));

    await waitFor(() => expect(result.current.detail?.name).toBe('Worker A'));
    expect(load).toHaveBeenCalledWith('p1', 'a1');
  });

  // ASIL RİSK: hata yutulursa boş panel "bu agent hiçbir şey yapmadı"
  // yalanını söyler — oysa veri hiç alınamamıştır.
  it('hata yutulmaz ve eski veri gosterilmez', async () => {
    const load = vi.fn(async () => { throw new Error('agent geçmişi alınamadı'); });
    const { result } = renderHook(() =>
      useAgentDetailViewModel('p1', 'a1', { load } as never));

    await waitFor(() => expect(result.current.error).toBe('agent geçmişi alınamadı'));
    expect(result.current.detail).toBeUndefined();
  });

  // Agent değişince ESKİ agent'ın verisi görünmemeli: yanlış agent'ın
  // geçmişini doğru sanmak, denetimi baştan bozar.
  it('agent degisince onceki verinin gec gelen cevabini yazmaz', async () => {
    let resolveFirst: ((value: unknown) => void) | undefined;
    const load = vi.fn((_p: string, agentId: string) => agentId === 'a1'
      ? new Promise((resolve) => { resolveFirst = resolve; })
      : Promise.resolve(detail('Worker B')));

    const { result, rerender } = renderHook(
      ({ agentId }: { agentId: string }) =>
        useAgentDetailViewModel('p1', agentId, { load } as never),
      { initialProps: { agentId: 'a1' } },
    );

    rerender({ agentId: 'a2' });
    await waitFor(() => expect(result.current.detail?.name).toBe('Worker B'));

    resolveFirst?.(detail('Worker A'));
    await new Promise((resolve) => { setTimeout(resolve, 10); });
    expect(result.current.detail?.name).toBe('Worker B');
  });
});
