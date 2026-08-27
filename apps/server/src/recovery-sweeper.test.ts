import { describe, expect, it, vi } from 'vitest';
import { sweepRecovery } from './recovery-sweeper.js';

const ports = (over: Record<string, unknown> = {}) => ({
  recover: vi.fn(async () => ({ requeuedTaskIds: [], idledAgentIds: [] })),
  log: vi.fn(),
  onError: vi.fn(),
  ...over,
}) as never as Parameters<typeof sweepRecovery>[0];

describe('sweepRecovery', () => {
  // ASIL KUSUR: kurtarma yalnızca açılışta koşuyordu; yarıda kalan TEK görev
  // agent'ları tutup projeyi kilitliyordu.
  it('düzeltilen kaynak sayısını döner', async () => {
    expect(await sweepRecovery(ports({
      recover: async () => ({ requeuedTaskIds: ['t1'], idledAgentIds: ['a1', 'a2'] }),
    }))).toBe(3);
  });

  it('düzeltme olduğunda bildirir', async () => {
    const log = vi.fn();
    await sweepRecovery(ports({ log, recover: async () => ({ requeuedTaskIds: ['t1'], idledAgentIds: [] }) }));
    expect(log).toHaveBeenCalledTimes(1);
  });

  // Her turda "0 düzeltildi" yazmak logu boğar ve gerçek olayı gizler.
  it('düzeltme yoksa sessiz kalır', async () => {
    const log = vi.fn();
    await sweepRecovery(ports({ log }));
    expect(log).not.toHaveBeenCalled();
  });

  it('hata sunucuyu düşürmez', async () => {
    await expect(sweepRecovery(ports({ recover: async () => { throw new Error('clickhouse kapalı'); } })))
      .resolves.toBe(0);
  });

  // Yutulan süpürücü hatası, kilitlenmenin sebebini görünmez kılar.
  it('hatayı bildirir', async () => {
    const onError = vi.fn();
    await sweepRecovery(ports({ onError, recover: async () => { throw new Error('boom'); } }));
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe('identifyStuckAgents — C2 Takılan Agent Tespiti', () => {
  it('5 dakikayi asan meşgul agenti tespit eder', async () => {
    const { identifyStuckAgents } = await import('./recovery-sweeper.js');
    const now = Date.now();
    const agents = [
      { agent_id: 'a1', status: 'busy', status_changed_at: new Date(now - 6 * 60 * 1000).toISOString() },
      { agent_id: 'a2', status: 'busy', status_changed_at: new Date(now - 2 * 60 * 1000).toISOString() },
      { agent_id: 'a3', status: 'idle', status_changed_at: new Date(now - 10 * 60 * 1000).toISOString() },
    ];
    const stuck = identifyStuckAgents(agents, now);
    expect(stuck.map((s) => s.agentId)).toEqual(['a1']);
  });
});
