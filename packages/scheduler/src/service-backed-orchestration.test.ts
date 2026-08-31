import { describe, expect, it, vi } from 'vitest';
import { ClickHouseSchedulerArtifactPersistence, createServiceBackedSchedulerPort, type ServiceBackedSchedulerInput } from './service-backed-orchestration.js';
import { SchedulerOrchestrationPortAdapter } from './orchestration-port.js';

const id = (n: number): string => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const attempt = { assignmentAttemptId: id(4) } as never;
const base = (): ServiceBackedSchedulerInput['base'] => ({
  assign: vi.fn(async () => attempt),
  awaitUserAnswer: vi.fn(async () => undefined),
  resumeUserAnswer: vi.fn(async () => attempt),
  handleExecutionError: vi.fn(async () => 'failed'),
  transition: vi.fn(async () => ({ status: 'working' })),
  reassign: vi.fn(async () => attempt),
  escalate: vi.fn(async () => undefined),
  gate: vi.fn(async () => ({ passed: false, evidenceRefs: [] })),
  commit: vi.fn(async () => ({ commitHash: 'base', artifactIds: [] })),
});

function input(): ServiceBackedSchedulerInput {
  return {
    base: base(),
    fence: { assertCurrent: vi.fn(async () => undefined) },
    gate: { run: vi.fn(async () => ({ passed: true, evidenceRefs: ['gate'], eventId: id(5) })) },
    commit: { commit: vi.fn(async () => ({ commitHash: 'abc1234', artifactIds: [id(6)], eventId: id(7) })) },
    artifacts: { appendGate: vi.fn(async () => undefined), appendCommit: vi.fn(async () => undefined) },
  };
}

describe('service-backed scheduler operations', () => {
  it('fence → gate → durable gate evidence sırasını korur', async () => {
    const value = input();
    const port = createServiceBackedSchedulerPort(value);
    const result = await port.gate({ taskId: id(2), attempt });
    expect(result.passed).toBe(true);
    expect(value.fence.assertCurrent).toHaveBeenCalledOnce();
    expect(value.artifacts.appendGate).toHaveBeenCalledWith(expect.objectContaining({ taskId: id(2), passed: true, eventId: id(5) }));
  });

  it('fence → commit → artifact/commit evidence sırasını korur', async () => {
    const value = input();
    const port = createServiceBackedSchedulerPort(value);
    const result = await port.commit({ taskId: id(2), attempt });
    expect(result.commitHash).toBe('abc1234');
    expect(value.fence.assertCurrent).toHaveBeenCalledOnce();
    expect(value.artifacts.appendCommit).toHaveBeenCalledWith(expect.objectContaining({ commitHash: 'abc1234', artifactIds: [id(6)] }));
  });

  it('fence reddederse gate/commit veya persistence çalışmaz', async () => {
    const value = input();
    value.fence.assertCurrent = vi.fn(async () => { throw new Error('STALE_FENCE'); });
    const port = createServiceBackedSchedulerPort(value);
    await expect(port.gate({ taskId: id(2), attempt })).rejects.toThrow('STALE_FENCE');
    expect(value.gate.run).not.toHaveBeenCalled();
    expect(value.artifacts.appendGate).not.toHaveBeenCalled();
  });

  it('class tabanlı base scheduler metodlarını wrapper boyunca korur', async () => {
    const value = input();
    const classBase = new SchedulerOrchestrationPortAdapter(value.base);
    const port = createServiceBackedSchedulerPort({ ...value, base: classBase });
    await expect(port.assign(id(2))).resolves.toEqual(attempt);
    expect(value.base.assign).toHaveBeenCalledOnce();
  });

  it('lease scope taze attempti evidence persistence katmanına kadar taşır', async () => {
    const value = input();
    const freshAttempt = { ...attempt, leaseFence: 10 } as never;
    value.leaseScope = { run: vi.fn(async (_input, operation) => operation(freshAttempt)) };
    const port = createServiceBackedSchedulerPort(value);
    await port.commit({ taskId: id(2), attempt });
    expect(value.artifacts.appendCommit).toHaveBeenCalledWith(expect.objectContaining({ attempt: freshAttempt }));
  });

  it('repository persistence adapter gate event ve commit artifact/event zincirini yazar', async () => {
    const artifacts: unknown[] = [];
    const events: unknown[] = [];
    const persistence = new ClickHouseSchedulerArtifactPersistence({} as never, { now: () => '2029-01-01T00:00:00.000Z' }, {
      appendArtifact: async (value) => { artifacts.push(value); },
      appendEvent: async (value) => { events.push(value); },
    });
    await persistence.appendGate({ taskId: id(2), attempt, passed: true, evidenceRefs: ['gate'] });
    await persistence.appendCommit({ taskId: id(2), attempt, commitHash: 'abc1234', artifactIds: [id(6)] });
    expect(events).toHaveLength(2);
    expect(artifacts).toHaveLength(1);
    expect((events[0] as { event_type: string }).event_type).toBe('test_run');
    expect((events[1] as { event_type: string }).event_type).toBe('commit');
  });
});
