import { describe, expect, it, vi } from 'vitest';
import { selectRuntimeProject, startOrchestrationRuntime, type StarterDeps } from './runtime-starter.js';

const id = (n: number): string => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;

const project = (over: Record<string, unknown> = {}) => ({
  project_id: id(1), slug: 'satranc', status: 'running', name: 'Satranç', ...over,
});

describe('selectRuntimeProject', () => {
  // registerPhase9RuntimeConfig TEK global slot; aynı anda yalnız bir projenin
  // runtime'ı kayıtlı olabilir. Seçim kuralı açık olmalı.
  it('açıkça istenen projeyi seçer', () => {
    const chosen = selectRuntimeProject([project(), project({ project_id: id(2), slug: 'b' })], id(2));
    expect(chosen?.project_id).toBe(id(2));
  });

  it('istenen proje yoksa null döner (sessizce başkasını seçmez)', () => {
    expect(selectRuntimeProject([project()], id(9))).toBeNull();
  });

  it('seçim verilmezse tek çalışan projeyi alır', () => {
    expect(selectRuntimeProject([project()], undefined)?.slug).toBe('satranc');
  });

  // Birden çok aday varsa hangisinin seçileceği belirsizdir; sessiz seçim
  // yanlış projede para harcatabilir.
  it('birden çok çalışan proje varsa seçmez', () => {
    expect(selectRuntimeProject(
      [project(), project({ project_id: id(2), slug: 'b' })], undefined,
    )).toBeNull();
  });

  it('çalışmayan projeleri aday saymaz', () => {
    expect(selectRuntimeProject([project({ status: 'paused' })], undefined)).toBeNull();
  });
});

function deps(over: Partial<StarterDeps> = {}): StarterDeps {
  return {
    enabled: true,
    listProjects: async () => [project()],
    requestedProjectId: undefined,
    bootstrap: vi.fn(async () => ({ registered: true, workerModelRef: 'deepseek:chat' })),
    log: vi.fn(),
    ...over,
  };
}

describe('startOrchestrationRuntime', () => {
  it('bayrak kapalıysa hiç denemez', async () => {
    const d = deps({ enabled: false });
    const result = await startOrchestrationRuntime(d);
    expect(result.started).toBe(false);
    expect(d.bootstrap).not.toHaveBeenCalled();
  });

  it('uygun proje varsa bootstrap çağırır', async () => {
    const d = deps();
    const result = await startOrchestrationRuntime(d);
    expect(result.started).toBe(true);
    expect(d.bootstrap).toHaveBeenCalledTimes(1);
  });

  it('aday proje yoksa sebebini bildirir', async () => {
    const d = deps({ listProjects: async () => [] });
    const result = await startOrchestrationRuntime(d);
    expect(result.started).toBe(false);
    expect(result.reason).toMatch(/proje/i);
  });

  // Bootstrap fail-closed döndüyse motor başlamamıştır; 'started' demek
  // /runtime'ı yalancı yapar.
  it('bootstrap kaydetmediyse başlamış saymaz', async () => {
    const d = deps({
      bootstrap: vi.fn(async () => ({ registered: false, reason: 'kullanılabilir sağlayıcı yok' })),
    });
    const result = await startOrchestrationRuntime(d);
    expect(result.started).toBe(false);
    expect(result.reason).toContain('sağlayıcı');
  });

  // Başlatma hatası sunucuyu düşürmemeli: REST/panel çalışmaya devam etmeli.
  it('bootstrap istisnası sunucuyu düşürmez ama sessiz kalmaz', async () => {
    const logs: string[] = [];
    const d = deps({
      bootstrap: vi.fn(async () => { throw new Error('ClickHouse yok'); }),
      log: (message: string) => logs.push(message),
    });
    const result = await startOrchestrationRuntime(d);
    expect(result.started).toBe(false);
    expect(logs.join(' ')).toMatch(/ClickHouse yok/);
  });

  it('çapraz kontrol uyarısını loglar', async () => {
    const logs: string[] = [];
    const d = deps({
      bootstrap: vi.fn(async () => ({ registered: true, warning: 'verifier worker ile aynı sağlayıcıda' })),
      log: (message: string) => logs.push(message),
    });
    await startOrchestrationRuntime(d);
    expect(logs.join(' ')).toMatch(/aynı sağlayıcıda/);
  });
});
