import { describe, expect, it, vi } from 'vitest';
import { runHealthSweep, type HealthSweepPorts } from './provider-health.service.js';

const provider = (over: Partial<{ provider_id: string; base_url: string; enabled: boolean; key_ref: string; health_status: string }> = {}) => ({
  provider_id: 'deepseek', display_name: 'DeepSeek', base_url: 'https://api.deepseek.com', enabled: true,
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
    recordUsage: vi.fn(async () => undefined),
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
    expect(persist.mock.calls[0]![0]).toMatchObject({ providerId: 'deepseek', healthStatus: 'ok' });
    expect(result.get('deepseek')).toBe(0);
  });

  it('art arda hataları sayar ve üçüncüde down yazar', async () => {
    const persist = vi.fn(async () => undefined);
    const failing = ports({ persist, ping: async () => ({ ok: false, latencyMs: 1, error: 'boom' }) });

    let state = new Map<string, number>();
    for (let i = 0; i < 3; i += 1) state = await runHealthSweep(failing, state);

    expect(state.get('deepseek')).toBe(3);
    expect(persist.mock.calls.at(-1)![0]).toMatchObject({ healthStatus: 'down' });
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

    expect(persist.mock.calls[0]![0]).toMatchObject({ healthStatus: 'down' });
    // Kalıcı hata art arda sayacını şişirmez; anahtar girilince tek pingle toparlar.
    expect(state.get('deepseek')).toBe(0);
  });

  it('durum değişmediyse panele yayın yapmaz', async () => {
    const publish = vi.fn(async () => undefined);
    const stable = ports({ publish, listProviders: async () => [provider({ health_status: 'ok' })] });

    await runHealthSweep(stable, new Map());
    expect(publish).not.toHaveBeenCalled();
  });

  // ASIL KUSUR: damga yalnızca durum değişiminde yazılırsa panelde "son kontrol"
  // saatlerce donuk kalır ve ÖLMÜŞ bir tarayıcı sağlıklı olandan ayırt edilemez.
  it('durum değişmese de son kontrol damgasını tazeler', async () => {
    const persist = vi.fn(async () => undefined);
    const stable = ports({ persist, listProviders: async () => [provider({ health_status: 'ok' })] });

    await runHealthSweep(stable, new Map());
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist.mock.calls[0]![0]).toMatchObject({
      providerId: 'deepseek',
      healthStatus: 'ok',
      checkedAt: '2026-08-17T00:00:00.000Z',
    });
  });

  // Tazeleme mevcut durumu değiştirmemeli; yoksa kalp atışı veriyi bozar.
  it('tazeleme sırasında durumu değiştirmez', async () => {
    const persist = vi.fn(async () => undefined);
    const degraded = ports({
      persist,
      errorRate: async () => 0.9,
      listProviders: async () => [provider({ health_status: 'degraded' })],
    });

    await runHealthSweep(degraded, new Map());
    expect(persist.mock.calls[0]![0]).toMatchObject({ healthStatus: 'degraded' });
  });

  it('pasif sağlayıcı için damga tazelemez', async () => {
    const persist = vi.fn(async () => undefined);
    const disabled = ports({ persist, listProviders: async () => [provider({ enabled: false })] });

    await runHealthSweep(disabled, new Map());
    expect(persist).not.toHaveBeenCalled();
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
    expect(persist.mock.calls[0]![0]).toMatchObject({ healthStatus: 'degraded' });
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

    const written = persist.mock.calls.map((call) => (call[0] as { providerId: string }).providerId);
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

  // docs/04: periyodik ping purpose='health_check' olarak kaydedilir.
  // Kayıt yoksa iki şey birden kaybolur: kontör panosunda ping maliyeti ve
  // mv_provider_errors'tan beslenen hata-oranı sinyali (degraded yolu ölü kalır).
  it('başarılı ping health_check olarak kaydedilir', async () => {
    const recordUsage = vi.fn(async () => undefined);
    await runHealthSweep(ports({ recordUsage }), new Map());

    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(recordUsage.mock.calls[0]![0]).toMatchObject({
      providerId: 'deepseek', purpose: 'health_check', status: 'ok',
    });
  });

  it('başarısız ping hata olarak kaydedilir', async () => {
    const recordUsage = vi.fn(async () => undefined);
    await runHealthSweep(ports({
      recordUsage,
      ping: async () => ({ ok: false, latencyMs: 12, error: 'timeout' }),
    }), new Map());

    expect(recordUsage.mock.calls[0]![0]).toMatchObject({ status: 'error', latencyMs: 12 });
  });

  // Durum değişmese bile ping YAPILDI: kaydı düşmek hata oranını çarpıtır.
  it('durum değişmese de ping kaydedilir', async () => {
    const recordUsage = vi.fn(async () => undefined);
    const persist = vi.fn(async () => undefined);
    await runHealthSweep(ports({
      recordUsage, persist,
      listProviders: async () => [provider({ health_status: 'ok' })],
    }), new Map());

    expect(recordUsage).toHaveBeenCalledTimes(1); // ping kaydedildi
    expect(persist).toHaveBeenCalledTimes(1);     // ve damga tazelendi
  });

  it('pasif sağlayıcı için kayıt üretmez', async () => {
    const recordUsage = vi.fn(async () => undefined);
    await runHealthSweep(ports({
      recordUsage,
      listProviders: async () => [provider({ enabled: false })],
    }), new Map());
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it('kayıt hatası taramayı düşürmez', async () => {
    const persist = vi.fn(async () => undefined);
    await runHealthSweep(ports({
      persist,
      recordUsage: async () => { throw new Error('clickhouse düştü'); },
    }), new Map());
    // Kayıt patlasa da sağlık durumu yazılmaya devam etmeli.
    expect(persist).toHaveBeenCalled();
  });

  // ÖLÇÜLDÜ (canlı ClickHouse, 2026-08-18): `mock` sağlayıcısına 1352 kez ping
  // atılmış ve hepsi `no_key` hatası vermiş. `mock` TAKLİTTİR — `base_url`'ü
  // boştur, ağ çağrısı yapmaz; konsey kodu onu zaten üye saymıyor.
  //
  // Bedeli üç katlı: (1) bu satırlar tüm api_usage tablosunun %45'i,
  // (2) mv_provider_errors'tan beslenen hata oranını kalıcı olarak şişiriyor,
  // (3) panelde sonsuza dek kırmızı duran sahte bir alarm — kullanıcıyı
  // kırmızıyı görmezden gelmeye alıştırır.
  //
  // NOT: anahtarsız GERÇEK sağlayıcı atlanmaya devam ETMEZ; o hâlâ pinglenip
  // 'down' yazılır (yapılandırma eksikliği gerçek bir sağlık sorunudur).
  it('taklit saglayiciyi (base_url bos) hic pinglemez', async () => {
    const ping = vi.fn(async () => ({ ok: false, latencyMs: 0, error: 'no_key', fatal: true }));
    const persist = vi.fn(async () => undefined);
    const recordUsage = vi.fn(async () => undefined);
    await runHealthSweep(ports({
      listProviders: async () => [provider({ provider_id: 'mock', base_url: '', key_ref: '' })],
      ping, persist, recordUsage,
    }), new Map());

    expect(ping).not.toHaveBeenCalled();
    // Kontör kaydı da yazılmaz: sahte hata satırı üretmek tabloyu kirletir.
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it('anahtarsiz GERCEK saglayiciyi yine de pingler', async () => {
    const ping = vi.fn(async () => ({ ok: false, latencyMs: 0, error: 'no_key', fatal: true }));
    await runHealthSweep(ports({
      listProviders: async () => [provider({ key_ref: '' })],
      ping,
    }), new Map());

    expect(ping).toHaveBeenCalledTimes(1);
  });

  // Ping'i kesmek TEK BAŞINA yetmez: taklit sağlayıcı en son yazılan
  // durumda (canlı veride 'down') donup kalır ve panelde sonsuza dek kırmızı
  // görünür — yani düzeltmek istediğimiz sahte alarm sürer. Taklit için
  // dürüst durum 'unknown'dır: onu hiç kontrol etmiyoruz.
  it('taklit saglayicinin bayat down durumunu unknowna cevirir', async () => {
    const persist = vi.fn(async () => undefined);
    await runHealthSweep(ports({
      listProviders: async () => [provider({ provider_id: 'mock', base_url: '', health_status: 'down' })],
      persist,
    }), new Map());

    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist.mock.calls[0]![0]).toMatchObject({ providerId: 'mock', healthStatus: 'unknown' });
  });

  it('zaten unknown olan taklit saglayiciyi bosuna yazmaz', async () => {
    const persist = vi.fn(async () => undefined);
    await runHealthSweep(ports({
      listProviders: async () => [provider({ provider_id: 'mock', base_url: '', health_status: 'unknown' })],
      persist,
    }), new Map());

    expect(persist).not.toHaveBeenCalled();
  });
});
