import { describe, expect, it } from 'vitest';
import { projectWorkspacePath } from './workspace-path.js';

describe('projectWorkspacePath', () => {
  // KUSUR: kayıt `workspace/<uuid>` yazıyordu ama çalışma zamanı kökü
  // SLUG ile çözüyor (resolveWorkspaceRoot). Yani `projects.workspace_path`
  // her projede VAR OLMAYAN bir klasörü gösteriyordu.
  it('slug ile cozulur, uuid ile degil', () => {
    expect(projectWorkspacePath('satranc-web')).toBe('workspace/satranc-web');
  });

  // Slug doğrulaması çalışma zamanındakiyle AYNI olmalı; farklı olursa kayıt
  // yine gerçeği yansıtmaz.
  it('gecersiz slugu reddeder', () => {
    expect(() => projectWorkspacePath('../etc')).toThrow(/slug/);
    expect(() => projectWorkspacePath('boş slug')).toThrow(/slug/);
    expect(() => projectWorkspacePath('')).toThrow(/slug/);
  });

  it('gecerli isaretlere izin verir', () => {
    expect(projectWorkspacePath('proje_1-a')).toBe('workspace/proje_1-a');
  });
});
