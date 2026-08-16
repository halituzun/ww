import { describe, expect, it, vi } from 'vitest';
import {
  askNarrator,
  createProject,
  fetchApiArtifacts,
  fetchFiles,
  fetchProjects,
  fetchTasks,
  fetchUsage,
  sendUserCommand,
  updateProjectStatus,
} from './projects.js';
import { DEFAULT_API_BASE } from './http.js';

const jsonResponse = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' }, ...init });

const urlOf = (mock: { mock: { calls: unknown[][] } }) =>
  (mock.mock.calls[0] as unknown as [string])[0];
const initOf = (mock: { mock: { calls: unknown[][] } }) =>
  (mock.mock.calls[0] as unknown as [string, RequestInit])[1];

describe('okuma uçları', () => {
  it('proje listesini çeker', async () => {
    const mock = vi.fn(async () => jsonResponse([{ project_id: 'p1' }]));
    await expect(fetchProjects({ fetchImpl: mock as unknown as typeof fetch }))
      .resolves.toEqual([{ project_id: 'p1' }]);
    expect(urlOf(mock)).toBe(`${DEFAULT_API_BASE}/projects`);
  });

  it.each([
    ['tasks', fetchTasks, '/projects/p1/tasks'],
    ['usage', fetchUsage, '/projects/p1/usage'],
    ['files', fetchFiles, '/projects/p1/files'],
    ['artifacts', fetchApiArtifacts, '/projects/p1/artifacts?type=api_endpoint'],
  ] as const)('%s ucunu proje kapsamında çağırır', async (_name, call, expected) => {
    const mock = vi.fn(async () => jsonResponse([]));
    await call('p1', { fetchImpl: mock as unknown as typeof fetch });
    expect(urlOf(mock)).toBe(`${DEFAULT_API_BASE}${expected}`);
  });

  // Okuma hatası panelin akışını kesmemeli.
  it('okuma ucu hata verirse boş sonuç döner', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, { status: 500 })) as unknown as typeof fetch;
    await expect(fetchTasks('p1', { fetchImpl })).resolves.toEqual([]);
    await expect(fetchUsage('p1', { fetchImpl })).resolves.toBeNull();
  });

  it('proje kimliğini URL için kodlar', async () => {
    const mock = vi.fn(async () => jsonResponse([]));
    await fetchTasks('a/b', { fetchImpl: mock as unknown as typeof fetch });
    expect(urlOf(mock)).toBe(`${DEFAULT_API_BASE}/projects/a%2Fb/tasks`);
  });
});

describe('yazma uçları', () => {
  it('proje durumunu yetkili PATCH ile günceller', async () => {
    const mock = vi.fn(async () => jsonResponse({ status: 'paused' }));
    await updateProjectStatus('p1', 'paused', {
      fetchImpl: mock as unknown as typeof fetch, sessionToken: 'tok',
    });
    expect(urlOf(mock)).toBe(`${DEFAULT_API_BASE}/projects/p1/status`);
    expect(initOf(mock).method).toBe('PATCH');
    expect(JSON.parse(String(initOf(mock).body))).toEqual({ status: 'paused' });
  });

  it('kullanıcı emrini user_command olarak gönderir', async () => {
    const mock = vi.fn(async () => jsonResponse({ ok: true }));
    await sendUserCommand('p1', 'başla', {
      fetchImpl: mock as unknown as typeof fetch, sessionToken: 'tok',
    });
    expect(JSON.parse(String(initOf(mock).body))).toEqual({ kind: 'user_command', text: 'başla' });
  });

  it('boş emri sunucuya göndermez', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(sendUserCommand('p1', '   ', { fetchImpl })).rejects.toThrow(/boş/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('proje oluşturmada bütçeyi sayıya çevirir', async () => {
    const mock = vi.fn(async () => jsonResponse({ project_id: 'p2' }));
    await createProject({ name: 'demo', type: 'web', budgetUsd: '12.5' }, {
      fetchImpl: mock as unknown as typeof fetch, sessionToken: 'tok',
    });
    // bootstrapAgents düşerse panelden açılan projeye agent kadrosu kurulmaz.
    expect(JSON.parse(String(initOf(mock).body))).toEqual({
      name: 'demo', type: 'web', budgetUsdLimit: 12.5, bootstrapAgents: true,
    });
  });

  it('adsız proje oluşturmayı reddeder', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(createProject({ name: ' ', type: 'web', budgetUsd: '1' }, { fetchImpl }))
      .rejects.toThrow(/ad/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('narrator sorusunu gönderir ve kanıt referanslarını döner', async () => {
    const mock = vi.fn(async () => jsonResponse({ answer: 'şöyle', evidenceRefs: ['task:1'] }));
    await expect(askNarrator('p1', 'nasıl yaptın?', {
      fetchImpl: mock as unknown as typeof fetch,
    })).resolves.toEqual({ answer: 'şöyle', evidenceRefs: ['task:1'] });
    expect(urlOf(mock)).toBe(`${DEFAULT_API_BASE}/projects/p1/narrator`);
  });
});
