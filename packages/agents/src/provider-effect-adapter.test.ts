import { describe, expect, it } from 'vitest';
import { ProviderError } from '@ww/providers';
import { DurableEffectExecutionError } from './errors.js';
import { DurableProviderInvocationEffect } from './provider-effect-adapter.js';

const meta = {
  projectId: '10000000-0000-4000-8000-000000000001',
  agentId: '10000000-0000-4000-8000-000000000002',
  taskId: '10000000-0000-4000-8000-000000000003',
  purpose: 'completion' as const,
  invocationId: '10000000-0000-4000-8000-000000000004',
  taskBriefId: '10000000-0000-4000-8000-000000000005',
  assignmentAttemptId: '10000000-0000-4000-8000-000000000006',
  promptInputSnapshotId: '10000000-0000-4000-8000-000000000007',
};

function request() { return { model: 'm', messages: [{ role: 'user' as const, content: 'x' }], meta }; }

describe('DurableProviderInvocationEffect', () => {
  it('retryable provider hatasını typed olarak geri verir', async () => {
    const runner = { run: async <T>(input: { execute: () => Promise<T> }) => {
      try { return await input.execute(); } catch (error) {
        if (error instanceof DurableEffectExecutionError) throw error;
        throw error;
      }
    } };
    const effect = new DurableProviderInvocationEffect(runner as never, {
      sessionId: meta.projectId, owningPmId: meta.agentId,
    });
    await expect(effect.run({
      invocationId: meta.invocationId, fallbackAttempt: 0, modelRef: 'x:m', request: request(),
      execute: async () => { throw new ProviderError('server', 'server'); },
    })).rejects.toBeInstanceOf(ProviderError);
  });

  it('belirsiz sonucu provider tekrarına dönüştürmez', async () => {
    const runner = { run: async <T>(input: { execute: () => Promise<T> }) => input.execute() };
    const effect = new DurableProviderInvocationEffect(runner as never, {
      sessionId: meta.projectId, owningPmId: meta.agentId,
    });
    await expect(effect.run({
      invocationId: meta.invocationId, fallbackAttempt: 0, modelRef: 'x:m', request: request(),
      execute: async () => { throw new Error('response lost'); },
    })).rejects.toThrow('response lost');
  });

  it('reconciliation evidenceini durable runnera verir', async () => {
    const requests: unknown[] = [];
    const runner = { run: async <T>(input: { request: unknown; execute: () => Promise<T> }) => {
      requests.push(input.request); return input.execute();
    } };
    const effect = new DurableProviderInvocationEffect(runner as never, {
      sessionId: meta.projectId, owningPmId: meta.agentId,
    });
    await effect.reconcile!({
      invocationId: meta.invocationId, modelRef: 'x:m', request: request(),
      error: new Error('sink'), usage: { promptTokens: 3, completionTokens: 2 }, latencyMs: 7,
    });
    expect(requests[0]).toMatchObject({ modelRef: 'x:m', usage: { promptTokens: 3, completionTokens: 2 }, latencyMs: 7 });
  });
});
