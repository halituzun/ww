import { describe, expect, it } from 'vitest';
import { ProviderRateLimiter, TokenBucket } from './rate-limiter.js';

describe('TokenBucket', () => {
  it('sinirsizken hep hemen izin verir', () => {
    const bucket = new TokenBucket({ perMinute: 0 });
    expect(bucket.unlimited).toBe(true);
    for (let index = 0; index < 100; index += 1) expect(bucket.reserve()).toBe(0);
  });

  it('kapasite kadar istegi beklemeden gecirir', () => {
    const now = 0;
    const bucket = new TokenBucket({ perMinute: 3, now: () => now });
    expect([bucket.reserve(), bucket.reserve(), bucket.reserve()]).toEqual([0, 0, 0]);
  });

  // Kova kapasitesi kadar ANİ isteği geçirir (token-bucket tanımı); asıl
  // soru kapasite bitince ne olduğudur. İstek DÜŞÜRÜLMEZ, bekletilir
  // (docs/07: "router bekletir").
  it('kapasite bitince bekleme suresi doner', () => {
    const now = 0;
    const bucket = new TokenBucket({ perMinute: 1, now: () => now });
    expect(bucket.reserve()).toBe(0);
    expect(bucket.reserve()).toBeGreaterThan(0);
  });

  it('zaman gectikce jeton yeniden dolar', () => {
    let now = 0;
    const bucket = new TokenBucket({ perMinute: 1, now: () => now });
    bucket.reserve();
    now += 60_000;
    expect(bucket.reserve()).toBe(0);
  });

  // Aynı anda gelen istekler aynı bekleme süresini PAYLAŞMAMALI; yoksa
  // beklemeden sonra hep birlikte patlarlar.
  it('es zamanli istekler artan sure bekler', () => {
    const now = 0;
    const bucket = new TokenBucket({ perMinute: 1, now: () => now });
    bucket.reserve();
    const first = bucket.reserve();
    const second = bucket.reserve();
    expect(second).toBeGreaterThan(first);
  });

  // Saat geriye giderse sınırı gevşetmek yerine bekletiriz.
  it('saat geriye giderse jeton uretmez', () => {
    let now = 10_000;
    const bucket = new TokenBucket({ perMinute: 1, now: () => now });
    bucket.reserve();
    now = 0;
    expect(bucket.reserve()).toBeGreaterThan(0);
  });

  // Uzun boşluktan sonra jeton KAPASİTEYİ aşarak birikmemeli; yoksa tek
  // seferde devasa bir patlama olur.
  it('kapasitenin ustunde birikmez', () => {
    let now = 0;
    const bucket = new TokenBucket({ perMinute: 2, now: () => now });
    now += 600_000;
    expect([bucket.reserve(), bucket.reserve()]).toEqual([0, 0]);
    expect(bucket.reserve()).toBeGreaterThan(0);
  });

  it('gecersiz sinir sinirsiz sayilir', () => {
    expect(new TokenBucket({ perMinute: Number.NaN }).unlimited).toBe(true);
    expect(new TokenBucket({ perMinute: -5 }).unlimited).toBe(true);
  });
});

describe('ProviderRateLimiter', () => {
  // Bir sağlayıcının sınırı diğerini etkilememeli.
  it('saglayicilari birbirinden ayirir', () => {
    const now = 0;
    const limiter = new ProviderRateLimiter(
      (id) => (id === 'yavas' ? 1 : 0), () => now);
    limiter.reserve('yavas');
    expect(limiter.reserve('yavas')).toBeGreaterThan(0);
    expect(limiter.reserve('hizli')).toBe(0);
  });

  it('ayni saglayici icin kovayi yeniden kullanir', () => {
    const now = 0;
    const limiter = new ProviderRateLimiter(() => 1, () => now);
    limiter.reserve('a');
    expect(limiter.reserve('a')).toBeGreaterThan(0);
  });
});
