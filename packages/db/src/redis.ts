import { createClient, type RedisClientType } from 'redis';
import { EntityIdSchema, type EntityId, type WsEnvelope } from '@ww/shared';

export type WwRedis = RedisClientType;

export const EVENTS_CHANNEL = 'ww:events';
export const MAX_QUEUE_BLOCK_MS = 5_000;
export const MAX_RECLAIM_BATCH = 100;
export const MIN_RECLAIM_IDLE_MS = 100;
export const DEFAULT_QUEUE_READER_CONNECT_TIMEOUT_MS = 1_000;
export const MAX_QUEUE_READER_CONNECT_TIMEOUT_MS = 5_000;
const QUEUE_READER_RESPONSE_GRACE_MS = 250;

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

export type QueueKey = `ww:queue:${EntityId}`;

export const queueKey = (projectId: string): QueueKey => (
  `ww:queue:${EntityIdSchema.parse(projectId)}`
);

function canonicalQueueKey(value: string): QueueKey {
  const prefix = 'ww:queue:';
  if (!value.startsWith(prefix)) throw new Error('gecersiz Redis queue key');
  const projectId = value.slice(prefix.length);
  return queueKey(projectId);
}

export async function ensureGroup(r: WwRedis, stream: QueueKey, group: string): Promise<void> {
  const key = canonicalQueueKey(stream);
  nonEmpty(group, 'group');
  try {
    await r.xGroupCreate(key, group, '0', { MKSTREAM: true });
  } catch (e) {
    if (!(e instanceof Error && e.message.includes('BUSYGROUP'))) throw e;
  }
}

export async function enqueueTask(
  r: WwRedis,
  stream: QueueKey,
  taskId: string,
): Promise<string> {
  const key = canonicalQueueKey(stream);
  const task = EntityIdSchema.parse(taskId);
  return r.xAdd(key, '*', { task_id: task });
}

export interface QueueMessage {
  readonly msgId: string;
  readonly taskId: EntityId;
}

export type InvalidQueueMessageReason = 'invalid_task_id';

export interface InvalidQueueMessage {
  readonly msgId: string;
  readonly deliveryCount: number;
  readonly reason: InvalidQueueMessageReason;
}

export interface ReadQueueResult {
  readonly messages: readonly QueueMessage[];
  readonly invalid: readonly InvalidQueueMessage[];
}

export interface ReclaimedQueueMessage extends QueueMessage {
  /** XREADGROUP dahil, bu consumer group icindeki toplam teslim denemesi. */
  readonly deliveryCount: number;
}

export interface ReclaimQueueOptions {
  /** Must be >= MIN_RECLAIM_IDLE_MS before ownership can move to this consumer. */
  minIdleMs: number;
  /** Total deliveries allowed, including the original XREADGROUP delivery. */
  maxDeliveries: number;
  cursor?: string;
  count?: number;
}

