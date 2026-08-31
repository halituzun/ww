import { randomUUID } from 'node:crypto';
import {
  RepositoryConflictError,
  RepositoryNotFoundError,
  RepositoryWriteError,
  type ClickHouseClient,
  type WwRedis,
} from '@ww/db';
import type { TaskContextSnapshotPort } from '@ww/memory';
import { EntityIdSchema } from '@ww/shared';
import { describe, expect, it } from 'vitest';
import { AssignmentService } from './assignment-service.js';
import { SchedulerError } from './errors.js';
import { systemPrincipal } from './ports.js';
import { TaskBriefService } from './task-brief-service.js';
import { TaskCausalLog } from './task-causal-log.js';
import { TaskTransitionService } from './task-transition-service.js';

const projectId = EntityIdSchema.parse(randomUUID());
const taskId = EntityIdSchema.parse(randomUUID());
const briefId = EntityIdSchema.parse(randomUUID());
const attemptId = EntityIdSchema.parse(randomUUID());

function rejectingClient(error: Error): ClickHouseClient {
  return {
    query: async () => {
      throw error;
    },
  } as unknown as ClickHouseClient;
}

const unusedRedis = {} as WwRedis;
const unusedSnapshot = {
  build: async () => {
    throw new Error('snapshot builder cagrilmamali');
  },
} as TaskContextSnapshotPort;

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => Object.freeze({ unexpectedlyResolved: true }),
    (error: unknown) => error,
  );
}

function expectBoundary(
  error: unknown,
  code: SchedulerError['code'],
  cause: Error,
): void {
  expect(error).toBeInstanceOf(SchedulerError);
  expect(error).toMatchObject({ name: 'SchedulerError', code });
  expect((error as SchedulerError).cause).toBe(cause);
}

describe('scheduler repository boundaries', () => {
  it('AssignmentService conflict hatasini exact INTEGRITY_CONFLICT ve cause ile mapler', async () => {
    const source = new RepositoryConflictError('assignment conflict');
    const ch = rejectingClient(source);
    const brief = new TaskBriefService(projectId, ch, unusedSnapshot, { redis: unusedRedis });
    const transition = new TaskTransitionService(ch, unusedRedis);
    const causal = new TaskCausalLog(ch, unusedRedis);
    const assignment = new AssignmentService(
      projectId,
      'repository-boundary',
      ch,
      unusedRedis,
      brief,
      transition,
      causal,
    );
    expectBoundary(await rejection(assignment.assign(taskId)), 'INTEGRITY_CONFLICT', source);
  });

  it('TaskBriefService not-found hatasini exact TASK_NOT_FOUND ve cause ile mapler', async () => {
    const source = new RepositoryNotFoundError('brief task missing');
    const service = new TaskBriefService(
      projectId,
      rejectingClient(source),
      unusedSnapshot,
      { redis: unusedRedis },
    );
    const error = await rejection(service.seal({
      taskId,
      workerPrompt: { name: 'role.worker.coding', version: 2 },
      verifierPrompt: { name: 'role.verifier', version: 1 },
    }));
    expectBoundary(error, 'TASK_NOT_FOUND', source);
  });

  it('TaskCausalLog write belirsizligini exact UNCERTAIN_WRITE ve cause ile mapler', async () => {
    const source = new RepositoryWriteError('causal write uncertain', { timeout: true });
    const service = new TaskCausalLog(rejectingClient(source), unusedRedis);
    const error = await rejection(service.append({
      projectId,
      taskId,
      taskBriefId: briefId,
      assignmentAttemptId: attemptId,
      sourceType: 'message',
      sourceId: randomUUID(),
      causationId: EntityIdSchema.parse(randomUUID()),
      createdAt: '2026-08-15T00:00:00.000Z',
    }));
    expectBoundary(error, 'UNCERTAIN_WRITE', source);
  });

  it('TaskTransitionService write belirsizligini exact UNCERTAIN_WRITE ve cause ile mapler', async () => {
    const source = new RepositoryWriteError('transition write uncertain', { timeout: true });
    const service = new TaskTransitionService(rejectingClient(source), unusedRedis);
    const requestedAt = '2026-08-15T00:00:00.000Z';
    const error = await rejection(service.apply(systemPrincipal('boundary-test', requestedAt), {
      protocolVersion: 1,
      transitionRequestId: EntityIdSchema.parse(randomUUID()),
      projectId,
      taskId,
      causationId: EntityIdSchema.parse(randomUUID()),
      requestedAt,
      action: 'cancel',
      fromStatus: 'queued',
      reason: 'boundary test',
    }));
    expectBoundary(error, 'UNCERTAIN_WRITE', source);
  });
});
