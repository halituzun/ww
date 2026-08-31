import { describe, expect, it, vi } from 'vitest';
import { applyLateBinding } from './late-bind-runtime.js';

const composition = {
  taskTransitionService: { name: 'transition' },
  assignmentService: { name: 'assignment' },
  toolExecutor: { name: 'tools' },
  gateRunner: { name: 'gate' },
  gitWorkspace: { name: 'git' },
  workspace: { name: 'workspace' },
  extra: { name: 'ignored' },
} as never;

describe('applyLateBinding', () => {
  // ASIL KUSUR: bootstrap bindLate'i döndürüyordu ama HİÇ ÇAĞRILMIYORDU.
  // Sonuç: her görev ilk geçişte "taskTransitionService henüz bağlanmadı"
  // ile düşüyordu — motor açıktı, hiçbir iş bitemezdi.
  it('composition’ın servislerini bağlayıcıya geçirir', () => {
    const bind = vi.fn();
    applyLateBinding(composition, bind);

    expect(bind).toHaveBeenCalledTimes(1);
    expect(bind.mock.calls[0]![0]).toMatchObject({
      taskTransitionService: { name: 'transition' },
      assignmentService: { name: 'assignment' },
      toolExecutor: { name: 'tools' },
      gateRunner: { name: 'gate' },
      gitWorkspace: { name: 'git' },
    });
  });

  it('bağlayıcı yoksa sessizce geçer', () => {
    expect(() => applyLateBinding(composition, undefined)).not.toThrow();
  });

  // Eksik servisi sessizce geçmek, aynı gizli hatayı geri getirirdi:
  // port çağrıldığında değil, KURULUMDA patlamalı.
  it('zorunlu servis eksikse açık hata verir', () => {
    const missing = { ...(composition as never as Record<string, unknown>) };
    delete missing['gateRunner'];
    expect(() => applyLateBinding(missing as never, vi.fn())).toThrow(/gateRunner/);
  });

  it('hangi servislerin eksik olduğunu tek seferde bildirir', () => {
    const missing = { ...(composition as never as Record<string, unknown>) };
    delete missing['gateRunner'];
    delete missing['gitWorkspace'];
    expect(() => applyLateBinding(missing as never, vi.fn())).toThrow(/gateRunner.*gitWorkspace/);
  });

  // Workspace composition'da DEĞİL; proje kökünü bilen assembly kurar.
  // Onu zorunlu saymak sunucuyu açılışta düşürüyordu.
  it('workspace’i composition’dan beklemez', () => {
    const withoutWorkspace = { ...(composition as never as Record<string, unknown>) };
    delete withoutWorkspace['workspace'];
    expect(() => applyLateBinding(withoutWorkspace as never, vi.fn())).not.toThrow();
  });
});
