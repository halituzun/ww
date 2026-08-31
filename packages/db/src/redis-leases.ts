import {
  EntityIdSchema,
  OpaqueIdentifierSchema,
  canonicalSha256V1,
  type EntityId,
} from '@ww/shared';
import { decodeRedisBoolean, type WwRedis } from './redis.js';

export type TaskLockKey = `ww:task:${EntityId}:claim`;
export type AgentLockKey = `ww:agent:${EntityId}:claim`;
export type MessageLockKey = `ww:message:${EntityId}:claim`;
export type ReceiptLockKey = `ww:receipt:${EntityId}:claim`;
export type EffectLockKey = `ww:effect:${EntityId}:${string}:claim`;
export type RedisLockKey =
  | TaskLockKey
  | AgentLockKey
  | MessageLockKey
  | ReceiptLockKey
  | EffectLockKey;
export type LeaseFenceKey = `${RedisLockKey}:fence`;

export interface FencedLease {
  readonly lockKey: RedisLockKey;
  readonly owner: string;
  /** Positive safe-integer decimal token, kept as text across Redis/ClickHouse. */
  readonly fence: string;
}

const MAX_SAFE_FENCE = 9_007_199_254_740_991n;

function entityId(value: string): EntityId {
  return EntityIdSchema.parse(value);
}

export const taskLockKey = (taskId: string): TaskLockKey => (
  `ww:task:${entityId(taskId)}:claim`
);
export const agentLockKey = (agentId: string): AgentLockKey => (
  `ww:agent:${entityId(agentId)}:claim`
);
export const messageLockKey = (messageId: string): MessageLockKey => (
  `ww:message:${entityId(messageId)}:claim`
);
export const receiptLockKey = (receiptId: string): ReceiptLockKey => (
  `ww:receipt:${entityId(receiptId)}:claim`
);
export const effectLockKey = (
  causationId: string,
  stableEffectId: string,
): EffectLockKey => {
  const effect = OpaqueIdentifierSchema.parse(stableEffectId);
  return `ww:effect:${entityId(causationId)}:${canonicalSha256V1(effect)}:claim`;
};
export const leaseFenceKey = (key: RedisLockKey): LeaseFenceKey => {
  assertLockKey(key);
  return `${key}:fence`;
};

const ENTITY_LOCK_KEY_PATTERN = /^ww:(task|agent|message|receipt):([^:]+):claim$/;
const EFFECT_LOCK_KEY_PATTERN = /^ww:effect:([^:]+):([a-f0-9]{64}):claim$/;

function assertLockKey(key: RedisLockKey): void {
  const entityMatch = ENTITY_LOCK_KEY_PATTERN.exec(key);
  if (entityMatch !== null && entityMatch[2] !== undefined) {
    const id = entityId(entityMatch[2]);
    const canonical = `ww:${entityMatch[1]}:${id}:claim`;
    if (key !== canonical) throw new Error('Redis lease lock key canonical degil');
    return;
  }
  const effectMatch = EFFECT_LOCK_KEY_PATTERN.exec(key);
  if (effectMatch === null || effectMatch[1] === undefined || effectMatch[2] === undefined) {
    throw new Error('gecersiz Redis lease lock key');
  }
  const id = entityId(effectMatch[1]);
  const canonical = `ww:effect:${id}:${effectMatch[2]}:claim`;
  if (key !== canonical) throw new Error('Redis lease lock key canonical degil');
}

function assertOwner(owner: string): void {
  if (owner.trim().length === 0) throw new Error('lease owner bos olamaz');
}

function assertTtl(ttlMs: number): void {
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new Error('lease ttlMs pozitif bir tam sayi olmalidir');
  }
}

function assertFence(fence: string): void {
  if (!/^[1-9]\d*$/.test(fence)) {
    throw new Error('lease fence pozitif safe integer olmalidir');
  }
  const value = BigInt(fence);
  if (value > MAX_SAFE_FENCE) {
    throw new Error('lease fence JavaScript safe integer araligi disinda');
  }
}

function assertMinimumFence(fence: string): void {
  if (!/^(0|[1-9]\d*)$/.test(fence)) {
    throw new Error('minimumFence sifir veya pozitif safe integer olmalidir');
  }
  if (BigInt(fence) >= MAX_SAFE_FENCE) {
    throw new Error('minimumFence yeni fence icin safe integer alani birakmalidir');
  }
}

