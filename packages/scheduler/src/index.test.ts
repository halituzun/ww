import { describe, expect, it } from 'vitest';

describe('@ww/scheduler exports', () => {
  it('Phase 4 servislerini paket sinirindan sunar', async () => {
    const scheduler = await import('./index.js');
    expect(scheduler.TaskTransitionService).toBeTypeOf('function');
    expect(scheduler.TaskCausalLog).toBeTypeOf('function');
    expect(scheduler.TaskBriefService).toBeTypeOf('function');
    expect(scheduler.AssignmentService).toBeTypeOf('function');
    expect(scheduler.SchedulerWorker).toBeTypeOf('function');
  });
});
