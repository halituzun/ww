import { createServer, type Socket } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { WsEnvelope } from '@ww/shared';
import {
  ackQueue, acquireLock, createRedis, ensureGroup, enqueueTask,
  publishEvent, readQueue, releaseLock, SUBSCRIPTION_CLEANUP_TIMEOUT_MS,
  subscribeEvents, type WwRedis,
} from './redis.js';

let up = true;
let r: WwRedis;
try {
  r = await createRedis(undefined, {
    connectTimeoutMs: 500,
    maxReconnectAttempts: 0,
    onError: () => undefined,
  });
  await r.ping();
} catch {
  up = false;
}

afterEach(() => {
  vi.useRealTimers();
});

async function unavailableRedisUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test portu alınamadı');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve()),
  );
  return `redis://127.0.0.1:${address.port}`;
}

async function blackholeRedisServer(): Promise<{
  close(): Promise<void>;
  connectionCount(): Promise<number>;
  sockets: Set<Socket>;
  url: string;
}> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    // TCP bağlantısını kabul et fakat Redis handshake'ine hiç yanıt verme.
    socket.resume();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test portu alınamadı');

  return {
    url: `redis://127.0.0.1:${address.port}`,
    sockets,
    connectionCount: () => new Promise<number>((resolve, reject) => {
      server.getConnections((error, count) => error ? reject(error) : resolve(count));
    }),
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve()),
      );
    },
  };
}

function redisWithDuplicate(subscriber: WwRedis): WwRedis {
  return {
    duplicate: vi.fn(() => subscriber),
  } as unknown as WwRedis;
}

describe('createRedis bağlantı sınırları', () => {
  it('bağlantı reddini sınırlı sürede rejection olarak döndürür', async () => {
    const url = await unavailableRedisUrl();
    const startedAt = Date.now();
    const onError = vi.fn();

    await expect(createRedis(url, { connectTimeoutMs: 100, onError }))
      .rejects.toBeInstanceOf(Error);

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(onError).toHaveBeenCalled();
  });

  it('geçersiz yeniden deneme sınırını bağlantı kurmadan reddeder', async () => {
    await expect(createRedis(undefined, { maxReconnectAttempts: -1 })).rejects.toThrow(/tam sayı/);
  });

  it('handler verilmezse bağlantı hatasını görünür kılar', async () => {
    const url = await unavailableRedisUrl();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(createRedis(url, {
        connectTimeoutMs: 100,
        maxReconnectAttempts: 0,
      })).rejects.toBeInstanceOf(Error);
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining('Redis istemci hatası'),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it('TCP açık fakat handshake yanıtsızsa deadline sonunda soketi zorla kapatır', async () => {
    const blackhole = await blackholeRedisServer();
    try {
      await expect(createRedis(blackhole.url, {
        connectTimeoutMs: 75,
        maxReconnectAttempts: 0,
        onError: () => undefined,
      })).rejects.toThrow(/75 ms içinde tamamlanmadı/);

      await vi.waitFor(() => expect(blackhole.sockets.size).toBe(0), { timeout: 1_000 });
      await expect(blackhole.connectionCount()).resolves.toBe(0);
    } finally {
      await blackhole.close();
    }
  });
});

describe('subscribeEvents cleanup', () => {
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
    const subscriber = {
      get isOpen() { return open; },
      on: vi.fn(),
      connect: vi.fn(async () => subscriber),
      subscribe: vi.fn(async () => undefined),
      unsubscribe: vi.fn(async () => undefined),
      quit,
      destroy,
    } as unknown as WwRedis;
    const stop = await subscribeEvents(redisWithDuplicate(subscriber), () => undefined);

    await expect(stop()).resolves.toBeUndefined();
    expect(quit).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledOnce();
    expect(socketOpen).toBe(false);
  });

  it('unsubscribe hata verirse duplicate istemciyi yine zorla kapatır', async () => {
    let open = true;
    const destroy = vi.fn(() => { open = false; });
    const quit = vi.fn(async () => 'OK');
    const subscriber = {
      get isOpen() { return open; },
      on: vi.fn(),
      connect: vi.fn(async () => subscriber),
      subscribe: vi.fn(async () => undefined),
      unsubscribe: vi.fn(async () => { throw new Error('unsubscribe failed'); }),
      quit,
      destroy,
    } as unknown as WwRedis;
    const stop = await subscribeEvents(redisWithDuplicate(subscriber), () => undefined);

    await expect(stop()).rejects.toThrow('unsubscribe failed');
    expect(destroy).toHaveBeenCalledOnce();
    expect(quit).not.toHaveBeenCalled();
  });

  it('unsubscribe hiç tamamlanmazsa deadline sonunda duplicate istemciyi kapatır', async () => {
    vi.useFakeTimers();
    let open = true;
    const destroy = vi.fn(() => { open = false; });
    const subscriber = {
      get isOpen() { return open; },
      on: vi.fn(),
      connect: vi.fn(async () => subscriber),
      subscribe: vi.fn(async () => undefined),
      unsubscribe: vi.fn(async () => new Promise<void>(() => undefined)),
      quit: vi.fn(async () => 'OK'),
      destroy,
    } as unknown as WwRedis;
    const stop = await subscribeEvents(redisWithDuplicate(subscriber), () => undefined);

    const result = stop();
    const rejection = expect(result).rejects.toThrow(/unsubscribe.*tamamlanmadı/);
    await vi.advanceTimersByTimeAsync(SUBSCRIPTION_CLEANUP_TIMEOUT_MS);

    await rejection;
    expect(destroy).toHaveBeenCalledOnce();
  });
});

describe.skipIf(!up)('redis yardımcıları', () => {
  const q = `ww:queue:test-${Date.now()}`;

  beforeAll(async () => {
    await ensureGroup(r, q, 'scheduler');
  });
  afterAll(async () => {
    await r.del(q);
    await r.quit();
  });

  it('kuyruk: xadd + grup okuma + ack', async () => {
    await enqueueTask(r, q, 'task-1');
    const msgs = await readQueue(r, q, 'scheduler', 'c1');
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.taskId).toBe('task-1');
    await ackQueue(r, q, 'scheduler', msgs[0]!.msgId);
    expect(await readQueue(r, q, 'scheduler', 'c1')).toHaveLength(0);
  });

  it('kilit: NX alma; sahibi olmayan bırakamaz', async () => {
    const key = `ww:lock:test-${Date.now()}`;
    expect(await acquireLock(r, key, 'owner-a', 10)).toBe(true);
    expect(await acquireLock(r, key, 'owner-b', 10)).toBe(false);
    expect(await releaseLock(r, key, 'owner-b')).toBe(false);
    expect(await releaseLock(r, key, 'owner-a')).toBe(true);
    expect(await acquireLock(r, key, 'owner-b', 10)).toBe(true);
    await r.del(key);
  });

  it('pub/sub: yayınlanan zarf aboneye ulaşır', async () => {
    let received: (env: WsEnvelope) => void = () => undefined;
    const got = new Promise<WsEnvelope>((resolve) => {
      received = resolve;
    });
    const stop = await subscribeEvents(r, (env) => received(env));
    try {
      const env: WsEnvelope = { event: 'task.updated', projectId: 'p1', seq: 1, ts: new Date().toISOString(), data: { x: 1 } };
      await publishEvent(r, env);
      const message = await got;
      expect(message.event).toBe('task.updated');
      expect(message.seq).toBe(1);
    } finally {
      await stop();
    }
  });
});
