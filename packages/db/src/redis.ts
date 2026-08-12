import { createClient, type RedisClientType } from 'redis';
import type { WsEnvelope } from '@ww/shared';

export type WwRedis = RedisClientType;

export const EVENTS_CHANNEL = 'ww:events';

// Varsayılan port docker-compose.yml ile eşleşir (6380: bu makinede 6379 başka projede).
export async function createRedis(url?: string): Promise<WwRedis> {
  const client = createClient({
    url: url ?? process.env['WW_REDIS_URL'] ?? 'redis://localhost:6380',
  });
  await client.connect();
  return client as WwRedis;
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
  await sub.connect();
  await sub.subscribe(EVENTS_CHANNEL, (msg) => {
    cb(JSON.parse(msg) as WsEnvelope);
  });
  return async () => {
    await sub.unsubscribe(EVENTS_CHANNEL);
    await sub.quit();
  };
}
