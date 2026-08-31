import { describe, expect, it } from 'vitest';
import { createRedis } from './redis.js';
import { dropLeakedRedisKeys } from './redis-cleanup.js';

let up = true;
try { const r = await createRedis(); await r.ping(); await r.quit(); } catch { up = false; }

describe.skipIf(!up)('dropLeakedRedisKeys', () => {
  it('desene uyan anahtarları siler, uymayanı korur', async () => {
    const redis = await createRedis();
    const stamp = Date.now();
    await redis.set(`ww:cleanuptest:${stamp}:a`, '1');
    await redis.set(`ww:cleanuptest:${stamp}:b`, '1');
    await redis.set(`ww:korunan:${stamp}`, '1');

    const removed = await dropLeakedRedisKeys({ patterns: [`ww:cleanuptest:${stamp}:*`] });
    expect(removed).toBe(2);
    // Desen dışındaki anahtar silinmemeli: geniş temizlik üretimi bozar.
    expect(await redis.exists(`ww:korunan:${stamp}`)).toBe(1);

    await redis.del(`ww:korunan:${stamp}`);
    await redis.quit();
  });

  it('eşleşme yoksa sıfır döner', async () => {
    expect(await dropLeakedRedisKeys({ patterns: [`ww:yok:${Date.now()}:*`] })).toBe(0);
  });
});
