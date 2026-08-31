import { createHash, randomUUID } from 'node:crypto';
import {
  acquireFencedLease,
  acquireFileLock,
  agentLockKey,
  appendAgentVersion,
  appendEffectVersion,
  appendEvent,
  appendPlanVersion,
  appendPromptVersion,
  createAgent,
  createCh,
  createPlan,
  createProject,
  createQueueReader,
  createRedis,
  createTask,
  enqueueTask,
  ensureGroup,
  fileLockKey,
  getAssignmentAttempt,
  getLatestAgent,
  getLatestEffect,
  getLatestPlan,
  getLatestTask,
  getTaskBrief,
  getTaskHandoff,
  listEvents,
  listLatestEffectsByState,
  listTaskCausalEntries,
  leaseFenceKey,
  queueKey,
  releaseFencedLease,
  releaseFileLock,
  renewFileLock,
  reserveEffect,
  runMigrations,
  taskLockKey,
  type ClickHouseClient,
  type FileLockKey,
  type TaskRow,
  type WwRedis,
} from '@ww/db';
import { TaskContextSnapshotBuilder } from '@ww/memory';
import {
  EntityIdSchema,
  NIL_UUID,
  USER_SENTINEL,
  canonicalSha256V1,
  type AssignmentAttemptV1,
  type EntityId,
} from '@ww/shared';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from 'vitest';
import { AssignmentService } from './assignment-service.js';
import { SchedulerError, TaskDeferredError, type SchedulerErrorCode } from './errors.js';
import type { AssignmentServiceFactoryPort, ClockPort } from './ports.js';
import { SchedulerWorker } from './scheduler-worker.js';
import { TaskBriefService } from './task-brief-service.js';
import { TaskCausalLog } from './task-causal-log.js';
import { TaskTransitionService } from './task-transition-service.js';
import { taskHandoffEventId } from './task-handoff-events.js';
import { systemPrincipal } from './ports.js';

async function integrationAvailable(): Promise<boolean> {
  const probe = createCh({ database: 'default' });
  let redis: WwRedis | undefined;
  try {
    const result = await probe.query({ query: 'SELECT 1', format: 'JSONEachRow' });
    await result.json();
    redis = await createRedis(undefined, {
      connectTimeoutMs: 500,
      maxReconnectAttempts: 0,
      onError: () => undefined,
    });
    await redis.ping();
    return true;
  } catch (error) {
    if (process.env['WW_REQUIRE_INTEGRATION'] === '1') {
      throw new Error('WW_REQUIRE_INTEGRATION=1 ancak ClickHouse/Redis kullanilamiyor', {
        cause: error,
      });
    }
    return false;
  } finally {
    if (redis?.isOpen) redis.destroy();
    await probe.close();
  }
}

const up = await integrationAvailable();

interface Fixture {
  readonly projectId: EntityId;
  readonly planId: EntityId;
  readonly taskId: EntityId;
  readonly dependencyTaskId?: EntityId;
  readonly worker1: EntityId;
  readonly worker2: EntityId;
  readonly verifierSameModel: EntityId;
  readonly verifierIndependent: EntityId;
  readonly clock: ClockPort;
  readonly now: () => string;
}

interface SeedOptions {
  readonly dependencyStatus?: 'queued' | 'done';
  readonly targetFiles?: readonly string[];
  readonly maxAttempts?: number;
}

interface Services {
  readonly assignment: AssignmentService;
  readonly causal: TaskCausalLog;
  readonly transition: TaskTransitionService;
}

function lockKey(projectId: EntityId, path: string): FileLockKey {
  return fileLockKey(projectId, createHash('sha1').update(path).digest('hex'));
}

