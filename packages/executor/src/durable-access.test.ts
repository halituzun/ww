import { randomUUID } from 'node:crypto';
import { EntityIdSchema } from '@ww/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  DurableExecutorAccess,
  type CurrentExecutorAttempt,
  type CurrentExecutorTask,
  type ExecutorAccessStatePort,
} from './durable-access.js';
import type { ExecutorAccessInput } from './ports.js';

const id = () => EntityIdSchema.parse(randomUUID());

function fixture(): {
  input: ExecutorAccessInput;
  task: CurrentExecutorTask;
  attempt: CurrentExecutorAttempt;
  state: ExecutorAccessStatePort;
} {
  const projectId = id();
  const taskId = id();
  const taskBriefId = id();
  const assignmentAttemptId = id();
  const workerAgentId = id();
  const verifierAgentId = id();
  const task: CurrentExecutorTask = Object.freeze({
    projectId,
    taskId,
    status: 'working',
    taskBriefId,
    assignmentAttemptId,
    workerAgentId,
    verifierAgentId,
  });
  const attempt: CurrentExecutorAttempt = Object.freeze({
    projectId,
    taskId,
    taskBriefId,
    assignmentAttemptId,
    workerAgentId,
    verifierAgentId,
    leaseOwner: 'scheduler:one',
    leaseFence: 9,
  });
  const state: ExecutorAccessStatePort = {
    loadTask: vi.fn(async () => task),
    loadAttempt: vi.fn(async () => attempt),
    loadTaskLease: vi.fn(async () => ({ owner: 'scheduler:one', fence: '9' })),
    loadFileLockOwner: vi.fn(async () => assignmentAttemptId),
  };
  const input: ExecutorAccessInput = Object.freeze({
    projectId,
    taskId,
    taskBriefId,
    assignmentAttemptId,
    agentId: workerAgentId,
    taskStatus: 'working',
    leaseOwner: 'scheduler:one',
    leaseFence: 9,
    relativePath: 'src/a.ts',
    requireFileLock: true,
  });
  return { input, task, attempt, state };
}

describe('DurableExecutorAccess', () => {
  it('current ClickHouse projectionu, Redis fence ve file-lock sahibi eşleşince izin verir', async () => {
    const test = fixture();
    await expect(new DurableExecutorAccess(test.state).assertAuthorized(test.input)).resolves.toBeUndefined();
    expect(test.state.loadFileLockOwner).toHaveBeenCalledWith(test.input.projectId, 'src/a.ts');
  });

  it('assignment satırı immutable kalırken yeniden alınmış daha yüksek task fence kabul eder', async () => {
    const test = fixture();
    test.state.loadTaskLease = vi.fn(async () => ({ owner: 'scheduler:one', fence: '10' }));
    await expect(new DurableExecutorAccess(test.state).assertAuthorized({ ...test.input, leaseFence: 10 })).resolves.toBeUndefined();
    expect(test.attempt.leaseFence).toBe(9);
  });

  it('stale task attempt veya durumunu LEASE_REQUIRED ile reddeder', async () => {
    const test = fixture();
    test.state.loadTask = vi.fn(async () => ({
      ...test.task,
      assignmentAttemptId: id(),
    }));
    await expect(new DurableExecutorAccess(test.state).assertAuthorized(test.input))
      .rejects.toMatchObject({ code: 'LEASE_REQUIRED' });
    expect(test.state.loadFileLockOwner).not.toHaveBeenCalled();
  });

  // Görev kilidi operasyon mutex'idir: assignment/transition/causal onu kısa
  // süreli alıp bırakır. "Kilit hâlâ bu attempt'in olmalı" kuralı mimariye
  // aykırıydı ve HER araç çağrısını düşürüyordu.
  it.each([
    null,
    { owner: 'transition:abc', fence: '9' },
    { owner: 'scheduler:one', fence: '8' },
  ])('kilit tutulmuyorsa veya daha düşük fence’teyse izin verir: %j', async (lease) => {
    const test = fixture();
    test.state.loadTaskLease = vi.fn(async () => lease);
    await expect(new DurableExecutorAccess(test.state).assertAuthorized(test.input))
      .resolves.toBeUndefined();
  });

  // Devralma koruması: daha yüksek fence, başka bir tarafın görevi aldığını
  // gösterir; bu attempt artık yazmamalıdır.
  it('daha yüksek fence devraldıysa reddeder', async () => {
    const test = fixture();
    test.state.loadTaskLease = vi.fn(async () => ({ owner: 'assignment:next', fence: '11' }));
    await expect(new DurableExecutorAccess(test.state).assertAuthorized(test.input))
      .rejects.toMatchObject({ code: 'LEASE_REQUIRED' });
  });

  it.each([null, id()])(
    'eksik veya yabancı file lock sahibini reddeder: %s',
    async (owner) => {
      const test = fixture();
      test.state.loadFileLockOwner = vi.fn(async () => owner);
      await expect(new DurableExecutorAccess(test.state).assertAuthorized(test.input))
        .rejects.toMatchObject({ code: 'LOCK_REQUIRED' });
    },
  );

  it('read-only tool için file lock okumaz ama current fence’i yine zorlar', async () => {
    const test = fixture();
    const input = { ...test.input, requireFileLock: false, relativePath: undefined };
    await new DurableExecutorAccess(test.state).assertAuthorized(input);
    expect(test.state.loadFileLockOwner).not.toHaveBeenCalled();
  });
});
