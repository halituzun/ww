import {
  ackQueue,
  createQueueReader,
  ensureGroup,
  queueKey,
  reclaimQueue,
  type QueueMessage,
  type ReclaimedQueueMessage,
  type RedisQueueReader,
  type WwRedis,
} from '@ww/db';
import { EntityIdSchema, type EntityId } from '@ww/shared';
import { SchedulerError, TaskDeferredError } from './errors.js';
import type {
  AssignmentServiceFactoryPort,
  RunOnceItemResult,
  RunOnceResult,
} from './ports.js';

export interface SchedulerWorkerOptions {
  readonly group?: string;
  readonly readCount?: number;
  readonly blockMs?: number;
  readonly reclaimCount?: number;
  readonly reclaimMinIdleMs?: number;
  readonly maxDeliveries?: number;
}

export class SchedulerWorker {
  readonly #redis: WwRedis;
  readonly #assignments: AssignmentServiceFactoryPort;
  readonly #group: string;
  readonly #readCount: number;
  readonly #blockMs: number;
  readonly #reclaimCount: number;
  readonly #reclaimMinIdleMs: number;
  readonly #maxDeliveries: number;
  readonly #readers = new Map<string, RedisQueueReader>();
  readonly #reclaimCursors = new Map<string, string>();

  constructor(
    redis: WwRedis,
    assignments: AssignmentServiceFactoryPort,
    options: SchedulerWorkerOptions = {},
  ) {
    this.#redis = redis;
    this.#assignments = assignments;
    this.#group = options.group ?? 'scheduler';
    this.#readCount = options.readCount ?? 20;
    this.#blockMs = options.blockMs ?? 25;
    this.#reclaimCount = options.reclaimCount ?? 20;
    this.#reclaimMinIdleMs = options.reclaimMinIdleMs ?? 30_000;
    this.#maxDeliveries = options.maxDeliveries ?? 5;
  }

  async runOnce(projectIdValue: string, consumerId: string): Promise<RunOnceResult> {
    const projectId = EntityIdSchema.parse(projectIdValue);
    if (consumerId.trim().length === 0) throw new Error('consumerId bos olamaz');
    const stream = queueKey(projectId);
    await ensureGroup(this.#redis, stream, this.#group);
    const readerKey = `${projectId}:${consumerId}`;
    let reader = this.#readers.get(readerKey);
    if (reader === undefined) {
      reader = createQueueReader(this.#redis);
      this.#readers.set(readerKey, reader);
    }
    const assignment = this.#assignments.forProject(projectId, consumerId);
    const items: RunOnceItemResult[] = [];
    const read = await reader.read(stream, this.#group, consumerId, {
      blockMs: this.#blockMs,
      count: this.#readCount,
    });
    for (const message of read.messages) {
      items.push(await this.#process(
        projectId,
        consumerId,
        assignment,
        message,
        'new',
        1,
      ));
    }

    const reclaim = await reclaimQueue(this.#redis, stream, this.#group, consumerId, {
      minIdleMs: this.#reclaimMinIdleMs,
      maxDeliveries: this.#maxDeliveries,
      cursor: this.#reclaimCursors.get(readerKey) ?? '0-0',
      count: this.#reclaimCount,
    });
    this.#reclaimCursors.set(readerKey, reclaim.nextCursor);
    for (const message of reclaim.claimed) {
      items.push(await this.#process(
        projectId,
        consumerId,
        assignment,
        message,
        'reclaimed',
        message.deliveryCount,
      ));
    }

    return Object.freeze({
      projectId,
      consumerId,
      items: Object.freeze(items),
      invalidMessageIds: Object.freeze([
        ...read.invalid.map((message) => message.msgId),
        ...reclaim.invalid.map((message) => message.msgId),
      ]),
      exhaustedMessageIds: Object.freeze(reclaim.exhausted.map((message) => message.msgId)),
      deletedMessageIds: Object.freeze([...reclaim.deletedIds]),
      nextReclaimCursor: reclaim.nextCursor,
    });
  }

  stop(): void {
    for (const reader of this.#readers.values()) reader.stop();
    this.#readers.clear();
  }

  async #process(
    projectId: EntityId,
    _consumerId: string,
    assignment: ReturnType<AssignmentServiceFactoryPort['forProject']>,
    message: QueueMessage | ReclaimedQueueMessage,
    source: 'new' | 'reclaimed',
    deliveryCount: number,
  ): Promise<RunOnceItemResult> {
    try {
      const attempt = await assignment.assign(message.taskId);
      // Task stream ACK is deliberately last: brief, attempt, task fold, file
      // locks, and causal ordinal zero are already durable at this point.
      await ackQueue(this.#redis, queueKey(projectId), this.#group, message.msgId);
      return Object.freeze({
        msgId: message.msgId,
        taskId: message.taskId,
        source,
        deliveryCount,
        state: source === 'new' ? 'assigned' : 'recovered',
        assignmentAttemptId: attempt.assignmentAttemptId,
      });
    } catch (error) {
      return Object.freeze({
        msgId: message.msgId,
        taskId: message.taskId,
        source,
        deliveryCount,
        state: error instanceof TaskDeferredError ? 'deferred' : 'failed',
        error: error instanceof Error ? error.message : String(error),
        ...(error instanceof SchedulerError ? { errorCode: error.code } : {}),
      });
    }
  }
}
