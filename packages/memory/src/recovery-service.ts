import {
  appendAgentVersion,
  appendEvent,
  appendTaskVersion,
  enqueueTask,
  getLatestTask,
  listLatestProjects,
  listLatestAgents,
  type ClickHouseClient,
  type TaskRow,
  type WwRedis,
  listLatestTasksByStatus,
  listStreamTaskIds,
} from '@ww/db';
import { NIL_UUID, canonicalSha256V1, type EntityId } from '@ww/shared';
import { planQueueRefill } from './queue-refill.js';

export interface RecoveryClock { now(): string; }

export interface RecoveryOptions {
  readonly heartbeatTtlMs?: number;
  readonly taskStatuses?: readonly TaskRow['status'][];
}

export interface RecoveryResult {
  readonly projectId: EntityId;
  readonly requeuedTaskIds: readonly EntityId[];
  readonly idledAgentIds: readonly EntityId[];
  readonly streamRepairedTaskIds: readonly EntityId[];
}

const DEFAULT_STATUSES: readonly TaskRow['status'][] = ['assigned', 'working', 'verifying', 'testing'];

function staleHeartbeat(redis: WwRedis, key: string): Promise<boolean> {
  return redis.pTTL(key).then((ttl: number) => ttl < 0);
}

/**
 * Startup recovery is deliberately explicit and bounded. It never mutates a
 * row without rereading its current version, and Redis is only used to detect
 * liveness/rebuild the durable queue.
 */
export class RecoveryService {
  readonly #ch: ClickHouseClient;
  readonly #redis: WwRedis;
  readonly #clock: RecoveryClock;
  readonly #heartbeatTtlMs: number;
  readonly #statuses: readonly TaskRow['status'][];

  constructor(ch: ClickHouseClient, redis: WwRedis, clock: RecoveryClock = { now: () => new Date().toISOString() }, options: RecoveryOptions = {}) {
    this.#ch = ch;
    this.#redis = redis;
    this.#clock = clock;
    this.#heartbeatTtlMs = options.heartbeatTtlMs ?? 30_000;
    this.#statuses = options.taskStatuses ?? DEFAULT_STATUSES;
    if (!Number.isSafeInteger(this.#heartbeatTtlMs) || this.#heartbeatTtlMs < 1) throw new Error('heartbeatTtlMs gecersiz');
  }

  async recoverProject(projectId: EntityId): Promise<RecoveryResult> {
    const now = this.#clock.now();
    const nowMs = Date.parse(now);
    if (!Number.isFinite(nowMs)) throw new Error('recovery clock gecersiz');
    const agents = await listLatestAgents(this.#ch, projectId, { limit: 1_000 });
    const requeuedTaskIds: EntityId[] = [];
    const streamRepairedTaskIds: EntityId[] = [];
    const idledAgentIds: EntityId[] = [];
    const staleAgentIds = new Set<EntityId>();
    for (const agent of agents) {
      if (agent.status === 'busy' || agent.status === 'waiting_verify' || agent.status === 'waiting_answer') {
        if (await staleHeartbeat(this.#redis, `ww:hb:${agent.agent_id}`)) staleAgentIds.add(agent.agent_id);
      }
    }
    for (const agent of agents) {
      if (!staleAgentIds.has(agent.agent_id)) continue;
      await appendAgentVersion(this.#ch, {
        expectedVersion: agent.version,
        assignmentFence: String(BigInt(agent.assignment_fence) + 1n),
        next: { ...agent, status: 'idle', current_task_id: NIL_UUID, updated_at: now },
      });
      idledAgentIds.push(agent.agent_id);
    }
    for (const status of this.#statuses) {
      const result = await this.#ch.query({
        query: `SELECT task_id FROM tasks
          WHERE project_id = {projectId:UUID} AND status = {status:String}
          AND (task_id, version) IN (SELECT task_id, max(version) FROM tasks WHERE project_id = {projectId:UUID} GROUP BY task_id)
          LIMIT 1000`,
        query_params: { projectId, status },
        format: 'JSONEachRow',
      });
      const rows = await result.json<{ task_id: string }>();
      for (const row of rows) {
        const task = await getLatestTask(this.#ch, projectId, row.task_id);
        if (task === null) continue;
        const workerStale = task.worker_agent_id !== NIL_UUID && staleAgentIds.has(task.worker_agent_id);
        const verifierStale = task.verifier_agent_id !== NIL_UUID && staleAgentIds.has(task.verifier_agent_id);
        const taskStale = await staleHeartbeat(this.#redis, `ww:hb:task:${task.task_id}`);
        if (!workerStale && !verifierStale && !taskStale) continue;
        const next = { ...task, status: 'queued' as const, worker_agent_id: NIL_UUID, verifier_agent_id: NIL_UUID, task_brief_id: NIL_UUID, assignment_attempt_id: NIL_UUID, updated_at: now };
        await appendTaskVersion(this.#ch, { expectedVersion: task.version, next });
        await enqueueTask(this.#redis, `ww:queue:${projectId}`, task.task_id);
        requeuedTaskIds.push(task.task_id);
        streamRepairedTaskIds.push(task.task_id);
      }
    }
    // docs/07 adım 3: ClickHouse'da 'queued' ama stream'de OLMAYAN görevleri
    // geri doldur. Bunlar aksi halde sonsuza dek bekler — kuyruğu tüketen
    // kimse onları görmez (Redis temizlenince/budanınca gerçekten oluyor).
    const queuedTasks = await listLatestTasksByStatus(this.#ch, projectId, 'queued');
    const inStream = await listStreamTaskIds(this.#redis, `ww:queue:${projectId}`);
    for (const taskId of planQueueRefill(queuedTasks.map((task) => task.task_id), inStream)) {
      await enqueueTask(this.#redis, `ww:queue:${projectId}`, taskId);
      streamRepairedTaskIds.push(taskId as EntityId);
    }

    const eventId = (`${canonicalSha256V1({ projectId, now, requeuedTaskIds, idledAgentIds }).slice(0, 8)}-${canonicalSha256V1({ projectId, now }).slice(8, 12)}-5${canonicalSha256V1({ projectId, now }).slice(13, 16)}-8${canonicalSha256V1({ projectId, now }).slice(17, 20)}-${canonicalSha256V1({ projectId, now }).slice(20, 32)}`) as EntityId;
    await appendEvent(this.#ch, {
      event_id: eventId,
      seq: String(BigInt(`0x${canonicalSha256V1({ eventId }).slice(0, 15)}`)),
      project_id: projectId,
      task_id: NIL_UUID,
      agent_id: NIL_UUID,
      event_type: 'recovery_completed',
      tool_name: 'recovery.service',
      payload: { projectId, requeuedTaskIds, idledAgentIds, streamRepairedTaskIds },
      duration_ms: 0,
      created_at: now,
    });
    return Object.freeze({ projectId, requeuedTaskIds, idledAgentIds, streamRepairedTaskIds });
  }

  async recoverAll(limit = 100): Promise<readonly RecoveryResult[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new Error('recovery project limiti gecersiz');
    const projects = await listLatestProjects(this.#ch, limit);
    const results: RecoveryResult[] = [];
    for (const project of projects) results.push(await this.recoverProject(project.project_id));
    return results;
  }
}
