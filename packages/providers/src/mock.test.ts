import { describe, expect, it } from 'vitest';
import { MockProvider } from './mock.js';
import { ProviderError, type CompletionMeta } from './types.js';

const meta: CompletionMeta = { projectId: 'p', agentId: 'a', purpose: 'completion' };

describe('MockProvider', () => {
  it('senaryo cevaplarını sırayla döner ve çağrıları kaydeder', async () => {
    const p = new MockProvider({
      script: [
        { content: 'birinci', toolCalls: [] },
        { content: null, toolCalls: [{ id: 't1', name: 'write_file', args: { path: 'a.ts' } }] },
      ],
    });
    const r1 = await p.complete({ model: 'mock-model', messages: [{ role: 'user', content: 'selam' }], meta });
    expect(r1.content).toBe('birinci');
    const r2 = await p.complete({ model: 'mock-model', messages: [], meta });
    expect(r2.toolCalls[0]!.name).toBe('write_file');
    expect(p.calls).toHaveLength(2);
    expect(p.calls[0]!.messages[0]!.content).toBe('selam');
  });

  it('failFirst: ilk n çağrı retryable hata fırlatır', async () => {
    const p = new MockProvider({ script: [{ content: 'ok', toolCalls: [] }], failFirst: 1 });
    await expect(p.complete({ model: 'mock-model', messages: [], meta })).rejects.toThrow(ProviderError);
    const r = await p.complete({ model: 'mock-model', messages: [], meta });
    expect(r.content).toBe('ok');
  });

  it('embed deterministiktir', async () => {
    const p = new MockProvider({ script: [] });
    const [v1] = await p.embed(['merhaba']);
    const [v2] = await p.embed(['merhaba']);
    expect(v1).toEqual(v2);
    expect(v1!.length).toBe(16);
  });
});
