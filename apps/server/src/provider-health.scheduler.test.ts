import { afterEach, describe, expect, it, vi } from 'vitest';
import { HEALTH_SWEEP_INTERVAL_MS } from './provider-health.service.js';
import { ProviderHealthScheduler } from './provider-health.scheduler.js';

/**
 * Sağlık taramasının ZAMANLAYICI sarmalayıcısı.
 *
 * NEDEN VAR: saf tarama mantığının (provider-health.service.ts) 21 testi
 * vardı ama onu ÇALIŞTIRAN sınıfın hiç testi yoktu. CLAUDE.md sağlayıcı
 * sağlık kontrolünü "yazılmış ama hiçbir üretim kodu çağırmıyor" kusurunun
 * yaşandığı yerlerden biri olarak anıyor: mekanizmanın varlığı, koştuğunu
 * kanıtlamaz.
 */
const scheduler = (database: unknown = { ch: {} }) =>
  new ProviderHealthScheduler(database as never);

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete process.env['WW_DISABLE_HEALTH_SWEEP'];
});

describe('ProviderHealthScheduler', () => {
  it('WW_DISABLE_HEALTH_SWEEP=1 iken hiç taramaz', () => {
    process.env['WW_DISABLE_HEALTH_SWEEP'] = '1';
    vi.useFakeTimers();
    const instance = scheduler();
    const sweep = vi.spyOn(instance, 'sweep').mockResolvedValue(undefined);

    instance.onModuleInit();

    expect(sweep).not.toHaveBeenCalled();
    // Zamanlayıcı da kurulmamalı: kapalı bir tarama, sessizce dakikada bir
    // koşmaya devam etmemelidir.
    vi.advanceTimersByTime(HEALTH_SWEEP_INTERVAL_MS * 3);
    expect(sweep).not.toHaveBeenCalled();
    instance.onModuleDestroy();
  });

  it('açılışta HEMEN bir tarama yapar', () => {
    vi.useFakeTimers();
    const instance = scheduler();
    const sweep = vi.spyOn(instance, 'sweep').mockResolvedValue(undefined);

    instance.onModuleInit();

    // İlk taramayı bir dakika beklemek, açılıştaki bozuk sağlayıcıyı bir
    // dakika boyunca "sağlıklı" göstermek demekti.
    expect(sweep).toHaveBeenCalledTimes(1);
    instance.onModuleDestroy();
  });

  it('aralıkla tekrar tarar', () => {
    vi.useFakeTimers();
    const instance = scheduler();
    const sweep = vi.spyOn(instance, 'sweep').mockResolvedValue(undefined);

    instance.onModuleInit();
    vi.advanceTimersByTime(HEALTH_SWEEP_INTERVAL_MS * 2);

    expect(sweep.mock.calls.length).toBeGreaterThanOrEqual(3);
    instance.onModuleDestroy();
  });

  it('onModuleDestroy zamanlayıcıyı durdurur', () => {
    vi.useFakeTimers();
    const instance = scheduler();
    const sweep = vi.spyOn(instance, 'sweep').mockResolvedValue(undefined);

    instance.onModuleInit();
    const afterInit = sweep.mock.calls.length;
    instance.onModuleDestroy();
    vi.advanceTimersByTime(HEALTH_SWEEP_INTERVAL_MS * 5);

    // Kapatılmış bir zamanlayıcının koşmaya devam etmesi, test sürecini de
    // canlı tutar ve süreç sonlanmaz.
    expect(sweep.mock.calls.length).toBe(afterInit);
  });

  it('iki kez destroy edilmek hata vermez', () => {
    const instance = scheduler();
    vi.spyOn(instance, 'sweep').mockResolvedValue(undefined);
    instance.onModuleInit();
    expect(() => { instance.onModuleDestroy(); instance.onModuleDestroy(); }).not.toThrow();
  });

  // TARAMA HATASI UYGULAMAYI DÜŞÜRMEZ ama sessiz de kalmaz: periyodik bir
  // görev içinde yakalanmamış reddetme, Node'da süreci sonlandırabilir.
  it('tarama düşerse hatayı yutar ve süreci düşürmez', async () => {
    const instance = scheduler({
      get ch(): never { throw new Error('clickhouse kapalı'); },
    });
    await expect(instance.sweep()).resolves.toBeUndefined();
  });
});
