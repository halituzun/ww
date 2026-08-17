import { describe, expect, it, vi } from 'vitest';
import { createTransitionOperation, type TransitionApplyPort } from './transition-operation.js';

const id = (n: number): string => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;

const attempt = {
  assignmentAttemptId: id(4), projectId: id(1), taskId: id(2), taskBriefId: id(3),
  attemptNumber: 1, workerAgentId: id(5), verifierAgentId: id(6),
} as never;

function port(): TransitionApplyPort & { requests: Record<string, unknown>[] } {
  const requests: Record<string, unknown>[] = [];
  return {
    requests,
    apply: vi.fn(async (_principal, request) => {
      requests.push(request as Record<string, unknown>);
      return { status: 'working' } as never;
    }),
  };
}

const run = async (p: TransitionApplyPort, action: string, extra: Record<string, unknown> = {}) => {
  const transition = createTransitionOperation({ port: p, principalName: 'scheduler' });
  return transition({ taskId: id(2), attempt, action, ...extra } as never);
};

describe('createTransitionOperation', () => {
  it('start_work isteğini kimlik alanlarıyla kurar', async () => {
    const p = port();
    await run(p, 'start_work');
    expect(p.requests[0]).toMatchObject({
      action: 'start_work', projectId: id(1), taskId: id(2),
      taskBriefId: id(3), assignmentAttemptId: id(4), protocolVersion: 1,
    });
  });

  it('report_result için özet ve kanıt taşır', async () => {
    const p = port();
    await run(p, 'report_result', { resultSummary: 'bitti', evidenceRefs: ['diff'] });
    expect(p.requests[0]).toMatchObject({
      action: 'report_result', resultSummary: 'bitti', evidenceRefs: ['diff'],
    });
  });

  // Şema boş özet kabul etmez; orkestratör boş gönderirse istek en azından
  // geçerli olmalı, yoksa geçiş sessizce reddedilir.
  it('boş özet yerine anlamlı yer tutucu koyar', async () => {
    const p = port();
    await run(p, 'report_result', { resultSummary: '   ' });
    expect(String((p.requests[0] as { resultSummary: string }).resultSummary).trim().length)
      .toBeGreaterThan(0);
  });

  it('verifier_approved için verdict mesaj kimliği üretir', async () => {
    const p = port();
    await run(p, 'verifier_approved', { evidenceRefs: ['verdict'] });
    expect(p.requests[0]).toMatchObject({ action: 'verifier_approved' });
    expect(typeof (p.requests[0] as { verdictMessageId: string }).verdictMessageId).toBe('string');
  });

  it('commit_completed için commit hash ve artifact listesi taşır', async () => {
    const p = port();
    await run(p, 'commit_completed', { evidenceRefs: ['abc1234'] });
    expect(p.requests[0]).toMatchObject({
      action: 'commit_completed', commitHash: 'abc1234', artifactIds: [],
    });
  });

  // Şema 7-64 hex bekler; kanıt referansı commit hash değilse geçiş reddedilirdi.
  it('geçersiz commit hash’i reddeder', async () => {
    const p = port();
    await expect(run(p, 'commit_completed', { evidenceRefs: ['bu-hash-degil'] }))
      .rejects.toThrow(/commit/i);
  });

  it('fail için gerekçe taşır', async () => {
    const p = port();
    await run(p, 'fail');
    expect(p.requests[0]).toMatchObject({ action: 'fail' });
    expect(String((p.requests[0] as { reason: string }).reason).length).toBeGreaterThan(0);
  });

  it('gate_passed ek alan taşımaz', async () => {
    const p = port();
    await run(p, 'gate_passed');
    expect(p.requests[0]).not.toHaveProperty('reason');
    expect(p.requests[0]).toMatchObject({ action: 'gate_passed' });
  });

  it('servisin döndürdüğü durumu geçirir', async () => {
    const p = port();
    await expect(run(p, 'start_work')).resolves.toEqual({ status: 'working' });
  });

  it('desteklenmeyen action’ı sessizce geçirmez', async () => {
    const p = port();
    await expect(run(p, 'uydurma_action')).rejects.toThrow(/action/i);
  });

  // Her istek benzersiz kimlik taşımalı; aksi halde iki geçiş çakışır.
  it('her istek için benzersiz transitionRequestId üretir', async () => {
    const p = port();
    await run(p, 'start_work');
    await run(p, 'gate_passed');
    const first = (p.requests[0] as { transitionRequestId: string }).transitionRequestId;
    const second = (p.requests[1] as { transitionRequestId: string }).transitionRequestId;
    expect(first).not.toBe(second);
  });
});
