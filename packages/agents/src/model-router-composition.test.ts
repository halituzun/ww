import { describe, expect, it } from 'vitest';
import { MockProvider } from '@ww/providers';
import { createDurableModelRouter } from './model-router-composition.js';

describe('createDurableModelRouter', () => {
  it('routeri durable composition ile kurar ve effect bypass yüzeyi sunmaz', () => {
    const provider = new MockProvider({ script: [{ content: 'ok', toolCalls: [] }] });
    const escalationPort = { append: async () => ({}) };
    const result = createDurableModelRouter(new Map([['mock', provider]]), {
      ch: {} as never,
      redis: {} as never,
      usageSink: async () => undefined,
      fallbacks: () => [],
      escalationPort: escalationPort as never,
      providerContext: {
        sessionId: '10000000-0000-4000-8000-000000000001',
        owningPmId: '10000000-0000-4000-8000-000000000002',
      },
    });
    expect(result.router).toBeDefined();
    expect(result.effectRunner).toBeDefined();
  });
});
