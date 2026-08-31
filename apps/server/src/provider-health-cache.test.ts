import { describe, expect, it } from 'vitest';
import { ProviderHealthCache, HEALTH_CACHE_MAX_AGE_MS } from './provider-health-cache.js';

const rows = (status: string) => [{ provider_id: 'deepseek', health_status: status }];

describe('ProviderHealthCache', () => {
  it('hic yuklenmediyse unknown der: kapi varsayilan olarak ACIK kalir', () => {
    const cache = new ProviderHealthCache(async () => rows('down'));
    // Henüz okumadan 'down' demek, açılışta TÜM sağlayıcıları eleyip
    // sistemi kendi bilgisizliğiyle kapatmak olurdu.
    expect(cache.statusOf('deepseek')).toBe('unknown');
  });

  it('yuklendikten sonra gercek durumu doner', async () => {
    const cache = new ProviderHealthCache(async () => rows('down'));
    await cache.refresh();
    expect(cache.statusOf('deepseek')).toBe('down');
    expect(cache.statusOf('bilinmeyen')).toBe('unknown');
  });

  it('kayit bayatlayinca unknowna doner: olu tazeleyici saglayiciyi kalici kara listeye almaz', async () => {
    let now = 1_000;
    const cache = new ProviderHealthCache(async () => rows('down'), { now: () => now });
    await cache.refresh();
    expect(cache.statusOf('deepseek')).toBe('down');

    now += HEALTH_CACHE_MAX_AGE_MS + 1;
    expect(cache.statusOf('deepseek')).toBe('unknown');
  });

  it('bayat okumada tazelemeyi tetikler ama BEKLEMEZ', async () => {
    let now = 1_000;
    let loads = 0;
    const cache = new ProviderHealthCache(async () => { loads += 1; return rows('ok'); }, { now: () => now });
    await cache.refresh();
    expect(loads).toBe(1);

    now += HEALTH_CACHE_MAX_AGE_MS + 1;
    cache.statusOf('deepseek'); // senkron: yükleme beklenmez
    await Promise.resolve();
    await Promise.resolve();
    expect(loads).toBe(2);
  });

  it('tazeleme hatasi patlamaz, onceki degeri korur', async () => {
    let fail = false;
    const seen: unknown[] = [];
    const cache = new ProviderHealthCache(
      async () => { if (fail) throw new Error('clickhouse yok'); return rows('down'); },
      { onError: (reason) => seen.push(reason) },
    );
    await cache.refresh();
    fail = true;
    await cache.refresh();

    expect(cache.statusOf('deepseek')).toBe('down');
    expect(seen).toHaveLength(1);
  });
});
