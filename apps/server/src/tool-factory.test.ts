import { describe, expect, it, vi } from 'vitest';
import { VERIFIER_READONLY_TOOLS, createToolPortFactory, type ToolExecutorLike } from './tool-factory.js';

const id = (n: number): string => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;

const brief = {
  projectId: id(1), taskId: id(2), taskBriefId: id(3),
  allowedTools: ['read_file', 'write_file', 'git_diff', 'run_command'],
} as never;

const attempt = {
  assignmentAttemptId: id(4), projectId: id(1), taskId: id(2), taskBriefId: id(3),
  attemptNumber: 1, workerAgentId: id(5), verifierAgentId: id(6),
} as never;

function executor() {
  const calls: { context: Record<string, unknown>; call: Record<string, unknown> }[] = [];
  const impl: ToolExecutorLike = {
    definitions: () => [
      { name: 'read_file', description: '', parameters: {} },
      { name: 'write_file', description: '', parameters: {} },
      { name: 'git_diff', description: '', parameters: {} },
      { name: 'run_command', description: '', parameters: {} },
    ],
    validate: (name, args) => args,
    execute: vi.fn(async (context, call) => {
      calls.push({
        context: context as unknown as Record<string, unknown>,
        call: call as unknown as Record<string, unknown>,
      });
      return { ok: true } as never;
    }),
  };
  return { impl, calls };
}

const factory = (impl: ToolExecutorLike) => createToolPortFactory({
  executor: impl,
  effectEscalation: { sessionId: id(7), owningPmId: id(8) },
});

describe('worker aracı', () => {
  it('brief’teki izinli araçları sunar', () => {
    const port = factory(executor().impl).forWorker({ brief, attempt, workspaceRoot: '/w' });
    expect(port.definitions().map((d) => d.name)).toEqual(
      ['read_file', 'write_file', 'git_diff', 'run_command'],
    );
  });

  it('çağrıyı worker kimliği ve rolüyle çalıştırır', async () => {
    const { impl, calls } = executor();
    const port = factory(impl).forWorker({ brief, attempt, workspaceRoot: '/w' });
    await port.execute({ callId: id(9), name: 'write_file', args: {}, occurredAt: '2026-08-17T00:00:00.000Z' });

    expect(calls[0]!.context).toMatchObject({
      workspaceRoot: '/w', agentId: id(5), agentRole: 'worker',
    });
  });
});

describe('verifier aracı', () => {
  // docs/03: verifier bağımsız denetler; yazma yetkisi olursa denetlediği
  // kodu değiştirebilir ve denetimin anlamı kalmaz.
  it('yalnızca salt-okuma araçlarını sunar', () => {
    const port = factory(executor().impl).forVerifier({ brief, attempt, workspaceRoot: '/w' });
    const names = port.definitions().map((d) => d.name);
    expect(names).toContain('git_diff');
    expect(names).not.toContain('write_file');
    expect(names).not.toContain('run_command');
  });

  it('yazma aracı çağrılırsa reddeder', async () => {
    const { impl } = executor();
    const port = factory(impl).forVerifier({ brief, attempt, workspaceRoot: '/w' });
    await expect(port.execute({
      callId: id(9), name: 'write_file', args: {}, occurredAt: '2026-08-17T00:00:00.000Z',
    })).rejects.toThrow(/salt-okuma|verifier/i);
  });

  it('yazma aracı çağrısı executor’a hiç ulaşmaz', async () => {
    const { impl, calls } = executor();
    const port = factory(impl).forVerifier({ brief, attempt, workspaceRoot: '/w' });
    await port.execute({ callId: id(9), name: 'write_file', args: {}, occurredAt: '2026-08-17T00:00:00.000Z' })
      .catch(() => undefined);
    expect(calls).toHaveLength(0);
  });

  it('çağrıyı verifier kimliği ve rolüyle çalıştırır', async () => {
    const { impl, calls } = executor();
    const port = factory(impl).forVerifier({ brief, attempt, workspaceRoot: '/w' });
    await port.execute({ callId: id(9), name: 'git_diff', args: {}, occurredAt: '2026-08-17T00:00:00.000Z' });
    expect(calls[0]!.context).toMatchObject({ agentId: id(6), agentRole: 'verifier' });
  });

  it('salt-okuma listesi yazma aracı içermez', () => {
    expect(VERIFIER_READONLY_TOOLS).not.toContain('write_file');
    expect(VERIFIER_READONLY_TOOLS).not.toContain('edit_file');
    expect(VERIFIER_READONLY_TOOLS).not.toContain('run_command');
  });
});
// ASIL KUSUR: definitions() ARGÜMANSIZ çağrılıyordu ama ToolExecutor
// bağlam ister (brief/agentRole/taskStatus). ToolExecutorLike'ın yanlış
// imzası uyuşmazlığı derleyiciden gizledi; worker döngüsü ilk adımda
// "Cannot read properties of undefined (reading 'brief')" ile düştü.
describe('tool port definitions bağlamı', () => {
  it('worker için bağlamı executor’a geçirir', () => {
    const seen: unknown[] = [];
    const factory = createToolPortFactory({
      executor: {
        definitions: (context: unknown) => { seen.push(context); return []; },
        validate: () => ({}),
        execute: async () => ({}),
      },
    } as never);

    factory.forWorker({
      brief: { allowedTools: ['read_file'] },
      attempt: { workerAgentId: 'a', verifierAgentId: 'b' },
      workspaceRoot: '/w',
    } as never).definitions();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ agentRole: 'worker', taskStatus: 'working' });
    expect((seen[0] as Record<string, unknown>)['brief']).toBeDefined();
  });

  it('verifier için de bağlamı geçirir', () => {
    const seen: unknown[] = [];
    const factory = createToolPortFactory({
      executor: {
        definitions: (context: unknown) => { seen.push(context); return []; },
        validate: () => ({}),
        execute: async () => ({}),
      },
    } as never);

    factory.forVerifier?.({
      brief: { allowedTools: ['read_file'] },
      attempt: { workerAgentId: 'a', verifierAgentId: 'b' },
      workspaceRoot: '/w',
    } as never).definitions();

    expect(seen[0]).toMatchObject({ agentRole: 'verifier', taskStatus: 'verifying' });
  });
});
