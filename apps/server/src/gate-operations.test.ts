import { describe, expect, it, vi } from 'vitest';
import { createGateOperations, type GateRunnerLike, type GitWorkspaceLike } from './gate-operations.js';

const id = (n: number): string => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;

const attempt = {
  assignmentAttemptId: id(4), projectId: id(1), taskId: id(2), taskBriefId: id(3),
  attemptNumber: 1, workerAgentId: id(5), verifierAgentId: id(6),
} as never;

const details = async () => ({
  title: 'Satranç tahtası bileşeni',
  summary: 'tahta çizimi eklendi',
  targetFiles: ['src/Board.tsx'],
  workerName: 'Worker-Coding-1',
  verifierName: 'Verifier-1',
});

function fakes(over: { passed?: boolean } = {}) {
  const gateRunner: GateRunnerLike = {
    // GateEvidence'ın GERÇEK şekli: evidenceRefs diye bir alan yoktur.
    run: vi.fn(async () => ({
      passed: over.passed ?? true,
      configPath: 'ww.gate.json',
      steps: [{ name: 'typecheck', passed: over.passed ?? true, exitCode: over.passed === false ? 1 : 0 }],
    })),
  };
  const git: GitWorkspaceLike = {
    commitAfterSuccessfulGate: vi.fn(async () => ({ commitHash: 'abc1234def' })),
  };
  return { gateRunner, git };
}

describe('createGateOperations', () => {
  // Composition gateRunner'ı kendi içinde kurar; operasyonlar ona ancak
  // composition oluştuktan SONRA bağlanabilir. Bağlanmadan çağrı, sessiz
  // undefined çökmesi yerine açık hata vermeli.
  it('bağlanmadan çağrılırsa açık hata verir', async () => {
    const ops = createGateOperations({ workspaceRoot: '/w', taskDetails: details });
    await expect(ops.gate({ taskId: id(2), attempt })).rejects.toThrow(/bağlanmad/i);
    await expect(ops.commit({ taskId: id(2), attempt })).rejects.toThrow(/bağlanmad/i);
  });

  it('kapı sonucunu ve kanıtları geçirir', async () => {
    const { gateRunner, git } = fakes();
    const ops = createGateOperations({ workspaceRoot: '/w', taskDetails: details });
    ops.bind({ gateRunner, git, workspace: { initialize: async () => undefined } as never });

    await expect(ops.gate({ taskId: id(2), attempt }))
      .resolves.toEqual({
        passed: true,
        evidenceRefs: ['gate_config:ww.gate.json', 'gate_step:typecheck:passed:0'],
      });
  });

  it('kapı düşerse passed=false döner', async () => {
    const { gateRunner, git } = fakes({ passed: false });
    const ops = createGateOperations({ workspaceRoot: '/w', taskDetails: details });
    ops.bind({ gateRunner, git, workspace: { initialize: async () => undefined } as never });
    expect((await ops.gate({ taskId: id(2), attempt })).passed).toBe(false);
  });

  it('commit hash döndürür', async () => {
    const { gateRunner, git } = fakes();
    const ops = createGateOperations({ workspaceRoot: '/w', taskDetails: details });
    ops.bind({ gateRunner, git, workspace: { initialize: async () => undefined } as never });
    expect(await ops.commit({ taskId: id(2), attempt })).toEqual({ commitHash: 'abc1234def' });
  });

  it('commit görev ayrıntılarını ve erişim kapsamını taşır', async () => {
    const { gateRunner, git } = fakes();
    const ops = createGateOperations({ workspaceRoot: '/w', taskDetails: details });
    ops.bind({ gateRunner, git, workspace: { initialize: async () => undefined } as never });
    await ops.commit({ taskId: id(2), attempt });

    const call = (git.commitAfterSuccessfulGate as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0]![1] as Record<string, unknown>;
    expect(call).toMatchObject({
      taskId: id(2), title: 'Satranç tahtası bileşeni', targetFiles: ['src/Board.tsx'],
    });
    // Erişim kapsamı olmadan yazma reddedilir; attempt bağlamı taşınmalı.
    expect(Array.isArray(call['targetAccess'])).toBe(true);
  });

  // Kapı geçmeden commit atmak, doğrulanmamış kodu tarihe yazmaktır.
  it('kapı çalıştırılmadan commit yapılamaz', async () => {
    const { gateRunner, git } = fakes({ passed: false });
    const ops = createGateOperations({
      workspaceRoot: '/w', taskDetails: details, requireGatePass: true,
    });
    ops.bind({ gateRunner, git, workspace: { initialize: async () => undefined } as never });

    await ops.gate({ taskId: id(2), attempt });
    await expect(ops.commit({ taskId: id(2), attempt })).rejects.toThrow(/kapı/i);
  });

  it('kapı geçtiyse commit serbesttir', async () => {
    const { gateRunner, git } = fakes({ passed: true });
    const ops = createGateOperations({
      workspaceRoot: '/w', taskDetails: details, requireGatePass: true,
    });
    ops.bind({ gateRunner, git, workspace: { initialize: async () => undefined } as never });

    await ops.gate({ taskId: id(2), attempt });
    await expect(ops.commit({ taskId: id(2), attempt })).resolves.toMatchObject({ commitHash: 'abc1234def' });
  });
});
