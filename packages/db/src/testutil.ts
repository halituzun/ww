// Yerel koşuda servis yoksa entegrasyon testleri atlanır. Faz kapatma kapısı
// WW_REQUIRE_INTEGRATION=1 kullandığında aynı durum görünür bir test hatasıdır.
import { createCh } from './client.js';
import { createRedis } from './redis.js';

const integrationRequired = (): boolean => process.env['WW_REQUIRE_INTEGRATION'] === '1';

function unavailable(service: 'ClickHouse' | 'Redis', error: unknown): false {
  if (integrationRequired()) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${service} entegrasyon servisi kullanılamıyor (WW_REQUIRE_INTEGRATION=1): ${detail}`,
    );
  }
  return false;
}

export async function clickhouseUp(): Promise<boolean> {
  const ch = createCh({ database: 'default' });
  try {
    const result = await ch.query({ query: 'SELECT 1 AS ok', format: 'JSONEachRow' });
    await result.json();
    return true;
  } catch (error) {
    return unavailable('ClickHouse', error);
  } finally {
    await ch.close();
  }
}

export async function redisUp(): Promise<boolean> {
  let redis: Awaited<ReturnType<typeof createRedis>> | undefined;
  try {
    redis = await createRedis(undefined, {
      connectTimeoutMs: 500,
      maxReconnectAttempts: 0,
      onError: () => undefined,
    });
    await redis.ping();
    return true;
  } catch (error) {
    return unavailable('Redis', error);
  } finally {
    if (redis?.isOpen) redis.destroy();
  }
}
