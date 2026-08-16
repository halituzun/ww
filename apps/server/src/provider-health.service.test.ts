import { describe, expect, it, vi } from 'vitest';
import { runHealthSweep, type HealthSweepPorts } from './provider-health.service.js';

const provider = (over: Partial<{ provider_id: string; enabled: boolean; key_ref: string; health_status: string }> = {}) => ({
  provider_id: 'deepseek', display_name: 'DeepSeek', base_url: '', enabled: true,
  is_default: false, fallback_order: 0, models: ['deepseek-chat'], key_ref: 'deepseek',
  health_status: 'unknown', last_health_check: '1970-01-01T00:00:00.000Z',
  updated_at: '1970-01-01T00:00:00.000Z', version: '1',
  ...over,
});

function ports(over: Partial<HealthSweepPorts> = {}): HealthSweepPorts {
  return {
    listProviders: async () => [provider()],
    ping: async () => ({ ok: true, latencyMs: 5 }),
    errorRate: async () => undefined,
    persist: vi.fn(async () => undefined),
    publish: vi.fn(async () => undefined),
    now: () => '2026-08-17T00:00:00.000Z',
    ...over,
  };
}

describe('runHealthSweep', () => {
  it('başarılı pingden sonra durumu ok olarak kalıcılaştırır', async () => {
    const persist = vi.fn(async () => undefined);
    const result = await runHealthSweep(ports({ persist }), new Map());

    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist.mock.calls[0]![0]).toMatchObject({ provider_id: 'deepseek', health_status: 'ok' });
    expect(result.get('deepseek')).toBe(0);
  });

  it('art arda hataları sayar ve üçüncüde down yazar', async () => {
    const persist = vi.fn(async () => undefined);
    const failing = ports({ persist, ping: async () => ({ ok: false, latencyMs: 1, error: 'boom' }) });

    let state = new Map<string, number>();
    for (let i = 0; i < 3; i += 1) state = await runHealthSweep(failing, state);

    expect(state.get('deepseek')).toBe(3);
    expect(persist.mock.calls.at(-1)![0]).toMatchObject({ health_status: 'down' });
  });

  it('pasif sağlayıcıyı hiç pinglemez', async () => {
    const ping = vi.fn(async () => ({ ok: true, latencyMs: 1 }));
    await runHealthSweep(ports({
      ping,
      listProviders: async () => [provider({ provider_id: 'pasif', enabled: false })],
    }), new Map());
    expect(ping).not.toHaveBeenCalled();
  });

  // Anahtarsız sağlayıcı 'unknown' kalmamalı: kullanıcı 'yapılandırılmamış' ile
  // 'hiç kontrol edilmemiş'i ayırt edebilmeli. Kalıcı eksiklik yumuşatılmaz.
  it('fatal ping (anahtar yok) art arda beklemeden doğrudan down yazar', async () => {
    const persist = vi.fn(async () => undefined);
    const state = await runHealthSweep(ports({
      persist,
      ping: async () => ({ ok: false, latencyMs: 1, error: 'anahtar yok', fatal: true }),
    }), new Map());

    expect(persist.mock.calls[0]![0]).toMatchObject({ health_status: 'down' });
    // Kalıcı hata art arda sayacını şişirmez; anahtar girilince tek pingle toparlar.
    expect(state.get('deepseek')).toBe(0);
  });

  it('durum değişmediyse gereksiz yazma ve yayın yapmaz', async () => {
    const persist = vi.fn(async () => undefined);
    const publish = vi.fn(async () => undefined);
    const stable = ports({ persist, publish, listProviders: async () => [provider({ health_status: 'ok' })] });

    await runHealthSweep(stable, new Map());
    expect(persist).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('durum değişiminde panele yayın yapar', async () => {
    const publish = vi.fn(async () => undefined);
    await runHealthSweep(ports({ publish }), new Map());
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'deepseek', status: 'ok',
    }));
  });

  it('hata oranı eşiği aşarsa ping geçse bile degraded yazar', async () => {
    const persist = vi.fn(async () => undefined);
    await runHealthSweep(ports({ persist, errorRate: async () => 0.9 }), new Map());
    expect(persist.mock.calls[0]![0]).toMatchObject({ health_status: 'degraded' });
  });

  // Bir sağlayıcının hatası taramanın kalanını düşürmemeli.
  it('tek sağlayıcıdaki istisna diğerlerini engellemez', async () => {
    const persist = vi.fn(async () => undefined);
    await runHealthSweep(ports({
      persist,
      listProviders: async () => [provider({ provider_id: 'patlayan' }), provider({ provider_id: 'saglam' })],
      ping: async (id: string) => {
        if (id === 'patlayan') throw new Error('adapter yok');
        return { ok: true, latencyMs: 2 };
      },
    }), new Map());

    const written = persist.mock.calls.map((call) => (call[0] as { provider_id: string }).provider_id);
    expect(written).toContain('saglam');
  });

  // Regresyon: geniş catch bir kez gerçek bir programlama hatasını (index'ten
  // dışa açılmamış evaluateHealth) sessizce yuttu. Hata artık gözlemlenebilir.
  it('yutulan hatayı onError ile bildirir', async () => {
    const onError = vi.fn();
    await runHealthSweep(ports({
      onError,
      ping: async () => { throw new Error('adapter yok'); },
    }), new Map());

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0]).toBe('deepseek');
    expect((onError.mock.calls[0]![1] as Error).message).toMatch(/adapter yok/);
  });
});
