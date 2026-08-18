// @vitest-environment jsdom
//
// NEDEN VAR: yükleme yolunun DAYANIKLILIĞI ancak burada görülür. Üç uç
// (kontör, sağlayıcı sağlığı, API uçları) hatayı yutuyordu; tek Promise.all
// ile hepsini reddettirmek ise bir uç düştüğünde görevleri de
// güncellememek demekti.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { useWorkspaceViewModel } from './useWorkspaceViewModel.js';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const ok = (body: unknown) => ({
  ok: true, status: 200,
  headers: new Headers({ 'content-type': 'application/json' }),
  text: async () => JSON.stringify(body),
});

const fail = () => ({
  ok: false, status: 500,
  headers: new Headers({ 'content-type': 'application/json' }),
  text: async () => JSON.stringify({ message: 'patladı' }),
});

const projectId = '11111111-1111-4111-8111-111111111111';

describe('useWorkspaceViewModel yükleme dayanıklılığı', () => {
  it('saglik ucu duserken gorevler yine yuklenir ve duşen uc ADIYLA soylenir', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/provider-health')) return Promise.resolve(fail() as never);
      if (url.includes('/tasks')) {
        return Promise.resolve(ok([{ task_id: 't1', title: 'Görev', status: 'queued' }]) as never);
      }
      if (url.includes('/projects/') && url.endsWith(projectId)) {
        return Promise.resolve(ok({ project_id: projectId, status: 'running' }) as never);
      }
      if (url.includes('/usage')) return Promise.resolve(ok(null) as never);
      return Promise.resolve(ok([]) as never);
    }) as never);

    const { result } = renderHook(() => useWorkspaceViewModel());
    result.current.setProjectId(projectId);

    await waitFor(() => expect(result.current.tasks).toHaveLength(1));
    expect(result.current.workspaceError).toContain('sağlayıcı sağlığı');
    // Diğer yüzeyler ETKİLENMEZ: bir ucun düşmesi paneli dondurmamalı.
    expect(result.current.workspaceError).not.toContain('görevler');
  });
});
