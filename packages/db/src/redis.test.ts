import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WsEnvelope } from '@ww/shared';
import {
  ackQueue, acquireLock, createRedis, ensureGroup, enqueueTask,
  publishEvent, readQueue, releaseLock, subscribeEvents, type WwRedis,
} from './redis.js';

let up = true;
let r: WwRedis;
try {
  r = await createRedis();
  await r.ping();
} catch {
  up = false;
}

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
    const got = new Promise<WsEnvelope>((resolve) => {
      void subscribeEvents(r, (env) => resolve(env));
    });
    await new Promise((res) => setTimeout(res, 100)); // abonelik otursun
    const env: WsEnvelope = { event: 'task.updated', projectId: 'p1', seq: 1, ts: new Date().toISOString(), data: { x: 1 } };
    await publishEvent(r, env);
    const received = await got;
    expect(received.event).toBe('task.updated');
    expect(received.seq).toBe(1);
  });
});
