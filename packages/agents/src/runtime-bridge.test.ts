import { describe, expect, it, vi } from 'vitest';
import type { ModelRouter } from '@ww/providers';
import type { AgentRuntime } from './agent-runtime.js';
import { createPhase1RuntimeBridge } from './runtime-bridge.js';

const id = (n: number): string => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const brief = { projectId: id(1), taskId: id(2), taskBriefId: id(3) } as never;
const attempt = { assignmentAttemptId: id(4) } as never;
const snapshot = {} as never;

describe('Phase 1 runtime bridge', () => {
  it('worker resultini scheduler runtime sözleşmesine map eder ve immutable context kullanır', async () => {
    const runtime: AgentRuntime = {
      worker: vi.fn(async () => ({ reason: 'question', turns: 1, question: 'hangi dosya?', questionMessageId: id(9) })),
      verifier: vi.fn(async () => ({ verdict: {} as never, invocationId: id(6) })),
      pm: vi.fn(async () => 'ok'),
    };
    const context = { load: vi.fn(async () => ({ snapshot, workspaceRoot: '/workspace/project', workerModelRef: 'mock:model', verifierModelRef: 'mock:verify' })) };
    const tools = { forWorker: vi.fn(() => ({ definitions: () => [], validate: () => ({}), execute: async () => ({}) })), forVerifier: vi.fn(() => ({ definitions: () => [], validate: () => ({}), execute: async () => ({}) })) };
    const bridge = createPhase1RuntimeBridge({ runtime, router: {} as ModelRouter, context, tools, communication: { question: async () => ({ messageId: id(9) }), report: async () => undefined } });
    const result = await bridge.work({ brief, attempt });
    expect(result).toMatchObject({ kind: 'question', question: 'hangi dosya?', questionMessageId: id(9) });
    expect(runtime.worker).toHaveBeenCalledOnce();
    expect(tools.forWorker).toHaveBeenCalledWith({ brief, attempt, workspaceRoot: '/workspace/project' });
  });

  it('verifier için diffi tool portundan alır ve modeli bağımsız çağırır', async () => {
    const runtime: AgentRuntime = {
      worker: vi.fn(async () => ({ reason: 'report', turns: 1, summary: 'ok' })),
      verifier: vi.fn(async (input) => ({ verdict: {} as never, invocationId: input.snapshot.invocationId })),
      pm: vi.fn(async () => 'ok'),
    };
    const context = { load: vi.fn(async () => ({ snapshot: { invocationId: id(6) } as never, workspaceRoot: '/workspace/project', workerModelRef: 'mock:model', verifierModelRef: 'mock:verify' })) };
    const execute = vi.fn(async () => ({ diff: 'sealed diff' }));
    const tools = { forWorker: vi.fn(() => ({ definitions: () => [], validate: () => ({}), execute })), forVerifier: vi.fn(() => ({ definitions: () => [], validate: () => ({}), execute })) };
    const bridge = createPhase1RuntimeBridge({ runtime, router: {} as ModelRouter, context, tools, communication: { question: async () => ({ messageId: id(9) }), report: async () => undefined } });
    const result = await bridge.verify({ brief, attempt, summary: 'summary' });
    expect(result.diff).toBe('sealed diff');
    expect(execute).toHaveBeenCalledOnce();
    expect(tools.forVerifier).toHaveBeenCalledWith({ brief, attempt, workspaceRoot: '/workspace/project' });
    expect(runtime.verifier).toHaveBeenCalledOnce();
  });
});
