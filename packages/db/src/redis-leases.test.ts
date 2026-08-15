import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRedis, type WwRedis } from './redis.js';
import {
  acquireFencedLease,
  agentLockKey,
  getFencedLease,
  leaseFenceKey,
  messageLockKey,
  receiptLockKey,
  releaseFencedLease,
  renewFencedLease,
  taskLockKey,
  type FencedLease,
  type RedisLockKey,
} from './redis-leases.js';
import { redisUp } from './testutil.js';

const up = await redisUp();

describe('fenced lease sinir dogrulamasi', () => {
  it('task, agent, message ve receipt anahtarlarini strict UUID ile kurar', () => {
    const taskId = randomUUID();
    const agentId = randomUUID();
    const messageId = randomUUID();
    const receiptId = randomUUID();

    expect(taskLockKey(taskId)).toBe(`ww:task:${taskId}:claim`);
    expect(agentLockKey(agentId)).toBe(`ww:agent:${agentId}:claim`);
    expect(messageLockKey(messageId)).toBe(`ww:message:${messageId}:claim`);
    expect(receiptLockKey(receiptId)).toBe(`ww:receipt:${receiptId}:claim`);
    expect(leaseFenceKey(taskLockKey(taskId))).toBe(`ww:task:${taskId}:claim:fence`);
  });

  it('gecersiz UUID ve elle uretilmis lock key degerlerini fail-closed reddeder', async () => {
    expect(() => taskLockKey('task-1')).toThrow();
    expect(() => agentLockKey('agent-1')).toThrow();
    expect(() => messageLockKey('')).toThrow();
    expect(() => receiptLockKey('00000000-0000-0000-0000-000000000000')).toThrow();

    const redis = { eval: vi.fn() } as unknown as WwRedis;
    await expect(acquireFencedLease(
      redis,
      'ww:task:not-a-uuid:claim' as RedisLockKey,
      'owner',
      100,
      '0',
    )).rejects.toThrow();
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('builder uppercase UUIDyi canonicalize eder, elle uppercase aliasi EVALden once reddeder', async () => {
    const id = randomUUID();
    expect(taskLockKey(id.toUpperCase())).toBe(taskLockKey(id));
    const redis = { eval: vi.fn() } as unknown as WwRedis;

    await expect(acquireFencedLease(
      redis,
      `ww:task:${id.toUpperCase()}:claim` as RedisLockKey,
      'owner',
      100,
      '0',
    )).rejects.toThrow(/canonical/);
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('bos owner, gecersiz TTL ve gecersiz fence icin Redis cagirmadan durur', async () => {
    const redis = { eval: vi.fn() } as unknown as WwRedis;
    const lockKey = taskLockKey(randomUUID());
    await expect(acquireFencedLease(redis, lockKey, '  ', 100, '0'))
      .rejects.toThrow(/owner/);
    await expect(acquireFencedLease(redis, lockKey, 'owner', 0, '0'))
      .rejects.toThrow(/ttlMs/);
    await expect(acquireFencedLease(redis, lockKey, 'owner', 100, '-1'))
      .rejects.toThrow(/minimumFence/);
    await expect(acquireFencedLease(
      redis,
      lockKey,
      'owner',
      100,
      Number.MAX_SAFE_INTEGER.toString(),
    )).rejects.toThrow(/minimumFence/);
    await expect(renewFencedLease(redis, {
      lockKey,
      owner: 'owner',
      fence: '0',
    }, 100)).rejects.toThrow(/fence/);
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('renew ve release Lua boolean cevaplarini yalniz exact number 0|1 kabul eder', async () => {
    const lease: FencedLease = {
      lockKey: taskLockKey(randomUUID()),
      owner: 'owner',
      fence: '1',
    };
    for (const invalid of [2, -1, '1', null, true]) {
      const redis = { eval: vi.fn(async () => invalid) } as unknown as WwRedis;
      await expect(renewFencedLease(redis, lease, 100)).rejects.toThrow(/0 veya 1/);
      await expect(releaseFencedLease(redis, lease)).rejects.toThrow(/0 veya 1/);
    }
  });
});

describe.skipIf(!up)('fenced lease canli Redis davranisi', () => {
  let redis: WwRedis;
  const cleanupKeys = new Set<string>();

  function freshTaskKey(): ReturnType<typeof taskLockKey> {
    const key = taskLockKey(randomUUID());
    cleanupKeys.add(key);
    cleanupKeys.add(leaseFenceKey(key));
    return key;
  }

  beforeAll(async () => {
    redis = await createRedis();
  });

  afterEach(async () => {
    if (cleanupKeys.size > 0) await redis.del([...cleanupKeys]);
    cleanupKeys.clear();
  });

  afterAll(() => {
    redis.destroy();
  });

  it('es zamanli acquire icin tek kazanan ve tek fence uretir', async () => {
    const key = freshTaskKey();
    const results = await Promise.all([
      acquireFencedLease(redis, key, 'owner-a', 1_000, '0'),
      acquireFencedLease(redis, key, 'owner-b', 1_000, '0'),
    ]);

    const acquired = results.filter((lease): lease is FencedLease => lease !== null);
    expect(acquired).toHaveLength(1);
    expect(acquired[0]!.fence).toBe('1');
    expect(results.filter((lease) => lease === null)).toHaveLength(1);
    expect(await redis.get(leaseFenceKey(key))).toBe('1');
  });

  it('yalniz owner ve fence birlikte eslesirse renew/release eder', async () => {
    const key = freshTaskKey();
    const lease = await acquireFencedLease(redis, key, 'owner-a', 80, '0');
    expect(lease).not.toBeNull();
    const current = lease!;
    const wrongOwner = { ...current, owner: 'owner-b' };
    const wrongFence = { ...current, fence: '2' };

    expect(await renewFencedLease(redis, wrongOwner, 200)).toBe(false);
    expect(await renewFencedLease(redis, wrongFence, 200)).toBe(false);
    expect(await releaseFencedLease(redis, wrongOwner)).toBe(false);
    expect(await releaseFencedLease(redis, wrongFence)).toBe(false);
    expect(await renewFencedLease(redis, current, 500)).toBe(true);
    expect(await getFencedLease(redis, key)).toEqual(current);
    expect(await redis.pTTL(key)).toBeGreaterThan(100);
    expect(await releaseFencedLease(redis, current)).toBe(true);
    expect(await getFencedLease(redis, key)).toBeNull();
    expect(await releaseFencedLease(redis, current)).toBe(false);
  });

  it('expiry sonrasi daha yuksek fence verir ve eski lease yeni sahibi bozamaz', async () => {
    const key = freshTaskKey();
    const oldLease = await acquireFencedLease(redis, key, 'owner-a', 25, '0');
    expect(oldLease).not.toBeNull();
    await vi.waitFor(async () => {
      expect(await redis.exists(key)).toBe(0);
    }, { timeout: 1_000, interval: 10 });

    const currentLease = await acquireFencedLease(redis, key, 'owner-b', 1_000, '1');
    expect(currentLease).toMatchObject({ owner: 'owner-b', fence: '2' });
    expect(await renewFencedLease(redis, oldLease!, 1_000)).toBe(false);
    expect(await releaseFencedLease(redis, oldLease!)).toBe(false);
    expect(await redis.hGet(key, 'owner')).toBe('owner-b');
    expect(await releaseFencedLease(redis, currentLease!)).toBe(true);
  });

  it('Redis kaybi sonrasi durable minimumFence ile token tekrarini onler', async () => {
    const key = freshTaskKey();
    const oldLease = await acquireFencedLease(redis, key, 'owner-a', 1_000, '0');
    expect(oldLease?.fence).toBe('1');
    await redis.del(key, leaseFenceKey(key));

    const recovered = await acquireFencedLease(
      redis,
      key,
      'owner-b',
      1_000,
      oldLease!.fence,
    );
    expect(recovered?.fence).toBe('2');
    expect(await renewFencedLease(redis, oldLease!, 1_000)).toBe(false);
    expect(await releaseFencedLease(redis, oldLease!)).toBe(false);
    expect(await releaseFencedLease(redis, recovered!)).toBe(true);
  });

  it('bozuk fence counterini lock olusturmadan fail-closed reddeder', async () => {
    const key = freshTaskKey();
    await redis.set(leaseFenceKey(key), 'broken');

    await expect(acquireFencedLease(redis, key, 'owner-a', 1_000, '0'))
      .rejects.toThrow(/invalid fenced lease counter/);
    expect(await redis.exists(key)).toBe(0);
  });
});
