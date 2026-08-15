import { describe, expect, it } from 'vitest';
import type { PrincipalAuthentication } from '@ww/agents';
import type { EntityId } from '@ww/shared';
import type { Phase1RuntimePort, Phase1SchedulerPort } from '@ww/scheduler';
import { createPhase8RuntimeComposition } from './runtime-composition.js';

const id = (n: number): EntityId => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}` as EntityId;

describe('Phase 8 server composition', () => {
  it('durable runtime ve orchestrator köprüsünü no-op olmadan çalıştırır', async () => {
    const calls: string[] = [];
    const scheduler: Phase1SchedulerPort = {
      assign: async () => ({ assignmentAttemptId: id(4) } as never),
      awaitUserAnswer: async () => undefined,
      resumeUserAnswer: async () => ({ assignmentAttemptId: id(5) } as never),
      handleExecutionError: async () => 'failed',
      transition: async ({ action }) => { calls.push(action); return { status: 'working' }; },
      reassign: async () => ({ assignmentAttemptId: id(6) } as never),
      escalate: async () => undefined,
      gate: async () => ({ passed: true, evidenceRefs: ['gate'] }),
      commit: async () => ({ commitHash: 'abc123' }),
    };
    const orchestrationRuntime: Phase1RuntimePort = {
      work: async () => ({ kind: 'report', summary: 'smoke' }),
      verify: async () => ({
        verdict: { decision: 'approve', reasons: [], evidenceRefs: [], ruleRefs: [] },
        diff: '',
      }),
    };
    const auth: PrincipalAuthentication = {
      type: 'internal_service', credential: 'scheduler-token', issuedAt: '2026-08-15T00:00:00.000Z',
    };
    const composition = createPhase8RuntimeComposition({
      ch: Object.create(null) as never,
      redis: Object.create(null) as never,
      providers: new Map(),
      fallbacks: () => [],
      communication: Object.create(null) as never,
      internalAuthentication: auth,
      providerContext: { sessionId: id(1), owningPmId: id(2) },
      usageSink: async () => undefined,
      scheduler,
      orchestrationRuntime,
    });
    const result = await composition.orchestrate({ taskId: id(3), brief: { taskId: id(3) } as never });
    expect(composition.runtime).toBeDefined();
    expect(composition.router).toBeDefined();
    expect(result).toMatchObject({ status: 'done', commitHash: 'abc123' });
    expect(calls).toEqual(['start_work', 'report_result', 'verifier_approved', 'gate_passed', 'commit_completed']);
  });
});
