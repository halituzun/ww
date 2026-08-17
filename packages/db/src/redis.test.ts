import { randomUUID } from 'node:crypto';
import { createServer, type Socket } from 'node:net';
import {
  afterAll, afterEach, beforeAll, describe, expect, expectTypeOf, it, vi,
} from 'vitest';
import type { WsEnvelope } from '@ww/shared';
import {
  MAX_QUEUE_BLOCK_MS, MAX_RECLAIM_BATCH, MIN_RECLAIM_IDLE_MS,
  SUBSCRIPTION_CLEANUP_TIMEOUT_MS, ackQueue, acquireFileLock, checkHeartbeat,
  createQueueReader, createRedis, enqueueTask, ensureGroup, fileLockKey,
  getFileLockOwner, heartbeatKey, inspectFileLock, publishEvent, queueKey, readQueue, reclaimQueue,
  releaseFileLock,
  releaseFileLockUnderTaskLease, renewFileLock, setHeartbeat, subscribeEvents,
  transferFileLocks, transferOrAcquireFileLocks,
  type FileLockKey, type QueueKey,
  type QueueMessage, type ReclaimedQueueMessage, type ReclaimQueueResult,
  type WwRedis,
} from './redis.js';
import {
  acquireFencedLease,
  releaseFencedLease,
  taskLockKey,
} from './redis-leases.js';
import type { RedisLockKey, TaskLockKey } from './redis-leases.js';
import { redisUp } from './testutil.js';

const up = await redisUp();
let r: WwRedis;

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

async function withUnhandledRejectionCapture(work: () => Promise<void>): Promise<unknown[]> {
  const unhandled: unknown[] = [];
  const listener = (reason: unknown): void => { unhandled.push(reason); };
  process.on('unhandledRejection', listener);
  try {
    await work();
    await new Promise<void>((resolve) => setImmediate(resolve));
    return unhandled;
  } finally {
    process.removeListener('unhandledRejection', listener);
  }
}

describe('reclaimQueue fail-closed sinirlari', () => {
  it('atomik Lua cevabindaki exact delivery kanitini dondurur', async () => {
    const projectId = randomUUID();
    const taskId = randomUUID();
    const stream = queueKey(projectId);
    const evalCommand = vi.fn(async () => [
      '0-0',
      [['1-0', taskId.toUpperCase(), 2]],
      [],
    ]);
    const redis = { eval: evalCommand } as unknown as WwRedis;

    await expect(reclaimQueue(redis, stream, 'group', 'consumer-b', {
      minIdleMs: MIN_RECLAIM_IDLE_MS,
      maxDeliveries: 2,
      count: 1,
    })).resolves.toEqual({
      nextCursor: '0-0',
      claimed: [{ msgId: '1-0', taskId, deliveryCount: 2 }],
      exhausted: [],
      invalid: [],
      deletedIds: [],
    });
    expect(evalCommand).toHaveBeenCalledWith(
      expect.stringContaining("'XAUTOCLAIM'"),
      {
        keys: [stream],
        arguments: ['group', 'consumer-b', String(MIN_RECLAIM_IDLE_MS), '0-0', '1'],
      },
    );
    expect(evalCommand.mock.calls[0]?.[0]).toContain("'XPENDING'");
    expect(evalCommand.mock.calls[0]?.[0]).not.toContain('JUSTID');
  });

  it('bozuk task IDyi typed invalid kovasina alir ve gecerli kardesi korur', async () => {
    const stream = queueKey(randomUUID());
    const taskId = randomUUID();
    const redis = {
      eval: vi.fn(async () => [
        '7-0',
        [
          ['1-0', null, 2],
          ['2-0', 'malformed', 3],
          ['3-0', taskId, 2],
        ],
        [],
      ]),
    } as unknown as WwRedis;

    await expect(reclaimQueue(redis, stream, 'group', 'consumer-b', {
      minIdleMs: MIN_RECLAIM_IDLE_MS,
      maxDeliveries: 3,
    })).resolves.toEqual({
      nextCursor: '7-0',
      claimed: [{ msgId: '3-0', taskId, deliveryCount: 2 }],
      exhausted: [],
      invalid: [
        { msgId: '1-0', deliveryCount: 2, reason: 'invalid_task_id' },
        { msgId: '2-0', deliveryCount: 3, reason: 'invalid_task_id' },
      ],
      deletedIds: [],
    });
  });

  it('ham cevap celiskisini ve code-owned batch asimini fail-closed reddeder', async () => {
    const stream = queueKey(randomUUID());
    const taskId = randomUUID();
    const duplicate = {
      eval: vi.fn(async () => [
        '0-0',
        [
          ['1-0', taskId, 2],
          ['1-0', taskId, 2],
        ],
        [],
      ]),
    } as unknown as WwRedis;
    await expect(reclaimQueue(duplicate, stream, 'group', 'consumer', {
      minIdleMs: MIN_RECLAIM_IDLE_MS,
      maxDeliveries: 2,
    })).rejects.toThrow(/birden cok/);

    const redis = {} as WwRedis;
    await expect(reclaimQueue(redis, stream, 'group', 'consumer', {
      minIdleMs: -1,
      maxDeliveries: 1,
    })).rejects.toThrow(/minIdleMs/);
    await expect(reclaimQueue(redis, stream, 'group', 'consumer', {
      minIdleMs: 0,
      maxDeliveries: 1,
    })).rejects.toThrow(/minIdleMs/);
    await expect(reclaimQueue(redis, stream, 'group', 'consumer', {
      minIdleMs: MIN_RECLAIM_IDLE_MS,
      maxDeliveries: 0,
    })).rejects.toThrow(/maxDeliveries/);
    await expect(reclaimQueue(redis, stream, 'group', 'consumer', {
      minIdleMs: MIN_RECLAIM_IDLE_MS,
      maxDeliveries: 1,
      count: 0,
    })).rejects.toThrow(/count/);
    await expect(reclaimQueue(redis, stream, 'group', 'consumer', {
      minIdleMs: MIN_RECLAIM_IDLE_MS,
      maxDeliveries: 1,
      count: MAX_RECLAIM_BATCH + 1,
    })).rejects.toThrow(new RegExp(String(MAX_RECLAIM_BATCH)));
    await expect(reclaimQueue(redis, stream, 'group', '', {
      minIdleMs: MIN_RECLAIM_IDLE_MS,
      maxDeliveries: 1,
    })).rejects.toThrow(/consumer/);
  });
});