export interface ReclaimQueueResult {
  /** Bir sonraki XAUTOCLAIM taramasinda kullanilacak opaque stream cursor'u. */
  readonly nextCursor: string;
  /** Teslim sinirini asmamis ve islenebilecek claim'ler. */
  readonly claimed: readonly ReclaimedQueueMessage[];
  /** Claim edilmis fakat artik otomatik denenmemesi gereken teslimler. */
  readonly exhausted: readonly ReclaimedQueueMessage[];
  /** Canonical DB poll/reconcile gerektiren ve otomatik ACK edilmeyen girdiler. */
  readonly invalid: readonly InvalidQueueMessage[];
  /** Stream'den silinmisken PEL'de kalmis ve XAUTOCLAIM tarafindan temizlenmis ID'ler. */
  readonly deletedIds: readonly string[];
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} pozitif bir tam sayi olmalidir`);
  }
  return value;
}

function nonEmpty(value: string, name: string): string {
  if (value.trim().length === 0) throw new Error(`${name} bos olamaz`);
  return value;
}

function boundedPositiveInteger(value: number, maximum: number, name: string): number {
  const parsed = positiveInteger(value, name);
  if (parsed > maximum) throw new Error(`${name} en fazla ${maximum} olabilir`);
  return parsed;
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function signalError(signal: AbortSignal, message: string): Error {
  return signal.reason instanceof Error ? signal.reason : abortError(message);
}

function throwIfAborted(signal: AbortSignal | undefined, message: string): void {
  if (signal?.aborted) throw signalError(signal, message);
}

function settleWithSignal<T>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
  message: string,
): Promise<T> {
  // Handler'lar abort durumu okunmadan once baglanir. Redis ayni tick icinde
  // rejected Promise dondururse abort yarisi unhandled rejection uretmez.
  const observed = work.then(
    (value) => value,
    (error: unknown) => { throw error; },
  );
  if (signal === undefined) return observed;
  let onAbort: (() => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signalError(signal, message));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([observed, cancelled]).finally(() => {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
  });
}

function operationSignal(
  external: AbortSignal | undefined,
  lifecycle: AbortSignal,
  timeoutMs: number,
  timeoutMessage: string,
): { readonly signal: AbortSignal; cleanup(): void } {
  const controller = new AbortController();
  const forward = (source: AbortSignal, fallback: string): (() => void) => () => {
    if (!controller.signal.aborted) controller.abort(signalError(source, fallback));
  };
  const onExternal = external === undefined
    ? undefined
    : forward(external, 'Redis queue okumasi iptal edildi');
  const onLifecycle = forward(lifecycle, 'Redis queue reader durduruldu');
  if (external?.aborted) onExternal?.();
  else external?.addEventListener('abort', onExternal!, { once: true });
  if (lifecycle.aborted) onLifecycle();
  else lifecycle.addEventListener('abort', onLifecycle, { once: true });
  const timeout = setTimeout(() => {
    if (!controller.signal.aborted) controller.abort(new Error(timeoutMessage));
  }, timeoutMs);
  timeout.unref();
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      if (onExternal !== undefined) external?.removeEventListener('abort', onExternal);
      lifecycle.removeEventListener('abort', onLifecycle);
    },
  };
}

function parseTaskId(value: unknown): EntityId | null {
  const parsed = EntityIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseNewQueueMessages(
  value: Awaited<ReturnType<WwRedis['xReadGroup']>>,
  expectedKey: QueueKey,
): ReadQueueResult {
  const messages: QueueMessage[] = [];
  const invalid: InvalidQueueMessage[] = [];
  if (value === null) {
    return Object.freeze({
      messages: Object.freeze(messages),
      invalid: Object.freeze(invalid),
    });
  }
  for (const stream of value) {
    const returnedKey = canonicalQueueKey(stream.name);
    if (stream.name !== returnedKey || returnedKey !== expectedKey) {
      throw new Error('Redis queue okumasi beklenmeyen veya canonical olmayan stream dondurdu');
    }
    for (const entry of stream.messages) {
      nonEmpty(entry.id, 'queue message id');
      const taskId = parseTaskId(entry.message['task_id']);
      if (taskId === null) {
        invalid.push(Object.freeze({
          msgId: entry.id,
          deliveryCount: 1,
          reason: 'invalid_task_id',
        }));
      } else {
        messages.push(Object.freeze({ msgId: entry.id, taskId }));
      }
    }
  }
  return Object.freeze({
    messages: Object.freeze(messages),
    invalid: Object.freeze(invalid),
  });
}

export interface ReadQueueOptions {
  count?: number;
  signal?: AbortSignal;
}

export async function readQueue(
  r: WwRedis,
  stream: QueueKey,
  group: string,
  consumer: string,
  opts: ReadQueueOptions = {},
): Promise<ReadQueueResult> {
  const key = canonicalQueueKey(stream);
  nonEmpty(group, 'group');
  nonEmpty(consumer, 'consumer');
  const count = boundedPositiveInteger(opts.count ?? 10, MAX_RECLAIM_BATCH, 'count');
  throwIfAborted(opts.signal, 'Redis queue okumasi iptal edildi');
  const client = opts.signal === undefined ? r : r.withAbortSignal(opts.signal);
  const work = client.xReadGroup(
    group,
    consumer,
    { key, id: '>' },
    { COUNT: count },
  );
  const result = await settleWithSignal(
    work,
    opts.signal,
    'Redis queue okumasi iptal edildi',
  );
  return parseNewQueueMessages(result, key);
}

export interface BlockingReadQueueOptions {
  readonly blockMs: number;
  readonly count?: number;
  readonly signal?: AbortSignal;
}

export interface RedisQueueReaderOptions {
  readonly connectTimeoutMs?: number;
}

/**
 * Owns the only connection that may issue blocking XREADGROUP. Abort, deadline,
 * protocol failure, and stop destroy that duplicate; the coordination client is
 * never blocked. A later read recreates the duplicate after per-call failure.
 */
export interface RedisQueueReader {
  read(
    stream: QueueKey,
    group: string,
    consumer: string,
    options: BlockingReadQueueOptions,
  ): Promise<ReadQueueResult>;
  stop(): void;
}

class OwnedRedisQueueReader implements RedisQueueReader {
  readonly #source: WwRedis;
  readonly #connectTimeoutMs: number;
  readonly #lifecycle = new AbortController();
  #client: WwRedis | undefined;
  #reading = false;
  #stopped = false;

  constructor(source: WwRedis, options: RedisQueueReaderOptions) {
    this.#source = source;
    this.#connectTimeoutMs = boundedPositiveInteger(
      options.connectTimeoutMs ?? DEFAULT_QUEUE_READER_CONNECT_TIMEOUT_MS,
      MAX_QUEUE_READER_CONNECT_TIMEOUT_MS,
      'connectTimeoutMs',
    );
  }

  #discard(client: WwRedis): void {
    if (this.#client !== client) return;
    this.#client = undefined;
    forceDestroy(client);
  }

  async #bounded<T>(
    client: WwRedis,
    external: AbortSignal | undefined,
    timeoutMs: number,
    timeoutMessage: string,
    start: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const operation = operationSignal(
      external,
      this.#lifecycle.signal,
      timeoutMs,
      timeoutMessage,
    );
    const onAbort = (): void => this.#discard(client);
    operation.signal.addEventListener('abort', onAbort, { once: true });
    try {
      throwIfAborted(operation.signal, 'Redis queue okumasi iptal edildi');
      return await settleWithSignal(
        start(operation.signal),
        operation.signal,
        'Redis queue okumasi iptal edildi',
      );
    } finally {
      operation.signal.removeEventListener('abort', onAbort);
      operation.cleanup();
    }
  }

  async read(
    stream: QueueKey,
    group: string,
    consumer: string,
    options: BlockingReadQueueOptions,
  ): Promise<ReadQueueResult> {
    const key = canonicalQueueKey(stream);
    nonEmpty(group, 'group');
    nonEmpty(consumer, 'consumer');
    const count = boundedPositiveInteger(
      options.count ?? 10,
      MAX_RECLAIM_BATCH,
      'count',
    );
    const blockMs = boundedPositiveInteger(options.blockMs, MAX_QUEUE_BLOCK_MS, 'blockMs');
    if (this.#stopped) throw abortError('Redis queue reader durduruldu');
    throwIfAborted(options.signal, 'Redis queue okumasi iptal edildi');
    if (this.#reading) throw new Error('Redis queue reader ayni anda yalniz bir okuma yapabilir');
    this.#reading = true;

    let client: WwRedis | undefined;
    try {
      client = this.#client;
      if (client === undefined) {
        client = this.#source.duplicate();
        client.on('error', reportRedisError);
        this.#client = client;
      }
      if (!client.isOpen) {
        await this.#bounded(
          client,
          options.signal,
          this.#connectTimeoutMs,
          'Redis queue reader baglantisi zaman asimina ugradi',
          () => client!.connect(),
        );
      }
      const result = await this.#bounded(
        client,
        options.signal,
        blockMs + QUEUE_READER_RESPONSE_GRACE_MS,
        'Redis blocking queue okumasi zaman asimina ugradi',
        (signal) => client!.withAbortSignal(signal).xReadGroup(
          group,
          consumer,
          { key, id: '>' },
          { COUNT: count, BLOCK: blockMs },
        ),
      );
      return parseNewQueueMessages(result, key);
    } catch (error) {
      if (client !== undefined) this.#discard(client);
      throw error;
    } finally {
      this.#reading = false;
    }
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#lifecycle.abort(abortError('Redis queue reader durduruldu'));
    if (this.#client !== undefined) this.#discard(this.#client);
  }
}

export function createQueueReader(
  source: WwRedis,
  options: RedisQueueReaderOptions = {},
): RedisQueueReader {
  return new OwnedRedisQueueReader(source, options);
}

// XAUTOCLAIM ve her claimed ID icin XPENDING delivery kaniti ayni script icinde
// calisir. Pozitif idle tabani, yeni sahibin hemen tekrar calinmasini engeller.
// https://redis.io/docs/latest/commands/xautoclaim/
// https://redis.io/docs/latest/commands/xpending/
const ATOMIC_RECLAIM_LUA = `
local response = redis.call(
  'XAUTOCLAIM', KEYS[1], ARGV[1], ARGV[2], ARGV[3], ARGV[4], 'COUNT', ARGV[5]
)
local claimed = {}
for _, message in ipairs(response[2]) do
  local messageId = message[1]
  local pending = redis.call(
    'XPENDING', KEYS[1], ARGV[1], messageId, messageId, 1, ARGV[2]
  )
  if #pending ~= 1 or pending[1][1] ~= messageId or pending[1][2] ~= ARGV[2] then
    return redis.error_reply('reclaim pending evidence mismatch')
  end
  local taskId = false
  local taskIdCount = 0
  for index = 1, #message[2], 2 do
    if message[2][index] == 'task_id' then
      taskId = message[2][index + 1]
      taskIdCount = taskIdCount + 1
    end
  end
  if taskIdCount ~= 1 then
    taskId = false
  end
  table.insert(claimed, { messageId, taskId, pending[1][4] })
