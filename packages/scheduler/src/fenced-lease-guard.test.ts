import type { FencedLease, WwRedis } from '@ww/db';
import { describe, expect, it, vi } from 'vitest';
import { FencedLeaseGuard } from './fenced-lease-guard.js';

const lease: FencedLease = Object.freeze({
  lockKey: 'ww:task:00000000-0000-4000-8000-000000000001:claim',
  owner: 'test-owner',
  fence: '1',
});

describe('FencedLeaseGuard lifecycle', () => {
  it('stop sonrasi assertHeld basarili gorunemez', async () => {
    const redis = { eval: vi.fn().mockResolvedValue(1) } as unknown as WwRedis;
    const guard = new FencedLeaseGuard(redis, lease, 60_000);

    expect(await guard.stop(false)).toBe(true);
    await expect(guard.assertHeld()).rejects.toMatchObject({ code: 'STALE_FENCE' });
  });

  it('renew lock kaybini kalici olarak stale sayar', async () => {
    const redis = { eval: vi.fn().mockResolvedValue(0) } as unknown as WwRedis;
    const guard = new FencedLeaseGuard(redis, lease, 60_000);

    await expect(guard.assertHeld()).rejects.toMatchObject({ code: 'STALE_FENCE' });
    await expect(guard.assertHeld()).rejects.toMatchObject({ code: 'STALE_FENCE' });
    expect(await guard.stop(false)).toBe(false);
  });

  it('Redis renew hatasini cause tasiyan typed STALE_FENCE hatasina cevirir', async () => {
    const transportError = new Error('redis connection reset');
    const redis = { eval: vi.fn().mockRejectedValue(transportError) } as unknown as WwRedis;
    const guard = new FencedLeaseGuard(redis, lease, 60_000);

    await expect(guard.assertHeld()).rejects.toMatchObject({
      name: 'SchedulerError',
      code: 'STALE_FENCE',
      cause: transportError,
    });
    await expect(guard.assertHeld()).rejects.toMatchObject({
      code: 'STALE_FENCE',
      cause: transportError,
    });
    expect(await guard.stop(false)).toBe(false);
  });

  it('devam eden basarili renew sirasindaki stop asserti stale yapar', async () => {
    let resolveRenew: ((value: number) => void) | undefined;
    const redis = {
      eval: vi.fn().mockImplementation(() => new Promise<number>((resolve) => {
        resolveRenew = resolve;
      })),
    } as unknown as WwRedis;
    const guard = new FencedLeaseGuard(redis, lease, 60_000);
    const assertion = guard.assertHeld();
    await vi.waitFor(() => expect(resolveRenew).toBeDefined());
    const stopping = guard.stop(false);
    resolveRenew?.(1);

    await expect(assertion).rejects.toMatchObject({ code: 'STALE_FENCE' });
    expect(await stopping).toBe(true);
  });

  it('release false ve ayni owner/fence gozleminde UNCERTAIN_WRITE verir', async () => {
    const redis = {
      eval: vi.fn(async () => 0),
      hGetAll: vi.fn(async () => ({ owner: lease.owner, fence: lease.fence })),
    } as unknown as WwRedis;
    const guard = new FencedLeaseGuard(redis, lease, 60_000);

    await expect(guard.stop(true)).rejects.toMatchObject({
      name: 'SchedulerError',
      code: 'UNCERTAIN_WRITE',
      cause: expect.any(Error),
    });
  });

  it('accepted release ACK kaybinda owner yoklugunu gorup basarili sayar', async () => {
    const releaseFailure = new Error('simulated accepted ACK loss');
    const redis = {
      eval: vi.fn(async () => {
        throw releaseFailure;
      }),
      hGetAll: vi.fn(async () => ({})),
    } as unknown as WwRedis;
    const guard = new FencedLeaseGuard(redis, lease, 60_000);

    await expect(guard.stop(true)).resolves.toBe(true);
    expect(redis.hGetAll).toHaveBeenCalledWith(lease.lockKey);
  });
});
