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
  projectId: '10000000-0000-4000-8000-000000000010',
  agentId: '10000000-0000-4000-8000-000000000011',
  taskId: '10000000-0000-4000-8000-000000000012',
  purpose: 'completion',
  invocationId: '10000000-0000-4000-8000-000000000013',
  taskBriefId: '10000000-0000-4000-8000-000000000014',
  assignmentAttemptId: '10000000-0000-4000-8000-000000000015',
  promptInputSnapshotId: '10000000-0000-4000-8000-000000000016',
  fallbackAttempt: 0,
};

function makeRouter(providers: Record<string, LlmProvider>, fallbacks: Record<string, string[]> = {}) {
  const rows: ApiUsageRow[] = [];
  const router = new ModelRouter(new Map(Object.entries(providers)), {
    fallbacks: (ref) => fallbacks[ref] ?? [],
    usageSink: async (row) => {
      rows.push(row);
    },
    invocationEffect: {
      run: async ({ execute }) => execute(),
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
    expect(rows[0]!.invocation_id).toBe(meta.invocationId);
    expect(rows[0]!.task_brief_id).toBe(meta.taskBriefId);
    expect(rows[0]!.assignment_attempt_id).toBe(meta.assignmentAttemptId);
    expect(rows[0]!.prompt_input_snapshot_id).toBe(meta.promptInputSnapshotId);
    expect(rows[0]!.fallback_attempt).toBe(0);
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
    expect(rows.map((r) => r.invocation_id)).toEqual([meta.invocationId, meta.invocationId]);
    expect(rows.map((r) => r.fallback_attempt)).toEqual([0, 1]);
  });

  // ASIL KUSUR: yönlendirici "aynı sağlayıcıyı tekrar deneme" (retryable=false)
  // ile "başka sağlayıcıyı deneme"yi aynı şey sayıyordu. Kimlik hatası O
  // SAĞLAYICIYA ÖZGÜDÜR: başka sağlayıcının anahtarı farklıdır ve docs/04
  // "düşen sağlayıcıda işler varsayılana akar" der. Canlı koşuda bozuk
  // anahtarlı sağlayıcı tüm görevi düşürdü, fallback hiç denenmedi.
  it('auth hatasinda yedek sağlayıcıya geçer', async () => {
    const bad = new MockProvider({ script: [], failFirst: 99, failKind: 'auth' });
    const good = new MockProvider({ script: [{ content: 'yedek', toolCalls: [] }] });
    const { router, rows } = makeRouter({ bad: renamed(bad, 'bad'), good: renamed(good, 'good') }, {
      'bad:m1': ['good:m2'],
    });

    const res = await router.complete('bad:m1', { messages: [], meta });
    expect(res.result.content).toBe('yedek');
    expect(res.fallbackUsed).toBe(true);
    expect(rows.map((r) => r.status)).toEqual(['error', 'fallback_used']);
    expect(rows.map((r) => r.error_kind)).toEqual(['auth', '']);
  });

  // Yedeği de bozuksa hata YUTULMAZ: sessizce başarısız olmak, kullanıcıya
  // işin yapıldığı yalanını söyler.
  it('tum zincir auth ile duserse hata firlar', async () => {
    const bad = new MockProvider({ script: [], failFirst: 99, failKind: 'auth' });
    const alsoBad = new MockProvider({ script: [], failFirst: 99, failKind: 'auth' });
    const { router, rows } = makeRouter(
      { bad: renamed(bad, 'bad'), alsoBad: renamed(alsoBad, 'alsoBad') },
      { 'bad:m1': ['alsoBad:m2'] },
    );

    await expect(router.complete('bad:m1', { messages: [], meta })).rejects.toThrow(ProviderError);
    expect(rows.map((r) => r.status)).toEqual(['error', 'error']);
  });


  // Konsey turu GERÇEK, paralı bir çağrıdır ve api_usage'a yazılmalıdır; ama
  // göreve bağlı değildir: brief/attempt provenance'ı yoktur. 'completion'
  // sayılırsa dayanıklı etki sınırı zorunlu olur ve konsey hiç koşamaz.
  it('council amacli cagri gorev provenance istemez ve usage yazar', async () => {
    const mock = new MockProvider({ script: [{ content: 'öneri', toolCalls: [] }] });
    const rows: unknown[] = [];
    const router = new ModelRouter(new Map([['mock', mock]]), {
      fallbacks: () => [],
      usageSink: async (row) => { rows.push(row); },
    });

    const res = await router.complete('mock:mock-model', {
      messages: [],
      meta: { purpose: 'council', projectId: meta.projectId, agentId: meta.agentId },
    } as never);

    expect(res.result.content).toBe('öneri');
    expect(rows).toHaveLength(1);
    expect((rows[0] as { purpose: string }).purpose).toBe('council');
  });


  // docs/07: "Rate limit aşımında router BEKLETİR (kuyruklu token-bucket)".
  // İstek düşürülmez; sınırsız çıkış 429'a çarpar ve 429'lar fallback'i
  // tetikleyip yükü daha da artırır.
  it('rate limit asiminda bekler, istegi dusurmez', async () => {
    const mock = new MockProvider({ script: [
      { content: 'bir', toolCalls: [] }, { content: 'iki', toolCalls: [] },
    ] });
    const waits: number[] = [];
    let allowed = 1;
    const router = new ModelRouter(new Map([['mock', mock]]), {
      fallbacks: () => [],
      usageSink: async () => undefined,
      rateLimiter: { reserve: () => (allowed-- > 0 ? 0 : 500) },
      sleep: async (ms) => { waits.push(ms); },
    });

    expect((await router.complete('mock:m', { messages: [], meta: { purpose: 'council', projectId: meta.projectId, agentId: meta.agentId } })).result.content).toBe('bir');
    expect(waits).toEqual([]);

    expect((await router.complete('mock:m', { messages: [], meta: { purpose: 'council', projectId: meta.projectId, agentId: meta.agentId } })).result.content).toBe('iki');
    expect(waits).toEqual([500]);
  });

  it('sinirlayici yokken beklemez', async () => {
    const mock = new MockProvider({ script: [{ content: 'tamam', toolCalls: [] }] });
    const waits: number[] = [];
    const router = new ModelRouter(new Map([['mock', mock]]), {
      fallbacks: () => [],
      usageSink: async () => undefined,
      sleep: async (ms) => { waits.push(ms); },
    });

    await router.complete('mock:m', { messages: [], meta: { purpose: 'council', projectId: meta.projectId, agentId: meta.agentId } });
    expect(waits).toEqual([]);
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