// EVAL scriptleri tek Redis komutu olarak atomik calisir.
// https://redis.io/docs/latest/develop/programmability/eval-intro/
const ACQUIRE_FENCED_LEASE_LUA = `
if redis.call('exists', KEYS[1]) == 1 then
  return false
end
local current = redis.call('get', KEYS[2]) or '0'
local floor = ARGV[3]
if current ~= '0' and not string.match(current, '^[1-9][0-9]*$') then
  return redis.error_reply('invalid fenced lease counter')
end
local maximumBase = '9007199254740990'
if string.len(current) > string.len(maximumBase)
  or (string.len(current) == string.len(maximumBase) and current > maximumBase) then
  return redis.error_reply('fenced lease counter exceeds safe integer range')
end
if string.len(current) < string.len(floor)
  or (string.len(current) == string.len(floor) and current < floor) then
  redis.call('set', KEYS[2], floor)
end
redis.call('incr', KEYS[2])
local fence = redis.call('get', KEYS[2])
redis.call('hset', KEYS[1], 'owner', ARGV[1], 'fence', fence)
redis.call('pexpire', KEYS[1], ARGV[2])
return fence
`;

const RENEW_FENCED_LEASE_LUA = `
if redis.call('hget', KEYS[1], 'owner') == ARGV[1]
  and redis.call('hget', KEYS[1], 'fence') == ARGV[2] then
  return redis.call('pexpire', KEYS[1], ARGV[3])
end
return 0
`;

const RELEASE_FENCED_LEASE_LUA = `
if redis.call('hget', KEYS[1], 'owner') == ARGV[1]
  and redis.call('hget', KEYS[1], 'fence') == ARGV[2] then
  return redis.call('del', KEYS[1])
end
return 0
`;

export async function acquireFencedLease(
  r: WwRedis,
  lockKey: RedisLockKey,
  owner: string,
  ttlMs: number,
  /** Latest durable ClickHouse fence, or "0" when no durable owner exists yet. */
  minimumFence: string,
): Promise<FencedLease | null> {
  assertLockKey(lockKey);
  assertOwner(owner);
  assertTtl(ttlMs);
  assertMinimumFence(minimumFence);
  const result: unknown = await r.eval(ACQUIRE_FENCED_LEASE_LUA, {
    keys: [lockKey, leaseFenceKey(lockKey)],
    arguments: [owner, String(ttlMs), minimumFence],
  });
  if (result === null) return null;
  if (typeof result !== 'string') {
    throw new Error('Redis fenced lease beklenmeyen fence tipi dondurdu');
  }
  assertFence(result);
  return Object.freeze({ lockKey, owner, fence: result });
}

export async function renewFencedLease(
  r: WwRedis,
  lease: FencedLease,
  ttlMs: number,
): Promise<boolean> {
  assertLockKey(lease.lockKey);
  assertOwner(lease.owner);
  assertFence(lease.fence);
  assertTtl(ttlMs);
  const result: unknown = await r.eval(RENEW_FENCED_LEASE_LUA, {
    keys: [lease.lockKey],
    arguments: [lease.owner, lease.fence, String(ttlMs)],
  });
  return decodeRedisBoolean(result, 'Redis fenced lease renew');
}

export async function releaseFencedLease(
  r: WwRedis,
  lease: FencedLease,
): Promise<boolean> {
  assertLockKey(lease.lockKey);
  assertOwner(lease.owner);
  assertFence(lease.fence);
  const result: unknown = await r.eval(RELEASE_FENCED_LEASE_LUA, {
    keys: [lease.lockKey],
    arguments: [lease.owner, lease.fence],
  });
  return decodeRedisBoolean(result, 'Redis fenced lease release');
}

/** Reads one fenced lease hash in a single Redis command for release reconciliation. */
export async function getFencedLease(
  r: WwRedis,
  lockKey: RedisLockKey,
): Promise<FencedLease | null> {
  assertLockKey(lockKey);
  const fields = await r.hGetAll(lockKey);
  if (Object.keys(fields).length === 0) return null;
  const owner = fields['owner'];
  const fence = fields['fence'];
  if (owner === undefined || fence === undefined) {
    throw new Error('Redis fenced lease hash owner/fence alanlarini tasimiyor');
  }
  assertOwner(owner);
  assertFence(fence);
  return Object.freeze({ lockKey, owner, fence });
}
