import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchHealth } from './health.js';

const healthyResponse = () => new Response(JSON.stringify({
  ok: true,
  clickhouse: true,
  redis: true,
}), { headers: { 'content-type': 'application/json' } });

afterEach(() => {
  vi.useRealTimers();
});

describe('fetchHealth', () => {
  it('yapılandırılmış production API adresini kullanır', async () => {
    const fetchImpl = vi.fn(async () => healthyResponse()) as unknown as typeof fetch;

    await expect(fetchHealth({
      baseUrl: 'https://api.example.com/',
      fetchImpl,
      retries: 0,
    })).resolves.toEqual({ ok: true, clickhouse: true, redis: true });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.example.com/health',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('timeout sonrası sınırlı sayıda yeniden dener', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(init.signal?.reason ?? new Error('aborted')),
          { once: true },
        );
      })) as unknown as typeof fetch;

    const result = fetchHealth({ fetchImpl, retries: 1, timeoutMs: 25 });
    const rejection = expect(result).rejects.toThrow(/tamamlanmadı/);
    await vi.advanceTimersByTimeAsync(25);
    await vi.advanceTimersByTimeAsync(25);

    await rejection;
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('yanıt invariantı bozuksa reddeder', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      clickhouse: false,
      redis: true,
    }))) as unknown as typeof fetch;

    await expect(fetchHealth({ fetchImpl, retries: 0 })).rejects.toThrow(/geçersiz/);
  });
});
