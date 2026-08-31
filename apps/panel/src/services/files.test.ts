import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchFileContent } from './files.js';

const ok = (body: unknown) => ({
  ok: true, status: 200,
  headers: new Headers({ 'content-type': 'application/json' }),
  json: async () => body,
  text: async () => JSON.stringify(body),
}) as Response;

afterEach(() => vi.unstubAllGlobals());

describe('fetchFileContent', () => {
  it('dosya içeriğini döner', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ path: 'src/a.ts', size: 3, content: 'abc' })));
    expect((await fetchFileContent('p1', 'src/a.ts'))?.content).toBe('abc');
  });

  it('yolu URL için kodlar', async () => {
    const fetchMock = vi.fn<(url: string) => Promise<Response>>(
      async () => ok({ path: 'a b.ts', size: 1, content: 'x' }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await fetchFileContent('p1', 'src/a b.ts');
    expect(String(fetchMock.mock.calls[0]![0])).toContain('src%2Fa%20b.ts');
  });

  it('proje ya da yol boşsa istek atmaz', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchFileContent('', 'a.ts')).toBeNull();
    expect(await fetchFileContent('p1', '')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Yer tutucu uydurmak, kullanıcının dosyayı gördüğünü sanmasına yol açar.
  it('hata durumunda null döner, içerik uydurmaz', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ağ yok'); }));
    expect(await fetchFileContent('p1', 'a.ts')).toBeNull();
  });
});
