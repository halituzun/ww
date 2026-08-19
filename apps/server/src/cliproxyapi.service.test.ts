import { afterEach, describe, expect, it, vi } from 'vitest';
import { CliproxyApiService } from './cliproxyapi.service.js';

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env['WW_CLIPROXY_ENABLED'];
  delete process.env['WW_CLIPROXY_BASE_URL'];
  delete process.env['WW_CLIPROXY_MANAGEMENT_KEY'];
});

describe('CliproxyApiService', () => {
  it('gateway kapaliysa bunu acikca bildirir', async () => {
    await expect(new CliproxyApiService().status()).resolves.toMatchObject({ state: 'not_configured', baseUrl: 'http://127.0.0.1:8317' });
  });

  it('management anahtari yoksa secret istemeden unauthorized doner', async () => {
    process.env['WW_CLIPROXY_ENABLED'] = '1';
    await expect(new CliproxyApiService().status()).resolves.toMatchObject({ state: 'unauthorized' });
  });

  it('config probe sonucunda sir sayilari doner, anahtari asla responsea koymaz', async () => {
    process.env['WW_CLIPROXY_ENABLED'] = '1';
    process.env['WW_CLIPROXY_MANAGEMENT_KEY'] = 'secret-management-key';
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.headers).toEqual({ Authorization: 'Bearer secret-management-key' });
      return new Response(JSON.stringify({ 'api-keys': ['one', 'two'], 'model-mapping': [{ name: 'gpt' }] }), { status: 200 });
    }));
    await expect(new CliproxyApiService().status()).resolves.toEqual({
      state: 'connected', baseUrl: 'http://127.0.0.1:8317', managementUrl: 'http://127.0.0.1:8317/management.html', modelCount: 1, accountCount: 2,
    });
  });
});
