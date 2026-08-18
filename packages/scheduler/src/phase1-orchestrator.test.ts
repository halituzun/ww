import { describe, expect, it } from 'vitest';
import { resumePhase1Orchestrator, runPhase1Orchestrator, type Phase1SchedulerPort, type Phase1RuntimePort } from './phase1-orchestrator.js';
import { BrakeError } from './safety-brakes.js';

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

  // Doğrulayıcının GEREKÇESİ worker'a ulaşmalı. Ulaşmıyordu: orkestratör
  // yalnızca evidenceRefs geçiyor, geçiş katmanı da sebebi bulamayınca sabit
  // "verifier işi reddetti" yazıyordu. Yani reddedilen worker neyi
  // düzelteceğini asla öğrenemiyor, aynı işi tekrar üretiyordu.
  it('doğrulayıcının gerekçesini geçişe tasir', async () => {
    const seen: (string | undefined)[] = [];
    const s = scheduler({
      transition: async ({ action, resultSummary }) => {
        if (action === 'verifier_rejected') seen.push(resultSummary);
        return { status: 'working' };
      },
    });
    let run = 0;
    const runtime: Phase1RuntimePort = {
      work: async () => ({ kind: 'report', summary: 'ok' }),
      verify: async () => ({
        verdict: run++ === 0
          ? {
            decision: 'reject' as const,
            reasons: [
              { message: 'testler eksik: Board.test.tsx yok', evidenceRefs: ['diff'] },
              { message: 'MVVM ihlali: mantık View içinde', evidenceRefs: ['diff'] },
            ],
            evidenceRefs: ['diff'],
            ruleRefs: [{ ruleId: 'TASK-001', ruleVersion: 1 }],
          }
          : verdict('approve'),
        diff: 'diff',
      }),
    };

    await runPhase1Orchestrator({ taskId: id(2), brief, scheduler: s, runtime });

    expect(seen).toHaveLength(1);
    // HER gerekçe taşınır: yalnız ilkini almak diğer ihlalleri gizler ve
    // worker tek tek düzelterek denemelerini tüketir.
    expect(seen[0]).toContain('Board.test.tsx');
    expect(seen[0]).toContain('MVVM ihlali');
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
    // resumeUserAnswer returns a fresh attempt already activated as working;
    // the resumed lifecycle must not emit a duplicate start_work transition.
    expect(s.calls[0]).toBe('report_result');
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

describe('güvenlik frenleri', () => {
  const runtime: Phase1RuntimePort = {
    work: async () => ({ kind: 'report', summary: 'ok' }),
    verify: async () => ({ verdict: verdict('approve'), diff: '' } as never),
  };

  // docs/07: her fren tetiklenişi tırmandırmaya gider. Fren bağlı değilse
  // kaçak döngü ve bütçe aşımı hiçbir şey tarafından durdurulmaz.
  it('fren tetiklenirse iş başlamadan tırmandırır', async () => {
    const s = scheduler();
    const result = await runPhase1Orchestrator({
      taskId: id(2), brief, scheduler: s, runtime,
      brakes: async () => { throw new BrakeError('cost_budget', 'maliyet butcesi asildi'); },
    });

    expect(result.status).toBe('escalated');
    // Fren iş BAŞLAMADAN devreye girmeli; para/token harcanmamalı.
    expect(s.calls).not.toContain('start_work');
    expect(s.calls).toContain('escalated');
  });

  it('tırmandırma gerekçesi fren türünü taşır', async () => {
    let reason = '';
    const s = scheduler({ escalate: async ({ reason: r }) => { reason = r; } });
    await runPhase1Orchestrator({
      taskId: id(2), brief, scheduler: s, runtime,
      brakes: async () => { throw new BrakeError('loop_similarity', 'kacak dongu'); },
    });
    expect(reason).toMatch(/loop_similarity/);
  });

  it('fren her denemede yeniden kontrol edilir', async () => {
    const seen: number[] = [];
    const s = scheduler();
    let run = 0;
    await runPhase1Orchestrator({
      taskId: id(2), brief, scheduler: s,
      runtime: { work: async () => ({ kind: 'report', summary: 'x' }), verify: async () => ({ verdict: verdict(++run === 1 ? 'reject' : 'approve'), diff: '' } as never) },
      brakes: async ({ attemptNumber }) => { seen.push(attemptNumber); },
    });
    expect(seen).toEqual([1, 2]);
  });

  it('fren yoksa davranış değişmez', async () => {
    const s = scheduler();
    const result = await runPhase1Orchestrator({ taskId: id(2), brief, scheduler: s, runtime });
    expect(result.status).toBe('done');
  });

  // Fren dışı hata yutulmamalı; normal hata yoluna gitmeli.
  it('fren kontrolündeki beklenmedik hata BrakeError gibi davranmaz', async () => {
    const s = scheduler();
    const result = await runPhase1Orchestrator({
      taskId: id(2), brief, scheduler: s, runtime,
      brakes: async () => { throw new Error('veritabanı düştü'); },
    });
    expect(s.calls).toContain('error');
    expect(result.status).toBe('escalated');
  });
});

// ASIL KUSUR: çağıran taraf brief'i kendi mühürlüyordu ama İLK ATAMA kendi
// brief'ini mühürler (agent'ların prompt sürümleri + kendi cutoff'u ile).
// İkisi asla aynı olamaz; worker raporu "task brief uyusmuyor" ile
// reddediliyor ve HİÇBİR görev çalışamıyordu.
describe('runPhase1Orchestrator brief kaynağı', () => {
  const attempt = {
    assignmentAttemptId: '00000000-0000-4000-8000-000000000009',
    projectId: '00000000-0000-4000-8000-000000000001',
    taskId: '00000000-0000-4000-8000-000000000002',
    taskBriefId: '00000000-0000-4000-8000-00000000000b',
  } as never;

  const scheduler = (over: Record<string, unknown> = {}) => ({
    assign: async () => attempt,
    transition: async () => ({ status: 'working' }),
    handleExecutionError: async () => 'failed',
    escalate: async () => undefined,
    gate: async () => ({ passed: true, evidenceRefs: [] }),
    commit: async () => ({ commitHash: 'abc1234' }),
    awaitUserAnswer: async () => undefined,
    reassign: async () => attempt,
    resumeUserAnswer: async () => attempt,
    ...over,
  }) as never;

  it('loadBrief verilirse atamanın brief’ini kullanır', async () => {
    const bound = { taskId: '00000000-0000-4000-8000-000000000002', marker: 'atamanın' } as never;
    const seen: unknown[] = [];

    await runPhase1Orchestrator({
      taskId: '00000000-0000-4000-8000-000000000002' as never,
      brief: { taskId: 'çağıranın', marker: 'çağıranın' } as never,
      loadBrief: async () => bound,
      scheduler: scheduler(),
      runtime: {
        work: async (input: { brief: unknown }) => { seen.push(input.brief); return { kind: 'report', summary: 'ok' }; },
        verify: async () => ({ verdict: { approved: true, evidenceRefs: [] }, diff: '' }),
      } as never,
      maxAttempts: 1,
    });

    expect(seen[0]).toBe(bound);
  });

  it('loadBrief yoksa çağıranın brief’i kullanılır', async () => {
    const caller = { taskId: '00000000-0000-4000-8000-000000000002' } as never;
    const seen: unknown[] = [];

    await runPhase1Orchestrator({
      taskId: '00000000-0000-4000-8000-000000000002' as never,
      brief: caller,
      scheduler: scheduler(),
      runtime: {
        work: async (input: { brief: unknown }) => { seen.push(input.brief); return { kind: 'report', summary: 'ok' }; },
        verify: async () => ({ verdict: { approved: true, evidenceRefs: [] }, diff: '' }),
      } as never,
      maxAttempts: 1,
    });

    expect(seen[0]).toBe(caller);
  });

  // Brief yüklenemezse sessizce çağıranınkine düşmek, uyuşmazlığı geri getirir.
  it('loadBrief düşerse hata yutulmaz', async () => {
    const result = await runPhase1Orchestrator({
      taskId: '00000000-0000-4000-8000-000000000002' as never,
      brief: {} as never,
      loadBrief: async () => { throw new Error('brief okunamadı'); },
      scheduler: scheduler(),
      runtime: { work: async () => ({ kind: 'report', summary: 'ok' }), verify: async () => ({}) } as never,
      maxAttempts: 1,
    });
    expect(result.status).toBe('failed');
  });
});
