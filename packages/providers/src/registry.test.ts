import { describe, expect, it, vi } from 'vitest';
import { buildProviderRegistry, type ProviderRecord } from './registry.js';

const record = (over: Partial<ProviderRecord> = {}): ProviderRecord => ({
  provider_id: 'deepseek',
  base_url: 'https://api.deepseek.com',
  enabled: true,
  models: ['deepseek-chat'],
  key_ref: 'deepseek',
  ...over,
});

const keys = (map: Record<string, string>) => ({
  get: async (id: string) => map[id],
});

describe('buildProviderRegistry', () => {
  it('anahtarı olan etkin sağlayıcı için adaptör kurar', async () => {
    const registry = await buildProviderRegistry([record()], keys({ deepseek: 'sk-x1234567' }));
    expect(registry.providers.get('deepseek')?.id).toBe('deepseek');
    expect(registry.skipped).toEqual([]);
  });

  it('pasif sağlayıcıyı kurmaz ve sebebini bildirir', async () => {
    const registry = await buildProviderRegistry(
      [record({ enabled: false })], keys({ deepseek: 'sk-x1234567' }));
    expect(registry.providers.size).toBe(0);
    expect(registry.skipped[0]).toMatchObject({ providerId: 'deepseek', reason: 'disabled' });
  });

  // Anahtarsız sağlayıcı SESSİZCE atlanmamalı: neden çalışmadığı görünmeli.
  it('anahtarsız sağlayıcıyı kurmaz ve sebebini bildirir', async () => {
    const registry = await buildProviderRegistry([record()], keys({}));
    expect(registry.providers.size).toBe(0);
    expect(registry.skipped[0]).toMatchObject({ providerId: 'deepseek', reason: 'no_key' });
  });

  it('bilinmeyen sağlayıcı türünü OpenAI-uyumlu sayar ama base_url zorunludur', async () => {
    const withUrl = await buildProviderRegistry(
      [record({ provider_id: 'yerel', base_url: 'https://ornek.test', key_ref: 'yerel' })],
      keys({ yerel: 'sk-x1234567' }));
    expect(withUrl.providers.get('yerel')?.id).toBe('yerel');

    const withoutUrl = await buildProviderRegistry(
      [record({ provider_id: 'yerel', base_url: '', key_ref: 'yerel' })], keys({ yerel: 'sk-x1234567' }));
    expect(withoutUrl.skipped[0]).toMatchObject({ reason: 'no_base_url' });
  });

  it('anthropic ve openai için doğru adaptörü seçer', async () => {
    const registry = await buildProviderRegistry([
      record({ provider_id: 'anthropic', base_url: '', models: ['claude-sonnet-5'], key_ref: 'anthropic' }),
      record({ provider_id: 'openai', base_url: '', models: ['gpt-5-mini'], key_ref: 'openai' }),
    ], keys({ anthropic: 'sk-ant-123456', openai: 'sk-oai-123456' }));

    expect(registry.providers.get('anthropic')?.id).toBe('anthropic');
    expect(registry.providers.get('openai')?.id).toBe('openai');
    expect(registry.providers.get('openai')?.listModels()).toContain('gpt-5-mini');
  });

  it('bir sağlayıcının kurulum hatası diğerlerini düşürmez', async () => {
    const registry = await buildProviderRegistry([
      record({ provider_id: 'patlayan', key_ref: 'patlayan' }),
      record({ provider_id: 'openai', base_url: '', key_ref: 'openai', models: ['gpt-5-mini'] }),
    ], {
      get: async (id: string) => {
        if (id === 'patlayan') throw new Error('keystore bozuk');
        return 'sk-oai-123456';
      },
    });

    expect(registry.providers.has('openai')).toBe(true);
    expect(registry.skipped.some((entry) => entry.providerId === 'patlayan')).toBe(true);
  });

  it('anahtar deposunu sağlayıcı başına yalnız bir kez okur', async () => {
    const get = vi.fn(async () => 'sk-x1234567');
    await buildProviderRegistry([record()], { get });
    expect(get).toHaveBeenCalledTimes(1);
  });
});