end
return { response[1], claimed, response[3] }
`;

function rawArray(value: unknown, context: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${context} dizi olmali`);
  return value;
}

function rawString(value: unknown, context: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${context} bos olmayan string olmali`);
  }
  return value;
}

function rawDeliveryCount(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error('Redis reclaim delivery kaniti pozitif safe integer olmali');
  }
  return value as number;
}

/**
 * Reclaim idle pending entries without JUSTID so Redis increments the delivery
 * counter. XAUTOCLAIM does not return that counter, therefore every claimed ID
 * is reconciled through XPENDING before it is exposed to the scheduler.
 */
export async function reclaimQueue(
  r: WwRedis,
  stream: QueueKey,
  group: string,
  consumer: string,
  options: ReclaimQueueOptions,
): Promise<ReclaimQueueResult> {
  if (
    !Number.isSafeInteger(options.minIdleMs) ||
    options.minIdleMs < MIN_RECLAIM_IDLE_MS
  ) {
    throw new Error(`minIdleMs en az ${MIN_RECLAIM_IDLE_MS} olmalidir`);
  }
  const minIdleMs = options.minIdleMs;
  const maxDeliveries = positiveInteger(options.maxDeliveries, 'maxDeliveries');
  const count = boundedPositiveInteger(
    options.count ?? 10,
    MAX_RECLAIM_BATCH,
    'count',
  );
  const cursor = nonEmpty(options.cursor ?? '0-0', 'cursor');
  const key = canonicalQueueKey(stream);
  nonEmpty(group, 'group');
  nonEmpty(consumer, 'consumer');

  const raw = await r.eval(ATOMIC_RECLAIM_LUA, {
    keys: [key],
    arguments: [group, consumer, String(minIdleMs), cursor, String(count)],
  });
  const response = rawArray(raw, 'Redis reclaim response');
  if (response.length !== 3) throw new Error('Redis reclaim response uc elemanli olmali');
  const nextCursor = rawString(response[0], 'next reclaim cursor');
  const rawClaimed = rawArray(response[1], 'Redis reclaimed messages');
  if (rawClaimed.length > count) throw new Error('Redis reclaim count sinirini asti');
  const deliveries: ReclaimedQueueMessage[] = [];
  const invalid: InvalidQueueMessage[] = [];
  const seenIds = new Set<string>();
  for (const rawEntry of rawClaimed) {
    const entry = rawArray(rawEntry, 'Redis reclaimed message');
    if (entry.length !== 3) throw new Error('Redis reclaimed message uc elemanli olmali');
    const msgId = rawString(entry[0], 'reclaimed message id');
    if (seenIds.has(msgId)) {
      throw new Error(`Redis reclaim ayni mesaji birden cok kez dondurdu: ${msgId}`);
    }
    seenIds.add(msgId);
    const deliveryCount = rawDeliveryCount(entry[2]);
    const taskId = parseTaskId(entry[1]);
    if (taskId === null) {
      invalid.push(Object.freeze({ msgId, deliveryCount, reason: 'invalid_task_id' }));
    } else {
      deliveries.push(Object.freeze({ msgId, taskId, deliveryCount }));
    }
  }

  const deletedIds = rawArray(response[2], 'Redis deleted message IDs')
    .map((id) => rawString(id, 'deleted message id'));
  const uniqueDeletedIds = new Set(deletedIds);
  if (
    uniqueDeletedIds.size !== deletedIds.length ||
    deletedIds.some((id) => seenIds.has(id))
  ) {
    throw new Error('Redis reclaim silinmis mesaj kimliklerinde celiskili sonuc dondurdu');
  }

  // Queue ownership is only a wakeup/claim hint. Scheduler, islemeye baslamadan
  // once durable task state plus fenced lease owner/tokenunu yine dogrulamalidir.
  return Object.freeze({
    nextCursor,
    claimed: Object.freeze(deliveries.filter((entry) => (
      entry.deliveryCount <= maxDeliveries
    ))),
    exhausted: Object.freeze(deliveries.filter((entry) => (
      entry.deliveryCount > maxDeliveries
    ))),
    invalid: Object.freeze(invalid),
    deletedIds: Object.freeze(deletedIds),
  });
}

export async function ackQueue(
  r: WwRedis,
  stream: QueueKey,
  group: string,
  msgId: string,
): Promise<void> {
  const key = canonicalQueueKey(stream);
  nonEmpty(group, 'group');
  nonEmpty(msgId, 'msgId');
  await r.xAck(key, group, msgId);
}

declare const FILE_LOCK_KEY_BRAND: unique symbol;
export type FileLockKey = string & { readonly [FILE_LOCK_KEY_BRAND]: true };

const FILE_HASH_PATTERN = /^[a-f0-9]{40}$/;

export function fileLockKey(projectId: string, fileHash: string): FileLockKey {
  const project = EntityIdSchema.parse(projectId);
  const hash = fileHash.toLowerCase();
  if (!FILE_HASH_PATTERN.test(hash)) throw new Error('fileHash SHA-1 hex olmali');
  return `ww:lock:file:${project}:${hash}` as FileLockKey;
}

function assertFileLockKey(key: FileLockKey): void {
  const parts = key.split(':');
  if (parts.length !== 5 || parts[0] !== 'ww' || parts[1] !== 'lock' || parts[2] !== 'file') {
    throw new Error('gecersiz Redis file lock key');
  }
  const canonical = fileLockKey(parts[3]!, parts[4]!);
  if (canonical !== key) throw new Error('Redis file lock key canonical degil');
}

export async function acquireFileLock(
  r: WwRedis,
  key: FileLockKey,
  owner: string,
  ttlSec: number,
): Promise<boolean> {
  assertFileLockKey(key);
  nonEmpty(owner, 'owner');
  positiveInteger(ttlSec, 'ttlSec');
  const res = await r.set(key, owner, { NX: true, EX: ttlSec });
  return res === 'OK';
}

// Owner-matching TTL heartbeat. Release + acquire yapmaz; arada kilitsiz pencere yoktur.
const RENEW_FILE_LOCK_LUA = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('expire', KEYS[1], ARGV[2]) else return 0 end`;

export async function renewFileLock(
  r: WwRedis,
  key: FileLockKey,
  owner: string,
  ttlSec: number,
): Promise<boolean> {
  assertFileLockKey(key);
  nonEmpty(owner, 'owner');
  positiveInteger(ttlSec, 'ttlSec');
  const result: unknown = await r.eval(RENEW_FILE_LOCK_LUA, {
    keys: [key],
    arguments: [owner, String(ttlSec)],
  });
  return decodeRedisBoolean(result, 'Redis file lock renew');
}

// Compare-and-delete: yalnızca sahibi bırakabilir.
const RELEASE_LUA = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

export async function releaseFileLock(
  r: WwRedis,
  key: FileLockKey,
  owner: string,
): Promise<boolean> {
  assertFileLockKey(key);
  nonEmpty(owner, 'owner');
  const result: unknown = await r.eval(RELEASE_LUA, {
    keys: [key],
    arguments: [owner],
  });
  return decodeRedisBoolean(result, 'Redis file lock release');
}

export function decodeRedisBoolean(value: unknown, context: string): boolean {
  if (value === 0) return false;
  if (value === 1) return true;
  throw new Error(`${context} 0 veya 1 yerine gecersiz Lua sonucu dondurdu`);
}

export const heartbeatKey = (agentId: string): string => (
  `ww:hb:${EntityIdSchema.parse(agentId)}`
);

export async function setHeartbeat(
  r: WwRedis,
  agentId: string,
  ttlMs = 30_000,
): Promise<void> {
  positiveInteger(ttlMs, 'ttlMs');
  await r.set(heartbeatKey(agentId), 'alive', { PX: ttlMs });
}

export async function checkHeartbeat(r: WwRedis, agentId: string): Promise<boolean> {
  return await r.exists(heartbeatKey(agentId)) === 1;
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
