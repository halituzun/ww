import { describe, expect, it } from 'vitest';
import { resumePhase1Orchestrator, runPhase1Orchestrator, type Phase1SchedulerPort, type Phase1RuntimePort } from './phase1-orchestrator.js';

const id = (n: number): string => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const attempt = (n: number) => ({ assignmentAttemptId: id(n), projectId: id(1), taskId: id(2), taskBriefId: id(3), attemptNumber: n, workerAgentId: id(10 + n), verifierAgentId: id(20 + n), leaseOwner: `worker-${n}`, leaseFence: n, leaseExpiresAt: '2030-01-01T00:00:00.000Z', startReason: n === 1 ? 'initial' : 'retry_after_rejection', ...(n === 1 ? {} : { previousAttemptId: id(n - 1) }), assignedAt: '2029-01-01T00:00:00.000Z' } as never);
const brief = { taskId: id(2), projectId: id(1) } as never;
const verdict = (decision: 'approve' | 'reject') => ({ decision, reasons: [{ message: decision, evidenceRefs: ['diff'] }], evidenceRefs: ['diff'], ruleRefs: [{ ruleId: 'TASK-001', ruleVersion: 1 }] });

function scheduler(overrides: Partial<Phase1SchedulerPort> = {}): Phase1SchedulerPort & { calls: string[] } {
  const calls: string[] = [];
  let count = 0;
  return {
    calls,
    assign: async () => attempt(++count),
    awaitUserAnswer: async () => { calls.push('waiting_user'); },
    resumeUserAnswer: async () => attempt(++count),
    handleExecutionError: async () => { calls.push('error'); return 'escalated'; },
    transition: async ({ action }) => { calls.push(action); return { status: 'working' }; },
    reassign: async ({ reason }) => { calls.push(reason); return attempt(++count); },
    escalate: async () => { calls.push('escalated'); },
    gate: async () => { calls.push('gate'); return { passed: true, evidenceRefs: ['gate'] }; },
    commit: async () => { calls.push('commit'); return { commitHash: 'abc1234' }; },
    ...overrides,
  };
}

describe('Phase 1 orchestrator', () => {
  it('question sonrası waiting_user ile durur, aynı attempti sürdürmez', async () => {
    const s = scheduler();
    const runtime: Phase1RuntimePort = { work: async () => ({ kind: 'question', question: 'hangi klasör?' }), verify: async () => { throw new Error('verify çağrılmamalı'); } };
    const result = await runPhase1Orchestrator({ taskId: id(2), brief, scheduler: s, runtime });
    expect(result).toMatchObject({ status: 'waiting_user', attempts: 1 });
    expect(s.calls).toEqual(['start_work', 'waiting_user']);
  });

  it('ret sonrası yeni attempt ile düzeltme yapıp temiz terminale ulaşır', async () => {
    const s = scheduler();
    let run = 0;
    const runtime: Phase1RuntimePort = { work: async () => ({ kind: 'report', summary: 'ok' }), verify: async () => ({ verdict: verdict(++run === 1 ? 'reject' : 'approve'), diff: 'diff' }) };
    const result = await runPhase1Orchestrator({ taskId: id(2), brief, scheduler: s, runtime });
    expect(result).toMatchObject({ status: 'done', attempts: 2, commitHash: 'abc1234' });
    expect(s.calls).toContain('retry_after_rejection');
  });

  it('üçüncü kalıcı ret sonrası escalated olur', async () => {
    const s = scheduler();
    const runtime: Phase1RuntimePort = { work: async () => ({ kind: 'report', summary: 'bad' }), verify: async () => ({ verdict: verdict('reject'), diff: 'diff' }) };
    const result = await runPhase1Orchestrator({ taskId: id(2), brief, scheduler: s, runtime });
    expect(result).toMatchObject({ status: 'escalated', attempts: 3 });
    expect(s.calls.filter((x) => x === 'escalated')).toHaveLength(1);
  });

  it('gate failure yeni attempt ile yeniden çalışır', async () => {
    let gates = 0;
    const s = scheduler({ gate: async () => ({ passed: ++gates > 1, evidenceRefs: ['gate'] }) });
    const runtime: Phase1RuntimePort = { work: async () => ({ kind: 'report', summary: 'ok' }), verify: async () => ({ verdict: verdict('approve'), diff: 'diff' }) };
    const result = await runPhase1Orchestrator({ taskId: id(2), brief, scheduler: s, runtime });
    expect(result.status).toBe('done');
    expect(s.calls).toContain('retry_after_gate_failure');
  });

  it('question → exact answer → fresh attempt resume akışını çalıştırır', async () => {
    const s = scheduler();
    const runtime: Phase1RuntimePort = { work: async () => ({ kind: 'report', summary: 'cevap sonrası tamam' }), verify: async () => ({ verdict: verdict('approve'), diff: 'diff' }) };
    const result = await resumePhase1Orchestrator({ taskId: id(2), brief, scheduler: s, runtime, replyMessageId: id(50), questionMessageId: id(49), previousAttemptId: id(4), answer: 'src', maxAttempts: 3 });
    expect(result.status).toBe('done');
    expect(s.calls[0]).toBe('start_work');
  });

  it('soru mesajının kendisini cevap veya boş cevabı resume olarak kabul etmez', async () => {
    const s = scheduler();
    const runtime: Phase1RuntimePort = { work: async () => ({ kind: 'report', summary: 'unused' }), verify: async () => ({ verdict: verdict('approve'), diff: 'diff' }) };
    await expect(resumePhase1Orchestrator({ taskId: id(2), brief, scheduler: s, runtime, replyMessageId: id(49), questionMessageId: id(49), previousAttemptId: id(4), answer: 'cevap' })).rejects.toThrow('aynı olamaz');
    await expect(resumePhase1Orchestrator({ taskId: id(2), brief, scheduler: s, runtime, replyMessageId: id(50), questionMessageId: id(49), previousAttemptId: id(4), answer: ' ' })).rejects.toThrow('boş');
  });

  it('runtime/verifier hatasını scheduler recovery portuna bırakmaz', async () => {
    const s = scheduler({ handleExecutionError: async () => 'failed' });
    const runtime: Phase1RuntimePort = { work: async () => ({ kind: 'report', summary: 'ok' }), verify: async () => { throw new Error('provider uncertain'); } };
    const result = await runPhase1Orchestrator({ taskId: id(2), brief, scheduler: s, runtime });
    expect(result.status).toBe('failed');
    expect(s.calls).toContain('report_result');
  });
});
