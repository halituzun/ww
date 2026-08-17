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

// ASIL KUSUR: bir worker döngüsü aynı invocation içinde birden çok model
// çağrısı yapar (araç turu, sonra rapor). Anahtar yalnızca invocation+fallback
// olunca ikinci çağrı birincinin anahtarını kullanıyor ve defter
// "effect anahtari farkli istekle kullanildi" ile reddediyordu.
describe('DurableProviderInvocationEffect anahtar ayrımı', () => {
  const runnerSpy = () => {
    const ids: string[] = [];
    return {
      ids,
      runner: {
        run: async (input: { stableEffectId: string; execute: () => Promise<unknown> }) => {
          ids.push(input.stableEffectId);
          return input.execute();
        },
      } as never,
    };
  };

  const meta = {
    projectId: '00000000-0000-4000-8000-000000000001',
    assignmentAttemptId: '00000000-0000-4000-8000-000000000004',
    taskId: '00000000-0000-4000-8000-000000000002',
  };
  const context = {
    sessionId: '00000000-0000-4000-8000-00000000000a',
    owningPmId: '00000000-0000-4000-8000-00000000000b',
  } as never;
  const invocationId = '00000000-0000-4000-8000-000000000007';

  const call = (spy: ReturnType<typeof runnerSpy>, messages: unknown) =>
    new DurableProviderInvocationEffect(spy.runner, context).run({
      invocationId,
      modelRef: 'deepseek:chat',
      fallbackAttempt: 0,
      request: { messages, meta } as never,
      execute: async () => ({ ok: true }),
    } as never);

  it('farklı istekler farklı efekt anahtarı alır', async () => {
    const spy = runnerSpy();
    await call(spy, [{ role: 'user', content: 'ilk tur' }]);
    await call(spy, [{ role: 'user', content: 'ikinci tur' }]);

    expect(spy.ids[0]).not.toBe(spy.ids[1]);
  });

  // Aynı isteğin yeniden denenmesi AYNI anahtarı almalı: idempotency budur.
  it('aynı istek aynı anahtarı alır', async () => {
    const spy = runnerSpy();
    await call(spy, [{ role: 'user', content: 'aynı' }]);
    await call(spy, [{ role: 'user', content: 'aynı' }]);

    expect(spy.ids[0]).toBe(spy.ids[1]);
  });
});
