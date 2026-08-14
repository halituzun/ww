import { describe, expect, it } from 'vitest';
import {
  PromptInputSnapshotV1Schema,
  canonicalSha256V1,
  type ApiUsageRow,
} from '@ww/shared';
import { MockProvider } from './mock.js';
import { ModelRouter } from './router.js';
import { ProviderError, type CompletionMeta, type LlmProvider } from './types.js';

const meta: CompletionMeta = {
  projectId: 'p',
  agentId: 'a',
  taskId: 't',
  purpose: 'completion',
  invocationId: 'invocation-1',
  taskBriefId: 'brief-1',
  assignmentAttemptId: 'attempt-1',
  promptInputSnapshotId: 'snapshot-1',
  fallbackAttempt: 0,
};

function makeRouter(providers: Record<string, LlmProvider>, fallbacks: Record<string, string[]> = {}) {
  const rows: ApiUsageRow[] = [];
  const router = new ModelRouter(new Map(Object.entries(providers)), {
    fallbacks: (ref) => fallbacks[ref] ?? [],
    usageSink: async (row) => {
      rows.push(row);
    },
  });
  return { router, rows };
}

describe('ModelRouter', () => {
  it('sealed snapshot readonly prompt mesajlarını cast olmadan replay eder', async () => {
    const promptMessages = [{ role: 'user', content: 'snapshot replay' }] as const;
    const snapshot = PromptInputSnapshotV1Schema.parse({
      contractVersion: 1,
      promptInputSnapshotId: '10000000-0000-4000-8000-000000000001',
      invocationId: '10000000-0000-4000-8000-000000000002',
      projectId: '10000000-0000-4000-8000-000000000003',
      taskId: '10000000-0000-4000-8000-000000000004',
      taskBriefId: '10000000-0000-4000-8000-000000000005',
      assignmentAttemptId: '10000000-0000-4000-8000-000000000006',
      inputTaskCausalCursor: {
        assignmentAttemptId: '10000000-0000-4000-8000-000000000006',
        ordinal: 0,
      },
      sourceVersionManifest: [{
        sourceType: 'task',
        sourceId: 'task-v1',
        version: 1,
        hash: 'a'.repeat(64),
      }],
      promptMessages,
      promptHash: canonicalSha256V1(promptMessages),
      sealedAt: '2026-08-14T08:00:00.000Z',
    });
    const snapshotMeta: CompletionMeta = {
      projectId: snapshot.projectId,
      agentId: '10000000-0000-4000-8000-000000000007',
      taskId: snapshot.taskId,
      purpose: 'completion',
      invocationId: snapshot.invocationId,
      taskBriefId: snapshot.taskBriefId,
      assignmentAttemptId: snapshot.assignmentAttemptId,
      promptInputSnapshotId: snapshot.promptInputSnapshotId,
      fallbackAttempt: 0,
    };
    const mock = new MockProvider({ script: [{ content: 'replayed', toolCalls: [] }] });
    const { router } = makeRouter({ mock });

    const result = await router.complete('mock:mock-model', {
      messages: snapshot.promptMessages,
      meta: snapshotMeta,
    });

    expect(result.result.content).toBe('replayed');
    expect(mock.calls[0]!.messages).toBe(snapshot.promptMessages);
  });

  it('birincil başarılıysa fallback denenmez, usage ok yazılır', async () => {
    const mock = new MockProvider({ script: [{ content: 'tamam', toolCalls: [] }] });
    const { router, rows } = makeRouter({ mock });
    const res = await router.complete('mock:mock-model', { messages: [], meta });
    expect(res.result.content).toBe('tamam');
    expect(res.fallbackUsed).toBe(false);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('ok');
    expect(rows[0]!.provider_id).toBe('mock');
  });

  it('retryable hatada yedek kullanılır; usage error + fallback_used', async () => {
    const bad = new MockProvider({ script: [], failFirst: 99, failKind: 'server' });
    const good = new MockProvider({ script: [{ content: 'yedek', toolCalls: [] }] });
    const { router, rows } = makeRouter({ bad: renamed(bad, 'bad'), good: renamed(good, 'good') }, {
      'bad:m1': ['good:m2'],
    });
    const res = await router.complete('bad:m1', { messages: [], meta });
    expect(res.result.content).toBe('yedek');
    expect(res.fallbackUsed).toBe(true);
    expect(res.usedRef).toBe('good:m2');
    expect(rows.map((r) => r.status)).toEqual(['error', 'fallback_used']);
  });

  it('bad_request fallback tetiklemez, hata fırlar', async () => {
    const bad = new MockProvider({ script: [], failFirst: 99, failKind: 'bad_request' });
    const good = new MockProvider({ script: [{ content: 'yedek', toolCalls: [] }] });
    const { router, rows } = makeRouter({ bad: renamed(bad, 'bad'), good: renamed(good, 'good') }, {
      'bad:m1': ['good:m2'],
    });
    await expect(router.complete('bad:m1', { messages: [], meta })).rejects.toThrow(ProviderError);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('error');
  });

  it('tüm zincir düşerse hata fırlar, her deneme usage yazılır', async () => {
    const b1 = new MockProvider({ script: [], failFirst: 99 });
    const b2 = new MockProvider({ script: [], failFirst: 99 });
    const { router, rows } = makeRouter({ b1: renamed(b1, 'b1'), b2: renamed(b2, 'b2') }, {
      'b1:m1': ['b2:m2'],
    });
    await expect(router.complete('b1:m1', { messages: [], meta })).rejects.toThrow();
    expect(rows).toHaveLength(2);
  });

  it('maliyet costUsd ile hesaplanır', async () => {
    const mock = new MockProvider({
      script: [{ content: 'x', toolCalls: [], usage: { promptTokens: 1_000_000, completionTokens: 0 } }],
    });
    const { router, rows } = makeRouter({ anthropic: renamed(mock, 'anthropic') });
    await router.complete('anthropic:claude-sonnet-5', { messages: [], meta });
    expect(rows[0]!.cost_usd).toBeCloseTo(3, 6);
  });
});

// MockProvider'ın id'sini test için değiştir (readonly alanı sarmalayarak).
function renamed(p: LlmProvider, id: string): LlmProvider {
  return new Proxy(p, { get: (t, k) => (k === 'id' ? id : Reflect.get(t, k)) });
}
