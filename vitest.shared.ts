// Entegrasyon testi koşan paketler için ortak vitest ayarları.
//
// NEDEN VAR: her paketin `vitest.config.ts` dosyası `export default {}` idi,
// yani vitest varsayılanları geçerliydi: test başına 5 sn, hook başına 10 sn
// ve dosyalar CPU sayısı kadar paralel fork'ta. Bu depoda 40 test dosyası
// `beforeAll` içinde `runMigrations` çağırıp TEK ClickHouse sunucusuna
// yükleniyor; `pnpm test` ise `turbo test --concurrency=1` ile PAKETLERİ
// sıralar, dosyaları değil.
//
// Sonuç, CLAUDE.md'de "yalnız tam kapı yükü altında dalgalanan testler" diye
// belgelenen listeydi: her koşuda BAŞKA bir dosya düşüyordu. Bu oturumda da
// iki kapı koşusuna mal oldu (migrate.test.ts, sonra plans/prompts/tasks).
//
// Zaman aşımını uzatmak testi yavaşlatmaz — yalnız yük altında erken kesmeyi
// engeller. Dosya paralelliğini sınırlamak ClickHouse'a aynı anda binen
// migration sayısını düşürür.
export const integrationDefaults = {
  test: {
    // Gerçek ClickHouse'a migration uygulayan bir beforeAll 10 sn'ye
    // sığmayabilir; sığmadığında hata testin kendisiyle ilgisizdir.
    testTimeout: 20_000,
    hookTimeout: 45_000,
    // Aynı anda en çok dört dosya: tek ClickHouse sunucusuna binen eşzamanlı
    // DDL sayısını sınırlar. `pool` AÇIKÇA verilir; yoksa vitest thread
    // havuzunu kullanıp "minThreads/maxThreads çakışıyor" ile düşüyor.
    pool: 'forks' as const,
    poolOptions: { forks: { minForks: 1, maxForks: 4 } },
  },
} as const;
