import { createClient, type RedisClientType } from 'redis';
import type { WsEnvelope } from '@ww/shared';

export type WwRedis = RedisClientType;

export const EVENTS_CHANNEL = 'ww:events';

export interface RedisConnectOptions {
  connectTimeoutMs?: number;
  maxReconnectAttempts?: number;
  onError?: (error: Error) => void;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 3;
export const SUBSCRIPTION_CLEANUP_TIMEOUT_MS = 500;

const reportRedisError = (error: Error): void => {
  console.error(`[ww] Redis istemci hatası: ${error.message}`);
};

function forceDestroy(client: WwRedis): void {
  try {
    // node-redis destroy() devam eden connect/handshake sırasında da alttaki
    // soketi senkron olarak kapatır; graceful komut kuyruğunu beklemez.
    client.destroy();
  } catch {
    // Cleanup asıl bağlantı/abonelik hatasını gölgelememeli.
  }
}

async function withDeadline<T>(
  work: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);
  });

  try {
    // Promise.race `work` için reject handler kurar; deadline sonrasındaki geç
    // rejection böylece unhandled rejection'a dönüşmez.
    return await Promise.race([work, deadline]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

// Varsayılan port docker-compose.yml ile eşleşir (6380: bu makinede 6379 başka projede).
export async function createRedis(
  url?: string,
  options: RedisConnectOptions = {},
): Promise<WwRedis> {
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const maxReconnectAttempts = options.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
  if (!Number.isFinite(connectTimeoutMs) || connectTimeoutMs <= 0) {
    throw new Error('connectTimeoutMs pozitif bir sayı olmalıdır');
  }
  if (!Number.isInteger(maxReconnectAttempts) || maxReconnectAttempts < 0) {
    throw new Error('maxReconnectAttempts sıfır veya pozitif bir tam sayı olmalıdır');
  }

  const client = createClient({
    url: url ?? process.env['WW_REDIS_URL'] ?? 'redis://localhost:6380',
    socket: {
      connectTimeout: connectTimeoutMs,
      reconnectStrategy: (retries) =>
        retries >= maxReconnectAttempts ? false : Math.min((retries + 1) * 50, 500),
    },
  });

  // node-redis bağlantı hatalarını EventEmitter üzerinden de yayınlar. Varsayılan
  // handler hatayı görünür kılar; sağlık probe'u sonucu boolean'a çevirdiği için susturabilir.
  client.on('error', options.onError ?? reportRedisError);

  const connecting = client.connect();
  try {
    await withDeadline(
      connecting,
      connectTimeoutMs,
      `Redis bağlantısı ${connectTimeoutMs} ms içinde tamamlanmadı`,
    );
    return client as WwRedis;
  } catch (error) {
    forceDestroy(client as WwRedis);
    throw error;
  }
}

export const queueKey = (projectId: string): string => `ww:queue:${projectId}`;

export async function ensureGroup(r: WwRedis, stream: string, group: string): Promise<void> {
  try {
    await r.xGroupCreate(stream, group, '0', { MKSTREAM: true });
  } catch (e) {
    if (!(e instanceof Error && e.message.includes('BUSYGROUP'))) throw e;
  }
}

export async function enqueueTask(r: WwRedis, stream: string, taskId: string): Promise<string> {
  return r.xAdd(stream, '*', { task_id: taskId });
}

export interface QueueMessage {
  msgId: string;
  taskId: string;
}

export async function readQueue(
  r: WwRedis,
  stream: string,
  group: string,
  consumer: string,
  opts: { count?: number; blockMs?: number } = {},
): Promise<QueueMessage[]> {
  // Not: BLOCK 0 = sonsuz bloklama; bloklama yalnızca blockMs açıkça verilirse yapılır.
  const res = await r.xReadGroup(
    group,
    consumer,
    { key: stream, id: '>' },
    opts.blockMs === undefined
      ? { COUNT: opts.count ?? 10 }
      : { COUNT: opts.count ?? 10, BLOCK: opts.blockMs },
  );
  if (!res) return [];
  return res.flatMap((s) =>
    s.messages.map((m) => ({ msgId: m.id, taskId: m.message['task_id'] ?? '' })),
  );
}

export async function ackQueue(r: WwRedis, stream: string, group: string, msgId: string): Promise<void> {
  await r.xAck(stream, group, msgId);
}

export async function acquireLock(r: WwRedis, key: string, owner: string, ttlSec: number): Promise<boolean> {
  const res = await r.set(key, owner, { NX: true, EX: ttlSec });
  return res === 'OK';
}

// Compare-and-delete: yalnızca sahibi bırakabilir.
const RELEASE_LUA = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

export async function releaseLock(r: WwRedis, key: string, owner: string): Promise<boolean> {
  const res = (await r.eval(RELEASE_LUA, { keys: [key], arguments: [owner] })) as number;
  return res === 1;
}

export async function publishEvent(r: WwRedis, env: WsEnvelope): Promise<void> {
  await r.publish(EVENTS_CHANNEL, JSON.stringify(env));
}

export async function subscribeEvents(r: WwRedis, cb: (env: WsEnvelope) => void): Promise<() => Promise<void>> {
  const sub = r.duplicate();
  sub.on('error', reportRedisError);
  try {
    await sub.connect();
    await sub.subscribe(EVENTS_CHANNEL, (msg) => {
      cb(JSON.parse(msg) as WsEnvelope);
    });
  } catch (error) {
    forceDestroy(sub);
    throw error;
  }
  return async () => {
    try {
      await withDeadline(
        sub.unsubscribe(EVENTS_CHANNEL),
        SUBSCRIPTION_CLEANUP_TIMEOUT_MS,
        `Redis unsubscribe ${SUBSCRIPTION_CLEANUP_TIMEOUT_MS} ms içinde tamamlanmadı`,
      );
    } finally {
      // Pub/sub istemcisi geçicidir. v5 quit(), QUIT yanıtını beklerken isOpen'u
      // false yapabildiği için cleanup doğrudan ve koşulsuz destroy kullanır.
      forceDestroy(sub);
    }
  };
}
