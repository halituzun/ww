import { describe, expect, it, vi } from 'vitest';
import {
  bootstrapOrchestrationRuntime,
  type BootstrapDeps,
} from './orchestration-bootstrap.js';

const id = (n: number): string => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;

function deps(over: Partial<BootstrapDeps> = {}): BootstrapDeps {
  return {
    ch: {} as never,
    redis: {} as never,
    projectId: id(1),
    projectSlug: 'satranc',
    workspaceRoot: '/srv/ww/workspace',
    localSessionToken: 'tok',
    consumerId: 'server-1',
    loadProviders: async () => ({
      providers: new Map([['deepseek', { id: 'deepseek' } as never]]),
      skipped: [],
    }),
    loadRouting: async () => ({
      modelForRole: (role: string) =>
        role === 'worker' ? 'deepseek:deepseek-chat'
          : role === 'verifier' ? 'openai:gpt-5-mini' : undefined,
      fallbacks: () => [],
    }),
    register: vi.fn(),
    ...over,
  };
}

describe('bootstrapOrchestrationRuntime', () => {
  it('sağlayıcı ve rol eşlemesi tamsa runtime kaydeder', async () => {
    const d = deps();
    const result = await bootstrapOrchestrationRuntime(d);
    expect(result.registered).toBe(true);
    expect(d.register).toHaveBeenCalledTimes(1);
  });

  // Sağlayıcı yoksa motoru başlatmak, her görevi anında hataya sürmektir.
  it('hiç kullanılabilir sağlayıcı yoksa kaydetmez ve sebebini söyler', async () => {
    const d = deps({
      loadProviders: async () => ({ providers: new Map(), skipped: [{ providerId: 'deepseek', reason: 'no_key' }] }),
    });
    const result = await bootstrapOrchestrationRuntime(d);
    expect(result.registered).toBe(false);
    expect(result.reason).toMatch(/sağlayıcı/i);
    expect(result.reason).toContain('deepseek');
    expect(d.register).not.toHaveBeenCalled();
  });

  // Rol eşlemesi olmadan hangi modelin çağrılacağı belirsizdir; varsayılana
  // düşmek kullanıcının seçmediği modelle para harcamaktır.
  it('worker rolü eşlenmemişse kaydetmez', async () => {
    const d = deps({
      loadRouting: async () => ({ modelForRole: () => undefined, fallbacks: () => [] }),
    });
    const result = await bootstrapOrchestrationRuntime(d);
    expect(result.registered).toBe(false);
    expect(result.reason).toMatch(/worker/i);
    expect(d.register).not.toHaveBeenCalled();
  });

  it('kayıtlı yapılandırma proje kimliğini ve consumer’ı taşır', async () => {
    const d = deps();
    await bootstrapOrchestrationRuntime(d);
    const config = (d.register as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0] as {
      composition: Record<string, unknown>;
    };
    expect(config.composition).toMatchObject({ projectId: id(1), consumerId: 'server-1' });
  });

  it('kayıtlı yapılandırma scheduler işlemlerinin tamamını içerir', async () => {
    const d = deps();
    await bootstrapOrchestrationRuntime(d);
    const config = (d.register as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0] as {
      composition: { schedulerOperations: Record<string, unknown> };
    };
    for (const op of [
      'transition', 'gate', 'commit', 'escalate', 'reassign',
      'awaitUserAnswer', 'resumeUserAnswer', 'handleExecutionError',
    ]) {
      expect(config.composition.schedulerOperations, `eksik işlem: ${op}`).toHaveProperty(op);
    }
  });

  it('runtimeContext ve toolFactory bağlanır (gerçek agent döngüsü için şart)', async () => {
    const d = deps();
    await bootstrapOrchestrationRuntime(d);
    const config = (d.register as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0] as {
      composition: Record<string, unknown>;
    };
    expect(config.composition).toHaveProperty('runtimeContext');
    expect(config.composition).toHaveProperty('toolFactory');
    expect(config.composition).toHaveProperty('executor');
  });

  // Geçersiz slug sandbox sınırını deler.
  it('geçersiz proje slug’ında kaydetmez', async () => {
    const d = deps({ projectSlug: '../etc' });
    const result = await bootstrapOrchestrationRuntime(d);
    expect(result.registered).toBe(false);
    expect(result.reason).toMatch(/slug/i);
  });

  it('kayıt hatası yutulmaz', async () => {
    const d = deps({ register: vi.fn(() => { throw new Error('kayıt reddedildi'); }) });
    await expect(bootstrapOrchestrationRuntime(d)).rejects.toThrow(/kayıt reddedildi/);
  });
});
