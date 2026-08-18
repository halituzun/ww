import {
  fileLockKey,
  releaseFileLock,
  listLatestTaskEffectsByStates,
  appendEffectVersion,
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
import { DEFAULT_RECOVERY_GRACE_MS, isRecoverableStale } from './recovery-staleness.js';
import { planEffectReconciliation } from './abandoned-effects.js';
import { plannedLockReleases } from './recovered-file-locks.js';

export interface RecoveryClock { now(): string; }

export interface RecoveryOptions {
  readonly heartbeatTtlMs?: number;
  /** Heartbeat'in ilk kez yazılabilmesi için tanınan pay. */
  readonly recoveryGraceMs?: number;
  readonly taskStatuses?: readonly TaskRow['status'][];
}

export interface RecoveryResult {
  readonly projectId: EntityId;
  readonly requeuedTaskIds: readonly EntityId[];
  readonly idledAgentIds: readonly EntityId[];
  readonly streamRepairedTaskIds: readonly EntityId[];
  /**
   * `queued` ama ATANAMAZ olduğu için kuyruğa KONMAYAN görevler (plansız).
   * Kuyruğa koymak sonsuz döngü açardı; bildirmemek ise "sessizce hiç
   * çalışmayan görev" kusurunu sürdürürdü.
   */
  readonly blockedTaskIds: readonly EntityId[];
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
  readonly #graceMs: number;
  readonly #statuses: readonly TaskRow['status'][];

  constructor(ch: ClickHouseClient, redis: WwRedis, clock: RecoveryClock = { now: () => new Date().toISOString() }, options: RecoveryOptions = {}) {
    this.#ch = ch;
    this.#redis = redis;
    this.#clock = clock;
    this.#heartbeatTtlMs = options.heartbeatTtlMs ?? 30_000;
    this.#graceMs = options.recoveryGraceMs ?? DEFAULT_RECOVERY_GRACE_MS;
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
        // Heartbeat YOKLUĞU tek başına yetmez: heartbeat ancak atamadan sonra
        // yazılabilir, yeni atanmış canlı agent ölü görünürdü (bkz.
        // recovery-staleness.ts).
        const stale = isRecoverableStale({
          heartbeatMissing: await staleHeartbeat(this.#redis, `ww:hb:${agent.agent_id}`),
          lastUpdatedAtMs: Date.parse(agent.updated_at),
          nowMs,
          graceMs: this.#graceMs,
        });
        if (stale) staleAgentIds.add(agent.agent_id);
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
        const taskStale = isRecoverableStale({
          heartbeatMissing: await staleHeartbeat(this.#redis, `ww:hb:task:${task.task_id}`),
          lastUpdatedAtMs: Date.parse(task.updated_at),
          nowMs,
          graceMs: this.#graceMs,
        });
        if (!workerStale && !verifierStale && !taskStale) continue;
        const next = { ...task, status: 'queued' as const, worker_agent_id: NIL_UUID, verifier_agent_id: NIL_UUID, task_brief_id: NIL_UUID, assignment_attempt_id: NIL_UUID, updated_at: now };
        await appendTaskVersion(this.#ch, { expectedVersion: task.version, next });
        // Yarıda kalan etkiler uzlaştırılmazsa görev KALICI olarak atanamaz:
        // "task icin baska assignment command uzlastirilmamis". Yalnızca
        // replay-safe olanlar kapatılır; tekrarı güvenli olmayan etki
        // otomatik çözülmez (bkz. abandoned-effects.ts).
        await this.#reconcileAbandonedEffects(task.task_id, now);
        // docs/07: kurtarmada KİLİTLER DE BIRAKILIR. Bırakılmazsa ölü
        // denemenin kilitleri TTL dolana dek durur (~8,5 dk) ve hemen kuyruğa
        // alınan görev kendi dosyalarını kilitli bulup çalışamaz.
        await this.#releaseDeadTaskLocks(task);
        await enqueueTask(this.#redis, `ww:queue:${projectId}`, task.task_id);
        requeuedTaskIds.push(task.task_id);
        streamRepairedTaskIds.push(task.task_id);
      }
    }
    // docs/07 adım 3: ClickHouse'da 'queued' ama stream'de OLMAYAN görevleri
    // geri doldur. Bunlar aksi halde sonsuza dek bekler — kuyruğu tüketen
    // kimse onları görmez (Redis temizlenince/budanınca gerçekten oluyor).
    const queuedTasks = await listLatestTasksByStatus(this.#ch, projectId, 'queued');
    // 'queued' görevin CANLI denemesi yoktur; üzerindeki terminal olmayan etki
    // tanım gereği terk edilmiştir. Uzlaştırılmazsa görev kuyrukta durur ama
    // her atama "assignment command uzlastirilmamis" ile reddedilir ve görev
    // kalıcı olarak koşamaz. Bunu yalnızca durum DEĞİŞTİRİRKEN yapmak yetmiyordu:
    // süreç ölmeden önce zaten 'queued' olan görevlere hiç dokunulmuyordu.
    for (const task of queuedTasks) {
      await this.#reconcileAbandonedEffects(task.task_id, now);
    }
    const inStream = await listStreamTaskIds(this.#redis, `ww:queue:${projectId}`);
    const planOf = new Map(queuedTasks.map((task) => [task.task_id, task.plan_id]));
    const refill = planQueueRefill(
      queuedTasks.map((task) => task.task_id),
      inStream,
      { planIdOf: (taskId) => planOf.get(taskId) ?? '' },
    );
    for (const taskId of refill) {
      await enqueueTask(this.#redis, `ww:queue:${projectId}`, taskId);
      streamRepairedTaskIds.push(taskId as EntityId);
    }
    // ENGELLENEN GÖREV SESSİZ KALMAZ. Kuyruğa koymayı bırakmak döngüyü keser
    // ama görev hâlâ kalıcı olarak koşamaz durumdadır; bunu bildirmezsek
    // "sessizce hiç çalışmayan görev" kusurunu daha sessiz bir biçimde
    // sürdürmüş oluruz.
    const blockedTaskIds = queuedTasks
      .filter((task) => !inStream.includes(task.task_id) && !refill.includes(task.task_id))
      .map((task) => task.task_id as EntityId);

    // HİÇBİR ŞEY OLMADIYSA OLAY YAZMA. Ölçüldü (canlı ClickHouse, 2026-08-18):
    // 2853 `recovery_completed` olayının 2805'i (%98) hiçbir şey kurtarmamıştı
    // ve bunlar tüm olay günlüğünün %65'iydi. Panel zaman çizelgesi 100 olay
    // tuttuğu için GERÇEK İŞ görünmez oluyordu; denetim izi de bu gürültüyle
    // okunamaz hale geliyordu.
    //
    // Sağlık kontrolünde aynı ilke zaten uygulanıyor: yayın SADECE değişimde.
    if (requeuedTaskIds.length === 0
      && idledAgentIds.length === 0
      && streamRepairedTaskIds.length === 0
      && blockedTaskIds.length === 0) {
      return Object.freeze({
        projectId, requeuedTaskIds, idledAgentIds, streamRepairedTaskIds, blockedTaskIds,
      });
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
      payload: { projectId, requeuedTaskIds, idledAgentIds, streamRepairedTaskIds, blockedTaskIds },
      duration_ms: 0,
      created_at: now,
    });
    return Object.freeze({
      projectId, requeuedTaskIds, idledAgentIds, streamRepairedTaskIds, blockedTaskIds,
    });
  }

  async recoverAll(limit = 100): Promise<readonly RecoveryResult[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new Error('recovery project limiti gecersiz');
    const projects = await listLatestProjects(this.#ch, limit);
    const results: RecoveryResult[] = [];
    for (const project of projects) results.push(await this.recoverProject(project.project_id));
    return results;
  }

  /**
   * Ölü bırakılmış etkileri uzlaştırır. Replay-safe olanlar 'failed' yazılır ki
   * yeni deneme yolu açılsın; tekrarı güvenli OLMAYAN etkiler dokunulmadan
   * bırakılır ve sayısı raporlanır — onları otomatik kapatmak yan etkiyi iki
   * kez uygulamak olurdu.
   */
  async #reconcileAbandonedEffects(taskId: EntityId, now: string): Promise<number> {
    const effects = await listLatestTaskEffectsByStates(this.#ch, taskId, ['pending', 'uncertain']);
    const plan = planEffectReconciliation(effects as never);
    for (const effect of plan.abandon) {
      const row = effects.find((candidate) =>
        candidate.causation_id === effect.causation_id
        && candidate.stable_effect_id === effect.stable_effect_id);
      if (row === undefined) continue;
      await appendEffectVersion(this.#ch, {
        causation_id: row.causation_id,
        stable_effect_id: row.stable_effect_id,
        expectedVersion: row.effect_version,
        state: 'failed',
        result: {},
        error: 'kurtarma: surec olurken yarida kaldi',
        lease_fence: row.lease_fence,
        created_at: now,
      });
    }
    return plan.escalate.length;
  }


  /**
   * Ölü denemenin dosya kilitlerini bırakır. `releaseFileLock` sahiplik
   * kontrollüdür: kilidi başka bir deneme devralmışsa çağrı etkisizdir, yani
   * canlı bir işin kilidi ÇALINAMAZ.
   */
  async #releaseDeadTaskLocks(
    task: Readonly<{
      project_id: string;
      target_files: readonly string[];
      assignment_attempt_id: string;
    }>,
  ): Promise<number> {
    const plan = plannedLockReleases(task.target_files, task.assignment_attempt_id, NIL_UUID);
    let released = 0;
    for (const entry of plan) {
      const key = fileLockKey(task.project_id, entry.fileHash);
      if (await releaseFileLock(this.#redis, key, entry.owner)) released += 1;
    }
    return released;
  }

}
