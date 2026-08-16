import { describe, expect, it, vi } from 'vitest';
import { fetchProviders, saveProviderKey, upsertProvider, type Provider } from './providers.js';

const provider: Provider = {
  provider_id: 'deepseek',
  display_name: 'DeepSeek',
  base_url: 'https://api.deepseek.com',
  models: ['deepseek-chat'],
  enabled: true,
  is_default: true,
  fallback_order: 0,
  keyConfigured: false,
  maskedKey: '',
  health_status: 'unknown',
};

const jsonResponse = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' }, ...init });

describe('fetchProviders', () => {
  it('sağlayıcı listesini çeker ve base URL sonundaki eğik çizgiyi normalize eder', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([provider])) as unknown as typeof fetch;
    await expect(fetchProviders({ baseUrl: 'http://localhost:4000/', fetchImpl })).resolves.toEqual([provider]);
    expect(fetchImpl).toHaveBeenCalledWith('http://localhost:4000/providers', expect.any(Object));
  });

  it('liste dışı gövdeyi reddeder', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ nope: true })) as unknown as typeof fetch;
    await expect(fetchProviders({ baseUrl: '', fetchImpl })).rejects.toThrow(/geçersiz/i);
  });

  it('başarısız yanıtta hata verir', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([], { status: 500 })) as unknown as typeof fetch;
    await expect(fetchProviders({ baseUrl: '', fetchImpl })).rejects.toThrow(/500/);
  });
});

describe('saveProviderKey', () => {
  it('anahtarı yetkili POST ile gönderir ve yalnız maskeli değeri döner', async () => {
    const mock = vi.fn(async () =>
      jsonResponse({ providerId: 'deepseek', configured: true, maskedKey: 'sk-…9abc' }));
    const fetchImpl = mock as unknown as typeof fetch;

    const result = await saveProviderKey('deepseek', 'sk-gercek-anahtar-123', {
      baseUrl: 'http://localhost:4000', fetchImpl, sessionToken: 'tok',
    });

    expect(result).toEqual({ providerId: 'deepseek', configured: true, maskedKey: 'sk-…9abc' });
    const [url, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://localhost:4000/providers/deepseek/key');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer tok');
    // Ham anahtar yalnızca istek gövdesinde gider; dönen değerde asla bulunmaz.
    expect(JSON.stringify(result)).not.toContain('sk-gercek-anahtar-123');
  });

  it('boş anahtarı sunucuya hiç göndermez', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(saveProviderKey('deepseek', '   ', { fetchImpl, sessionToken: 't' })).rejects.toThrow(/boş/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('sağlayıcı kimliğini URL için kodlar', async () => {
    const mock = vi.fn(async () => jsonResponse({ providerId: 'a/b', configured: true, maskedKey: 'x' }));
    await saveProviderKey('a/b', 'sk-12345678', {
      baseUrl: '', fetchImpl: mock as unknown as typeof fetch, sessionToken: 't',
    });
    expect((mock.mock.calls[0] as unknown as [string, RequestInit])[0]).toBe('/providers/a%2Fb/key');
  });

  it('401 yanıtında oturum tokenına işaret eden hata verir', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, { status: 401 })) as unknown as typeof fetch;
    await expect(saveProviderKey('deepseek', 'sk-12345678', { fetchImpl, sessionToken: 'yanlis' }))
      .rejects.toThrow(/oturum/i);
  });
});

describe('upsertProvider', () => {
  it('sağlayıcı yapılandırmasını PATCH ile kaydeder', async () => {
    const mock = vi.fn(async () => jsonResponse({ ...provider, key_ref: '' }));

    await upsertProvider({
      providerId: 'deepseek', displayName: 'DeepSeek', baseUrl: 'https://api.deepseek.com',
      models: ['deepseek-chat'], enabled: true, isDefault: true, fallbackOrder: 0,
    }, { baseUrl: '', fetchImpl: mock as unknown as typeof fetch, sessionToken: 'tok' });

    const [url, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/providers/deepseek');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body))).toEqual({
      displayName: 'DeepSeek', baseUrl: 'https://api.deepseek.com',
      models: ['deepseek-chat'], enabled: true, isDefault: true, fallbackOrder: 0,
    });
  });

  it('kimliksiz kaydı reddeder', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(upsertProvider({
      providerId: '  ', displayName: 'X', baseUrl: '', models: [], enabled: true, isDefault: false, fallbackOrder: 0,
    }, { fetchImpl, sessionToken: 't' })).rejects.toThrow(/kimli/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
