import { describe, expect, it, vi } from 'vitest';
import { resetRecoveredWorkspaces } from './workspace-recovery.js';

const project = { project_id: 'p1', slug: 'satranc' };

describe('resetRecoveredWorkspaces (docs/01: çökmede working tree temizlenir)', () => {
  it('kurtarilan projenin agacini temizler', async () => {
    const reset = vi.fn(async () => undefined);
    await resetRecoveredWorkspaces({
      results: [{ projectId: 'p1', requeuedTaskIds: ['t1'] }] as never,
      loadProject: async () => project as never,
      reset, onError: () => undefined,
    });
    expect(reset).toHaveBeenCalledWith('p1', 'satranc');
  });

  // HİÇBİR ŞEY kurtarılmadıysa dokunulmaz: çalışan bir sistemin working
  // tree'sini temizlemek, süren işi silmek olurdu.
  it('kurtarilan gorev yoksa dokunmaz', async () => {
    const reset = vi.fn(async () => undefined);
    await resetRecoveredWorkspaces({
      results: [{ projectId: 'p1', requeuedTaskIds: [] }] as never,
      loadProject: async () => project as never,
      reset, onError: () => undefined,
    });
    expect(reset).not.toHaveBeenCalled();
  });

  it('proje kaydi yoksa atlar', async () => {
    const reset = vi.fn(async () => undefined);
    await resetRecoveredWorkspaces({
      results: [{ projectId: 'p1', requeuedTaskIds: ['t1'] }] as never,
      loadProject: async () => null,
      reset, onError: () => undefined,
    });
    expect(reset).not.toHaveBeenCalled();
  });

  // Temizlik hatası KURTARMAYI düşürmez: görevler zaten kuyruğa alındı,
  // temizlik yapılamadı diye onları geri almak çözdüğünden fazlasını bozar.
  it('temizlik hatasi kurtarmayi dusurmez ama sessiz kalmaz', async () => {
    const seen: unknown[] = [];
    await expect(resetRecoveredWorkspaces({
      results: [{ projectId: 'p1', requeuedTaskIds: ['t1'] }] as never,
      loadProject: async () => project as never,
      reset: async () => { throw new Error('git yok'); },
      onError: (reason) => seen.push(reason),
    })).resolves.toBeUndefined();
    expect(seen).toHaveLength(1);
  });
});
