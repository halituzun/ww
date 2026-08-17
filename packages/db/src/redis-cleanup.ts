import { createRedis } from './redis.js';

/**
 * Sızan test anahtarlarını temizler.
 *
 * Entegrasyon testleri `ww:queue:*`, `ww:task:*:claim`, `ww:lock:*` gibi
 * anahtarlar yaratır. Test ortasında düşerse veya TTL'siz yazılırsa anahtar
 * kalır. Birikince Redis yavaşlar ve fenced-lease gibi zamanlamaya duyarlı
 * testler İLGİSİZ biçimde düşmeye başlar — yani sızıntı sağlam kodu kırık
 * gösterir. ClickHouse tarafındaki `dropLeakedTestDatabases` ile aynı sorun.
 */
export async function dropLeakedRedisKeys(options: {
  patterns?: readonly string[];
  batch?: number;
} = {}): Promise<number> {
  // Testler iletişim/effect anahtarları da bırakır; dar desen listesi
  // sızıntının küçük bir kısmını temizleyip sorunu sürdürür.
  const patterns = options.patterns ?? [
    'ww:queue:*', 'ww:task:*', 'ww:lock:*', 'ww:hb:*',
    'ww:message:*', 'ww:effect:*', 'ww:receipt:*', 'ww:agent:*',
  ];
  const batch = options.batch ?? 500;
  const redis = await createRedis();
  let removed = 0;
  try {
    for (const pattern of patterns) {
      let cursor = '0';
      do {
        const reply = await redis.scan(cursor as never, { MATCH: pattern, COUNT: batch });
        cursor = String(reply.cursor);
        const keys = reply.keys as string[];
        if (keys.length > 0) {
          await redis.del(keys);
          removed += keys.length;
        }
      } while (cursor !== '0');
    }
    return removed;
  } finally {
    await redis.quit();
  }
}
