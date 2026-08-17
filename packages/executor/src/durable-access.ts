import { createHash } from 'node:crypto';
import {
  fileLockKey,
  getAssignmentAttempt,
  getFencedLease,
  getFileLockOwner,
  getLatestTask,
  taskLockKey,
  type ClickHouseClient,
  type WwRedis,
} from '@ww/db';
import type { EntityId, TaskStatus } from '@ww/shared';
import { ExecutorError } from './errors.js';
import type { ExecutorAccessInput, ExecutorAccessPort } from './ports.js';

export interface CurrentExecutorTask {
  readonly projectId: EntityId;
  readonly taskId: EntityId;
  readonly status: TaskStatus;
  readonly taskBriefId?: EntityId;
  readonly assignmentAttemptId?: EntityId;
  readonly workerAgentId?: EntityId;
  readonly verifierAgentId?: EntityId;
}

export interface CurrentExecutorAttempt {
  readonly projectId: EntityId;
  readonly taskId: EntityId;
  readonly taskBriefId: EntityId;
  readonly assignmentAttemptId: EntityId;
  readonly workerAgentId: EntityId;
  readonly verifierAgentId: EntityId;
  readonly leaseOwner: string;
  readonly leaseFence: number;
}

export interface CurrentExecutorLease {
  readonly owner: string;
  readonly fence: string;
}

export interface ExecutorAccessStatePort {
  loadTask(projectId: EntityId, taskId: EntityId): Promise<CurrentExecutorTask | null>;
  loadAttempt(assignmentAttemptId: EntityId): Promise<CurrentExecutorAttempt | null>;
  loadTaskLease(taskId: EntityId): Promise<CurrentExecutorLease | null>;
  loadFileLockOwner(projectId: EntityId, relativePath: string): Promise<string | null>;
}

export class DurableExecutorAccess implements ExecutorAccessPort {
  constructor(readonly state: ExecutorAccessStatePort) {}

  async assertAuthorized(input: ExecutorAccessInput): Promise<void> {
    const [task, attempt, lease] = await Promise.all([
      this.state.loadTask(input.projectId, input.taskId),
      this.state.loadAttempt(input.assignmentAttemptId),
      this.state.loadTaskLease(input.taskId),
    ]);
    if (
      task === null ||
      task.projectId !== input.projectId ||
      task.taskId !== input.taskId ||
      task.status !== input.taskStatus ||
      task.taskBriefId !== input.taskBriefId ||
      task.assignmentAttemptId !== input.assignmentAttemptId ||
      (task.workerAgentId !== input.agentId && task.verifierAgentId !== input.agentId)
    ) {
      throw new ExecutorError('LEASE_REQUIRED', 'Current task/brief/attempt/agent bağlamı eşleşmiyor');
    }
    if (
      attempt === null ||
      attempt.projectId !== input.projectId ||
      attempt.taskId !== input.taskId ||
      attempt.taskBriefId !== input.taskBriefId ||
      attempt.assignmentAttemptId !== input.assignmentAttemptId ||
      attempt.leaseOwner !== input.leaseOwner ||
      input.leaseFence < attempt.leaseFence ||
      (attempt.workerAgentId !== input.agentId && attempt.verifierAgentId !== input.agentId)
    ) {
      throw new ExecutorError('LEASE_REQUIRED', 'Kalıcı assignment fence bağlamı eşleşmiyor');
    }
    // Görev kilidi OPERASYON MUTEX'idir, sahiplik belgesi değil: assignment,
    // transition ve causal-log onu kısa süreli alır ve bırakır (owner önekleri
    // `assignment:`/`transition:`/`causal:`). Bu yüzden "kilit hâlâ bu
    // attempt'in olmalı" kuralı MİMARİYE AYKIRIYDI ve her araç çağrısını
    // düşürüyordu — worker hiçbir dosya yazamıyordu.
    //
    // Güncellik kanıtı yukarıdaki KALICI kontrollerdir (ClickHouse'daki task
    // ve attempt bu çağrıyı işaret etmeli). Redis kilidinden beklenen tek şey
    // devralma koruması: daha YÜKSEK fence'li bir kilit varsa başka bir taraf
    // görevi devralıyordur ve bu attempt artık yazmamalıdır.
    if (lease !== null && BigInt(lease.fence) > BigInt(input.leaseFence)) {
      throw new ExecutorError(
        'LEASE_REQUIRED',
        `Görevi daha yüksek fence devraldı: ${lease.fence} > ${input.leaseFence}`,
      );
    }
    if (input.requireFileLock) {
      if (input.relativePath === undefined) {
        throw new ExecutorError('LOCK_REQUIRED', 'Dosya yazımı relativePath gerektirir');
      }
      const owner = await this.state.loadFileLockOwner(input.projectId, input.relativePath);
      if (owner !== input.assignmentAttemptId) {
        throw new ExecutorError('LOCK_REQUIRED', 'Current assignment dosya kilidinin sahibi değil');
      }
    }
  }
}

/** Production adapter over Phase 2-4 read APIs; Redis remains non-durable evidence only. */
export function dbRedisExecutorAccess(
  ch: ClickHouseClient,
  redis: WwRedis,
): DurableExecutorAccess {
  return new DurableExecutorAccess({
    async loadTask(projectId, taskId) {
      const task = await getLatestTask(ch, projectId, taskId);
      if (task === null) return null;
      return Object.freeze({
        projectId: task.project_id,
        taskId: task.task_id,
        status: task.status,
        ...(task.task_brief_id === undefined ? {} : { taskBriefId: task.task_brief_id }),
        ...(task.assignment_attempt_id === undefined
          ? {}
          : { assignmentAttemptId: task.assignment_attempt_id }),
        ...(task.worker_agent_id === undefined ? {} : { workerAgentId: task.worker_agent_id }),
        ...(task.verifier_agent_id === undefined ? {} : { verifierAgentId: task.verifier_agent_id }),
      });
    },
    async loadAttempt(assignmentAttemptId) {
      const attempt = await getAssignmentAttempt(ch, assignmentAttemptId);
      if (attempt === null) return null;
      return Object.freeze({
        projectId: attempt.projectId,
        taskId: attempt.taskId,
        taskBriefId: attempt.taskBriefId,
        assignmentAttemptId: attempt.assignmentAttemptId,
        workerAgentId: attempt.workerAgentId,
        verifierAgentId: attempt.verifierAgentId,
        leaseOwner: attempt.leaseOwner,
        leaseFence: attempt.leaseFence,
      });
    },
    async loadTaskLease(taskId) {
      const lease = await getFencedLease(redis, taskLockKey(taskId));
      return lease === null ? null : Object.freeze({ owner: lease.owner, fence: lease.fence });
    },
    async loadFileLockOwner(projectId, relativePath) {
      const hash = createHash('sha1').update(relativePath).digest('hex');
      return await getFileLockOwner(redis, fileLockKey(projectId, hash));
    },
  });
}
