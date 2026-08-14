import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HEALTH_CLEANUP_TIMEOUT_MS,
  HEALTH_PROBE_TIMEOUT_MS,
  HealthService,
  type HealthDependencies,
} from './health.service.js';

function dependenciesFor(clickhouse: boolean, redis: boolean) {
  const close = vi.fn(async () => undefined);
  const destroy = vi.fn(() => undefined);
  const clickhousePing = vi.fn(async () => {
    if (!clickhouse) return { success: false };
    return { success: true };
  });
  const ping = vi.fn(async () => {
    if (!redis) throw new Error('redis down');
    return 'PONG';
  });
  const dependencies: HealthDependencies = {
    createClickhouse: () => ({ ping: clickhousePing, close }),
    createRedis: async () => ({ ping, destroy }),
  };

  return { dependencies, clickhousePing, close, destroy, ping };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('HealthService', () => {
  it.each([
    [true, true, true],
    [false, true, false],
    [true, false, false],
    [false, false, false],
  ])('ClickHouse=%s Redis=%s iken ok=%s döndürür', async (clickhouse, redis, ok) => {
    const test = dependenciesFor(clickhouse, redis);

    await expect(new HealthService(test.dependencies).check()).resolves.toEqual({
      ok,
      clickhouse,
      redis,
    });
    expect(test.close).toHaveBeenCalledOnce();
    expect(test.destroy).toHaveBeenCalledOnce();
  });

  it('probe hatalarını degraded yanıta çevirip istemcileri kapatır', async () => {
    const test = dependenciesFor(false, false);

    const report = await new HealthService(test.dependencies).check();

    expect(report).toEqual({ ok: false, clickhouse: false, redis: false });
    expect(test.clickhousePing).toHaveBeenCalledOnce();
    expect(test.ping).toHaveBeenCalledOnce();
    expect(test.close).toHaveBeenCalledOnce();
    expect(test.destroy).toHaveBeenCalledOnce();
  });

  it('Redis destroy hatasını degraded yanıta çevirir', async () => {
    const test = dependenciesFor(true, true);
    test.destroy.mockImplementationOnce(() => { throw new Error('destroy failed'); });

    await expect(new HealthService(test.dependencies).check()).resolves.toEqual({
      ok: false,
      clickhouse: true,
      redis: false,
    });
    expect(test.destroy).toHaveBeenCalledOnce();
  });

  it('v5 quit yarışına girmeden açık soketi doğrudan destroy eder', async () => {
    let open = true;
    let socketOpen = true;
    const destroy = vi.fn(() => {
      if (!open) throw new Error('ClientClosedError');
      open = false;
      socketOpen = false;
    });
    // v5-faithful anti-pattern: çağrı isOpen'u false yapıp QUIT yanıtında takılır.
    const quit = vi.fn(() => {
      open = false;
      return new Promise<string>(() => undefined);
    });
    const dependencies: HealthDependencies = {
      createClickhouse: () => ({
        ping: async () => ({ success: true }),
        close: async () => undefined,
      }),
      createRedis: async () => ({
        get isOpen() { return open; },
        ping: async () => 'PONG',
        quit,
        destroy,
      }),
    };

    await expect(new HealthService(dependencies).check()).resolves.toEqual({
      ok: true,
      clickhouse: true,
      redis: true,
    });
    expect(quit).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledOnce();
    expect(socketOpen).toBe(false);
  });

  it('ClickHouse close hatasını degraded yanıta çevirir', async () => {
    const test = dependenciesFor(true, true);
    test.close.mockRejectedValueOnce(new Error('close failed'));

    await expect(new HealthService(test.dependencies).check()).resolves.toEqual({
      ok: false,
      clickhouse: false,
      redis: true,
    });
  });

  it('istemci factory hatalarını boolean sağlık sonucuna dönüştürür', async () => {
    const dependencies: HealthDependencies = {
      createClickhouse: () => { throw new Error('create clickhouse failed'); },
      createRedis: async () => { throw new Error('create redis failed'); },
    };

    await expect(new HealthService(dependencies).check()).resolves.toEqual({
      ok: false,
      clickhouse: false,
      redis: false,
    });
  });

  it('hiç tamamlanmayan SELECT ve PING probe\'larını deadline ile kapatır', async () => {
    vi.useFakeTimers();
    const close = vi.fn(async () => undefined);
    const destroy = vi.fn(() => undefined);
    const dependencies: HealthDependencies = {
      createClickhouse: () => ({
        ping: async () => new Promise<{ success: boolean }>(() => undefined),
        close,
      }),
      createRedis: async () => ({
        ping: async () => new Promise(() => undefined),
        destroy,
      }),
    };

    const result = new HealthService(dependencies).check();
    const assertion = expect(result).resolves.toEqual({
      ok: false,
      clickhouse: false,
      redis: false,
    });
    await vi.advanceTimersByTimeAsync(HEALTH_PROBE_TIMEOUT_MS);

    await assertion;
    expect(close).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('hiç tamamlanmayan ClickHouse cleanup işlemine rağmen deadline içinde sonuçlanır', async () => {
    vi.useFakeTimers();
    const destroy = vi.fn(() => undefined);
    const dependencies: HealthDependencies = {
      createClickhouse: () => ({
        ping: async () => ({ success: true }),
        close: async () => new Promise<void>(() => undefined),
      }),
      createRedis: async () => ({
        ping: async () => 'PONG',
        destroy,
      }),
    };

    const result = new HealthService(dependencies).check();
    const assertion = expect(result).resolves.toEqual({
      ok: false,
      clickhouse: false,
      redis: true,
    });
    await vi.advanceTimersByTimeAsync(HEALTH_CLEANUP_TIMEOUT_MS);

    await assertion;
    expect(destroy).toHaveBeenCalledOnce();
  });
});
