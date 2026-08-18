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

  // Bu köprü yönlendiricinin TEK üretim kurulum yoluydu ve RouterOptions'ın
  // yarısını sessizce düşürüyordu: orchestration-assembly bir hız sınırlayıcı
  // kuruyor, buraya kadar geliyor, sonra buharlaşıyordu. Yazılmış ama
  // bağlanmamış kod — deponun en pahalı tekrar eden kusuru.
  it('hiz sinirlayici ve saglik kapisini routere GERCEKTEN gecirir', async () => {
    const provider = new MockProvider({ script: [{ content: 'ok', toolCalls: [] }] });
    const reserved: string[] = [];
    const asked: string[] = [];
    const { router } = createDurableModelRouter(new Map([['mock', provider]]), {
      ch: {} as never,
      redis: {} as never,
      usageSink: async () => undefined,
      fallbacks: () => [],
      escalationPort: { append: async () => ({}) } as never,
      providerContext: {
        sessionId: '10000000-0000-4000-8000-000000000001',
        owningPmId: '10000000-0000-4000-8000-000000000002',
      },
      rateLimiter: { reserve: (id) => { reserved.push(id); return 0; } },
      providerHealth: (id) => { asked.push(id); return 'ok'; },
    });

    // Sağlık kapısı ve rezervasyon, kalıcı efekt çalışmadan ÖNCE işler.
    // Efektin sahte ch/redis ile düşmesi bu testin konusu değil: burada
    // sorulan tek şey seçeneklerin routere ulaşıp ulaşmadığı.
    await router.complete('mock:m', {
      messages: [],
      meta: {
        purpose: 'council',
        projectId: '10000000-0000-4000-8000-000000000003',
        agentId: '10000000-0000-4000-8000-000000000004',
      },
    }).catch(() => undefined);

    expect(asked).toEqual(['mock']);
    expect(reserved).toEqual(['mock']);
  });
});