describe('queue girdi sinirlari', () => {
  it('queue sonuc tiplerini ve bos/non-empty runtime koleksiyonlarini immutable tutar', async () => {
    expectTypeOf<QueueMessage>().toEqualTypeOf<Readonly<QueueMessage>>();
    expectTypeOf<ReclaimedQueueMessage>()
      .toEqualTypeOf<Readonly<ReclaimedQueueMessage>>();
    expectTypeOf<ReclaimQueueResult>()
      .toEqualTypeOf<Readonly<ReclaimQueueResult>>();

    const stream = queueKey(randomUUID());
    const empty = await readQueue(
      { xReadGroup: vi.fn(async () => null) } as unknown as WwRedis,
      stream,
      'group',
      'consumer',
    );
    expect(Object.isFrozen(empty)).toBe(true);
    expect(Object.isFrozen(empty.messages)).toBe(true);
    expect(Object.isFrozen(empty.invalid)).toBe(true);
    expect(() => (empty.messages as QueueMessage[]).push({
      msgId: '1-0',
      taskId: randomUUID(),
    })).toThrow(TypeError);

    const taskId = randomUUID();
    const reclaimed = await reclaimQueue(
      {
        eval: vi.fn(async () => ['0-0', [['1-0', taskId, 2]], []]),
      } as unknown as WwRedis,
      stream,
      'group',
      'consumer',
      { minIdleMs: MIN_RECLAIM_IDLE_MS, maxDeliveries: 2 },
    );
    expect(Object.isFrozen(reclaimed)).toBe(true);
    expect(Object.isFrozen(reclaimed.claimed)).toBe(true);
    expect(Object.isFrozen(reclaimed.claimed[0])).toBe(true);
    expect(Object.isFrozen(reclaimed.exhausted)).toBe(true);
    expect(Object.isFrozen(reclaimed.invalid)).toBe(true);
    expect(Object.isFrozen(reclaimed.deletedIds)).toBe(true);
    expect(() => (reclaimed.claimed as ReclaimedQueueMessage[]).pop()).toThrow(TypeError);
  });

  it('yeni teslimde bozuk taski invalid kovasina alir, UUIDyi canonicalize eder', async () => {
    const taskId = randomUUID();
    const stream = queueKey(randomUUID());
    const xReadGroup = vi.fn(async () => [{
      name: stream,
      messages: [
        { id: '1-0', message: { task_id: 'bad' } },
        { id: '2-0', message: { task_id: taskId.toUpperCase() } },
      ],
    }]);
    const redis = {
      xReadGroup,
    } as unknown as WwRedis;
    await expect(readQueue(redis, stream, 'group', 'consumer'))
      .resolves.toEqual({
        messages: [{ msgId: '2-0', taskId }],
        invalid: [{ msgId: '1-0', deliveryCount: 1, reason: 'invalid_task_id' }],
      });
  });

  it('Redis cevabindaki baska veya canonical olmayan proje streamini fail-closed reddeder', async () => {
    const requested = queueKey(randomUUID());
    const other = queueKey(randomUUID());
    const taskId = randomUUID();
    const redis = {
      xReadGroup: vi.fn(async () => [{
        name: other,
        messages: [{ id: '1-0', message: { task_id: taskId } }],
      }]),
    } as unknown as WwRedis;

    await expect(readQueue(redis, requested, 'group', 'consumer'))
      .rejects.toThrow(/beklenmeyen/);
  });

  it('BLOCK 0, max block ve gecersiz count degerlerini Redis cagirmadan reddeder', async () => {
    const redis = { xReadGroup: vi.fn(), duplicate: vi.fn() } as unknown as WwRedis;
    const stream = queueKey(randomUUID());
    await expect(readQueue(redis, stream, 'group', 'consumer', { count: 0 }))
      .rejects.toThrow(/count/);
    const reader = createQueueReader(redis);
    await expect(reader.read(stream, 'group', 'consumer', { blockMs: 0 }))
      .rejects.toThrow(/blockMs/);
    await expect(reader.read(stream, 'group', 'consumer', {
      blockMs: MAX_QUEUE_BLOCK_MS + 1,
    })).rejects.toThrow(new RegExp(String(MAX_QUEUE_BLOCK_MS)));
    reader.stop();
    expect(redis.xReadGroup).not.toHaveBeenCalled();
    expect(redis.duplicate).not.toHaveBeenCalled();
  });

  it('pre-abort Redis komutu baslatmaz; rejected Promise yarisi unhandled uretmez', async () => {
    const stream = queueKey(randomUUID());
    const preAborted = new AbortController();
    preAborted.abort();
    const neverCalled = vi.fn(() => Promise.reject(new Error('pre-abort command')));
    const preRedis = {
      withAbortSignal: vi.fn(() => ({ xReadGroup: neverCalled })),
    } as unknown as WwRedis;
    const preUnhandled = await withUnhandledRejectionCapture(async () => {
      await expect(readQueue(preRedis, stream, 'group', 'consumer', {
        signal: preAborted.signal,
      })).rejects.toMatchObject({ name: 'AbortError' });
    });
    expect(preUnhandled).toEqual([]);
    expect(preRedis.withAbortSignal).not.toHaveBeenCalled();
    expect(neverCalled).not.toHaveBeenCalled();

    const racing = new AbortController();
    const rejected = new Error('command rejected in abort race');
    const xReadGroup = vi.fn(() => {
      racing.abort();
      return Promise.reject(rejected);
    });
    const raceRedis = {
      withAbortSignal: vi.fn(() => ({ xReadGroup })),
    } as unknown as WwRedis;
    const raceUnhandled = await withUnhandledRejectionCapture(async () => {
      await expect(readQueue(raceRedis, stream, 'group', 'consumer', {
        signal: racing.signal,
      })).rejects.toMatchObject({ name: 'AbortError' });
    });
    expect(raceUnhandled).toEqual([]);
    expect(xReadGroup).toHaveBeenCalledOnce();
  });

  it('owned blocking reader abortta duplicatei yok eder ve sonraki okumada yenisini kurar', async () => {
    let firstOpen = false;
    const firstRead = vi.fn(() => new Promise<null>(() => undefined));
    const first = {
      get isOpen() { return firstOpen; },
      on: vi.fn(),
      connect: vi.fn(async () => { firstOpen = true; return first; }),
      withAbortSignal: vi.fn(() => ({ xReadGroup: firstRead })),
      destroy: vi.fn(() => { firstOpen = false; }),
    } as unknown as WwRedis;
    let secondOpen = false;
    const secondRead = vi.fn(async () => null);
    const second = {
      get isOpen() { return secondOpen; },
      on: vi.fn(),
      connect: vi.fn(async () => { secondOpen = true; return second; }),
      withAbortSignal: vi.fn(() => ({ xReadGroup: secondRead })),
      destroy: vi.fn(() => { secondOpen = false; }),
    } as unknown as WwRedis;
    const source = {
      duplicate: vi.fn()
        .mockReturnValueOnce(first)
        .mockReturnValueOnce(second),
    } as unknown as WwRedis;
    const reader = createQueueReader(source, { connectTimeoutMs: 50 });
    const controller = new AbortController();
    const stream = queueKey(randomUUID());
    const pending = reader.read(stream, 'group', 'consumer', {
      blockMs: 100,
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(first.destroy).toHaveBeenCalledOnce();

    await expect(reader.read(stream, 'group', 'consumer', { blockMs: 10 }))
      .resolves.toEqual({ messages: [], invalid: [] });
    expect(source.duplicate).toHaveBeenCalledTimes(2);
    reader.stop();
    expect(second.destroy).toHaveBeenCalledOnce();
  });

  it('owned reader baglanti blackholeunu connect deadline ile yok eder', async () => {
    let open = false;
    const dedicated = {
      get isOpen() { return open; },
      on: vi.fn(),
      connect: vi.fn(() => new Promise<WwRedis>(() => undefined)),
      destroy: vi.fn(() => { open = false; }),
    } as unknown as WwRedis;
    const source = { duplicate: vi.fn(() => dedicated) } as unknown as WwRedis;
    const reader = createQueueReader(source, { connectTimeoutMs: 25 });
    const startedAt = Date.now();
    await expect(reader.read(queueKey(randomUUID()), 'group', 'consumer', {
      blockMs: 100,
    })).rejects.toThrow(/baglantisi.*zaman asimi/);
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(dedicated.destroy).toHaveBeenCalledOnce();
    reader.stop();
  });

  it('queue project/task UUIDlerini canonicalize eder ve bozuk kimligi reddeder', async () => {
    const projectId = randomUUID();
    const taskId = randomUUID();
    const redis = { xAdd: vi.fn() } as unknown as WwRedis;
    const stream = queueKey(projectId.toUpperCase());
    expect(stream).toBe(queueKey(projectId));
    await enqueueTask(redis, stream, taskId.toUpperCase());
    expect(redis.xAdd).toHaveBeenCalledWith(stream, '*', { task_id: taskId });
    await expect(enqueueTask(redis, stream, 'task-1')).rejects.toThrow();
  });

  it('file lock API fenced task keyini runtime sinirinda da reddeder', async () => {
    expectTypeOf<RedisLockKey>().not.toMatchTypeOf<FileLockKey>();
    const redis = { set: vi.fn(), eval: vi.fn() } as unknown as WwRedis;
    const forged = taskLockKey(randomUUID()) as unknown as FileLockKey;
    await expect(acquireFileLock(redis, forged, 'owner', 10)).rejects.toThrow(/file lock/);
    await expect(renewFileLock(redis, forged, 'owner', 10)).rejects.toThrow(/file lock/);
    await expect(releaseFileLock(redis, forged, 'owner')).rejects.toThrow(/file lock/);
    await expect(transferOrAcquireFileLocks(redis, [forged], 'old', 'new', 10))
      .rejects.toThrow(/file lock/);
    const file = fileLockKey(randomUUID(), 'f'.repeat(40));
    await expect(releaseFileLockUnderTaskLease(
      redis,
      file as unknown as TaskLockKey,
      'task-owner',
      '1',
      file,
      'file-owner',
    )).rejects.toThrow(/task lease/);
    await expect(releaseFileLockUnderTaskLease(
      redis,
      taskLockKey(randomUUID()),
      'task-owner',
      '0',
      file,
      'file-owner',
    )).rejects.toThrow(/fence/);
    expect(redis.set).not.toHaveBeenCalled();
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('file lock anahtarini docs/07 SHA-1 formatiyla kurar ve renewu atomik yapar', async () => {
    const projectId = randomUUID();
    const uppercaseSha1 = 'A'.repeat(40);
    const key = fileLockKey(projectId, uppercaseSha1);
    expect(key).toBe(`ww:lock:file:${projectId}:${'a'.repeat(40)}`);
    expect(() => fileLockKey(projectId, 'a'.repeat(64))).toThrow(/SHA-1/);

    const evalCommand = vi.fn(async () => 1);
    const redis = { eval: evalCommand } as unknown as WwRedis;
    await expect(renewFileLock(redis, key, 'owner', 30)).resolves.toBe(true);
    const renewScript = evalCommand.mock.calls[0]?.[0];
    expect(renewScript).toContain("'expire'");
    expect(renewScript).not.toContain("'del'");
    expect(evalCommand).toHaveBeenCalledWith(expect.any(String), {
      keys: [key],
      arguments: ['owner', '30'],
    });
    await expect(renewFileLock(redis, key, 'owner', 0)).rejects.toThrow(/ttlSec/);
  });

  it('file release ve renew Lua boolean sonucunu strict decode eder', async () => {
    const key = fileLockKey(randomUUID(), 'a'.repeat(40));
    for (const invalid of [2, -1, '1', null, true]) {
      const redis = { eval: vi.fn(async () => invalid) } as unknown as WwRedis;
      await expect(renewFileLock(redis, key, 'owner', 10))
        .rejects.toThrow(/0 veya 1/);
      await expect(releaseFileLock(redis, key, 'owner'))
        .rejects.toThrow(/0 veya 1/);
      await expect(transferOrAcquireFileLocks(redis, [key], 'old', 'new', 10))
        .rejects.toThrow(/0 veya 1/);
    }
  });

  it('file lock atomik snapshot sonucunu strict decode eder', async () => {
    const key = fileLockKey(randomUUID(), '8'.repeat(40));
    await expect(inspectFileLock({
      eval: vi.fn(async () => ['owner', 12_345]),
    } as unknown as WwRedis, key)).resolves.toEqual({ owner: 'owner', pttlMs: 12_345 });
    await expect(inspectFileLock({
      eval: vi.fn(async () => [null, -2]),
    } as unknown as WwRedis, key)).resolves.toEqual({ owner: null, pttlMs: -2 });
    for (const invalid of [
      null,
      ['owner'],
      ['owner', '1000'],
      [null, 1000],
      ['owner', -2],
      ['', 1000],
    ]) {
      await expect(inspectFileLock({
        eval: vi.fn(async () => invalid),
      } as unknown as WwRedis, key)).rejects.toThrow(/inspect|owner/);
    }
  });

  it('file transfer siniri sirali ve tekil canonical anahtar ister', async () => {
    const projectId = randomUUID();
    const first = fileLockKey(projectId, 'a'.repeat(40));
    const second = fileLockKey(projectId, 'b'.repeat(40));
    const redis = { eval: vi.fn(async () => 1) } as unknown as WwRedis;
    await expect(transferFileLocks(redis, [second, first], 'old', 'new', 10))
      .rejects.toThrow(/sirali/);
    await expect(transferFileLocks(redis, [first, first], 'old', 'new', 10))
      .rejects.toThrow(/tekil/);
    await expect(transferFileLocks(redis, [first, second], 'old', 'new', 10))
      .resolves.toBe(true);
    expect(redis.eval).toHaveBeenCalledWith(expect.any(String), {
      keys: [first, second],
      arguments: ['old', 'new', '10'],
    });
    await expect(transferOrAcquireFileLocks(redis, [second, first], 'old', 'new', 10))
      .rejects.toThrow(/sirali/);
    await expect(transferOrAcquireFileLocks(redis, [first, first], 'old', 'new', 10))
      .rejects.toThrow(/tekil/);
    await expect(transferOrAcquireFileLocks(redis, [first, second], 'old', 'new', 10))
      .resolves.toBe(true);
  });
});

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
  const q = queueKey(randomUUID());
  const cleanupKeys = new Set<string>([q]);

  async function pendingQueue(count: number): Promise<{
    messages: Awaited<ReturnType<typeof readQueue>>['messages'];
    stream: QueueKey;
  }> {
    const stream = queueKey(randomUUID());
    cleanupKeys.add(stream);
    await ensureGroup(r, stream, 'scheduler');
    const taskIds: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const taskId = randomUUID();
      taskIds.push(taskId);
      await enqueueTask(r, stream, taskId);
    }
    const result = await readQueue(r, stream, 'scheduler', 'consumer-a', { count });
    expect(result.invalid).toEqual([]);
    expect(result.messages.map((message) => message.taskId)).toEqual(taskIds);
    return { messages: result.messages, stream };
  }

  async function waitForReclaimIdle(): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, MIN_RECLAIM_IDLE_MS + 25));
  }

  beforeAll(async () => {
    r = await createRedis();
    await ensureGroup(r, q, 'scheduler');
  });
  afterAll(async () => {
    await r.del([...cleanupKeys]);
    // Test istemcisi gecicidir; QUIT yaniti beklenmeden soket kosulsuz kapatilir.
    r.destroy();
  });

  it('kuyruk: xadd + grup okuma + ack', async () => {
    const taskId = randomUUID();
    await enqueueTask(r, q, taskId.toUpperCase());
    const result = await readQueue(r, q, 'scheduler', 'c1');
    expect(result.messages).toEqual([expect.objectContaining({ taskId })]);
    expect(result.invalid).toEqual([]);
    await ackQueue(r, q, 'scheduler', result.messages[0]!.msgId);
    expect((await readQueue(r, q, 'scheduler', 'c1')).messages).toEqual([]);
  });

  it('file kilidi: NX alma; sahibi olmayan birakamaz', async () => {
    const key = fileLockKey(randomUUID(), 'a'.repeat(40));
    cleanupKeys.add(key);
    expect(await acquireFileLock(r, key, 'owner-a', 10)).toBe(true);
    expect(await getFileLockOwner(r, key)).toBe('owner-a');
    expect(await acquireFileLock(r, key, 'owner-b', 10)).toBe(false);
    expect(await renewFileLock(r, key, 'owner-b', 30)).toBe(false);
    expect(await renewFileLock(r, key, 'owner-a', 30)).toBe(true);
    expect(await r.ttl(key)).toBeGreaterThan(20);
    expect(await releaseFileLock(r, key, 'owner-b')).toBe(false);
    expect(await releaseFileLock(r, key, 'owner-a')).toBe(true);
    expect(await getFileLockOwner(r, key)).toBeNull();
    expect(await acquireFileLock(r, key, 'owner-b', 10)).toBe(true);
    await r.del(key);
  });

  it('expired file kilidi renew edilmez', async () => {
    const key = fileLockKey(randomUUID(), 'b'.repeat(40));
    cleanupKeys.add(key);
    expect(await acquireFileLock(r, key, 'owner-a', 1)).toBe(true);
    await vi.waitFor(async () => {
      expect(await r.exists(key)).toBe(0);
    }, { timeout: 2_000, interval: 25 });
    expect(await renewFileLock(r, key, 'owner-a', 10)).toBe(false);
  });

  it('file lock owner ve PTTL degerini gercek Redis Lua calismasinda atomik okur', async () => {
    const key = fileLockKey(randomUUID(), '9'.repeat(40));
    cleanupKeys.add(key);
    expect(await inspectFileLock(r, key)).toEqual({ owner: null, pttlMs: -2 });
    expect(await acquireFileLock(r, key, 'snapshot-owner', 30)).toBe(true);
    const held = await inspectFileLock(r, key);
    expect(held.owner).toBe('snapshot-owner');
    expect(held.pttlMs).toBeGreaterThan(25_000);
    expect(held.pttlMs).toBeLessThanOrEqual(30_000);
    await r.persist(key);
    expect(await inspectFileLock(r, key)).toEqual({ owner: 'snapshot-owner', pttlMs: -1 });
    await releaseFileLock(r, key, 'snapshot-owner');
    expect(await inspectFileLock(r, key)).toEqual({ owner: null, pttlMs: -2 });
  });

  it('rollback file kilidini yalniz exact task owner/fence hala gecerliyken siler', async () => {
    const taskId = randomUUID();
    const taskKey = taskLockKey(taskId);
    const fenceKey = `${taskKey}:fence`;
    const key = fileLockKey(randomUUID(), '0'.repeat(40));
    cleanupKeys.add(taskKey);
    cleanupKeys.add(fenceKey);
    cleanupKeys.add(key);
    const stale = await acquireFencedLease(r, taskKey, 'stale-cleanup', 30_000, '0');
    if (stale === null) throw new Error('stale task lease alinamadi');
    expect(await acquireFileLock(r, key, 'attempt-owner', 30)).toBe(true);
    expect(await releaseFileLockUnderTaskLease(
      r,
      taskKey,
      stale.owner,
      stale.fence,
      key,
      'attempt-owner',
    )).toBe(true);
    expect(await getFileLockOwner(r, key)).toBeNull();

    expect(await acquireFileLock(r, key, 'attempt-owner', 30)).toBe(true);
    expect(await releaseFencedLease(r, stale)).toBe(true);
    const fresh = await acquireFencedLease(r, taskKey, 'fresh-retry', 30_000, stale.fence);
    if (fresh === null) throw new Error('fresh task lease alinamadi');
    expect(await releaseFileLockUnderTaskLease(
      r,
      taskKey,
      stale.owner,
      stale.fence,
      key,
      'attempt-owner',
    )).toBe(false);
    expect(await getFileLockOwner(r, key)).toBe('attempt-owner');
    expect(await releaseFileLockUnderTaskLease(
      r,
      taskKey,
      fresh.owner,
      fresh.fence,
      key,
      'foreign-owner',
    )).toBe(false);
    expect(await getFileLockOwner(r, key)).toBe('attempt-owner');
    expect(await releaseFencedLease(r, fresh)).toBe(true);
  });

  it('file kilit setini sahiplik tam eslesirse atomik transfer eder', async () => {
    const projectId = randomUUID();
    const first = fileLockKey(projectId, 'c'.repeat(40));
    const second = fileLockKey(projectId, 'd'.repeat(40));
    cleanupKeys.add(first);
    cleanupKeys.add(second);
    expect(await acquireFileLock(r, first, 'owner-a', 10)).toBe(true);
    expect(await acquireFileLock(r, second, 'intruder', 10)).toBe(true);
    expect(await transferFileLocks(r, [first, second], 'owner-a', 'owner-b', 10)).toBe(false);
    expect(await r.get(first)).toBe('owner-a');
    expect(await r.get(second)).toBe('intruder');
    expect(await releaseFileLock(r, second, 'intruder')).toBe(true);
    expect(await acquireFileLock(r, second, 'owner-a', 10)).toBe(true);
    expect(await transferFileLocks(r, [first, second], 'owner-a', 'owner-b', 20)).toBe(true);
    expect(await r.get(first)).toBe('owner-b');
    expect(await r.get(second)).toBe('owner-b');
  });

  it('file lock transfer-or-acquire old/new/expired karmasini atomik uzlastirir ve TTL yeniler', async () => {
    const projectId = randomUUID();
    const first = fileLockKey(projectId, '1'.repeat(40));
    const second = fileLockKey(projectId, '2'.repeat(40));
    const expired = fileLockKey(projectId, '3'.repeat(40));
    for (const key of [first, second, expired]) cleanupKeys.add(key);
    expect(await acquireFileLock(r, first, 'old-owner', 10)).toBe(true);
    expect(await acquireFileLock(r, second, 'new-owner', 10)).toBe(true);
    expect(await acquireFileLock(r, expired, 'old-owner', 10)).toBe(true);
    await r.del(expired);

    expect(await transferOrAcquireFileLocks(
      r,
      [first, second, expired],
      'old-owner',
      'new-owner',
      30,
    )).toBe(true);
    for (const key of [first, second, expired]) {
      expect(await getFileLockOwner(r, key)).toBe('new-owner');
      expect(await r.ttl(key)).toBeGreaterThan(20);
    }
  });

  it('file lock transfer-or-acquire foreign owner gorurse hicbir anahtari degistirmez', async () => {
    const projectId = randomUUID();
    const old = fileLockKey(projectId, '4'.repeat(40));
    const absent = fileLockKey(projectId, '5'.repeat(40));
    const foreign = fileLockKey(projectId, '6'.repeat(40));
    for (const key of [old, absent, foreign]) cleanupKeys.add(key);
    expect(await acquireFileLock(r, old, 'old-owner', 30)).toBe(true);
    expect(await acquireFileLock(r, foreign, 'intruder', 30)).toBe(true);

    expect(await transferOrAcquireFileLocks(
      r,
      [old, absent, foreign],
      'old-owner',
      'new-owner',
      30,
    )).toBe(false);
    expect(await getFileLockOwner(r, old)).toBe('old-owner');
    expect(await getFileLockOwner(r, absent)).toBeNull();
    expect(await getFileLockOwner(r, foreign)).toBe('intruder');
  });

  it('file lock transfer-or-acquire accepted-response kaybinda exact retry ile uzlasir', async () => {
    const projectId = randomUUID();
    const first = fileLockKey(projectId, '7'.repeat(40));
    const second = fileLockKey(projectId, '8'.repeat(40));
    for (const key of [first, second]) cleanupKeys.add(key);
    expect(await acquireFileLock(r, first, 'old-owner', 10)).toBe(true);
    let loseResponse = true;
    const uncertain = new Proxy(r, {
      get(target, property) {
        if (property === 'eval') return async (
          script: Parameters<WwRedis['eval']>[0],
          options: Parameters<WwRedis['eval']>[1],
        ) => {
          const result = await target.eval(script, options);
          if (loseResponse) {
            loseResponse = false;
            throw new Error('simulated Redis response loss after accepted eval');
          }
          return result;
        };
        const member: unknown = Reflect.get(target, property, target);
        return typeof member === 'function' ? member.bind(target) : member;
      },
    });

    await expect(transferOrAcquireFileLocks(
      uncertain,
      [first, second],
      'old-owner',
      'new-owner',
      30,
    )).rejects.toThrow(/response loss/);
    expect(await getFileLockOwner(r, first)).toBe('new-owner');
    expect(await getFileLockOwner(r, second)).toBe('new-owner');
    await expect(transferOrAcquireFileLocks(
      r,
      [first, second],
      'old-owner',
      'new-owner',
      30,
    )).resolves.toBe(true);
  });

  it('pending mesaji ancak idle esigi dolunca reclaim eder ve sayaci artirir', async () => {
    const { messages, stream } = await pendingQueue(1);
    const before = await r.xPendingRange(stream, 'scheduler', '-', '+', 10);
    expect(before[0]?.deliveriesCounter).toBe(1);

    const tooEarly = await reclaimQueue(r, stream, 'scheduler', 'consumer-b', {
      minIdleMs: 10_000,
      maxDeliveries: 3,
    });
    expect(tooEarly.claimed).toEqual([]);
    await waitForReclaimIdle();

    const result = await reclaimQueue(r, stream, 'scheduler', 'consumer-b', {
      minIdleMs: MIN_RECLAIM_IDLE_MS,
      maxDeliveries: 3,
    });
    expect(result).toEqual({
      nextCursor: '0-0',
      claimed: [{
        msgId: messages[0]!.msgId,
        taskId: messages[0]!.taskId,
        deliveryCount: 2,
      }],
      exhausted: [],
      invalid: [],
      deletedIds: [],
    });
  });

  it('pozitif idle tabani ikinci anlik consumerin reclaim ve false exhaustion yapmasini onler', async () => {
    const { stream } = await pendingQueue(1);
    await waitForReclaimIdle();
    const results = await Promise.all([
      reclaimQueue(r, stream, 'scheduler', 'consumer-b', {
        minIdleMs: MIN_RECLAIM_IDLE_MS,
        maxDeliveries: 2,
      }),
      reclaimQueue(r, stream, 'scheduler', 'consumer-c', {
        minIdleMs: MIN_RECLAIM_IDLE_MS,
        maxDeliveries: 2,
      }),
    ]);

    expect(results.flatMap((result) => result.exhausted)).toEqual([]);
    expect(results.flatMap((result) => result.claimed)
      .map((message) => message.deliveryCount)).toEqual([2]);
    expect(results.filter((result) => result.claimed.length === 0)).toHaveLength(1);
  });

  it('bozuk task ID gecerli kardesi zehirlemez ve invalid girdiyi ACK etmez', async () => {
    const stream = queueKey(randomUUID());
    cleanupKeys.add(stream);
    await ensureGroup(r, stream, 'scheduler');
    const invalidMsgId = await r.xAdd(stream, '*', { task_id: 'not-a-uuid' });
    const validTaskId = randomUUID();
    await enqueueTask(r, stream, validTaskId);
    const initial = await readQueue(r, stream, 'scheduler', 'consumer-a', { count: 2 });
    expect(initial.invalid).toEqual([{
      msgId: invalidMsgId,
      deliveryCount: 1,
      reason: 'invalid_task_id',
    }]);
    expect(initial.messages[0]?.taskId).toBe(validTaskId);
    await waitForReclaimIdle();

    const reclaimed = await reclaimQueue(r, stream, 'scheduler', 'consumer-b', {
      minIdleMs: MIN_RECLAIM_IDLE_MS,
      maxDeliveries: 3,
      count: 2,
    });
    expect(reclaimed.invalid).toEqual([{
      msgId: invalidMsgId,
      deliveryCount: 2,
      reason: 'invalid_task_id',
    }]);
    expect(reclaimed.claimed[0]?.taskId).toBe(validTaskId);
    const pendingIds = (await r.xPendingRange(stream, 'scheduler', '-', '+', 10))
      .map((entry) => entry.id);
    expect(pendingIds).toContain(invalidMsgId);
  });

  it('maxDeliveries toplam teslim sinirini dahil ederek bounded retry uygular', async () => {
    const { stream } = await pendingQueue(1);
    await waitForReclaimIdle();
    const lastAllowed = await reclaimQueue(r, stream, 'scheduler', 'consumer-b', {
      minIdleMs: MIN_RECLAIM_IDLE_MS,
      maxDeliveries: 2,
    });
    expect(lastAllowed.claimed[0]?.deliveryCount).toBe(2);
    expect(lastAllowed.exhausted).toEqual([]);

    await waitForReclaimIdle();
    const overLimit = await reclaimQueue(r, stream, 'scheduler', 'consumer-c', {
      minIdleMs: MIN_RECLAIM_IDLE_MS,
      maxDeliveries: 2,
    });
    expect(overLimit.claimed).toEqual([]);
    expect(overLimit.exhausted[0]?.deliveryCount).toBe(3);
  });

  it('opaque cursor ile tum PEL taramasini kayipsiz ve tekrarsiz surdurur', async () => {
    const { messages, stream } = await pendingQueue(4);
    await waitForReclaimIdle();
    const reclaimedIds: string[] = [];
    let cursor = '0-0';
    let scans = 0;
    do {
      const page = await reclaimQueue(r, stream, 'scheduler', 'consumer-b', {
        minIdleMs: MIN_RECLAIM_IDLE_MS,
        maxDeliveries: 3,
        count: 1,
        cursor,
      });
      reclaimedIds.push(...page.claimed.map((entry) => entry.msgId));
      cursor = page.nextCursor;
      scans += 1;
      expect(scans).toBeLessThanOrEqual(5);
    } while (cursor !== '0-0');

    expect(reclaimedIds).toEqual(messages.map((message) => message.msgId));
    expect(new Set(reclaimedIds).size).toBe(4);
  });

  it('streamden silinmis pending IDyi raporlar ve PELden temizler', async () => {
    const { messages, stream } = await pendingQueue(1);
    const deletedId = messages[0]!.msgId;
    expect(await r.xDel(stream, deletedId)).toBe(1);
    await waitForReclaimIdle();

    const result = await reclaimQueue(r, stream, 'scheduler', 'consumer-b', {
      minIdleMs: MIN_RECLAIM_IDLE_MS,
      maxDeliveries: 2,
    });
    expect(result.claimed).toEqual([]);
    expect(result.exhausted).toEqual([]);
    expect(result.invalid).toEqual([]);
    expect(result.deletedIds).toEqual([deletedId]);
    expect(await r.xPendingRange(stream, 'scheduler', '-', '+', 10)).toEqual([]);
  });

  it('owned BLOCK read abortta duplicatei yok eder, ana clienti acik tutar ve yeniden kurulur', async () => {
    const stream = queueKey(randomUUID());
    cleanupKeys.add(stream);
    const controller = new AbortController();
    const reader = createQueueReader(r);
    try {
      await ensureGroup(r, stream, 'blocking-scheduler');
      const startedAt = Date.now();
      const work = reader.read(
        stream,
        'blocking-scheduler',
        'blocking-consumer',
        { blockMs: 1_000, signal: controller.signal },
      );
      setTimeout(() => controller.abort(), 25);
      await expect(work).rejects.toMatchObject({ name: 'AbortError' });
      expect(Date.now() - startedAt).toBeLessThan(500);

      const pingStartedAt = Date.now();
      await expect(r.ping()).resolves.toBe('PONG');
      expect(Date.now() - pingStartedAt).toBeLessThan(500);

      const taskId = randomUUID();
      await enqueueTask(r, stream, taskId);
      const recovered = await reader.read(
        stream,
        'blocking-scheduler',
        'blocking-consumer',
        { blockMs: 100 },
      );
      expect(recovered.messages).toEqual([expect.objectContaining({ taskId })]);
      await ackQueue(r, stream, 'blocking-scheduler', recovered.messages[0]!.msgId);
    } finally {
      reader.stop();
    }
  });

  it('real node-redis pre-abort duplicate veya komut baslatmaz ve rejection sizdirmaz', async () => {
    const stream = queueKey(randomUUID());
    cleanupKeys.add(stream);
    await ensureGroup(r, stream, 'pre-abort-scheduler');
    const duplicate = vi.spyOn(r, 'duplicate');
    const reader = createQueueReader(r);
    const controller = new AbortController();
    controller.abort();
    try {
      const unhandled = await withUnhandledRejectionCapture(async () => {
        await expect(reader.read(
          stream,
          'pre-abort-scheduler',
          'consumer',
          { blockMs: 100, signal: controller.signal },
        )).rejects.toMatchObject({ name: 'AbortError' });
      });
      expect(unhandled).toEqual([]);
      expect(duplicate).not.toHaveBeenCalled();
      await expect(r.ping()).resolves.toBe('PONG');
    } finally {
      reader.stop();
      duplicate.mockRestore();
    }
  });

  it('heartbeat TTLyi yeniler ve yenilenen expiry sonrasi agenti canli saymaz', async () => {
    const agentId = randomUUID();
    cleanupKeys.add(heartbeatKey(agentId));
    expect(await checkHeartbeat(r, agentId)).toBe(false);
    // TTL'ler bilerek cömert: test YENİLEMENİN TAZELEDİĞİNİ kanıtlar, makine
    // hızını değil. Dar marjlar paralel yük altında ilgisiz biçimde düşüyordu.
    await setHeartbeat(r, agentId, 2_000);
    expect(await checkHeartbeat(r, agentId)).toBe(true);

    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    const beforeRenew = await r.pTTL(heartbeatKey(agentId));
    await setHeartbeat(r, agentId, 3_000);
    const afterRenew = await r.pTTL(heartbeatKey(agentId));
    // Mutlak eşik yok: yenileme kalan süreyi ARTIRMALI.
    expect(afterRenew).toBeGreaterThan(beforeRenew);
    expect(afterRenew).toBeLessThanOrEqual(3_000);

    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(await checkHeartbeat(r, agentId)).toBe(true);

    // Süre dolması ayrı ve kısa bir TTL ile kanıtlanır.
    await setHeartbeat(r, agentId, 50);
    await vi.waitFor(async () => {
      expect(await checkHeartbeat(r, agentId)).toBe(false);
    }, { timeout: 1_000, interval: 10 });
    await expect(setHeartbeat(r, agentId, 0)).rejects.toThrow(/ttlMs/);
    expect(() => heartbeatKey('agent-1')).toThrow();
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