function uncertainClient(
  source: ClickHouseClient,
  table: string,
  mode: 'before_accept' | 'after_accept',
): ClickHouseClient {
  let injected = false;
  return new Proxy(source, {
    get(target, property) {
      if (property === 'insert') {
        return async (options: Parameters<ClickHouseClient['insert']>[0]) => {
          if (!injected && options.table === table) {
            injected = true;
            if (mode === 'after_accept') await target.insert(options);
            throw new Error(`simulated ${mode} timeout`);
          }
          return target.insert(options);
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function loseFileLockTransferResponse(
  source: WwRedis,
  mode: 'before_accept' | 'after_accept',
): WwRedis {
  let injected = false;
  return new Proxy(source, {
    get(target, property) {
      if (property === 'eval') {
        return async (...args: Parameters<WwRedis['eval']>) => {
          const script = String(args[0]);
          const options = args[1];
          const keys = options !== undefined && 'keys' in options ? options.keys : [];
          if (
            !injected && keys.length > 0 &&
            keys.every((key) => key.startsWith('ww:lock:file:')) &&
            script.includes("local owner = redis.call('get', KEYS[index])")
          ) {
            injected = true;
            if (mode === 'after_accept') await target.eval(...args);
            throw new Error(`simulated transfer ${mode} response loss`);
          }
          return target.eval(...args);
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function loseAgentLeaseReleaseResponse(
  source: WwRedis,
  mode: 'before_accept' | 'after_accept',
): WwRedis {
  let injected = false;
  return new Proxy(source, {
    get(target, property) {
      if (property === 'eval') {
        return async (...args: Parameters<WwRedis['eval']>) => {
          const script = String(args[0]);
          const options = args[1];
          const keys = options !== undefined && 'keys' in options ? options.keys : [];
          if (
            !injected && keys.length === 1 && keys[0]?.startsWith('ww:agent:') &&
            script.includes("return redis.call('del', KEYS[1])")
          ) {
            injected = true;
            if (mode === 'after_accept') await target.eval(...args);
            throw new Error(`simulated agent release ${mode} response loss`);
          }
          return target.eval(...args);
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function stealTaskLeaseAfterAcceptedLockEvent(
  source: ClickHouseClient,
  redis: WwRedis,
  taskId: EntityId,
): ClickHouseClient {
  let injected = false;
  return new Proxy(source, {
    get(target, property) {
      if (property === 'insert') {
        return async (options: Parameters<ClickHouseClient['insert']>[0]) => {
          await target.insert(options);
          const rows = Array.isArray(options.values) ? options.values : [];
          const matched = rows.some((value) =>
            value !== null && typeof value === 'object' &&
            'event_type' in value && value.event_type === 'lock_acquired' &&
            'task_id' in value && value.task_id === taskId);
          if (!injected && options.table === 'events' && matched) {
            injected = true;
            await redis.del(taskLockKey(taskId));
          }
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function stealLeaseAfterEffectReserve(
  source: ClickHouseClient,
  redis: WwRedis,
  taskId: EntityId,
  effectType: string,
): ClickHouseClient {
  let injected = false;
  return new Proxy(source, {
    get(target, property) {
      if (property === 'insert') {
        return async (options: Parameters<ClickHouseClient['insert']>[0]) => {
          await target.insert(options);
          const rows = Array.isArray(options.values) ? options.values : [];
          const matched = rows.some((value) =>
            value !== null && typeof value === 'object' &&
            'effect_type' in value && value.effect_type === effectType &&
            'state' in value && value.state === 'pending');
          if (!injected && options.table === 'effect_ledger' && matched) {
            injected = true;
            await redis.del(taskLockKey(taskId));
          }
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function stealLeaseAfterAcceptedInsert(
  source: ClickHouseClient,
  redis: WwRedis,
  taskId: EntityId,
  table: string,
): ClickHouseClient {
  let injected = false;
  return new Proxy(source, {
    get(target, property) {
      if (property === 'insert') {
        return async (options: Parameters<ClickHouseClient['insert']>[0]) => {
          await target.insert(options);
          if (!injected && options.table === table) {
            injected = true;
            await redis.del(taskLockKey(taskId));
          }
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function delayTaskAcceptance(
  source: ClickHouseClient,
): {
  readonly client: ClickHouseClient;
  land(): Promise<void>;
} {
  let captured: Parameters<ClickHouseClient['insert']>[0] | undefined;
  let injected = false;
  const client = new Proxy(source, {
    get(target, property) {
      if (property === 'insert') {
        return async (options: Parameters<ClickHouseClient['insert']>[0]) => {
          if (!injected && options.table === 'tasks') {
            injected = true;
            captured = options;
            throw new Error('simulated delayed task acceptance');
          }
          return target.insert(options);
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return Object.freeze({
    client,
    land: async () => {
      if (captured === undefined) throw new Error('delayed task insert yakalanmadi');
      await source.insert(captured);
    },
  });
}

function stealAgentLeaseAfterAcceptedReservation(
  source: ClickHouseClient,
  redis: WwRedis,
  taskId: EntityId,
): ClickHouseClient {
  let injected = false;
  return new Proxy(source, {
    get(target, property) {
      if (property === 'insert') {
        return async (options: Parameters<ClickHouseClient['insert']>[0]) => {
          await target.insert(options);
          const rows = Array.isArray(options.values) ? options.values : [];
          const accepted = rows.find((value) =>
            value !== null && typeof value === 'object' &&
            'status' in value && value.status === 'busy' &&
            'current_task_id' in value && value.current_task_id === taskId &&
            'agent_id' in value && typeof value.agent_id === 'string');
          if (!injected && options.table === 'agents' && accepted !== undefined) {
            injected = true;
            await redis.del(agentLockKey(EntityIdSchema.parse(accepted.agent_id)));
          }
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function stealTaskLeaseAfterFileAcquire(
  source: WwRedis,
  taskId: EntityId,
): WwRedis {
  let injected = false;
  return new Proxy(source, {
    get(target, property) {
      if (property === 'set') {
        return async (...args: Parameters<WwRedis['set']>) => {
          const result = await target.set(...args);
          if (!injected && typeof args[0] === 'string' && args[0].startsWith('ww:lock:file:')) {
            injected = true;
            await target.del(taskLockKey(taskId));
          }
          return result;
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function loseFileLockAcquireResponse(
  source: WwRedis,
  mode: 'before_accept' | 'after_accept' | 'always_before_accept',
): WwRedis {
  let injected = false;
  return new Proxy(source, {
    get(target, property) {
      if (property === 'set') {
        return async (...args: Parameters<WwRedis['set']>) => {
          const key = args[0];
          const isFileLock = typeof key === 'string' && key.startsWith('ww:lock:file:');
          if (isFileLock && (mode === 'always_before_accept' || !injected)) {
            injected = true;
            if (mode === 'after_accept') await target.set(...args);
            throw new Error(`simulated file lock acquire ${mode} response loss`);
          }
          return target.set(...args);
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function loseFileLockRenewResponse(
  source: WwRedis,
  mode: 'before_accept' | 'after_accept',
): WwRedis {
  let injected = false;
  return new Proxy(source, {
    get(target, property) {
      if (property === 'eval') {
        return async (...args: Parameters<WwRedis['eval']>) => {
          const script = String(args[0]);
          const options = args[1];
          const keys = options !== undefined && 'keys' in options ? options.keys : [];
          if (
            !injected && keys.length === 1 && keys[0]?.startsWith('ww:lock:file:') &&
            script.includes("return redis.call('expire', KEYS[1], ARGV[2])")
          ) {
            injected = true;
            if (mode === 'after_accept') await target.eval(...args);
            throw new Error(`simulated file lock renew ${mode} response loss`);
          }
          return target.eval(...args);
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function armLegacyTornFileLockRead(
  source: WwRedis,
  key: FileLockKey,
  foreignOwner: string,
): { readonly client: WwRedis; triggered(): boolean } {
  let triggered = false;
  let replacementDone: Promise<void> | undefined;
  const client = new Proxy(source, {
    get(target, property) {
      if (property === 'get') {
        return async (requestedKey: string) => {
          const owner = await target.get(requestedKey);
          if (!triggered && requestedKey === key) {
            triggered = true;
            replacementDone = target.set(key, foreignOwner, { EX: 30 }).then(() => undefined);
            await replacementDone;
          }
          return owner;
        };
      }
      if (property === 'ttl') {
        return async (requestedKey: string) => {
          if (requestedKey === key && replacementDone !== undefined) await replacementDone;
          return target.ttl(requestedKey);
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return Object.freeze({ client, triggered: () => triggered });
}

function pauseTaskFencedFileReleaseAfterLeaseTheft(
  source: WwRedis,
  taskId: EntityId,
): {
  readonly client: WwRedis;
  readonly staleReleaseReady: Promise<void>;
  resume(): void;
} {
  let injected = false;
  let markReady: (() => void) | undefined;
  let resumeRelease: (() => void) | undefined;
  const staleReleaseReady = new Promise<void>((resolve) => { markReady = resolve; });
  const resume = new Promise<void>((resolve) => { resumeRelease = resolve; });
  const client = new Proxy(source, {
    get(target, property) {
      if (property === 'eval') {
        return async (...args: Parameters<WwRedis['eval']>) => {
          const script = String(args[0]);
          const options = args[1];
          const keys = options !== undefined && 'keys' in options ? options.keys : [];
          if (
            !injected && keys[0] === taskLockKey(taskId) &&
            keys[1]?.startsWith('ww:lock:file:') &&
            script.includes("redis.call('hget', KEYS[1], 'fence')") &&
            script.includes("redis.call('del', KEYS[2])")
          ) {
            injected = true;
            await target.del(taskLockKey(taskId));
            markReady?.();
            await resume;
          }
          return target.eval(...args);
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return Object.freeze({
    client,
    staleReleaseReady,
    resume: () => { resumeRelease?.(); },
  });
}

function pauseTaskLeaseReleaseAfterFileAcquire(
  source: WwRedis,
  taskId: EntityId,
): {
  readonly client: WwRedis;
  readonly taskLeaseReleased: Promise<void>;
  resume(): void;
} {
  let armed = false;
  let paused = false;
  let markReleased: (() => void) | undefined;
  let resumeRelease: (() => void) | undefined;
  const taskLeaseReleased = new Promise<void>((resolve) => { markReleased = resolve; });
  const resume = new Promise<void>((resolve) => { resumeRelease = resolve; });
  const client = new Proxy(source, {
    get(target, property) {
      if (property === 'set') {
        return async (...args: Parameters<WwRedis['set']>) => {
          const result = await target.set(...args);
          if (typeof args[0] === 'string' && args[0].startsWith('ww:lock:file:')) armed = true;
          return result;
        };
      }
      if (property === 'eval') {
        return async (...args: Parameters<WwRedis['eval']>) => {
          const result = await target.eval(...args);
          const script = String(args[0]);
          const options = args[1];
          const keys = options !== undefined && 'keys' in options ? options.keys : [];
          if (
            armed && !paused && keys[0] === taskLockKey(taskId) &&
            script.includes("return redis.call('del', KEYS[1])")
          ) {
            paused = true;
            markReleased?.();
            await resume;
          }
          return result;
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return Object.freeze({
    client,
    taskLeaseReleased,
    resume: () => { resumeRelease?.(); },
  });
}

function failFirstFileLockRelease(
  source: WwRedis,
  mode: 'transport_error' | 'false',
): WwRedis {
  let injected = false;
  return new Proxy(source, {
    get(target, property) {
      if (property === 'eval') {
        return async (...args: Parameters<WwRedis['eval']>) => {
          const script = String(args[0]);
          const options = args[1];
          const keys = options !== undefined && 'keys' in options ? options.keys : [];
          if (
            !injected && keys.length === 1 && keys[0]?.startsWith('ww:lock:file:') &&
            script.includes("redis.call('del', KEYS[1])")
          ) {
            injected = true;
            if (mode === 'transport_error') throw new Error('simulated release transport error');
            return 0;
          }
          return target.eval(...args);
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function loseFirstAcceptedFileLockReleaseAck(source: WwRedis): WwRedis {
  let injected = false;
  return new Proxy(source, {
    get(target, property) {
      if (property === 'eval') {
        return async (...args: Parameters<WwRedis['eval']>) => {
          const result = await target.eval(...args);
          const script = String(args[0]);
          const options = args[1];
          const keys = options !== undefined && 'keys' in options ? options.keys : [];
          if (
            !injected && result === 1 && keys.length === 1 &&
            keys[0]?.startsWith('ww:lock:file:') &&
            script.includes("redis.call('del', KEYS[1])")
          ) {
            injected = true;
            throw new Error('simulated accepted release ACK loss');
          }
          return result;
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function refuseFirstTerminalFileLockRelease(source: WwRedis): WwRedis {
  let refusals = 0;
  return new Proxy(source, {
    get(target, property) {
      if (property === 'eval') {
        return async (...args: Parameters<WwRedis['eval']>) => {
          const script = String(args[0]);
          const options = args[1];
          const keys = options !== undefined && 'keys' in options ? options.keys : [];
          if (
            refusals < 2 && keys.length === 1 && keys[0]?.startsWith('ww:lock:file:') &&
            script.includes("redis.call('del', KEYS[1])")
          ) {
            refusals += 1;
            return 0;
          }
          return target.eval(...args);
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function stealTaskLeaseAfterFileTransfer(
  source: WwRedis,
  taskId: EntityId,
): WwRedis {
  let injected = false;
  return new Proxy(source, {
    get(target, property) {
      if (property === 'eval') {
        return async (...args: Parameters<WwRedis['eval']>) => {
          const result = await target.eval(...args);
          const options = args[1];
          const keys = options !== undefined && 'keys' in options ? options.keys : [];
          if (
            !injected && result === 1 && keys.length >= 2 &&
            keys.every((key) => key.startsWith('ww:lock:file:'))
          ) {
            injected = true;
            await target.del(taskLockKey(taskId));
          }
          return result;
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function stealTaskLeaseAfterAcceptedStatusEvent(
  source: ClickHouseClient,
  redis: WwRedis,
  taskId: EntityId,
): ClickHouseClient {
  let injected = false;
  return new Proxy(source, {
    get(target, property) {
      if (property === 'insert') {
        return async (options: Parameters<ClickHouseClient['insert']>[0]) => {
          await target.insert(options);
          const rows = Array.isArray(options.values) ? options.values : [];
          const matched = rows.some((value) =>
            value !== null && typeof value === 'object' &&
            'event_type' in value && value.event_type === 'status_change' &&
            'task_id' in value && value.task_id === taskId);
          if (!injected && options.table === 'events' && matched) {
            injected = true;
            await redis.del(taskLockKey(taskId));
          }
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function delayedQueries(source: ClickHouseClient, delayMs: number): ClickHouseClient {
  return new Proxy(source, {
    get(target, property) {
      if (property === 'query') {
        return async (options: Parameters<ClickHouseClient['query']>[0]) => {
          await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
          return target.query(options);
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

describe.skipIf(!up)('Phase 4 scheduler ClickHouse/Redis integration', () => {
  const database = `ww_test_scheduler_phase4_${Date.now()}_${process.pid}`;
  let ch: ClickHouseClient;
  let redis: WwRedis;
  const cleanupKeys = new Set<string>();

  beforeAll(async () => {
    await runMigrations({ database });
    ch = createCh({ database });
    redis = await createRedis();
  }, 30_000);

  afterEach(async () => {
    if (cleanupKeys.size > 0) await redis.del([...cleanupKeys]);
    cleanupKeys.clear();
  });

  afterAll(async () => {
    if (redis?.isOpen) {
      if (cleanupKeys.size > 0) await redis.del([...cleanupKeys]);
      redis.destroy();
    }
    if (ch !== undefined) await ch.close();
    const admin = createCh({ database: 'default' });
    await admin.command({ query: `DROP DATABASE IF EXISTS ${database}` });
    await admin.close();
  }, 30_000);

  async function seed(options: SeedOptions = {}): Promise<Fixture> {
    const projectId = randomUUID();
    const planId = randomUUID();
    const taskId = randomUUID();
    const dependencyTaskId = options.dependencyStatus === undefined ? undefined : randomUUID();
    const workerIds = [randomUUID(), randomUUID()].sort().map((id) => EntityIdSchema.parse(id));
    const verifierIds = [randomUUID(), randomUUID()].sort().map((id) => EntityIdSchema.parse(id));
    const agentIds = Object.freeze({
      worker1: workerIds[0]!,
      worker2: workerIds[1]!,
      verifierSameModel: verifierIds[0]!,
      verifierIndependent: verifierIds[1]!,
    });
    const base = Date.now() + 2_000;
    let tick = 0;
    const now = (): string => new Date(base + tick++ * 10).toISOString();
    const clock: ClockPort = Object.freeze({ now });
    const createdAt = now();

    await createProject(ch, {
      project_id: projectId,
      name: `Phase4 ${projectId.slice(0, 8)}`,
      slug: `phase4-${projectId.slice(0, 8)}`,
      type: 'web',
      status: 'running',
      description: 'Phase 4 integration fixture',
      workspace_path: `/tmp/${projectId}`,
      budget_usd_limit: 10,
      settings: {},
      active_plan_id: planId,
      created_at: createdAt,
      updated_at: createdAt,
    });

    const agents = [
      {
        agentId: agentIds.worker1,
        role: 'worker' as const,
        name: 'Worker A',
        modelRef: 'openai:gpt-test',
        promptName: 'role.worker.coding',
        promptVersion: 2,
      },
      {
        agentId: agentIds.worker2,
        role: 'worker' as const,
        name: 'Worker B',
        modelRef: 'anthropic:claude-test',
        promptName: 'role.worker.coding',
        promptVersion: 2,
      },
      {
        agentId: agentIds.verifierSameModel,
        role: 'verifier' as const,
        name: 'Verifier same model',
        modelRef: 'openai:gpt-test',
        promptName: 'role.verifier',
        promptVersion: 1,
      },
      {
        agentId: agentIds.verifierIndependent,
        role: 'verifier' as const,
        name: 'Verifier independent',
        modelRef: 'deepseek:verify-test',
        promptName: 'role.verifier',
        promptVersion: 1,
      },
    ];
    for (const agent of agents) {
      const key = agentLockKey(agent.agentId);
      cleanupKeys.add(key);
      cleanupKeys.add(leaseFenceKey(key));
      await createAgent(ch, {
        agent_id: agent.agentId,
        project_id: projectId,
        role: agent.role,
        group: 'coding',
        name: agent.name,
        model_ref: agent.modelRef,
        parent_agent_id: NIL_UUID,
        clone_of: NIL_UUID,
        status: 'idle',
        current_task_id: NIL_UUID,
        prompt_name: agent.promptName,
        prompt_version: agent.promptVersion,
        tasks_done: 0,
        tasks_rejected: 0,
        created_at: createdAt,
        updated_at: createdAt,
      });
    }
    await createPlan(ch, {
      plan_id: planId,
      project_id: projectId,
      plan_version: 1,
      status: 'approved',
      title: 'Phase 4 plan',
      content_md: '# Plan v1',
      council_session_id: NIL_UUID,
      team_json: {},
      scenarios_json: [],
      replan_reason: '',
      supersedes_plan_id: NIL_UUID,
      created_by_agent_id: agentIds.worker1,
      approved_by: 'test',
      created_at: createdAt,
    });
    if (dependencyTaskId !== undefined) {
      await createTask(ch, taskInput({
        projectId,
        planId,
        taskId: dependencyTaskId,
        title: 'Dependency',
        createdAt,
        targetFiles: [],
        dependsOn: [],
        issuerAgentId: agentIds.worker1,
        status: options.dependencyStatus ?? 'queued',
      }));
    }
    await createTask(ch, taskInput({
      projectId,
      planId,
      taskId,
      title: 'Scheduled task',
      createdAt,
      targetFiles: options.targetFiles ?? ['src/a.ts'],
      dependsOn: dependencyTaskId === undefined ? [] : [dependencyTaskId],
      issuerAgentId: agentIds.worker1,
      status: 'queued',
      ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
    }));
    for (const currentTaskId of [taskId, ...(dependencyTaskId === undefined ? [] : [dependencyTaskId])]) {
      const key = taskLockKey(currentTaskId);
      cleanupKeys.add(key);
      cleanupKeys.add(leaseFenceKey(key));
    }
    cleanupKeys.add(queueKey(projectId));
    for (const path of options.targetFiles ?? ['src/a.ts']) cleanupKeys.add(lockKey(projectId, path));
    return Object.freeze({
      projectId,
      planId,
      taskId,
      ...(dependencyTaskId === undefined ? {} : { dependencyTaskId }),
      worker1: agentIds.worker1,
      worker2: agentIds.worker2,
      verifierSameModel: agentIds.verifierSameModel,
      verifierIndependent: agentIds.verifierIndependent,
      clock,
      now,
    });
  }

  function taskInput(input: {
    readonly projectId: EntityId;
    readonly planId: EntityId;
    readonly taskId: EntityId;
    readonly title: string;
    readonly createdAt: string;
    readonly targetFiles: readonly string[];
    readonly dependsOn: readonly EntityId[];
    readonly issuerAgentId: EntityId;
    readonly status: 'queued' | 'done';
    readonly maxAttempts?: number;
  }): Omit<TaskRow, 'version'> {
    return {
      task_id: input.taskId,
      project_id: input.projectId,
      plan_id: input.planId,
      parent_task_id: NIL_UUID,
      title: input.title,
      description: `${input.title} description`,
      status: input.status,
      priority: 5,
      issuer_agent_id: input.issuerAgentId,
      worker_agent_id: NIL_UUID,
      verifier_agent_id: NIL_UUID,
      group: 'coding',
      depends_on: input.dependsOn,
      target_files: input.targetFiles,
      attempt: 0,
      max_attempts: input.maxAttempts ?? 3,
      delegation_depth: 0,
      token_budget: 2_000,
      tokens_spent: '0',
      commit_hash: '',
      result_summary: '',
      reject_reason: '',
      task_brief_id: NIL_UUID,
      assignment_attempt_id: NIL_UUID,
      created_at: input.createdAt,
      updated_at: input.createdAt,
    };
  }

  function services(
    fixture: Fixture,
    consumerId: string,
    client: ClickHouseClient = ch,
    redisClient: WwRedis = redis,
    options: {
      readonly clock?: ClockPort;
      readonly fileLockTtlSec?: number;
      readonly leaseTtlMs?: number;
    } = {},
  ): Services {
    const clock = options.clock ?? fixture.clock;
    const snapshot = new TaskContextSnapshotBuilder(client);
    const brief = new TaskBriefService(fixture.projectId, client, snapshot, {
      clock,
      redis: redisClient,
      });
    const leaseTtlMs = options.leaseTtlMs ?? 5_000;
    const transition = new TaskTransitionService(client, redisClient, { leaseTtlMs });
    const causal = new TaskCausalLog(client, redisClient, { leaseTtlMs });
    const assignment = new AssignmentService(
      fixture.projectId,
      consumerId,
      client,
      redisClient,
      brief,
      transition,
      causal,
      {
        clock,
        taskLeaseTtlMs: leaseTtlMs,
        fileLockTtlSec: options.fileLockTtlSec ?? 30,
      },
    );
    return Object.freeze({ assignment, causal, transition });
  }

  async function siblingTask(
    fixture: Fixture,
    targetFiles: readonly string[],
  ): Promise<Fixture> {
    const taskId = EntityIdSchema.parse(randomUUID());
    await createTask(ch, taskInput({
      projectId: fixture.projectId,
      planId: fixture.planId,
      taskId,
      title: 'Concurrent sibling',
      createdAt: fixture.now(),
      targetFiles,
      dependsOn: [],
      issuerAgentId: fixture.worker1,
      status: 'queued',
    }));
    const taskKey = taskLockKey(taskId);
    cleanupKeys.add(taskKey);
    cleanupKeys.add(leaseFenceKey(taskKey));
    for (const path of targetFiles) cleanupKeys.add(lockKey(fixture.projectId, path));
    return Object.freeze({ ...fixture, taskId });
  }

  async function startWorking(
    fixture: Fixture,
    attempt: AssignmentAttemptV1,
    transition = services(fixture, 'transition').transition,
  ): Promise<void> {
    await transition.apply(systemPrincipal('test-orchestrator', fixture.now()), {
      protocolVersion: 1,
      transitionRequestId: randomUUID(),
      projectId: fixture.projectId,
      taskId: fixture.taskId,
      taskBriefId: attempt.taskBriefId,
      assignmentAttemptId: attempt.assignmentAttemptId,
      causationId: randomUUID(),
      requestedAt: fixture.now(),
      action: 'start_work',
    });
  }

  it('deterministik bagimsiz cift, tek aktif attempt, brief ve ordinal sifiri kalici kurar', async () => {
    const fixture = await seed({ targetFiles: ['src/b.ts', 'src/a.ts', 'src/a.ts'] });
    const concurrent = await Promise.allSettled([
      services(fixture, 'scheduler-a').assignment.assign(fixture.taskId),
      services(fixture, 'scheduler-b').assignment.assign(fixture.taskId),
    ]);
    const first = concurrent.find((result) => result.status === 'fulfilled')?.value;
    if (first === undefined) {
      throw new Error(`concurrent assignment winner bulunamadi: ${concurrent.map((result) =>
        result.status === 'rejected'
          ? result.reason instanceof Error ? result.reason.message : String(result.reason)
          : 'fulfilled').join(' | ')}`);
    }
    expect(first.workerAgentId).toBe(fixture.worker1);
    expect(first.verifierAgentId).toBe(fixture.verifierIndependent);
    expect(first.workerAgentId).not.toBe(first.verifierAgentId);

    const task = await getLatestTask(ch, fixture.projectId, fixture.taskId);
    expect(task).toMatchObject({
      status: 'assigned',
      assignment_attempt_id: first.assignmentAttemptId,
      task_brief_id: first.taskBriefId,
    });
    const brief = await getTaskBrief(ch, first.taskBriefId);
    expect(brief?.sourceVersionManifest.map((ref) => ref.sourceType)).toEqual([
      'task', 'plan', 'prompt', 'prompt', 'rule', 'rule', 'rule', 'rule',
    ]);
    expect(await listTaskCausalEntries(ch, fixture.taskId, first.assignmentAttemptId))
      .toMatchObject([{ ordinal: 0, source_type: 'assignment' }]);
    expect(await renewFileLock(redis, lockKey(fixture.projectId, 'src/a.ts'), first.assignmentAttemptId, 30))
      .toBe(true);
    expect(await renewFileLock(redis, lockKey(fixture.projectId, 'src/b.ts'), first.assignmentAttemptId, 30))
      .toBe(true);

    const recovered = await services(fixture, 'scheduler-recovery').assignment.assign(fixture.taskId);
    expect(recovered).toEqual(first);
    const count = await ch.query({
      query: `SELECT countDistinct(assignment_attempt_id) AS count
        FROM assignment_attempts WHERE task_id = {taskId:UUID}`,
      query_params: { taskId: fixture.taskId },
      format: 'JSONEachRow',
    });
    expect(await count.json()).toEqual([{ count: '1' }]);
  });

  it('lock eventleri accepted crash ve exact replayde her benzersiz kilit icin tekildir', async () => {
    const fixture = await seed({
      targetFiles: ['src/event-b.ts', 'src/event-a.ts', 'src/event-a.ts'],
    });
    const stolen = stealTaskLeaseAfterAcceptedLockEvent(ch, redis, fixture.taskId);
    await expect(services(
      fixture,
      'lock-event-crash',
      stolen,
      redis,
    ).assignment.assign(fixture.taskId)).rejects.toMatchObject({ code: 'STALE_FENCE' });

    const recovered = await services(fixture, 'lock-event-replay').assignment.assign(fixture.taskId);
    expect(await services(fixture, 'lock-event-exact').assignment.assign(fixture.taskId))
      .toEqual(recovered);
    const events = (await listEvents(ch, fixture.projectId, { limit: 1_000 }))
      .filter((event) => event.task_id === fixture.taskId && event.event_type === 'lock_acquired');
    expect(events).toHaveLength(2);
    expect(new Set(events.map((event) => event.event_id)).size).toBe(2);
    expect(events.map((event) => (
      event.payload !== null && typeof event.payload === 'object' &&
      !Array.isArray(event.payload) ? event.payload['path'] : undefined
    )).sort()).toEqual(['src/event-a.ts', 'src/event-b.ts']);
    const physical = await ch.query({
      query: `SELECT event_id, count() AS count FROM events
        WHERE task_id = {taskId:UUID} AND event_type = 'lock_acquired'
        GROUP BY event_id ORDER BY event_id`,
      query_params: { taskId: fixture.taskId },
      format: 'JSONEachRow',
    });
    const physicalRows = await physical.json<{ event_id: string; count: string }>();
    expect(physicalRows).toHaveLength(2);
    expect(physicalRows.map((row) => row.count)).toEqual(['1', '1']);
    expect(new Set(physicalRows.map((row) => row.event_id)))
      .toEqual(new Set(events.map((event) => event.event_id)));
  });

  it('gecikmis ilk atama tek clock anini command, yeni plan/prompt, brief ve lease icin pinler', async () => {
    const fixture = await seed({ targetFiles: ['src/delayed.ts'] });
    const sourceAt = '2095-01-01T00:00:09.000Z';
    const pinnedAt = '2095-01-01T00:00:10.000Z';
    const plan = await getLatestPlan(ch, fixture.projectId, fixture.planId);
    if (plan === null) throw new Error('fixture plani bulunamadi');
    const revisedPlan = await appendPlanVersion(ch, {
      expectedVersion: plan.version,
      next: {
        ...plan,
        content_md: '# Delayed plan v2',
      },
    });
    await appendPromptVersion(ch, {
      prompt_name: 'role.worker.coding',
      prompt_version: 3,
      content: 'Delayed worker prompt v3',
      variables: [],
      changelog: 'phase 4 delayed assignment coverage',
      is_active: false,
      created_at: sourceAt,
    });
    await appendPromptVersion(ch, {
      prompt_name: 'role.verifier',
      prompt_version: 2,
      content: 'Delayed verifier prompt v2',
      variables: [],
      changelog: 'phase 4 delayed assignment coverage',
      is_active: false,
      created_at: sourceAt,
    });
    for (const [agentId, promptVersion] of [
      [fixture.worker1, 3],
      [fixture.verifierIndependent, 2],
    ] as const) {
      const agent = await getLatestAgent(ch, fixture.projectId, agentId);
      if (agent === null) throw new Error(`fixture agenti bulunamadi: ${agentId}`);
      await appendAgentVersion(ch, {
        expectedVersion: agent.version,
        assignmentFence: '1',
        next: { ...agent, prompt_version: promptVersion, updated_at: sourceAt },
      });
    }

    let clockCalls = 0;
    const runtime = services(fixture, 'delayed-clock', ch, redis, {
      clock: Object.freeze({
        now: () => {
          clockCalls += 1;
          return pinnedAt;
        },
      }),
    });
    const attempt = await runtime.assignment.assign(fixture.taskId);
    const brief = await getTaskBrief(ch, attempt.taskBriefId);
    expect(clockCalls).toBe(1);
    expect(attempt.assignedAt).toBe(pinnedAt);
    expect(attempt.leaseExpiresAt).toBe('2095-01-01T00:00:15.000Z');
    expect(brief).toMatchObject({
      baseContextCutoffAt: pinnedAt,
      sealedAt: pinnedAt,
      planHash: canonicalSha256V1(revisedPlan),
    });
    expect(brief?.promptRefs.map((ref) => `${ref.sourceId}@${ref.version}`).sort()).toEqual([
      'role.verifier@2',
      'role.worker.coding@3',
    ]);
    const command = (await listLatestEffectsByState(ch, fixture.projectId, 'succeeded'))
      .find((effect) =>
        effect.task_id === fixture.taskId &&
        effect.effect_type === 'scheduler_assignment_command_v1');
    expect(command?.created_at).toBe(pinnedAt);
  });

  it('ilk command reserve sonrasi crash exact retryda ilk clock anini korur', async () => {
    const fixture = await seed({ targetFiles: ['src/initial-time-retry.ts'] });
    const instants = [
      '2096-01-01T00:00:10.000Z',
      '2096-01-01T02:00:00.000Z',
    ] as const;
    let calls = 0;
    const advancingClock: ClockPort = Object.freeze({
      now: () => instants[Math.min(calls++, instants.length - 1)]!,
    });
    const crashing = services(
      fixture,
      'initial-time-crash',
      stealLeaseAfterEffectReserve(
        ch,
        redis,
        fixture.taskId,
        'scheduler_assignment_command_v1',
      ),
      redis,
      { clock: advancingClock },
    );
    await expect(crashing.assignment.assign(fixture.taskId)).rejects.toMatchObject({
      name: 'SchedulerError',
      code: 'STALE_FENCE',
    });
    const recovered = await services(
      fixture,
      'initial-time-retry',
      ch,
      redis,
      { clock: advancingClock },
    ).assignment.assign(fixture.taskId);
    const brief = await getTaskBrief(ch, recovered.taskBriefId);
    expect(calls).toBe(2);
    expect(recovered.assignedAt).toBe(instants[0]);
    expect(recovered.leaseExpiresAt).toBe('2096-01-01T00:00:15.000Z');
    expect(brief?.baseContextCutoffAt).toBe(instants[0]);
    const command = (await listLatestEffectsByState(ch, fixture.projectId, 'succeeded'))
      .find((effect) =>
        effect.task_id === fixture.taskId &&
        effect.effect_type === 'scheduler_assignment_command_v1');
    expect(command?.created_at).toBe(instants[0]);
  });

  it('task lease Redis kaybindan sonra durable effect fence tabaninin ustunden baslar', async () => {
    const fixture = await seed({ targetFiles: ['src/effect-fence.ts'] });
    const causationId = EntityIdSchema.parse(randomUUID());
    await reserveEffect(ch, {
      causation_id: causationId,
      stable_effect_id: 'test-durable-fence-anchor',
      project_id: fixture.projectId,
      task_id: fixture.taskId,
      effect_type: 'test_durable_fence_anchor_v1',
      request: { taskId: fixture.taskId },
      replay_safety: 'replay_safe',
      lease_fence: '9000000',
      created_at: fixture.now(),
    });
    const key = taskLockKey(fixture.taskId);
    await redis.del(key, leaseFenceKey(key));
    const attempt = await services(fixture, 'effect-fence-floor').assignment.assign(fixture.taskId);
    const command = (await listLatestEffectsByState(ch, fixture.projectId, 'succeeded'))
      .find((effect) =>
        effect.task_id === fixture.taskId &&
        effect.effect_type === 'scheduler_assignment_command_v1');
    expect(command).toBeDefined();
    expect(BigInt(command!.lease_fence)).toBeGreaterThan(9_000_000n);
    expect(attempt.taskId).toBe(fixture.taskId);
  });

  it('iki task ayni agent havuzu icin yaristiginda reservation catismasi sizdirmaz', async () => {
    const firstFixture = await seed({ targetFiles: ['src/race-a.ts'] });
    const secondFixture = await siblingTask(firstFixture, ['src/race-b.ts']);
    const raced = await Promise.allSettled([
      services(firstFixture, 'agent-race-a').assignment.assign(firstFixture.taskId),
      services(secondFixture, 'agent-race-b').assignment.assign(secondFixture.taskId),
    ]);
    for (const result of raced) {
      if (result.status === 'rejected') {
        expect(result.reason).toMatchObject({
          code: expect.stringMatching(/LEASE_UNAVAILABLE|NO_ELIGIBLE_AGENT/),
        });
        expect(result.reason).not.toMatchObject({ name: 'RepositoryConflictError' });
      }
    }
    const attempts: AssignmentAttemptV1[] = raced.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : []);
    if (attempts.length === 1) {
      const retryFixture = attempts[0]!.taskId === firstFixture.taskId
        ? secondFixture
        : firstFixture;
      attempts.push(await services(retryFixture, 'agent-race-retry').assignment.assign(
        retryFixture.taskId,
      ));
    }
    expect(attempts).toHaveLength(2);
    expect(new Set(attempts.map((attempt) => attempt.workerAgentId)).size).toBe(2);
    expect(new Set(attempts.map((attempt) => attempt.verifierAgentId)).size).toBe(2);
    for (const attempt of attempts) {
      expect((await getLatestAgent(ch, attempt.projectId, attempt.workerAgentId))?.current_task_id)
        .toBe(attempt.taskId);
      expect((await getLatestAgent(ch, attempt.projectId, attempt.verifierAgentId))?.current_task_id)
        .toBe(attempt.taskId);
    }
  });

  it('dependency ve sirali file-lock reddinde task queued kalir, kismi kilitleri geri alir', async () => {
    const blockedFixture = await seed({
      dependencyStatus: 'queued',
      targetFiles: ['src/a.ts', 'src/b.ts'],
    });
    await expect(services(blockedFixture, 'scheduler-dependency').assignment.assign(
      blockedFixture.taskId,
    )).rejects.toMatchObject({
      code: 'DEPENDENCY_BLOCKED',
    });
    const fixture = await seed({
      dependencyStatus: 'done',
      targetFiles: ['src/a.ts', 'src/b.ts'],
    });
    const assignment = services(fixture, 'scheduler-locks').assignment;

    const blockedKey = lockKey(fixture.projectId, 'src/b.ts');
    expect(await acquireFileLock(redis, blockedKey, 'external-task', 30)).toBe(true);
    await expect(assignment.assign(fixture.taskId)).rejects.toMatchObject({
      code: 'FILE_LOCK_UNAVAILABLE',
    });
    const firstKey = lockKey(fixture.projectId, 'src/a.ts');
    expect(await acquireFileLock(redis, firstKey, 'rollback-proof', 30)).toBe(true);
    expect((await getLatestTask(ch, fixture.projectId, fixture.taskId))?.status).toBe('queued');
    expect((await getLatestAgent(ch, fixture.projectId, fixture.worker1))?.status).toBe('idle');
    await releaseFileLock(redis, firstKey, 'rollback-proof');
    await releaseFileLock(redis, blockedKey, 'external-task');
  });

  it('file lock kabulunden hemen sonraki task lease theft tum lokal kilitleri temizler', async () => {
    const fixture = await seed({ targetFiles: ['src/accepted-lock-a.ts', 'src/accepted-lock-b.ts'] });
    const stolenRedis = stealTaskLeaseAfterFileAcquire(redis, fixture.taskId);
    await expect(services(fixture, 'accepted-file-lock-theft', ch, stolenRedis).assignment.assign(
      fixture.taskId,
    )).rejects.toMatchObject({ code: 'STALE_FENCE' });

    expect(await redis.get(lockKey(fixture.projectId, 'src/accepted-lock-a.ts'))).toBeNull();
    expect(await redis.get(lockKey(fixture.projectId, 'src/accepted-lock-b.ts'))).toBeNull();
    expect((await getLatestTask(ch, fixture.projectId, fixture.taskId))?.status).toBe('queued');
    const planned = (await listLatestEffectsByState(ch, fixture.projectId, 'pending'))
      .find((effect) =>
        effect.task_id === fixture.taskId &&
        effect.effect_type === 'scheduler_assignment_command_v1');
    expect(planned).toBeDefined();
    if (planned === undefined || planned.result === null || typeof planned.result !== 'object') {
      throw new Error('initial assignment planned effect bulunamadi');
    }
    const plannedResult = planned.result as {
      readonly taskBriefId: EntityId;
      readonly sourceVersionManifest: readonly unknown[];
    };
    expect(plannedResult.sourceVersionManifest.length).toBeGreaterThan(0);
    expect((await getTaskBrief(ch, plannedResult.taskBriefId))?.sourceVersionManifest)
      .toEqual(plannedResult.sourceVersionManifest);
    const recovered = await services(fixture, 'accepted-file-lock-retry').assignment.assign(
      fixture.taskId,
    );
    expect(recovered.taskBriefId).toBe(plannedResult.taskBriefId);
    expect(await redis.get(lockKey(fixture.projectId, 'src/accepted-lock-a.ts')))
      .toBe(recovered.assignmentAttemptId);
    expect(await redis.get(lockKey(fixture.projectId, 'src/accepted-lock-b.ts')))
      .toBe(recovered.assignmentAttemptId);
    expect((await getLatestEffect(ch, planned.causation_id, planned.stable_effect_id))?.state)
      .toBe('succeeded');
  });

  it('initial cleanup task guardi birakmadan locklari temizler ve concurrent retry lockunu silemez', async () => {
    const path = 'src/initial-cleanup-barrier.ts';
    const fixture = await seed({ targetFiles: [path] });
    const barrier = pauseTaskLeaseReleaseAfterFileAcquire(redis, fixture.taskId);
    const interrupted = services(
      fixture,
      'initial-cleanup-interrupted',
      uncertainClient(ch, 'agents', 'before_accept'),
      barrier.client,
    ).assignment.assign(fixture.taskId);

    await barrier.taskLeaseReleased;
    const retry = await services(fixture, 'initial-cleanup-retry').assignment.assign(
      fixture.taskId,
    );
    expect((await getLatestTask(ch, fixture.projectId, fixture.taskId))?.assignment_attempt_id)
      .toBe(retry.assignmentAttemptId);
    barrier.resume();
    await expect(interrupted).rejects.toMatchObject({ code: 'UNCERTAIN_WRITE' });
    expect(await redis.get(lockKey(fixture.projectId, path))).toBe(retry.assignmentAttemptId);
  });

  it('stale cleanup assert sonrasi higher-fence exact retry lockunu atomik task fence ile korur', async () => {
    const path = 'src/stale-cleanup-fence.ts';
    const fixture = await seed({ targetFiles: [path] });
    const barrier = pauseTaskFencedFileReleaseAfterLeaseTheft(redis, fixture.taskId);
    const staleCleanup = services(
      fixture,
      'stale-cleanup-owner',
      uncertainClient(ch, 'agents', 'before_accept'),
      barrier.client,
    ).assignment.assign(fixture.taskId);

    await barrier.staleReleaseReady;
    const fresh = await services(fixture, 'higher-fence-exact-retry').assignment.assign(
      fixture.taskId,
    );
    expect(await redis.get(lockKey(fixture.projectId, path))).toBe(fresh.assignmentAttemptId);
    barrier.resume();
    await expect(staleCleanup).rejects.toMatchObject({ code: 'STALE_FENCE' });
    expect(await redis.get(lockKey(fixture.projectId, path))).toBe(fresh.assignmentAttemptId);
    expect((await getLatestTask(ch, fixture.projectId, fixture.taskId))?.assignment_attempt_id)
      .toBe(fresh.assignmentAttemptId);
  });

  it('file-lock acquire before/after ACK kaybini service ve worker sinirinda uzlastirir', async () => {
    for (const mode of ['before_accept', 'after_accept'] as const) {
      const directPath = `src/acquire-${mode}-service.ts`;
      const direct = await seed({ targetFiles: [directPath] });
      const directAttempt = await services(
        direct,
        `acquire-${mode}-service`,
        ch,
        loseFileLockAcquireResponse(redis, mode),
      ).assignment.assign(direct.taskId);
      expect(await redis.get(lockKey(direct.projectId, directPath)))
        .toBe(directAttempt.assignmentAttemptId);

      const workerPath = `src/acquire-${mode}-worker.ts`;
      const workerFixture = await seed({ targetFiles: [workerPath] });
      await enqueueTask(redis, queueKey(workerFixture.projectId), workerFixture.taskId);
      const unreliable = loseFileLockAcquireResponse(redis, mode);
      const worker = new SchedulerWorker(redis, {
        forProject: (_projectId, consumerId) => services(
          workerFixture,
          consumerId,
          ch,
          unreliable,
        ).assignment,
      }, { blockMs: 5, reclaimMinIdleMs: 30_000 });
      const result = await worker.runOnce(workerFixture.projectId, `acquire-${mode}-worker`);
      worker.stop();
      expect(result.items).toMatchObject([{ state: 'assigned' }]);
      expect(result.items[0]?.errorCode).toBeUndefined();
      const workerAttemptId = result.items[0]?.assignmentAttemptId;
      expect(workerAttemptId).toBeDefined();
      expect(await redis.get(lockKey(workerFixture.projectId, workerPath)))
        .toBe(workerAttemptId);
    }

    const ambiguousPath = 'src/acquire-ambiguous.ts';
    const ambiguous = await seed({ targetFiles: [ambiguousPath] });
    await expect(services(
      ambiguous,
      'acquire-ambiguous',
      ch,
      loseFileLockAcquireResponse(redis, 'always_before_accept'),
    ).assignment.assign(ambiguous.taskId)).rejects.toMatchObject({
      name: 'SchedulerError',
      code: 'UNCERTAIN_WRITE',
      cause: expect.any(Error),
    });
    expect(await redis.get(lockKey(ambiguous.projectId, ambiguousPath))).toBeNull();
  }, 20_000);

  it('file-lock renew before/after ACK kaybini owner ve TTL ile service/workerda uzlastirir', async () => {
    for (const mode of ['before_accept', 'after_accept'] as const) {
      const servicePath = `src/renew-${mode}-service.ts`;
      const serviceFixture = await seed({ targetFiles: [servicePath] });
      const healthy = services(serviceFixture, `renew-${mode}-healthy`, ch, redis, {
        fileLockTtlSec: 30,
      });
      const initial = await healthy.assignment.assign(serviceFixture.taskId);
      const serviceKey = lockKey(serviceFixture.projectId, servicePath);
      if (mode === 'before_accept') await redis.expire(serviceKey, 2);
      const recovered = await services(
        serviceFixture,
        `renew-${mode}-service`,
        ch,
        loseFileLockRenewResponse(redis, mode),
        { fileLockTtlSec: 30 },
      ).assignment.assign(serviceFixture.taskId);
      expect(recovered).toEqual(initial);
      expect(await redis.get(serviceKey)).toBe(initial.assignmentAttemptId);
      expect(await redis.ttl(serviceKey)).toBeGreaterThan(25);

      const workerPath = `src/renew-${mode}-worker.ts`;
      const workerFixture = await seed({ targetFiles: [workerPath] });
      const workerHealthy = services(workerFixture, `renew-${mode}-worker-healthy`, ch, redis, {
        fileLockTtlSec: 30,
      });
      const workerInitial = await workerHealthy.assignment.assign(workerFixture.taskId);
      const workerKey = lockKey(workerFixture.projectId, workerPath);
      if (mode === 'before_accept') await redis.expire(workerKey, 2);
      await enqueueTask(redis, queueKey(workerFixture.projectId), workerFixture.taskId);
      const unreliable = loseFileLockRenewResponse(redis, mode);
      const worker = new SchedulerWorker(redis, {
        forProject: (_projectId, consumerId) => services(
          workerFixture,
          consumerId,
          ch,
          unreliable,
          { fileLockTtlSec: 30 },
        ).assignment,
      }, { blockMs: 5, reclaimMinIdleMs: 30_000 });
      const result = await worker.runOnce(workerFixture.projectId, `renew-${mode}-worker`);
      worker.stop();
      expect(result.items).toMatchObject([{
        state: 'assigned',
        assignmentAttemptId: workerInitial.assignmentAttemptId,
      }]);
      expect(result.items[0]?.errorCode).toBeUndefined();
      expect(await redis.get(workerKey)).toBe(workerInitial.assignmentAttemptId);
      expect(await redis.ttl(workerKey)).toBeGreaterThan(25);
    }

    for (const mode of ['transport_error', 'malformed'] as const) {
      const indeterminatePath = `src/renew-indeterminate-${mode}.ts`;
      const indeterminate = await seed({ targetFiles: [indeterminatePath] });
      const indeterminateHealthy = services(indeterminate, `renew-indeterminate-${mode}-healthy`);
      const indeterminateAttempt = await indeterminateHealthy.assignment.assign(
        indeterminate.taskId,
      );
      const lostRenew = loseFileLockRenewResponse(redis, 'before_accept');
      const unreadableSnapshot = new Proxy(lostRenew, {
        get(target, property) {
          if (property === 'eval') {
            return async (...args: Parameters<WwRedis['eval']>) => {
              if (String(args[0]).includes("redis.call('pttl', KEYS[1])")) {
                if (mode === 'malformed') return ['owner-without-pttl'];
                throw new Error('simulated atomic owner/PTTL read loss');
              }
              return target.eval(...args);
            };
          }
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      await expect(services(
        indeterminate,
        `renew-indeterminate-${mode}`,
        ch,
        unreadableSnapshot,
      ).assignment.assign(indeterminate.taskId)).rejects.toMatchObject({
        name: 'SchedulerError',
        code: 'UNCERTAIN_WRITE',
        cause: expect.objectContaining({ reconciliation: expect.any(Error) }),
      });
      expect(await redis.get(lockKey(indeterminate.projectId, indeterminatePath)))
        .toBe(indeterminateAttempt.assignmentAttemptId);
    }
  }, 20_000);

  it('renew uzlastirmasi legacy owner/TTL arasindaki foreign replacement torn snapshotunu kullanmaz', async () => {
    const servicePath = 'src/renew-atomic-service.ts';
    const serviceFixture = await seed({ targetFiles: [servicePath] });
    const serviceInitial = await services(serviceFixture, 'renew-atomic-service-initial', ch, redis, {
      fileLockTtlSec: 30,
    }).assignment.assign(serviceFixture.taskId);
    const serviceKey = lockKey(serviceFixture.projectId, servicePath);
    await redis.expire(serviceKey, 2);
    const serviceTorn = armLegacyTornFileLockRead(
      loseFileLockRenewResponse(redis, 'before_accept'),
      serviceKey,
      'foreign-service-owner',
    );
    const serviceRecovered = await services(
      serviceFixture,
      'renew-atomic-service-recovery',
      ch,
      serviceTorn.client,
      { fileLockTtlSec: 30 },
    ).assignment.assign(serviceFixture.taskId);
    expect(serviceRecovered).toEqual(serviceInitial);
    expect(serviceTorn.triggered()).toBe(false);
    expect(await redis.get(serviceKey)).toBe(serviceInitial.assignmentAttemptId);
    expect(await redis.pTTL(serviceKey)).toBeGreaterThan(25_000);

    const workerPath = 'src/renew-atomic-worker.ts';
    const workerFixture = await seed({ targetFiles: [workerPath] });
    const workerInitial = await services(workerFixture, 'renew-atomic-worker-initial', ch, redis, {
      fileLockTtlSec: 30,
    }).assignment.assign(workerFixture.taskId);
    const workerKey = lockKey(workerFixture.projectId, workerPath);
    await redis.expire(workerKey, 2);
    await enqueueTask(redis, queueKey(workerFixture.projectId), workerFixture.taskId);
    const workerTorn = armLegacyTornFileLockRead(
      loseFileLockRenewResponse(redis, 'before_accept'),
      workerKey,
      'foreign-worker-owner',
    );
    const worker = new SchedulerWorker(workerTorn.client, {
      forProject: (_projectId, consumerId) => services(
        workerFixture,
        consumerId,
        ch,
        workerTorn.client,
        { fileLockTtlSec: 30 },
      ).assignment,
    }, { blockMs: 5, reclaimMinIdleMs: 30_000 });
    const result = await worker.runOnce(workerFixture.projectId, 'renew-atomic-worker');
    worker.stop();
    expect(result.items).toMatchObject([{
      state: 'assigned',
      assignmentAttemptId: workerInitial.assignmentAttemptId,
    }]);
    expect(result.items[0]?.errorCode).toBeUndefined();
    expect(workerTorn.triggered()).toBe(false);
    expect(await redis.get(workerKey)).toBe(workerInitial.assignmentAttemptId);
    expect(await redis.pTTL(workerKey)).toBeGreaterThan(25_000);
  }, 15_000);

  it('kismi file-lock temizligi release transport hatasi veya false sonucunu uzlastirir', async () => {
    for (const mode of ['transport_error', 'false'] as const) {
      const paths = [`src/release-${mode}-a.ts`, `src/release-${mode}-b.ts`];
      const fixture = await seed({ targetFiles: paths });
      const keys = paths.map((path) => lockKey(fixture.projectId, path)).sort();
      const acquiredKey = keys[0]!;
      const blockedKey = keys[1]!;
      expect(await acquireFileLock(redis, blockedKey, 'external-owner', 30)).toBe(true);
      const unreliable = failFirstFileLockRelease(redis, mode);

      await expect(services(
        fixture,
        `release-cleanup-${mode}`,
        ch,
        unreliable,
      ).assignment.assign(fixture.taskId)).rejects.toMatchObject({
        code: 'FILE_LOCK_UNAVAILABLE',
      });
      expect(await redis.get(acquiredKey)).toBeNull();
      expect(await redis.get(blockedKey)).toBe('external-owner');
      expect((await getLatestTask(ch, fixture.projectId, fixture.taskId))?.status)
        .toBe('queued');
      await releaseFileLock(redis, blockedKey, 'external-owner');
    }
  });

  it('agent reservation kabulunden sonraki own-lease theft fresh fence ile yalniz queued kaydi geri alir', async () => {
    const fixture = await seed({ targetFiles: ['src/accepted-agent.ts'] });
    const stolenClient = stealAgentLeaseAfterAcceptedReservation(ch, redis, fixture.taskId);
    await expect(services(fixture, 'accepted-agent-theft', stolenClient).assignment.assign(
      fixture.taskId,
    )).rejects.toMatchObject({ code: 'STALE_FENCE' });

    expect((await getLatestTask(ch, fixture.projectId, fixture.taskId))?.status).toBe('queued');
    expect((await getLatestAgent(ch, fixture.projectId, fixture.worker1))?.status).toBe('idle');
    expect((await getLatestAgent(ch, fixture.projectId, fixture.verifierIndependent))?.status)
      .toBe('idle');
    expect(await redis.get(lockKey(fixture.projectId, 'src/accepted-agent.ts'))).toBeNull();
    expect(await redis.exists(agentLockKey(fixture.worker1))).toBe(0);
    expect(await redis.exists(agentLockKey(fixture.verifierIndependent))).toBe(0);

    const recovered = await services(fixture, 'accepted-agent-retry').assignment.assign(
      fixture.taskId,
    );
    expect(recovered.workerAgentId).toBe(fixture.worker1);
  });

  it('applyWithGuard task veya status-event kabulunden sonraki thefti fresh fence ile causal oncesi tamamlar', async () => {
    const taskFixture = await seed({ targetFiles: ['src/accepted-task-transition.ts'] });
    const taskAccepted = services(
      taskFixture,
      'accepted-task-transition',
      stealLeaseAfterAcceptedInsert(ch, redis, taskFixture.taskId, 'tasks'),
    );
    const taskAttempt = await taskAccepted.assignment.assign(taskFixture.taskId);
    expect((await getLatestTask(ch, taskFixture.projectId, taskFixture.taskId))?.status)
      .toBe('assigned');
    expect(await listTaskCausalEntries(
      ch,
      taskFixture.taskId,
      taskAttempt.assignmentAttemptId,
    )).toMatchObject([{ ordinal: 0, source_type: 'assignment' }]);

    const eventFixture = await seed({ targetFiles: ['src/accepted-status-event.ts'] });
    const eventAccepted = services(
      eventFixture,
      'accepted-status-event',
      stealTaskLeaseAfterAcceptedStatusEvent(ch, redis, eventFixture.taskId),
    );
    const eventAttempt = await eventAccepted.assignment.assign(eventFixture.taskId);
    expect((await getLatestTask(ch, eventFixture.projectId, eventFixture.taskId))?.status)
      .toBe('assigned');
    expect(await listTaskCausalEntries(
      ch,
      eventFixture.taskId,
      eventAttempt.assignmentAttemptId,
    )).toMatchObject([{ ordinal: 0, source_type: 'assignment' }]);
  });

  it('brief identity tum contracti kapsar ve cutoff sonrasi plan/task kaynagini reddeder', async () => {
    const fixture = await seed();
    const briefService = new TaskBriefService(
      fixture.projectId,
      ch,
      new TaskContextSnapshotBuilder(ch),
      { clock: fixture.clock, redis },
    );
    const cutoff = fixture.now();
    const input = {
      taskId: fixture.taskId,
      workerPrompt: { name: 'role.worker.coding', version: 2 },
      verifierPrompt: { name: 'role.verifier', version: 1 },
      acceptanceCriteria: ['first contract'],
      baseContextCutoffAt: cutoff,
    };
    const sealed = await briefService.seal(input);
    expect(await briefService.seal(input)).toEqual(sealed);
    const distinctContract = await briefService.seal({
      ...input,
      acceptanceCriteria: ['different contract'],
    });
    const distinctCutoff = await briefService.seal({
      ...input,
      baseContextCutoffAt: fixture.now(),
    });
    expect(distinctContract.taskBriefId).not.toBe(sealed.taskBriefId);
    expect(distinctCutoff.taskBriefId).not.toBe(sealed.taskBriefId);
    expect(await getTaskBrief(ch, sealed.taskBriefId)).toEqual(sealed);
    expect(await getTaskBrief(ch, distinctContract.taskBriefId)).toEqual(distinctContract);
    expect(await getTaskBrief(ch, distinctCutoff.taskBriefId)).toEqual(distinctCutoff);

    const futurePlanId = EntityIdSchema.parse(randomUUID());
    const futureTaskId = EntityIdSchema.parse(randomUUID());
    const planCutoff = new Date(Date.now() - 1_000).toISOString();
    await createPlan(ch, {
      plan_id: futurePlanId,
      project_id: fixture.projectId,
      plan_version: 2,
      status: 'approved',
      title: 'Future plan',
      content_md: '# Future',
      council_session_id: NIL_UUID,
      team_json: {},
      scenarios_json: [],
      replan_reason: 'future cutoff repro',
      supersedes_plan_id: fixture.planId,
      created_by_agent_id: fixture.worker1,
      approved_by: 'test',
      created_at: planCutoff,
    });
    await createTask(ch, taskInput({
      projectId: fixture.projectId,
      planId: futurePlanId,
      taskId: futureTaskId,
      title: 'Future source task',
      createdAt: planCutoff,
      targetFiles: [],
      dependsOn: [],
      issuerAgentId: fixture.worker1,
      status: 'queued',
    }));
    {
      const key = taskLockKey(futureTaskId);
      cleanupKeys.add(key);
      cleanupKeys.add(leaseFenceKey(key));
    }
    await expect(briefService.seal({
      ...input,
      taskId: futureTaskId,
      baseContextCutoffAt: planCutoff,
    })).rejects.toMatchObject({
      name: 'SchedulerError',
      code: 'INTEGRITY_CONFLICT',
      message: expect.stringMatching(/plan kaynagi.*cutoff/),
    });

    const futureTaskSourceId = EntityIdSchema.parse(randomUUID());
    await createTask(ch, taskInput({
      projectId: fixture.projectId,
      planId: fixture.planId,
      taskId: futureTaskSourceId,
      title: 'Future task source',
      createdAt: new Date(Date.parse(cutoff) + 60_000).toISOString(),
      targetFiles: [],
      dependsOn: [],
      issuerAgentId: fixture.worker1,
      status: 'queued',
    }));
    {
      const key = taskLockKey(futureTaskSourceId);
      cleanupKeys.add(key);
      cleanupKeys.add(leaseFenceKey(key));
    }
    await expect(briefService.seal({ ...input, taskId: futureTaskSourceId }))
      .rejects.toMatchObject({
        name: 'SchedulerError',
        code: 'INTEGRITY_CONFLICT',
        message: expect.stringMatching(/task kaynagi.*cutoff/),
      });

    const versionedPlanId = EntityIdSchema.parse(randomUUID());
    const initialPlan = await createPlan(ch, {
      plan_id: versionedPlanId,
      project_id: fixture.projectId,
      plan_version: 3,
      status: 'approved',
      title: 'As-of plan',
      content_md: '# Before cutoff',
      council_session_id: NIL_UUID,
      team_json: {},
      scenarios_json: [],
      replan_reason: '',
      supersedes_plan_id: fixture.planId,
      created_by_agent_id: fixture.worker1,
      approved_by: 'test',
      created_at: new Date().toISOString(),
    });
    const versionedTaskId = EntityIdSchema.parse(randomUUID());
    await createTask(ch, taskInput({
      projectId: fixture.projectId,
      planId: versionedPlanId,
      taskId: versionedTaskId,
      title: 'As-of versioned plan task',
      createdAt: initialPlan.observed_at,
      targetFiles: [],
      dependsOn: [],
      issuerAgentId: fixture.worker1,
      status: 'queued',
    }));
    {
      const key = taskLockKey(versionedTaskId);
      cleanupKeys.add(key);
      cleanupKeys.add(leaseFenceKey(key));
    }
    await appendPlanVersion(ch, {
      expectedVersion: initialPlan.version,
      next: { ...initialPlan, content_md: '# After cutoff' },
    });
    const asOfBrief = await briefService.seal({
      ...input,
      taskId: versionedTaskId,
      baseContextCutoffAt: initialPlan.observed_at,
    });
    expect(asOfBrief.planHash).toBe(canonicalSha256V1(initialPlan));
    expect(asOfBrief.planHash).not.toBe(canonicalSha256V1(
      await getLatestPlan(ch, fixture.projectId, versionedPlanId),
    ));

    const concurrentTaskId = EntityIdSchema.parse(randomUUID());
    await createTask(ch, taskInput({
      projectId: fixture.projectId,
      planId: fixture.planId,
      taskId: concurrentTaskId,
      title: 'Concurrent brief identity',
      createdAt: cutoff,
      targetFiles: [],
      dependsOn: [],
      issuerAgentId: fixture.worker1,
      status: 'queued',
    }));
    const concurrentKey = taskLockKey(concurrentTaskId);
    cleanupKeys.add(concurrentKey);
    cleanupKeys.add(leaseFenceKey(concurrentKey));
    const contracts = [
      { ...input, taskId: concurrentTaskId, acceptanceCriteria: ['contract-a'] },
      { ...input, taskId: concurrentTaskId, acceptanceCriteria: ['contract-b'] },
    ] as const;
    const raced = await Promise.allSettled(contracts.map((contract) => briefService.seal(contract)));
    const concurrentBriefs = [];
    for (const [index, result] of raced.entries()) {
      concurrentBriefs.push(result.status === 'fulfilled'
        ? result.value
        : await briefService.seal(contracts[index]!));
    }
    expect(concurrentBriefs[0]!.taskBriefId).not.toBe(concurrentBriefs[1]!.taskBriefId);
    expect(await getTaskBrief(ch, concurrentBriefs[0]!.taskBriefId)).toEqual(concurrentBriefs[0]);
    expect(await getTaskBrief(ch, concurrentBriefs[1]!.taskBriefId)).toEqual(concurrentBriefs[1]);

    const lostLeaseTaskId = EntityIdSchema.parse(randomUUID());
    await createTask(ch, taskInput({
      projectId: fixture.projectId,
      planId: fixture.planId,
      taskId: lostLeaseTaskId,
      title: 'Brief snapshot lease loss',
      createdAt: cutoff,
      targetFiles: [],
      dependsOn: [],
      issuerAgentId: fixture.worker1,
      status: 'queued',
    }));
    const lostLeaseKey = taskLockKey(lostLeaseTaskId);
    cleanupKeys.add(lostLeaseKey);
    cleanupKeys.add(leaseFenceKey(lostLeaseKey));
    const baseBuilder = new TaskContextSnapshotBuilder(ch);
    const losingBriefService = new TaskBriefService(
      fixture.projectId,
      ch,
      {
        build: async (buildInput) => {
          const snapshot = await baseBuilder.build(buildInput);
          await redis.del(lostLeaseKey);
          return snapshot;
        },
      },
      { clock: fixture.clock, redis, leaseTtlMs: 100 },
    );
    await expect(losingBriefService.seal({
      ...input,
      taskId: lostLeaseTaskId,
    })).rejects.toMatchObject({ code: 'STALE_FENCE' });
    const leakedBriefs = await ch.query({
      query: `SELECT count() AS count FROM task_briefs WHERE task_id = {taskId:UUID}`,
      query_params: { taskId: lostLeaseTaskId },
      format: 'JSONEachRow',
    });
    expect(await leakedBriefs.json()).toEqual([{ count: '0' }]);
  });

  it('ACK yalniz durable assignment ve causal kayittan sonra olur; restart pending mesaji reclaim eder', async () => {
    const fixture = await seed();
    const stream = queueKey(fixture.projectId);
    await enqueueTask(redis, stream, fixture.taskId);
    let pendingDuringAssignment = false;
    const factory: AssignmentServiceFactoryPort = {
      forProject: (projectId, consumerId) => {
        expect(projectId).toBe(fixture.projectId);
        const assignment = services(fixture, consumerId).assignment;
        return {
          assign: async (taskId) => {
            const attempt = await assignment.assign(taskId);
            pendingDuringAssignment = (await redis.xPendingRange(
              stream,
              'scheduler',
              '-',
              '+',
              10,
            )).some((entry) => entry.id.length > 0);
            return attempt;
          },
        };
      },
    };
    const worker = new SchedulerWorker(redis, factory, {
      blockMs: 5,
      reclaimMinIdleMs: 100,
    });
    const result = await worker.runOnce(fixture.projectId, 'consumer-a');
    worker.stop();
    expect(result.items).toMatchObject([{ source: 'new', state: 'assigned' }]);
    expect(pendingDuringAssignment).toBe(true);
    expect(await redis.xPendingRange(stream, 'scheduler', '-', '+', 10)).toEqual([]);

    const restart = await seed();
    const restartStream = queueKey(restart.projectId);
    await ensureGroup(redis, restartStream, 'scheduler');
    const messageId = await enqueueTask(redis, restartStream, restart.taskId);
    const reader = createQueueReader(redis);
    const read = await reader.read(restartStream, 'scheduler', 'crashed-consumer', {
      blockMs: 5,
      count: 1,
    });
    expect(read.messages[0]?.msgId).toBe(messageId);
    const durableAttempt = await services(restart, 'crashed-consumer').assignment.assign(restart.taskId);
    reader.stop();
    await new Promise<void>((resolve) => setTimeout(resolve, 120));

    const restartFactory: AssignmentServiceFactoryPort = {
      forProject: (_projectId, consumerId) => services(restart, consumerId).assignment,
    };
    const restartedWorker = new SchedulerWorker(redis, restartFactory, {
      blockMs: 5,
      reclaimMinIdleMs: 100,
    });
    const reclaimed = await restartedWorker.runOnce(restart.projectId, 'consumer-after-restart');
    restartedWorker.stop();
    expect(reclaimed.items).toMatchObject([{
      msgId: messageId,
      source: 'reclaimed',
      state: 'recovered',
      assignmentAttemptId: durableAttempt.assignmentAttemptId,
    }]);
    expect(await redis.xPendingRange(restartStream, 'scheduler', '-', '+', 10)).toEqual([]);
    expect((await getLatestTask(ch, restart.projectId, restart.taskId))?.assignment_attempt_id)
      .toBe(durableAttempt.assignmentAttemptId);

    const causalCrash = await seed();
    const interrupted = services(
      causalCrash,
      'consumer-before-causal-ack',
      uncertainClient(ch, 'task_causal_entries', 'before_accept'),
    );
    await expect(interrupted.assignment.assign(causalCrash.taskId)).rejects.toMatchObject({
      name: 'SchedulerError',
      code: 'UNCERTAIN_WRITE',
      message: expect.stringMatching(/belirsiz|uzlastirilamadi/),
    });
    const assignedProjection = await getLatestTask(ch, causalCrash.projectId, causalCrash.taskId);
    expect(assignedProjection?.status).toBe('assigned');
    const recoveredAttempt = await services(
      causalCrash,
      'consumer-after-causal-crash',
    ).assignment.assign(causalCrash.taskId);
    expect(recoveredAttempt.assignmentAttemptId).toBe(assignedProjection?.assignment_attempt_id);
    expect(await listTaskCausalEntries(
      ch,
      causalCrash.taskId,
      recoveredAttempt.assignmentAttemptId,
    )).toMatchObject([{ ordinal: 0, source_type: 'assignment' }]);
  });

  it('SchedulerWorker her typed scheduler hata kodunu item sonucunda korur', async () => {
    const fixture = await seed();
    const stream = queueKey(fixture.projectId);
    const codes: readonly SchedulerErrorCode[] = [
      'TASK_NOT_FOUND',
      'DEPENDENCY_BLOCKED',
      'LEASE_UNAVAILABLE',
      'STALE_FENCE',
      'FILE_LOCK_UNAVAILABLE',
      'NO_ELIGIBLE_AGENT',
      'POLICY_DENIED',
      'INTEGRITY_CONFLICT',
      'UNCERTAIN_WRITE',
    ];
    for (let remaining = codes.length; remaining > 0; remaining -= 1) {
      await enqueueTask(redis, stream, fixture.taskId);
    }
    let index = 0;
    const factory: AssignmentServiceFactoryPort = {
      forProject: () => ({
        assign: async () => {
          const code = codes[index++]!;
          if (
            code === 'DEPENDENCY_BLOCKED' || code === 'LEASE_UNAVAILABLE' ||
            code === 'FILE_LOCK_UNAVAILABLE' || code === 'NO_ELIGIBLE_AGENT'
          ) throw new TaskDeferredError(code, `worker test ${code}`);
          throw new SchedulerError(code, `worker test ${code}`);
        },
      }),
    };
    const worker = new SchedulerWorker(redis, factory, {
      blockMs: 5,
      readCount: codes.length,
      reclaimMinIdleMs: 30_000,
    });
    const result = await worker.runOnce(fixture.projectId, 'error-code-worker');
    worker.stop();
    expect(result.items.map((item) => item.errorCode)).toEqual(codes);
    expect(result.items.map((item) => item.state)).toEqual(codes.map((code) => (
      code === 'DEPENDENCY_BLOCKED' || code === 'LEASE_UNAVAILABLE' ||
        code === 'FILE_LOCK_UNAVAILABLE' || code === 'NO_ELIGIBLE_AGENT'
        ? 'deferred'
        : 'failed'
    )));
  });

  it('transition lease/fence, deterministic replay ve request-hash collisionini fail-closed uygular', async () => {
    const fixture = await seed();
    const runtime = services(fixture, 'scheduler-transition');
    const attempt = await runtime.assignment.assign(fixture.taskId);
    const requestedAt = fixture.now();
    const causationId = randomUUID();
    const request = {
      protocolVersion: 1 as const,
      transitionRequestId: randomUUID(),
      projectId: fixture.projectId,
      taskId: fixture.taskId,
      taskBriefId: attempt.taskBriefId,
      assignmentAttemptId: attempt.assignmentAttemptId,
      causationId,
      requestedAt,
      action: 'start_work' as const,
    };
    const first = await runtime.transition.apply(
      systemPrincipal('test-orchestrator', fixture.now()),
      request,
    );
    const replay = await runtime.transition.apply(
      systemPrincipal('test-orchestrator', fixture.now()),
      request,
    );
    expect(replay).toEqual(first);
    await expect(runtime.transition.apply(
      systemPrincipal('test-orchestrator', fixture.now()),
      { ...request, transitionRequestId: randomUUID() },
    )).rejects.toMatchObject({ code: 'INTEGRITY_CONFLICT' });

    const entries = await listTaskCausalEntries(ch, fixture.taskId, attempt.assignmentAttemptId);
    const minimum = entries.reduce(
      (maximum, entry) => BigInt(entry.lease_fence) > maximum
        ? BigInt(entry.lease_fence)
        : maximum,
      BigInt(attempt.leaseFence),
    );
    const stale = await acquireFencedLease(
      redis,
      taskLockKey(fixture.taskId),
      'stale-owner',
      5_000,
      minimum.toString(),
    );
    expect(stale).not.toBeNull();
    expect(await releaseFencedLease(redis, stale!)).toBe(true);
    const current = await acquireFencedLease(
      redis,
      taskLockKey(fixture.taskId),
      'current-owner',
      5_000,
      stale!.fence,
    );
    expect(current).not.toBeNull();
    await expect(runtime.transition.applyWithLease(
      systemPrincipal('test-orchestrator', fixture.now()),
      {
        protocolVersion: 1,
        transitionRequestId: randomUUID(),
        projectId: fixture.projectId,
        taskId: fixture.taskId,
        taskBriefId: attempt.taskBriefId,
        assignmentAttemptId: attempt.assignmentAttemptId,
        causationId: randomUUID(),
        requestedAt: fixture.now(),
        action: 'report_result',
        resultSummary: 'stale writer must not persist',
        evidenceRefs: [],
      },
      stale!,
    )).rejects.toMatchObject({ code: 'STALE_FENCE' });
    await releaseFencedLease(redis, current!);
    expect((await getLatestTask(ch, fixture.projectId, fixture.taskId))?.status).toBe('working');

    const uncertainTransition = new TaskTransitionService(
      uncertainClient(ch, 'tasks', 'after_accept'),
      redis,
      { leaseTtlMs: 5_000 },
    );
    const reconciled = await uncertainTransition.apply(
      systemPrincipal('test-orchestrator', fixture.now()),
      {
        protocolVersion: 1,
        transitionRequestId: randomUUID(),
        projectId: fixture.projectId,
        taskId: fixture.taskId,
        taskBriefId: attempt.taskBriefId,
        assignmentAttemptId: attempt.assignmentAttemptId,
        causationId: randomUUID(),
        requestedAt: fixture.now(),
        action: 'report_result',
        resultSummary: 'unknown ACK reconciled by deterministic task version',
        evidenceRefs: [],
      },
    );
    expect(reconciled.status).toBe('verifying');
  });

  it('heartbeat uzun I/Oda leasei tutar; calinan transition/causal lease stale yazari durdurur', async () => {
    const heartbeatFixture = await seed();
    const heartbeatAttempt = await services(
      heartbeatFixture,
      'heartbeat-assignment',
    ).assignment.assign(heartbeatFixture.taskId);
    const slowTransition = new TaskTransitionService(
      delayedQueries(ch, 45),
      redis,
      { leaseTtlMs: 30 },
    );
    await startWorking(heartbeatFixture, heartbeatAttempt, slowTransition);
    expect((await getLatestTask(
      ch,
      heartbeatFixture.projectId,
      heartbeatFixture.taskId,
    ))?.status).toBe('working');

    const fixture = await seed();
    const runtime = services(fixture, 'lease-theft-base');
    const attempt = await runtime.assignment.assign(fixture.taskId);
    await startWorking(fixture, attempt, runtime.transition);
    const stolenTransition = new TaskTransitionService(
      stealLeaseAfterEffectReserve(ch, redis, fixture.taskId, 'task_transition_v1'),
      redis,
      { leaseTtlMs: 100 },
    );
    await expect(stolenTransition.apply(systemPrincipal('test-orchestrator', fixture.now()), {
      protocolVersion: 1,
      transitionRequestId: randomUUID(),
      projectId: fixture.projectId,
      taskId: fixture.taskId,
      taskBriefId: attempt.taskBriefId,
      assignmentAttemptId: attempt.assignmentAttemptId,
      causationId: randomUUID(),
      requestedAt: fixture.now(),
      action: 'report_result',
      resultSummary: 'must not persist after stolen lease',
      evidenceRefs: [],
    })).rejects.toMatchObject({ code: 'UNCERTAIN_WRITE' });
    expect((await getLatestTask(ch, fixture.projectId, fixture.taskId))?.status).toBe('working');
    expect((await listLatestEffectsByState(ch, fixture.projectId, 'pending'))
      .filter((effect) => effect.task_id === fixture.taskId)).toEqual([]);
    expect((await listLatestEffectsByState(ch, fixture.projectId, 'uncertain'))
      .filter((effect) => effect.task_id === fixture.taskId)).toHaveLength(1);
    await expect(runtime.transition.apply(systemPrincipal('test-orchestrator', fixture.now()), {
      protocolVersion: 1,
      transitionRequestId: randomUUID(),
      projectId: fixture.projectId,
      taskId: fixture.taskId,
      taskBriefId: attempt.taskBriefId,
      assignmentAttemptId: attempt.assignmentAttemptId,
      causationId: randomUUID(),
      requestedAt: fixture.now(),
      action: 'report_result',
      resultSummary: 'different operation must remain blocked',
      evidenceRefs: [],
    })).rejects.toMatchObject({ code: 'UNCERTAIN_WRITE' });

    const causalFixture = await seed();
    const causalRuntime = services(causalFixture, 'causal-theft-base');
    const causalAttempt = await causalRuntime.assignment.assign(causalFixture.taskId);
    const causalSourceId = randomUUID();
    const stolenCausal = new TaskCausalLog(
      stealLeaseAfterEffectReserve(
        ch,
        redis,
        causalFixture.taskId,
        'task_causal_append_v1',
      ),
      redis,
      { leaseTtlMs: 100 },
    );
    await expect(stolenCausal.append({
      projectId: causalFixture.projectId,
      taskId: causalFixture.taskId,
      taskBriefId: causalAttempt.taskBriefId,
      assignmentAttemptId: causalAttempt.assignmentAttemptId,
      sourceType: 'lease_theft',
      sourceId: causalSourceId,
      causationId: randomUUID(),
      createdAt: causalFixture.now(),
    })).rejects.toMatchObject({ code: 'UNCERTAIN_WRITE' });
    expect((await listTaskCausalEntries(
      ch,
      causalFixture.taskId,
      causalAttempt.assignmentAttemptId,
    ))
      .some((entry) => entry.source_id === causalSourceId)).toBe(false);
    expect((await listLatestEffectsByState(ch, causalFixture.projectId, 'pending'))
      .filter((effect) => effect.task_id === causalFixture.taskId)).toEqual([]);
    expect((await listLatestEffectsByState(ch, causalFixture.projectId, 'uncertain'))
      .filter((effect) => effect.task_id === causalFixture.taskId)).toHaveLength(1);
    await expect(causalRuntime.causal.append({
      projectId: causalFixture.projectId,
      taskId: causalFixture.taskId,
      taskBriefId: causalAttempt.taskBriefId,
      assignmentAttemptId: causalAttempt.assignmentAttemptId,
      sourceType: 'different_after_uncertain',
      sourceId: randomUUID(),
      causationId: randomUUID(),
      createdAt: causalFixture.now(),
    })).rejects.toMatchObject({ code: 'UNCERTAIN_WRITE' });
  });

  it('fresh fence accepted transition/causal yazisini tamamlar ve effect version zehirlenmez', async () => {
    const transitionFixture = await seed();
    const transitionRuntime = services(transitionFixture, 'accepted-transition-base');
    const transitionAttempt = await transitionRuntime.assignment.assign(transitionFixture.taskId);
    await startWorking(transitionFixture, transitionAttempt, transitionRuntime.transition);
    const transitionRequest = {
      protocolVersion: 1 as const,
      transitionRequestId: EntityIdSchema.parse(randomUUID()),
      projectId: transitionFixture.projectId,
      taskId: transitionFixture.taskId,
      taskBriefId: transitionAttempt.taskBriefId,
      assignmentAttemptId: transitionAttempt.assignmentAttemptId,
      causationId: EntityIdSchema.parse(randomUUID()),
      requestedAt: transitionFixture.now(),
      action: 'report_result' as const,
      resultSummary: 'accepted before lease theft',
      evidenceRefs: [],
    };
    const acceptedTransition = new TaskTransitionService(
      stealLeaseAfterAcceptedInsert(ch, redis, transitionFixture.taskId, 'tasks'),
      redis,
      { leaseTtlMs: 100 },
    );
    const transitionState = await acceptedTransition.apply(
      systemPrincipal('test-orchestrator', transitionFixture.now()),
      transitionRequest,
    );
    expect(transitionState.status).toBe('verifying');
    expect(await transitionRuntime.transition.apply(
      systemPrincipal('test-orchestrator', transitionFixture.now()),
      transitionRequest,
    )).toEqual(transitionState);

    const causalFixture = await seed();
    const causalRuntime = services(causalFixture, 'accepted-causal-base');
    const causalAttempt = await causalRuntime.assignment.assign(causalFixture.taskId);
    const causalInput = {
      projectId: causalFixture.projectId,
      taskId: causalFixture.taskId,
      taskBriefId: causalAttempt.taskBriefId,
      assignmentAttemptId: causalAttempt.assignmentAttemptId,
      sourceType: 'accepted_lease_theft',
      sourceId: randomUUID(),
      causationId: EntityIdSchema.parse(randomUUID()),
      createdAt: causalFixture.now(),
    };
    const acceptedCausal = new TaskCausalLog(
      stealLeaseAfterAcceptedInsert(
        ch,
        redis,
        causalFixture.taskId,
        'task_causal_entries',
      ),
      redis,
      { leaseTtlMs: 100 },
    );
    const cursor = await acceptedCausal.append(causalInput);
    expect(await causalRuntime.causal.append(causalInput)).toEqual(cursor);
    expect((await listTaskCausalEntries(
      ch,
      causalFixture.taskId,
      causalAttempt.assignmentAttemptId,
    )).filter((entry) => entry.source_id === causalInput.sourceId)).toHaveLength(1);

    for (const causationId of [transitionRequest.causationId, causalInput.causationId]) {
      const divergent = await ch.query({
        query: `SELECT effect_version
          FROM effect_ledger
          WHERE causation_id = {causationId:UUID}
          GROUP BY effect_version
          HAVING uniqExact(tuple(state, result_json, error)) > 1`,
        query_params: { causationId },
        format: 'JSONEachRow',
      });
      expect(await divergent.json()).toEqual([]);
    }
  });

  it('rejection retry yeni same-owner attempt, rebase yeni brief ve reassignment typed handoff uretir', async () => {
    const retryFixture = await seed();
    const retryRuntime = services(retryFixture, 'scheduler-retry');
    const initial = await retryRuntime.assignment.assign(retryFixture.taskId);
    await startWorking(retryFixture, initial, retryRuntime.transition);
    await retryRuntime.transition.apply(systemPrincipal('test-orchestrator', retryFixture.now()), {
      protocolVersion: 1,
      transitionRequestId: randomUUID(),
      projectId: retryFixture.projectId,
      taskId: retryFixture.taskId,
      taskBriefId: initial.taskBriefId,
      assignmentAttemptId: initial.assignmentAttemptId,
      causationId: randomUUID(),
      requestedAt: retryFixture.now(),
      action: 'report_result',
      resultSummary: 'first result',
      evidenceRefs: [],
    });
    await retryRuntime.transition.apply(systemPrincipal('test-orchestrator', retryFixture.now()), {
      protocolVersion: 1,
      transitionRequestId: randomUUID(),
      projectId: retryFixture.projectId,
      taskId: retryFixture.taskId,
      taskBriefId: initial.taskBriefId,
      assignmentAttemptId: initial.assignmentAttemptId,
      causationId: randomUUID(),
      requestedAt: retryFixture.now(),
      action: 'verifier_rejected',
      verdictMessageId: randomUUID(),
      reason: 'needs correction',
    });
    const correction = await retryRuntime.assignment.retry(
      retryFixture.taskId,
      'retry_after_rejection',
    );
    expect(correction).toMatchObject({
      previousAttemptId: initial.assignmentAttemptId,
      taskBriefId: initial.taskBriefId,
      workerAgentId: initial.workerAgentId,
      verifierAgentId: initial.verifierAgentId,
      attemptNumber: 2,
      startReason: 'retry_after_rejection',
    });
    expect((await listTaskCausalEntries(ch, retryFixture.taskId, correction.assignmentAttemptId)))
      .toMatchObject([{ ordinal: 0, source_type: 'retry_after_rejection' }]);
    expect(await retryRuntime.assignment.retry(
      retryFixture.taskId,
      'retry_after_rejection',
    )).toEqual(correction);

    const gateFixture = await seed();
    const gateRuntime = services(gateFixture, 'scheduler-gate-retry');
    const gateInitial = await gateRuntime.assignment.assign(gateFixture.taskId);
    await startWorking(gateFixture, gateInitial, gateRuntime.transition);
    await gateRuntime.transition.apply(systemPrincipal('test-orchestrator', gateFixture.now()), {
      protocolVersion: 1,
      transitionRequestId: randomUUID(),
      projectId: gateFixture.projectId,
      taskId: gateFixture.taskId,
      taskBriefId: gateInitial.taskBriefId,
      assignmentAttemptId: gateInitial.assignmentAttemptId,
      causationId: randomUUID(),
      requestedAt: gateFixture.now(),
      action: 'report_result',
      resultSummary: 'ready for verification',
      evidenceRefs: [],
    });
    await gateRuntime.transition.apply(systemPrincipal('test-orchestrator', gateFixture.now()), {
      protocolVersion: 1,
      transitionRequestId: randomUUID(),
      projectId: gateFixture.projectId,
      taskId: gateFixture.taskId,
      taskBriefId: gateInitial.taskBriefId,
      assignmentAttemptId: gateInitial.assignmentAttemptId,
      causationId: randomUUID(),
      requestedAt: gateFixture.now(),
      action: 'verifier_approved',
      verdictMessageId: randomUUID(),
    });
    await gateRuntime.transition.apply(systemPrincipal('test-orchestrator', gateFixture.now()), {
      protocolVersion: 1,
      transitionRequestId: randomUUID(),
      projectId: gateFixture.projectId,
      taskId: gateFixture.taskId,
      taskBriefId: gateInitial.taskBriefId,
      assignmentAttemptId: gateInitial.assignmentAttemptId,
      causationId: randomUUID(),
      requestedAt: gateFixture.now(),
      action: 'gate_failed',
      reason: 'lint failed',
      evidenceRefs: ['gate:lint'],
    });
    const gateCorrection = await gateRuntime.assignment.retry(
      gateFixture.taskId,
      'retry_after_gate_failure',
    );
    expect(gateCorrection).toMatchObject({
      previousAttemptId: gateInitial.assignmentAttemptId,
      attemptNumber: 2,
      startReason: 'retry_after_gate_failure',
    });

    const rebaseFixture = await seed();
    const rebaseRuntime = services(rebaseFixture, 'scheduler-rebase');
    const beforeRebase = await rebaseRuntime.assignment.assign(rebaseFixture.taskId);
    await startWorking(rebaseFixture, beforeRebase, rebaseRuntime.transition);
    const rebasedPlanId = randomUUID();
    await createPlan(ch, {
      plan_id: rebasedPlanId,
      project_id: rebaseFixture.projectId,
      plan_version: 2,
      status: 'approved',
      title: 'Phase 4 plan v2',
      content_md: '# Plan v2',
      council_session_id: NIL_UUID,
      team_json: {},
      scenarios_json: [],
      replan_reason: 'Explicit rebase',
      supersedes_plan_id: rebaseFixture.planId,
      created_by_agent_id: rebaseFixture.worker1,
      approved_by: 'test',
      created_at: rebaseFixture.now(),
    });
    const rebaseInput = {
      taskId: rebaseFixture.taskId,
      planId: rebasedPlanId,
      causationId: randomUUID(),
      requestedAt: rebaseFixture.now(),
      acceptanceCriteria: ['Use the rebased plan'],
    };
    const rebased = await rebaseRuntime.assignment.rebase(rebaseInput);
    expect(rebased).toMatchObject({
      previousAttemptId: beforeRebase.assignmentAttemptId,
      attemptNumber: 2,
      startReason: 'rebase',
    });
    const rebasedBrief = await getTaskBrief(ch, rebased.taskBriefId);
    expect(rebasedBrief).toMatchObject({
      taskBriefVersion: 2,
      planId: rebasedPlanId,
      planVersion: 2,
    });
    expect((await getTaskBrief(ch, beforeRebase.taskBriefId))?.planVersion).toBe(1);
    expect((await getLatestTask(ch, rebaseFixture.projectId, rebaseFixture.taskId))?.plan_id)
      .toBe(rebasedPlanId);
    expect(await rebaseRuntime.assignment.rebase(rebaseInput)).toEqual(rebased);
    await expect(rebaseRuntime.assignment.rebase({
      ...rebaseInput,
      acceptanceCriteria: ['same causation, different command'],
    })).rejects.toMatchObject({ code: 'INTEGRITY_CONFLICT' });

    const handoffFixture = await seed({ targetFiles: ['src/handoff.ts'] });
    const handoffRuntime = services(handoffFixture, 'scheduler-handoff');
    const oldAttempt = await handoffRuntime.assignment.assign(handoffFixture.taskId);
    await startWorking(handoffFixture, oldAttempt, handoffRuntime.transition);
    const reassignInput = {
      taskId: handoffFixture.taskId,
      causationId: randomUUID(),
      requestedAt: handoffFixture.now(),
    };
    const reassigned = await services(
      handoffFixture,
      'scheduler-handoff-event-ack-loss',
      uncertainClient(ch, 'events', 'after_accept'),
      redis,
    ).assignment.reassign(reassignInput);
    expect(reassigned).toMatchObject({
      workerAgentId: handoffFixture.worker2,
      verifierAgentId: handoffFixture.verifierSameModel,
      previousAttemptId: oldAttempt.assignmentAttemptId,
      attemptNumber: 2,
      startReason: 'reassignment',
    });
    expect(reassigned.handoffId).toBeDefined();
    const handoff = await getTaskHandoff(ch, reassigned.handoffId!);
    expect(handoff).toMatchObject({
      fromAssignmentAttemptId: oldAttempt.assignmentAttemptId,
      toAssignmentAttemptId: reassigned.assignmentAttemptId,
      workspaceCheckpoint: { changedPaths: ['src/handoff.ts'] },
    });
    const newEntries = await listTaskCausalEntries(
      ch,
      handoffFixture.taskId,
      reassigned.assignmentAttemptId,
    );
    expect(newEntries).toMatchObject([{
      ordinal: 0,
      handoff_id: reassigned.handoffId,
      source_type: 'handoff',
    }]);
    expect(handoff?.ancestorCursor.ordinal).toBeGreaterThanOrEqual(1);
    expect(await renewFileLock(
      redis,
      lockKey(handoffFixture.projectId, 'src/handoff.ts'),
      reassigned.assignmentAttemptId,
      30,
    )).toBe(true);
    expect((await getLatestAgent(ch, handoffFixture.projectId, oldAttempt.workerAgentId))?.status)
      .toBe('idle');
    const handoffTimeline = await listEvents(ch, handoffFixture.projectId, { limit: 1_000 });
    const handoffEvents = handoffTimeline.filter((event) =>
      event.task_id === handoffFixture.taskId && event.event_type === 'task_handoff');
    expect(handoffEvents).toMatchObject([{
      event_id: taskHandoffEventId(reassigned.handoffId!),
      seq: String(Date.parse(reassignInput.requestedAt)),
      payload: {
        contractVersion: 1,
        handoffId: reassigned.handoffId,
        taskBriefId: reassigned.taskBriefId,
        fromAssignmentAttemptId: oldAttempt.assignmentAttemptId,
        toAssignmentAttemptId: reassigned.assignmentAttemptId,
        causationId: reassignInput.causationId,
        handoffHash: canonicalSha256V1(handoff!),
      },
    }]);
    const lockEvents = handoffTimeline
      .filter((event) =>
        event.task_id === handoffFixture.taskId &&
        (event.event_type === 'lock_acquired' || event.event_type === 'lock_released'));
    expect(lockEvents.map((event) => ({
      eventType: event.event_type,
      attemptId: event.payload !== null && typeof event.payload === 'object' &&
        !Array.isArray(event.payload) ? event.payload['assignmentAttemptId'] : undefined,
    }))).toEqual(expect.arrayContaining([
      { eventType: 'lock_acquired', attemptId: oldAttempt.assignmentAttemptId },
      { eventType: 'lock_released', attemptId: oldAttempt.assignmentAttemptId },
      { eventType: 'lock_acquired', attemptId: reassigned.assignmentAttemptId },
    ]));
    await expect(handoffRuntime.causal.append({
      projectId: handoffFixture.projectId,
      taskId: handoffFixture.taskId,
      taskBriefId: oldAttempt.taskBriefId,
      assignmentAttemptId: oldAttempt.assignmentAttemptId,
      sourceType: 'message',
      sourceId: randomUUID(),
      causationId: randomUUID(),
      createdAt: handoffFixture.now(),
    })).rejects.toMatchObject({ code: 'STALE_FENCE' });
    expect(await handoffRuntime.assignment.reassign(reassignInput)).toEqual(reassigned);
    expect((await listEvents(ch, handoffFixture.projectId, { limit: 1_000 })).filter((event) =>
      event.task_id === handoffFixture.taskId && event.event_type === 'task_handoff'))
      .toHaveLength(1);
    await expect(handoffRuntime.assignment.reassign({
      ...reassignInput,
      requestedAt: handoffFixture.now(),
    })).rejects.toMatchObject({ code: 'INTEGRITY_CONFLICT' });
  }, 20_000);

  it('task_handoff eventi crash retry ve immutable event collisioninda replay-safe kalir', async () => {
    const crashPath = 'src/handoff-event-crash.ts';
    const crashFixture = await seed({ targetFiles: [crashPath] });
    const crashRuntime = services(crashFixture, 'handoff-event-crash-base');
    const crashInitial = await crashRuntime.assignment.assign(crashFixture.taskId);
    await startWorking(crashFixture, crashInitial, crashRuntime.transition);
    const crashInput = {
      taskId: crashFixture.taskId,
      causationId: EntityIdSchema.parse(randomUUID()),
      requestedAt: crashFixture.now(),
    };
    await expect(services(
      crashFixture,
      'handoff-event-before-accept',
      uncertainClient(ch, 'events', 'before_accept'),
      redis,
    ).assignment.reassign(crashInput)).rejects.toMatchObject({
      name: 'SchedulerError',
      code: 'UNCERTAIN_WRITE',
    });
    expect(await redis.get(lockKey(crashFixture.projectId, crashPath)))
      .toBe(crashInitial.assignmentAttemptId);
    const crashRecovered = await crashRuntime.assignment.reassign(crashInput);
    const crashEvents = (await listEvents(ch, crashFixture.projectId, { limit: 1_000 }))
      .filter((event) =>
        event.task_id === crashFixture.taskId && event.event_type === 'task_handoff');
    expect(crashEvents).toHaveLength(1);
    expect(crashEvents[0]?.payload).toMatchObject({
      contractVersion: 1,
      handoffId: crashRecovered.handoffId,
      fromAssignmentAttemptId: crashInitial.assignmentAttemptId,
      toAssignmentAttemptId: crashRecovered.assignmentAttemptId,
    });

    const collisionPath = 'src/handoff-event-collision.ts';
    const collisionFixture = await seed({ targetFiles: [collisionPath] });
    const collisionRuntime = services(collisionFixture, 'handoff-event-collision-base');
    const collisionInitial = await collisionRuntime.assignment.assign(collisionFixture.taskId);
    await startWorking(collisionFixture, collisionInitial, collisionRuntime.transition);
    const collisionInput = {
      taskId: collisionFixture.taskId,
      causationId: EntityIdSchema.parse(randomUUID()),
      requestedAt: collisionFixture.now(),
    };
    await expect(services(
      collisionFixture,
      'handoff-event-collision-seed',
      uncertainClient(ch, 'events', 'before_accept'),
      redis,
    ).assignment.reassign(collisionInput)).rejects.toMatchObject({ code: 'UNCERTAIN_WRITE' });
    const handoffResult = await ch.query({
      query: `SELECT toString(handoff_id) AS handoff_id FROM task_handoffs
        WHERE task_id = {taskId:UUID} GROUP BY handoff_id`,
      query_params: { taskId: collisionFixture.taskId },
      format: 'JSONEachRow',
    });
    const handoffRows = await handoffResult.json<{ readonly handoff_id: string }>();
    expect(handoffRows).toHaveLength(1);
    const handoffId = EntityIdSchema.parse(handoffRows[0]!.handoff_id);
    await appendEvent(ch, {
      event_id: taskHandoffEventId(handoffId),
      seq: String(Date.parse(collisionInput.requestedAt)),
      project_id: collisionFixture.projectId,
      task_id: collisionFixture.taskId,
      agent_id: NIL_UUID,
      event_type: 'task_handoff',
      tool_name: '',
      payload: { contractVersion: 1, handoffId, collision: true },
      duration_ms: 0,
      created_at: collisionInput.requestedAt,
    });
    await expect(collisionRuntime.assignment.reassign(collisionInput)).rejects.toMatchObject({
      name: 'SchedulerError',
      code: 'INTEGRITY_CONFLICT',
    });
    expect((await getLatestTask(
      ch,
      collisionFixture.projectId,
      collisionFixture.taskId,
    ))?.assignment_attempt_id).toBe(collisionInitial.assignmentAttemptId);
    expect(await redis.get(lockKey(collisionFixture.projectId, collisionPath)))
      .toBe(collisionInitial.assignmentAttemptId);
  }, 20_000);

  it('correction file-lock setini atomik transfer eder ve contentionda eski sahibi korur', async () => {
    const fixture = await seed({ targetFiles: ['src/transfer-a.ts', 'src/transfer-b.ts'] });
    const runtime = services(fixture, 'scheduler-transfer');
    const initial = await runtime.assignment.assign(fixture.taskId);
    await startWorking(fixture, initial, runtime.transition);
    await runtime.transition.apply(systemPrincipal('test-orchestrator', fixture.now()), {
      protocolVersion: 1,
      transitionRequestId: randomUUID(),
      projectId: fixture.projectId,
      taskId: fixture.taskId,
      taskBriefId: initial.taskBriefId,
      assignmentAttemptId: initial.assignmentAttemptId,
      causationId: randomUUID(),
      requestedAt: fixture.now(),
      action: 'report_result',
      resultSummary: 'transfer contention result',
      evidenceRefs: [],
    });
    await runtime.transition.apply(systemPrincipal('test-orchestrator', fixture.now()), {
      protocolVersion: 1,
      transitionRequestId: randomUUID(),
      projectId: fixture.projectId,
      taskId: fixture.taskId,
      taskBriefId: initial.taskBriefId,
      assignmentAttemptId: initial.assignmentAttemptId,
      causationId: randomUUID(),
      requestedAt: fixture.now(),
      action: 'verifier_rejected',
      verdictMessageId: randomUUID(),
      reason: 'retry transfer',
    });
    const first = lockKey(fixture.projectId, 'src/transfer-a.ts');
    const second = lockKey(fixture.projectId, 'src/transfer-b.ts');
    expect(await releaseFileLock(redis, second, initial.assignmentAttemptId)).toBe(true);
    expect(await acquireFileLock(redis, second, 'transfer-intruder', 30)).toBe(true);
    await expect(runtime.assignment.retry(
      fixture.taskId,
      'retry_after_rejection',
    )).rejects.toMatchObject({ code: 'FILE_LOCK_UNAVAILABLE' });
    expect(await redis.get(first)).toBe(initial.assignmentAttemptId);
    expect(await redis.get(second)).toBe('transfer-intruder');
    expect((await getLatestTask(ch, fixture.projectId, fixture.taskId))?.assignment_attempt_id)
      .toBe(initial.assignmentAttemptId);
    const pendingCommand = (await listLatestEffectsByState(ch, fixture.projectId, 'pending'))
      .find((effect) =>
        effect.task_id === fixture.taskId &&
        effect.effect_type === 'scheduler_assignment_command_v1');
    if (
      pendingCommand === undefined || pendingCommand.result === null ||
      typeof pendingCommand.result !== 'object' || Array.isArray(pendingCommand.result)
    ) throw new Error('planned correction command bulunamadi');
    const plannedAttemptId = EntityIdSchema.parse(pendingCommand.result['assignmentAttemptId']);
    expect(await releaseFileLock(redis, first, initial.assignmentAttemptId)).toBe(true);
    expect(await acquireFileLock(redis, first, plannedAttemptId, 30)).toBe(true);
    await expect(runtime.assignment.retry(
      fixture.taskId,
      'retry_after_rejection',
    )).rejects.toMatchObject({ code: 'UNCERTAIN_WRITE' });
    expect(await redis.get(first)).toBe(plannedAttemptId);
    expect(await redis.get(second)).toBe('transfer-intruder');
    expect(await releaseFileLock(redis, first, plannedAttemptId)).toBe(true);
    expect(await acquireFileLock(redis, first, initial.assignmentAttemptId, 30)).toBe(true);
    expect(await releaseFileLock(redis, second, 'transfer-intruder')).toBe(true);
    const correction = await runtime.assignment.retry(
      fixture.taskId,
      'retry_after_rejection',
    );
    expect(await redis.get(first)).toBe(correction.assignmentAttemptId);
    expect(await redis.get(second)).toBe(correction.assignmentAttemptId);
  });

  it('atomik transfer response kaybini tum owner setinden uzlastirir ve raw hata sizdirmaz', async () => {
    const fixture = await seed({ targetFiles: ['src/transfer-ack-a.ts', 'src/transfer-ack-b.ts'] });
    const healthy = services(fixture, 'transfer-response-healthy');
    const initial = await healthy.assignment.assign(fixture.taskId);
    await startWorking(fixture, initial, healthy.transition);
    await healthy.transition.apply(systemPrincipal('test-orchestrator', fixture.now()), {
      protocolVersion: 1,
      transitionRequestId: randomUUID(),
      projectId: fixture.projectId,
      taskId: fixture.taskId,
      taskBriefId: initial.taskBriefId,
      assignmentAttemptId: initial.assignmentAttemptId,
      causationId: randomUUID(),
      requestedAt: fixture.now(),
      action: 'report_result',
      resultSummary: 'response reconciliation result',
      evidenceRefs: [],
    });
    await healthy.transition.apply(systemPrincipal('test-orchestrator', fixture.now()), {
      protocolVersion: 1,
      transitionRequestId: randomUUID(),
      projectId: fixture.projectId,
      taskId: fixture.taskId,
      taskBriefId: initial.taskBriefId,
      assignmentAttemptId: initial.assignmentAttemptId,
      causationId: randomUUID(),
      requestedAt: fixture.now(),
      action: 'verifier_rejected',
      verdictMessageId: randomUUID(),
      reason: 'response reconciliation retry',
    });

    const accepted = services(
      fixture,
      'transfer-response-after',
      ch,
      loseFileLockTransferResponse(redis, 'after_accept'),
    );
    const correction = await accepted.assignment.retry(
      fixture.taskId,
      'retry_after_rejection',
    );
    for (const path of ['src/transfer-ack-a.ts', 'src/transfer-ack-b.ts']) {
      expect(await redis.get(lockKey(fixture.projectId, path)))
        .toBe(correction.assignmentAttemptId);
    }

    const missing = lockKey(fixture.projectId, 'src/transfer-ack-b.ts');
    expect(await releaseFileLock(redis, missing, correction.assignmentAttemptId)).toBe(true);
    await services(
      fixture,
      'transfer-response-before',
      ch,
      loseFileLockTransferResponse(redis, 'before_accept'),
    ).assignment.renewAttemptFileLocks(fixture.taskId);
    expect(await redis.get(missing)).toBe(correction.assignmentAttemptId);
  });

  it('aktif attempt file-lock heartbeat eksik kilidi geri alir, foreign ownerda atomik reddeder', async () => {
    const fixture = await seed({ targetFiles: ['src/heartbeat-a.ts', 'src/heartbeat-b.ts'] });
    const runtime = services(fixture, 'file-lock-heartbeat', ch, redis, {
      fileLockTtlSec: 45,
    });
    const attempt = await runtime.assignment.assign(fixture.taskId);
    const first = lockKey(fixture.projectId, 'src/heartbeat-a.ts');
    const second = lockKey(fixture.projectId, 'src/heartbeat-b.ts');
    expect(await releaseFileLock(redis, second, attempt.assignmentAttemptId)).toBe(true);
    await runtime.assignment.renewAttemptFileLocks(fixture.taskId);
    expect(await redis.get(first)).toBe(attempt.assignmentAttemptId);
    expect(await redis.get(second)).toBe(attempt.assignmentAttemptId);
    expect(await redis.ttl(first)).toBeGreaterThan(40);
    expect(await redis.ttl(second)).toBeGreaterThan(40);

    expect(await releaseFileLock(redis, second, attempt.assignmentAttemptId)).toBe(true);
    expect(await acquireFileLock(redis, second, 'heartbeat-intruder', 45)).toBe(true);
    await expect(runtime.assignment.renewAttemptFileLocks(fixture.taskId)).rejects.toMatchObject({
      name: 'TaskDeferredError',
      code: 'FILE_LOCK_UNAVAILABLE',
    });
    expect(await redis.get(first)).toBe(attempt.assignmentAttemptId);
    expect(await redis.get(second)).toBe('heartbeat-intruder');
  });

  it('verifier ve gate attempt limiti escalated cleanup yapar; resolution fresh kaynak ister', async () => {
    for (const mode of ['verifier', 'gate'] as const) {
      const path = `src/escalated-${mode}.ts`;
      const fixture = await seed({ targetFiles: [path], maxAttempts: 1 });
      const runtime = services(fixture, `escalated-${mode}`);
      const initial = await runtime.assignment.assign(fixture.taskId);
      await startWorking(fixture, initial, runtime.transition);
      const principal = systemPrincipal('test-orchestrator', fixture.now());
      await runtime.transition.apply(principal, {
        protocolVersion: 1,
        transitionRequestId: randomUUID(),
        projectId: fixture.projectId,
        taskId: fixture.taskId,
        taskBriefId: initial.taskBriefId,
        assignmentAttemptId: initial.assignmentAttemptId,
        causationId: randomUUID(),
        requestedAt: fixture.now(),
        action: 'report_result',
        resultSummary: `${mode} escalation result`,
        evidenceRefs: [],
      });
      if (mode === 'gate') {
        await runtime.transition.apply(principal, {
          protocolVersion: 1,
          transitionRequestId: randomUUID(),
          projectId: fixture.projectId,
          taskId: fixture.taskId,
          taskBriefId: initial.taskBriefId,
          assignmentAttemptId: initial.assignmentAttemptId,
          causationId: randomUUID(),
          requestedAt: fixture.now(),
          action: 'verifier_approved',
          verdictMessageId: randomUUID(),
        });
      }
      const terminalRequest = mode === 'verifier'
        ? {
          protocolVersion: 1 as const,
          transitionRequestId: EntityIdSchema.parse(randomUUID()),
          projectId: fixture.projectId,
          taskId: fixture.taskId,
          taskBriefId: initial.taskBriefId,
          assignmentAttemptId: initial.assignmentAttemptId,
          causationId: EntityIdSchema.parse(randomUUID()),
          requestedAt: fixture.now(),
          action: 'verifier_rejected' as const,
          verdictMessageId: EntityIdSchema.parse(randomUUID()),
          reason: 'attempt limit reached',
        }
        : {
          protocolVersion: 1 as const,
          transitionRequestId: EntityIdSchema.parse(randomUUID()),
          projectId: fixture.projectId,
          taskId: fixture.taskId,
          taskBriefId: initial.taskBriefId,
          assignmentAttemptId: initial.assignmentAttemptId,
          causationId: EntityIdSchema.parse(randomUUID()),
          requestedAt: fixture.now(),
          action: 'gate_failed' as const,
          reason: 'attempt limit reached',
          evidenceRefs: [`gate:${mode}`],
        };
      const terminalTransition = mode === 'verifier'
        ? services(
          fixture,
          'escalated-release-ack-loss',
          ch,
          loseFirstAcceptedFileLockReleaseAck(redis),
        ).transition
        : runtime.transition;
      expect((await terminalTransition.apply(principal, terminalRequest)).status).toBe('escalated');
      expect((await runtime.transition.apply(principal, terminalRequest)).status).toBe('escalated');
      for (const agentId of [initial.workerAgentId, initial.verifierAgentId]) {
        expect(await getLatestAgent(ch, fixture.projectId, agentId)).toMatchObject({
          status: 'idle',
          current_task_id: NIL_UUID,
        });
      }
      expect(await redis.get(lockKey(fixture.projectId, path))).toBeNull();
      const released = (await listEvents(ch, fixture.projectId, { limit: 1_000 }))
        .filter((event) => event.task_id === fixture.taskId && event.event_type === 'lock_released');
      expect(released).toHaveLength(1);

      await expect(runtime.transition.apply(principal, {
        protocolVersion: 1,
        transitionRequestId: randomUUID(),
        projectId: fixture.projectId,
        taskId: fixture.taskId,
        taskBriefId: initial.taskBriefId,
        assignmentAttemptId: initial.assignmentAttemptId,
        causationId: randomUUID(),
        requestedAt: fixture.now(),
        action: 'escalation_resolved',
      })).rejects.toMatchObject({
        name: 'TaskDeferredError',
        code: 'DEPENDENCY_BLOCKED',
      });

      const retryReason = mode === 'verifier'
        ? 'retry_after_rejection' as const
        : 'retry_after_gate_failure' as const;
      const resumed = await runtime.assignment.retry(fixture.taskId, retryReason);
      expect(resumed).toMatchObject({
        previousAttemptId: initial.assignmentAttemptId,
        attemptNumber: 2,
        startReason: retryReason,
      });
      expect(await getLatestTask(ch, fixture.projectId, fixture.taskId)).toMatchObject({
        status: 'working',
        assignment_attempt_id: resumed.assignmentAttemptId,
      });
      for (const agentId of [resumed.workerAgentId, resumed.verifierAgentId]) {
        expect(await getLatestAgent(ch, fixture.projectId, agentId)).toMatchObject({
          status: 'busy',
          current_task_id: fixture.taskId,
        });
      }
      expect(await redis.get(lockKey(fixture.projectId, path)))
        .toBe(resumed.assignmentAttemptId);
    }
  }, 20_000);

  it('user answer eski escalated attempti calistirmaz; crash/replay sonrasi fresh retry gerekir', async () => {
    const path = 'src/escalated-user-answer.ts';
    const fixture = await seed({ targetFiles: [path], maxAttempts: 1 });
    const runtime = services(fixture, 'escalated-user-answer');
    const initial = await runtime.assignment.assign(fixture.taskId);
    await startWorking(fixture, initial, runtime.transition);
    const scheduler = systemPrincipal('test-orchestrator', fixture.now());
    await runtime.transition.apply(scheduler, {
      protocolVersion: 1,
      transitionRequestId: randomUUID(),
      projectId: fixture.projectId,
      taskId: fixture.taskId,
      taskBriefId: initial.taskBriefId,
      assignmentAttemptId: initial.assignmentAttemptId,
      causationId: randomUUID(),
      requestedAt: fixture.now(),
      action: 'report_result',
      resultSummary: 'needs user clarification',
      evidenceRefs: [],
    });
    await runtime.transition.apply(scheduler, {
      protocolVersion: 1,
      transitionRequestId: randomUUID(),
      projectId: fixture.projectId,
      taskId: fixture.taskId,
      taskBriefId: initial.taskBriefId,
      assignmentAttemptId: initial.assignmentAttemptId,
      causationId: randomUUID(),
      requestedAt: fixture.now(),
      action: 'verifier_rejected',
      verdictMessageId: randomUUID(),
      reason: 'user decision required',
    });
    expect((await getLatestTask(ch, fixture.projectId, fixture.taskId))?.status)
      .toBe('escalated');

    const questionRequest = {
      protocolVersion: 1 as const,
      transitionRequestId: EntityIdSchema.parse(randomUUID()),
      projectId: fixture.projectId,
      taskId: fixture.taskId,
      taskBriefId: initial.taskBriefId,
      assignmentAttemptId: initial.assignmentAttemptId,
      causationId: EntityIdSchema.parse(randomUUID()),
      requestedAt: fixture.now(),
      action: 'request_user_input' as const,
      questionMessageId: EntityIdSchema.parse(randomUUID()),
    };
    const questionAfterCrash = new TaskTransitionService(
      stealTaskLeaseAfterAcceptedStatusEvent(ch, redis, fixture.taskId),
      redis,
    );
    const waiting = await questionAfterCrash.apply(scheduler, questionRequest);
    expect(waiting.status).toBe('waiting_user');
    expect(await runtime.transition.apply(scheduler, questionRequest)).toEqual(waiting);

    const user = {
      principalType: 'user' as const,
      principalId: USER_SENTINEL,
      authenticatedAt: fixture.now(),
    };
    const answerRequest = {
      protocolVersion: 1 as const,
      transitionRequestId: EntityIdSchema.parse(randomUUID()),
      projectId: fixture.projectId,
      taskId: fixture.taskId,
      taskBriefId: initial.taskBriefId,
      assignmentAttemptId: initial.assignmentAttemptId,
      causationId: EntityIdSchema.parse(randomUUID()),
      requestedAt: fixture.now(),
      action: 'user_answered' as const,
    };
    const answerAfterCrash = new TaskTransitionService(
      stealTaskLeaseAfterAcceptedStatusEvent(ch, redis, fixture.taskId),
      redis,
    );
    const answered = await answerAfterCrash.apply(user, answerRequest);
    expect(answered.status).toBe('escalated');
    expect(await runtime.transition.apply(user, answerRequest)).toEqual(answered);
    for (const agentId of [initial.workerAgentId, initial.verifierAgentId]) {
      expect(await getLatestAgent(ch, fixture.projectId, agentId)).toMatchObject({
        status: 'idle',
        current_task_id: NIL_UUID,
      });
    }
    expect(await redis.get(lockKey(fixture.projectId, path))).toBeNull();

    await expect(runtime.transition.apply(scheduler, {
      ...answerRequest,
      transitionRequestId: randomUUID(),
      causationId: randomUUID(),
      requestedAt: fixture.now(),
      action: 'escalation_resolved',
    })).rejects.toMatchObject({
      name: 'TaskDeferredError',
      code: 'DEPENDENCY_BLOCKED',
    });
    const resumed = await runtime.assignment.retry(fixture.taskId, 'retry_after_rejection');
    expect(resumed).toMatchObject({
      previousAttemptId: initial.assignmentAttemptId,
      attemptNumber: 2,
    });
    expect((await getLatestTask(ch, fixture.projectId, fixture.taskId))).toMatchObject({
      status: 'working',
      assignment_attempt_id: resumed.assignmentAttemptId,
    });
    expect(await redis.get(lockKey(fixture.projectId, path))).toBe(resumed.assignmentAttemptId);
  }, 20_000);

  it('failed kapanisi agentleri ve locklari birakir; accepted release ACK kaybini uzlastirir', async () => {
    const fixture = await seed({ targetFiles: ['src/fail-a.ts', 'src/fail-b.ts'] });
    const healthy = services(fixture, 'terminal-failed');
    const attempt = await healthy.assignment.assign(fixture.taskId);
    await startWorking(fixture, attempt, healthy.transition);
    const transition = services(
      fixture,
      'terminal-failed-ack-loss',
      ch,
      loseFirstAcceptedFileLockReleaseAck(redis),
    ).transition;
    const state = await transition.apply(systemPrincipal('test-orchestrator', fixture.now()), {
      protocolVersion: 1,
      transitionRequestId: randomUUID(),
      projectId: fixture.projectId,
      taskId: fixture.taskId,
      taskBriefId: attempt.taskBriefId,
      assignmentAttemptId: attempt.assignmentAttemptId,
      causationId: randomUUID(),
      requestedAt: fixture.now(),
      action: 'fail',
      reason: 'terminal resource cleanup test',
    });
    expect(state.status).toBe('failed');
    for (const agentId of [attempt.workerAgentId, attempt.verifierAgentId]) {
      expect(await getLatestAgent(ch, fixture.projectId, agentId)).toMatchObject({
        status: 'idle',
        current_task_id: NIL_UUID,
      });
    }
    expect(await redis.get(lockKey(fixture.projectId, 'src/fail-a.ts'))).toBeNull();
    expect(await redis.get(lockKey(fixture.projectId, 'src/fail-b.ts'))).toBeNull();
  });

  it('terminal agent guard release belirsizligini owner/fence ile uzlastirir', async () => {
    for (const mode of ['before_accept', 'after_accept'] as const) {
      const fixture = await seed({ targetFiles: [`src/agent-release-${mode}.ts`] });
      const healthy = services(fixture, `agent-release-healthy-${mode}`);
      const attempt = await healthy.assignment.assign(fixture.taskId);
      await startWorking(fixture, attempt, healthy.transition);
      const principal = systemPrincipal('test-orchestrator', fixture.now());
      const request = {
        protocolVersion: 1 as const,
        transitionRequestId: EntityIdSchema.parse(randomUUID()),
        projectId: fixture.projectId,
        taskId: fixture.taskId,
        taskBriefId: attempt.taskBriefId,
        assignmentAttemptId: attempt.assignmentAttemptId,
        causationId: EntityIdSchema.parse(randomUUID()),
        requestedAt: fixture.now(),
        action: 'fail' as const,
        reason: `agent release ${mode}`,
      };
      const uncertain = services(
        fixture,
        `agent-release-${mode}`,
        ch,
        loseAgentLeaseReleaseResponse(redis, mode),
      );
      if (mode === 'after_accept') {
        expect((await uncertain.transition.apply(principal, request)).status).toBe('failed');
      } else {
        await expect(uncertain.transition.apply(principal, request)).rejects.toMatchObject({
          name: 'SchedulerError',
          code: 'UNCERTAIN_WRITE',
          cause: expect.any(Error),
        });
        expect(await getLatestTask(ch, fixture.projectId, fixture.taskId)).toMatchObject({
          status: 'failed',
        });
        const agentKeys = [attempt.workerAgentId, attempt.verifierAgentId].map(agentLockKey);
        expect((await Promise.all(agentKeys.map((key) => redis.exists(key))))
          .some((exists) => exists === 1)).toBe(true);
        for (const key of agentKeys) await redis.del(key);
        expect((await healthy.transition.apply(principal, request)).status).toBe('failed');
      }
      for (const agentId of [attempt.workerAgentId, attempt.verifierAgentId]) {
        expect(await getLatestAgent(ch, fixture.projectId, agentId)).toMatchObject({
          status: 'idle',
          current_task_id: NIL_UUID,
        });
      }
      expect(await redis.get(lockKey(
        fixture.projectId,
        `src/agent-release-${mode}.ts`,
      ))).toBeNull();
    }
  }, 20_000);

  it('done kapanisindaki lock release crashi exact transition retry ile tamamlanir', async () => {
    const fixture = await seed({ targetFiles: ['src/done-a.ts', 'src/done-b.ts'] });
    const healthy = services(fixture, 'terminal-done');
    const attempt = await healthy.assignment.assign(fixture.taskId);
    await startWorking(fixture, attempt, healthy.transition);
    const principal = systemPrincipal('test-orchestrator', fixture.now());
    await healthy.transition.apply(principal, {
      protocolVersion: 1,
      transitionRequestId: randomUUID(),
      projectId: fixture.projectId,
      taskId: fixture.taskId,
      taskBriefId: attempt.taskBriefId,
      assignmentAttemptId: attempt.assignmentAttemptId,
      causationId: randomUUID(),
      requestedAt: fixture.now(),
      action: 'report_result',
      resultSummary: 'terminal done result',
      evidenceRefs: [],
    });
    await healthy.transition.apply(principal, {
      protocolVersion: 1,
      transitionRequestId: randomUUID(),
      projectId: fixture.projectId,
      taskId: fixture.taskId,
      taskBriefId: attempt.taskBriefId,
      assignmentAttemptId: attempt.assignmentAttemptId,
      causationId: randomUUID(),
      requestedAt: fixture.now(),
      action: 'verifier_approved',
      verdictMessageId: randomUUID(),
    });
    await healthy.transition.apply(principal, {
      protocolVersion: 1,
      transitionRequestId: randomUUID(),
      projectId: fixture.projectId,
      taskId: fixture.taskId,
      taskBriefId: attempt.taskBriefId,
      assignmentAttemptId: attempt.assignmentAttemptId,
      causationId: randomUUID(),
      requestedAt: fixture.now(),
      action: 'gate_passed',
    });
    const commitRequest = {
      protocolVersion: 1 as const,
      transitionRequestId: EntityIdSchema.parse(randomUUID()),
      projectId: fixture.projectId,
      taskId: fixture.taskId,
      taskBriefId: attempt.taskBriefId,
      assignmentAttemptId: attempt.assignmentAttemptId,
      causationId: EntityIdSchema.parse(randomUUID()),
      requestedAt: fixture.now(),
      action: 'commit_completed' as const,
      commitHash: 'abcdef1234567',
      artifactIds: [],
    };
    const crashing = services(
      fixture,
      'terminal-done-release-crash',
      ch,
      refuseFirstTerminalFileLockRelease(redis),
    ).transition;
    await expect(crashing.apply(principal, commitRequest)).rejects.toMatchObject({
      name: 'SchedulerError',
      code: 'UNCERTAIN_WRITE',
    });
    expect((await getLatestTask(ch, fixture.projectId, fixture.taskId))?.status).toBe('done');
    for (const agentId of [attempt.workerAgentId, attempt.verifierAgentId]) {
      expect(await getLatestAgent(ch, fixture.projectId, agentId)).toMatchObject({
        status: 'idle',
        current_task_id: NIL_UUID,
      });
    }
    expect(await redis.get(lockKey(fixture.projectId, 'src/done-b.ts')))
      .toBe(attempt.assignmentAttemptId);

    const recovered = await healthy.transition.apply(principal, commitRequest);
    expect(recovered.status).toBe('done');
    expect(await redis.get(lockKey(fixture.projectId, 'src/done-a.ts'))).toBeNull();
    expect(await redis.get(lockKey(fixture.projectId, 'src/done-b.ts'))).toBeNull();
  });

  it('queued cancel terminal durumunu kaynak sizintisi olmadan tekrarlar', async () => {
    const fixture = await seed({ targetFiles: ['src/cancelled.ts'] });
    const runtime = services(fixture, 'terminal-cancelled');
    const principal = systemPrincipal('test-orchestrator', fixture.now());
    const request = {
      protocolVersion: 1 as const,
      transitionRequestId: EntityIdSchema.parse(randomUUID()),
      projectId: fixture.projectId,
      taskId: fixture.taskId,
      causationId: EntityIdSchema.parse(randomUUID()),
      requestedAt: fixture.now(),
      action: 'cancel' as const,
      fromStatus: 'queued' as const,
      reason: 'plan revision',
    };
    expect((await runtime.transition.apply(principal, request)).status).toBe('cancelled');
    expect((await runtime.transition.apply(principal, request)).status).toBe('cancelled');
    expect(await redis.get(lockKey(fixture.projectId, 'src/cancelled.ts'))).toBeNull();
  });

  it('atomik transfer kabulunden sonraki task lease theft eski lock sahibini fresh fence ile geri kurar', async () => {
    const fixture = await seed({ targetFiles: ['src/theft-transfer-a.ts', 'src/theft-transfer-b.ts'] });
    const healthy = services(fixture, 'transfer-theft-healthy');
    const initial = await healthy.assignment.assign(fixture.taskId);
    await startWorking(fixture, initial, healthy.transition);
    await healthy.transition.apply(systemPrincipal('test-orchestrator', fixture.now()), {
      protocolVersion: 1,
      transitionRequestId: randomUUID(),
      projectId: fixture.projectId,
      taskId: fixture.taskId,
      taskBriefId: initial.taskBriefId,
      assignmentAttemptId: initial.assignmentAttemptId,
      causationId: randomUUID(),
      requestedAt: fixture.now(),
      action: 'report_result',
      resultSummary: 'accepted lock transfer theft',
      evidenceRefs: [],
    });
    await healthy.transition.apply(systemPrincipal('test-orchestrator', fixture.now()), {
      protocolVersion: 1,
      transitionRequestId: randomUUID(),
      projectId: fixture.projectId,
      taskId: fixture.taskId,
      taskBriefId: initial.taskBriefId,
      assignmentAttemptId: initial.assignmentAttemptId,
      causationId: randomUUID(),
      requestedAt: fixture.now(),
      action: 'verifier_rejected',
      verdictMessageId: randomUUID(),
      reason: 'transfer theft retry',
    });

    const stolenRedis = stealTaskLeaseAfterFileTransfer(redis, fixture.taskId);
    await expect(services(fixture, 'transfer-theft-stale', ch, stolenRedis).assignment.retry(
      fixture.taskId,
      'retry_after_rejection',
    )).rejects.toMatchObject({ code: 'STALE_FENCE' });
    for (const path of ['src/theft-transfer-a.ts', 'src/theft-transfer-b.ts']) {
      expect(await redis.get(lockKey(fixture.projectId, path))).toBe(initial.assignmentAttemptId);
    }
    expect((await getLatestTask(ch, fixture.projectId, fixture.taskId))?.assignment_attempt_id)
      .toBe(initial.assignmentAttemptId);

    const recovered = await healthy.assignment.retry(fixture.taskId, 'retry_after_rejection');
    for (const path of ['src/theft-transfer-a.ts', 'src/theft-transfer-b.ts']) {
      expect(await redis.get(lockKey(fixture.projectId, path)))
        .toBe(recovered.assignmentAttemptId);
    }
  });

  it('correction crash sonrasi ayni command/attempt ile devam eder ve orphan lock birakmaz', async () => {
    const fixture = await seed({ targetFiles: ['src/retry-crash.ts'] });
    const healthy = services(fixture, 'retry-crash-healthy');
    const initial = await healthy.assignment.assign(fixture.taskId);
    await startWorking(fixture, initial, healthy.transition);
    await healthy.transition.apply(systemPrincipal('test-orchestrator', fixture.now()), {
      protocolVersion: 1,
      transitionRequestId: randomUUID(),
      projectId: fixture.projectId,
      taskId: fixture.taskId,
      taskBriefId: initial.taskBriefId,
      assignmentAttemptId: initial.assignmentAttemptId,
      causationId: randomUUID(),
      requestedAt: fixture.now(),
      action: 'report_result',
      resultSummary: 'retry crash result',
      evidenceRefs: [],
    });
    await healthy.transition.apply(systemPrincipal('test-orchestrator', fixture.now()), {
      protocolVersion: 1,
      transitionRequestId: randomUUID(),
      projectId: fixture.projectId,
      taskId: fixture.taskId,
      taskBriefId: initial.taskBriefId,
      assignmentAttemptId: initial.assignmentAttemptId,
      causationId: randomUUID(),
      requestedAt: fixture.now(),
      action: 'verifier_rejected',
      verdictMessageId: randomUUID(),
      reason: 'retry after crash',
    });
    const crashing = services(
      fixture,
      'retry-crash-before-activation',
      uncertainClient(ch, 'tasks', 'before_accept'),
    );
    await expect(crashing.assignment.retry(
      fixture.taskId,
      'retry_after_rejection',
    )).rejects.toMatchObject({ name: 'SchedulerError', code: 'UNCERTAIN_WRITE' });
    expect((await getLatestTask(ch, fixture.projectId, fixture.taskId))?.assignment_attempt_id)
      .toBe(initial.assignmentAttemptId);
    expect(await redis.get(lockKey(fixture.projectId, 'src/retry-crash.ts')))
      .toBe(initial.assignmentAttemptId);
    const recovered = await healthy.assignment.retry(
      fixture.taskId,
      'retry_after_rejection',
    );
    expect(recovered.previousAttemptId).toBe(initial.assignmentAttemptId);
    expect(await redis.get(lockKey(fixture.projectId, 'src/retry-crash.ts')))
      .toBe(recovered.assignmentAttemptId);
    expect(await listTaskCausalEntries(ch, fixture.taskId, recovered.assignmentAttemptId))
      .toMatchObject([{ ordinal: 0, source_type: 'retry_after_rejection' }]);
  });

  it('accepted attempt sonrasi lease theft fresh fence ile rollback olur ve exact retry ayni attempti kullanir', async () => {
    const fixture = await seed({ targetFiles: ['src/b.ts', 'src/c.ts'] });
    const healthy = services(fixture, 'attempt-theft-healthy');
    const initial = await healthy.assignment.assign(fixture.taskId);
    await startWorking(fixture, initial, healthy.transition);
    await healthy.transition.apply(systemPrincipal('test-orchestrator', fixture.now()), {
      protocolVersion: 1,
      transitionRequestId: randomUUID(),
      projectId: fixture.projectId,
      taskId: fixture.taskId,
      taskBriefId: initial.taskBriefId,
      assignmentAttemptId: initial.assignmentAttemptId,
      causationId: randomUUID(),
      requestedAt: fixture.now(),
      action: 'report_result',
      resultSummary: 'accepted attempt theft',
      evidenceRefs: [],
    });
    await healthy.transition.apply(systemPrincipal('test-orchestrator', fixture.now()), {
      protocolVersion: 1,
      transitionRequestId: randomUUID(),
      projectId: fixture.projectId,
      taskId: fixture.taskId,
      taskBriefId: initial.taskBriefId,
      assignmentAttemptId: initial.assignmentAttemptId,
      causationId: randomUUID(),
      requestedAt: fixture.now(),
      action: 'verifier_rejected',
      verdictMessageId: randomUUID(),
      reason: 'steal after accepted attempt',
    });
    const stolen = services(
      fixture,
      'attempt-theft-stale',
      stealLeaseAfterAcceptedInsert(ch, redis, fixture.taskId, 'assignment_attempts'),
    );
    await expect(stolen.assignment.retry(
      fixture.taskId,
      'retry_after_rejection',
    )).rejects.toMatchObject({ code: 'STALE_FENCE' });
    const pendingCommand = (await listLatestEffectsByState(ch, fixture.projectId, 'pending'))
      .find((effect) =>
        effect.task_id === fixture.taskId &&
        effect.effect_type === 'scheduler_assignment_command_v1');
    expect(pendingCommand).toBeDefined();
    if (pendingCommand === undefined) throw new Error('planned command bulunamadi');
    const plannedAttemptId = EntityIdSchema.parse(
      (pendingCommand.result as { assignmentAttemptId: string }).assignmentAttemptId,
    );
    expect(await getAssignmentAttempt(ch, plannedAttemptId)).not.toBeNull();
    expect((await getLatestTask(ch, fixture.projectId, fixture.taskId))?.assignment_attempt_id)
      .toBe(initial.assignmentAttemptId);
    expect(await redis.get(lockKey(fixture.projectId, 'src/b.ts')))
      .toBe(initial.assignmentAttemptId);
    expect(await redis.get(lockKey(fixture.projectId, 'src/c.ts')))
      .toBe(initial.assignmentAttemptId);
    expect(await redis.exists(agentLockKey(initial.workerAgentId))).toBe(0);
    expect(await redis.exists(agentLockKey(initial.verifierAgentId))).toBe(0);

    const recovered = await healthy.assignment.retry(
      fixture.taskId,
      'retry_after_rejection',
    );
    expect(recovered.assignmentAttemptId).toBe(plannedAttemptId);
    expect(await redis.get(lockKey(fixture.projectId, 'src/b.ts'))).toBe(plannedAttemptId);
    expect(await redis.get(lockKey(fixture.projectId, 'src/c.ts'))).toBe(plannedAttemptId);
    expect((await getLatestEffect(
      ch,
      pendingCommand.causation_id,
      pendingCommand.stable_effect_id,
    ))?.state).toBe('succeeded');
  }, 20_000);

  it('activation sonrasi crash exact commandi tamamlar ve farkli correction reconcile oncesi bloklanir', async () => {
    const fixture = await seed({ targetFiles: ['src/activation-crash.ts'] });
    const healthy = services(fixture, 'activation-crash-healthy');
    const initial = await healthy.assignment.assign(fixture.taskId);
    await startWorking(fixture, initial, healthy.transition);
    await healthy.transition.apply(systemPrincipal('test-orchestrator', fixture.now()), {
      protocolVersion: 1,
      transitionRequestId: randomUUID(),
      projectId: fixture.projectId,
      taskId: fixture.taskId,
      taskBriefId: initial.taskBriefId,
      assignmentAttemptId: initial.assignmentAttemptId,
      causationId: randomUUID(),
      requestedAt: fixture.now(),
      action: 'report_result',
      resultSummary: 'activation crash result',
      evidenceRefs: [],
    });
    await healthy.transition.apply(systemPrincipal('test-orchestrator', fixture.now()), {
      protocolVersion: 1,
      transitionRequestId: randomUUID(),
      projectId: fixture.projectId,
      taskId: fixture.taskId,
      taskBriefId: initial.taskBriefId,
      assignmentAttemptId: initial.assignmentAttemptId,
      causationId: randomUUID(),
      requestedAt: fixture.now(),
      action: 'verifier_rejected',
      verdictMessageId: randomUUID(),
      reason: 'crash after activation',
    });
    const crashing = services(
      fixture,
      'activation-event-crash',
      uncertainClient(ch, 'events', 'before_accept'),
    );
    await expect(crashing.assignment.retry(
      fixture.taskId,
      'retry_after_rejection',
    )).rejects.toMatchObject({ name: 'SchedulerError', code: 'UNCERTAIN_WRITE' });
    const pendingCommand = (await listLatestEffectsByState(ch, fixture.projectId, 'pending'))
      .find((effect) =>
        effect.task_id === fixture.taskId &&
        effect.effect_type === 'scheduler_assignment_command_v1');
    expect(pendingCommand).toBeDefined();
    if (pendingCommand === undefined) throw new Error('activation pending command bulunamadi');
    const plannedAttemptId = EntityIdSchema.parse(
      (pendingCommand.result as { assignmentAttemptId: string }).assignmentAttemptId,
    );
    expect((await getLatestTask(ch, fixture.projectId, fixture.taskId))?.assignment_attempt_id)
      .toBe(plannedAttemptId);
    await expect(healthy.assignment.retry(
      fixture.taskId,
      'retry_after_gate_failure',
    )).rejects.toMatchObject({ code: 'UNCERTAIN_WRITE' });

    const recovered = await healthy.assignment.retry(
      fixture.taskId,
      'retry_after_rejection',
    );
    expect(recovered.assignmentAttemptId).toBe(plannedAttemptId);
    expect(await listTaskCausalEntries(ch, fixture.taskId, plannedAttemptId))
      .toMatchObject([{ ordinal: 0, source_type: 'retry_after_rejection' }]);
    expect((await getLatestEffect(
      ch,
      pendingCommand.causation_id,
      pendingCommand.stable_effect_id,
    ))?.state).toBe('succeeded');
    const count = await ch.query({
      query: `SELECT countDistinct(assignment_attempt_id) AS count
        FROM assignment_attempts WHERE task_id = {taskId:UUID}`,
      query_params: { taskId: fixture.taskId },
      format: 'JSONEachRow',
    });
    expect(await count.json()).toEqual([{ count: '2' }]);
  }, 20_000);

  it('uncertain activation exact retryda sonradan gorunen kabul edilmis task/eventi tamamlar', async () => {
    const fixture = await seed({ targetFiles: ['src/activation-late-visible.ts'] });
    const healthy = services(fixture, 'activation-late-visible-healthy');
    const initial = await healthy.assignment.assign(fixture.taskId);
    await startWorking(fixture, initial, healthy.transition);
    await healthy.transition.apply(systemPrincipal('test-orchestrator', fixture.now()), {
      protocolVersion: 1,
      transitionRequestId: randomUUID(),
      projectId: fixture.projectId,
      taskId: fixture.taskId,
      taskBriefId: initial.taskBriefId,
      assignmentAttemptId: initial.assignmentAttemptId,
      causationId: randomUUID(),
      requestedAt: fixture.now(),
      action: 'report_result',
      resultSummary: 'late activation result',
      evidenceRefs: [],
    });
    await healthy.transition.apply(systemPrincipal('test-orchestrator', fixture.now()), {
      protocolVersion: 1,
      transitionRequestId: randomUUID(),
      projectId: fixture.projectId,
      taskId: fixture.taskId,
      taskBriefId: initial.taskBriefId,
      assignmentAttemptId: initial.assignmentAttemptId,
      causationId: randomUUID(),
      requestedAt: fixture.now(),
      action: 'verifier_rejected',
      verdictMessageId: randomUUID(),
      reason: 'late accepted activation',
    });

    const delayed = delayTaskAcceptance(ch);
    await expect(services(
      fixture,
      'activation-late-visible-stale',
      delayed.client,
    ).assignment.retry(
      fixture.taskId,
      'retry_after_rejection',
    )).rejects.toMatchObject({ code: 'UNCERTAIN_WRITE' });

    const pendingActivation = (await listLatestEffectsByState(
      ch,
      fixture.projectId,
      'pending',
    )).find((effect) => effect.effect_type === 'task_attempt_activation_v1');
    expect(pendingActivation).toBeDefined();
    const command = (await listLatestEffectsByState(ch, fixture.projectId, 'pending'))
      .find((effect) => effect.effect_type === 'scheduler_assignment_command_v1');
    expect(command).toBeDefined();
    if (pendingActivation === undefined || command === undefined) {
      throw new Error('activation/command effect bulunamadi');
    }
    const uncertaintyLease = await acquireFencedLease(
      redis,
      taskLockKey(fixture.taskId),
      'test-activation-uncertain',
      600_000,
      pendingActivation.lease_fence,
    );
    if (uncertaintyLease === null) throw new Error('uncertainty lease alinamadi');
    const activationEffect = await appendEffectVersion(ch, {
      causation_id: pendingActivation.causation_id,
      stable_effect_id: pendingActivation.stable_effect_id,
      expectedVersion: pendingActivation.effect_version,
      state: 'uncertain',
      result: pendingActivation.result,
      error: 'simulated accepted result not yet visible',
      lease_fence: uncertaintyLease.fence,
      created_at: pendingActivation.created_at,
    });
    expect(await releaseFencedLease(redis, uncertaintyLease)).toBe(true);
    expect(activationEffect.state).toBe('uncertain');
    await expect(healthy.assignment.retry(
      fixture.taskId,
      'retry_after_rejection',
    )).rejects.toMatchObject({ code: 'UNCERTAIN_WRITE' });
    const plannedAttemptId = EntityIdSchema.parse(
      (command.result as { assignmentAttemptId: string }).assignmentAttemptId,
    );

    await delayed.land();
    expect((await getLatestTask(ch, fixture.projectId, fixture.taskId))?.assignment_attempt_id)
      .toBe(plannedAttemptId);
    const recovered = await healthy.assignment.retry(
      fixture.taskId,
      'retry_after_rejection',
    );
    expect(recovered.assignmentAttemptId).toBe(plannedAttemptId);
    expect((await getLatestEffect(
      ch,
      activationEffect.causation_id,
      activationEffect.stable_effect_id,
    ))?.state).toBe('succeeded');
    expect((await getLatestEffect(
      ch,
      command.causation_id,
      command.stable_effect_id,
    ))?.state).toBe('succeeded');
    expect(await listTaskCausalEntries(ch, fixture.taskId, plannedAttemptId))
      .toMatchObject([{ ordinal: 0, source_type: 'retry_after_rejection' }]);
  }, 20_000);

  it('causal log restart/dedupe/collision ve gercek belirsiz insert uzlastirmasini korur', async () => {
    const fixture = await seed();
    const runtime = services(fixture, 'scheduler-causal');
    const attempt = await runtime.assignment.assign(fixture.taskId);
    const firstInput = {
      projectId: fixture.projectId,
      taskId: fixture.taskId,
      taskBriefId: attempt.taskBriefId,
      assignmentAttemptId: attempt.assignmentAttemptId,
      sourceType: 'message',
      sourceId: randomUUID(),
      causationId: randomUUID(),
      createdAt: fixture.now(),
    };
    const first = await runtime.causal.append(firstInput);
    expect(await runtime.causal.append(firstInput)).toEqual(first);
    const restarted = services(fixture, 'scheduler-causal-restart').causal;
    const second = await restarted.append({
      ...firstInput,
      sourceId: randomUUID(),
      causationId: randomUUID(),
      createdAt: fixture.now(),
    });
    expect(second.ordinal).toBe(first.ordinal + 1);
    await expect(restarted.append({
      ...firstInput,
      createdAt: fixture.now(),
    })).rejects.toMatchObject({ code: 'INTEGRITY_CONFLICT' });

    const acceptedInput = {
      ...firstInput,
      sourceId: randomUUID(),
      causationId: randomUUID(),
      createdAt: fixture.now(),
    };
    const acceptedRuntime = services(
      fixture,
      'scheduler-causal-after-accept',
      uncertainClient(ch, 'task_causal_entries', 'after_accept'),
    );
    const accepted = await acceptedRuntime.causal.append(acceptedInput);
    expect(accepted.ordinal).toBe(second.ordinal + 1);

    const uncertainInput = {
      ...firstInput,
      sourceId: randomUUID(),
      causationId: randomUUID(),
      createdAt: fixture.now(),
    };
    const uncertainRuntime = services(
      fixture,
      'scheduler-causal-before-accept',
      uncertainClient(ch, 'task_causal_entries', 'before_accept'),
    );
    await expect(uncertainRuntime.causal.append(uncertainInput)).rejects.toMatchObject({
      name: 'SchedulerError',
      code: 'UNCERTAIN_WRITE',
      message: expect.stringMatching(/belirsiz|uzlastirilamadi/),
    });
    await expect(restarted.append({
      ...firstInput,
      sourceId: randomUUID(),
      causationId: randomUUID(),
      createdAt: fixture.now(),
    })).rejects.toMatchObject({ code: 'UNCERTAIN_WRITE' });
    const reconciled = await restarted.append(uncertainInput);
    expect(reconciled.ordinal).toBe(accepted.ordinal + 1);

    const collisionFixture = await seed();
    const collisionRuntime = services(collisionFixture, 'scheduler-ordinal-collision');
    const collisionAttempt = await collisionRuntime.assignment.assign(collisionFixture.taskId);
    const rows = await listTaskCausalEntries(
      ch,
      collisionFixture.taskId,
      collisionAttempt.assignmentAttemptId,
    );
    const zero = rows[0]!;
    await ch.insert({
      table: 'task_causal_entries',
      values: [{
        ...zero,
        entry_id: randomUUID(),
        source_id: randomUUID(),
        lease_fence: '1',
      }],
      format: 'JSONEachRow',
    });
    await expect(collisionRuntime.causal.append({
      projectId: collisionFixture.projectId,
      taskId: collisionFixture.taskId,
      taskBriefId: collisionAttempt.taskBriefId,
      assignmentAttemptId: collisionAttempt.assignmentAttemptId,
      sourceType: 'message',
      sourceId: randomUUID(),
      causationId: randomUUID(),
      createdAt: collisionFixture.now(),
    })).rejects.toMatchObject({
      name: 'SchedulerError',
      code: 'INTEGRITY_CONFLICT',
      message: expect.stringMatching(/ordinal catismasi/),
    });

    expect(await getAssignmentAttempt(ch, attempt.assignmentAttemptId)).toEqual(attempt);
  });
});
