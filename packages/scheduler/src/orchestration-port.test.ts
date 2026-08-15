import { describe, expect, it, vi } from 'vitest';
import { SchedulerOrchestrationPortAdapter, type SchedulerOrchestrationOperations } from './orchestration-port.js';

const operations = (): SchedulerOrchestrationOperations => ({
  assign: vi.fn(async () => ({}) as never),
  awaitUserAnswer: vi.fn(async () => undefined),
  resumeUserAnswer: vi.fn(async () => ({}) as never),
  handleExecutionError: vi.fn(async () => 'failed'),
  transition: vi.fn(async () => ({ status: 'working' })),
  reassign: vi.fn(async () => ({}) as never),
  escalate: vi.fn(async () => undefined),
  gate: vi.fn(async () => ({ passed: true, evidenceRefs: [] })),
  commit: vi.fn(async () => ({ commitHash: 'abc1234' })),
});

describe('SchedulerOrchestrationPortAdapter', () => {
  it('typed operationsı birebir yönlendirir, kendi FSM veya DB yazımını yapmaz', async () => {
    const source = operations();
    const adapter = new SchedulerOrchestrationPortAdapter(source);
    await adapter.assign('00000000-0000-4000-8000-000000000001');
    await adapter.gate({ taskId: '00000000-0000-4000-8000-000000000001', attempt: {} as never });
    await adapter.commit({ taskId: '00000000-0000-4000-8000-000000000001', attempt: {} as never });
    expect(source.assign).toHaveBeenCalledOnce();
    expect(source.gate).toHaveBeenCalledOnce();
    expect(source.commit).toHaveBeenCalledOnce();
  });

  it('eksik operasyonu no-op olarak kabul etmez', () => {
    expect(() => new SchedulerOrchestrationPortAdapter({} as never)).toThrow('operation eksik');
  });
});
