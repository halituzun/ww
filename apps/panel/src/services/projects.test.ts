import { describe, expect, it, vi } from 'vitest';
import {
  askNarrator,
  createProjectMapSnapshot,
  createProject,
  createExpressProject,
  fetchApiArtifacts,
  fetchFiles,
  fetchProjectMap,
  fetchProjects,
  fetchTasks,
  fetchProviderHealth,
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


  // "Proje yok" ile "liste alınamadı" AYNI ŞEY DEĞİLDİR. `getJsonOr` boş dizi
  // döndürdüğünde ProjectPicker "Henüz proje yok — yukarıdan ilkini
  // oluşturun" diyordu; kullanıcı var olan projelerini kaybettiğini sanabilir
  // ve kopyasını açabilir. Bu, panelin "yüzey yalan söylüyor" sınıfının son
  // örneğiydi (denetim ve kontör panolarında aynısı düzeltildi).
  it('proje listesi alinamazsa hatayi YUTMAZ', async () => {
    const mock = vi.fn(async () => new Response('bozuk', { status: 500 }));
    await expect(fetchProjects({ fetchImpl: mock as unknown as typeof fetch }))
      .rejects.toBeTruthy();
  });


  // Bu iki uç, bu oturumda EKLEDİĞİM "henüz görev/dosya yok" boş durumlarını
  // besliyor. Hata yutulursa o mesajlar YALAN söyler: kullanıcı 32 kuyruk
  // görevi varken "görev yok" görür.
  it.each([
    ['görev listesi', fetchTasks],
    ['dosya listesi', fetchFiles],
  ])('%s alinamazsa hatayi YUTMAZ', async (_name, call) => {
    const mock = vi.fn(async () => new Response('bozuk', { status: 500 }));
    await expect(call('p1', { fetchImpl: mock as unknown as typeof fetch }))
      .rejects.toBeTruthy();
  });

  it.each([
    ['tasks', fetchTasks, '/projects/p1/tasks'],
    ['usage', fetchUsage, '/projects/p1/usage'],
    ['files', fetchFiles, '/projects/p1/files'],
    ['project-map', fetchProjectMap, '/projects/p1/files/map'],
    ['artifacts', fetchApiArtifacts, '/projects/p1/artifacts?type=api_endpoint'],
  ] as const)('%s ucunu proje kapsamında çağırır', async (_name, call, expected) => {
    const mock = vi.fn(async () => jsonResponse([]));
    await call('p1', { fetchImpl: mock as unknown as typeof fetch });
    expect(urlOf(mock)).toBe(`${DEFAULT_API_BASE}${expected}`);
  });

  // DEĞİŞTİ: bu üç uç de artık hatayı YUTMUYOR. Yutulduğunda "veri yok" ile
  // "veri alınamadı" aynı görünüyordu; sağlayıcı sağlığında bu, rozetin
  // yokluğunu "her şey yolunda" diye okutuyordu (docs/04 düşen sağlayıcının
  // KIRMIZI görünmesini ister). Dayanıklılık artık ViewModel'de: her uç ayrı
  // değerlendirilir, düşen adıyla söylenir, diğerleri güncellenmeye devam eder.
  it('kontör, saglik ve API uclari hatayi yutmaz', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, { status: 500 })) as unknown as typeof fetch;
    await expect(fetchUsage('p1', { fetchImpl })).rejects.toThrow();
    await expect(fetchProviderHealth('p1', { fetchImpl })).rejects.toThrow();
    await expect(fetchApiArtifacts('p1', { fetchImpl })).rejects.toThrow();
  });

  it('proje kimliğini URL için kodlar', async () => {
    const mock = vi.fn(async () => jsonResponse([]));
    await fetchTasks('a/b', { fetchImpl: mock as unknown as typeof fetch });
    expect(urlOf(mock)).toBe(`${DEFAULT_API_BASE}/projects/a%2Fb/tasks`);
  });
});

describe('yazma uçları', () => {
  it('proje haritası snapshotini yetkili POST ile kaydeder', async () => {
    const mock = vi.fn(async () => jsonResponse({ snapshot: { project_map_id: 'm1' }, sourceRef: null }));
    await createProjectMapSnapshot('p1', {
      fetchImpl: mock as unknown as typeof fetch, sessionToken: 'tok',
    });
    expect(urlOf(mock)).toBe(`${DEFAULT_API_BASE}/projects/p1/files/map/snapshots`);
    expect(initOf(mock).method).toBe('POST');
  });

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

  it('express proje oluşturur', async () => {
    const mock = vi.fn(async () => jsonResponse({ project_id: 'exp-1' }));
    await createExpressProject({ name: 'Hava Durumu', prompt: 'web app' }, {
      fetchImpl: mock as unknown as typeof fetch, sessionToken: 'tok',
    });
    expect(urlOf(mock)).toBe(`${DEFAULT_API_BASE}/projects/express`);
    expect(JSON.parse(String(initOf(mock).body))).toEqual({
      name: 'Hava Durumu', prompt: 'web app', type: 'web',
    });
  });

  it('boş prompt ile express proje oluşturmayı reddeder', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(createExpressProject({ name: 'demo', prompt: '   ' }, { fetchImpl }))
      .rejects.toThrow(/açıklama/i);
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
