import { describe, expect, it } from 'vitest';
import { ReplanningError, ReplanningService } from './replanning-service.js';

const PROJECT = '11111111-1111-4111-8111-111111111111';

const input = (over: Partial<Parameters<ReplanningService['replan']>[0]> = {}) => ({
  projectId: PROJECT as never,
  reason: 'kapsam degisti',
  summary: 'mobil destek eklenecek',
  now: '2026-08-31T09:00:00.000Z',
  ...over,
});

describe('ReplanningService', () => {
  it('aktif plan yoksa fail-closed düşer', async () => {
    const ch = { query: async () => ({ json: async () => [] }) } as never;
    await expect(new ReplanningService(ch).replan(input())).rejects.toThrow('aktif plan');
  });

  // Gerekçesiz yeniden planlama, plan geçmişinde "neden" sorusunu cevapsız
  // bırakır; sonraki oturum kararın sebebini bulamaz.
  it('gerekçesiz talebi reddeder ve plana dokunmaz', async () => {
    let queried = false;
    const ch = {
      query: async () => { queried = true; return { json: async () => [] }; },
    } as never;
    await expect(new ReplanningService(ch).replan(input({ reason: '   ' })))
      .rejects.toThrow(ReplanningError);
    expect(queried).toBe(false);
  });

  // NOT: planı `superseded` yapan ve açık görevleri `cancelled` yapan yol
  // gerçek ClickHouse ister (plan yazımı `INSERT ... SELECT` ile observed_at'i
  // sunucuda üretir). O yol replanning.integration.test.ts içinde doğrulanır.
});
