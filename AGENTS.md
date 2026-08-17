# Repository Guidelines

## Proje Yapısı ve Modül Düzeni

Bu depo, pnpm ve Turborepo kullanan bir TypeScript monorepo'sudur. Çalıştırılabilir uygulamalar `apps/` altında bulunur; mevcut NestJS API'sinin kaynakları `apps/server/src` dizinindedir. Panel `apps/panel` altındadır. Yeniden kullanılabilir çalışma alanları `packages/` altındadır: `shared` ortak tip ve sabitleri, `db` ClickHouse/Redis erişimi ile sıralı SQL migration'larını, `providers` LLM adaptörlerini/yönlendirmeyi/fiyatlandırmayı ve anahtar saklamayı, `agents` agent döngüleri ile iletişim servisini, `scheduler` görev durum makinesi ve güvenlik frenlerini, `memory` bağlam/özet/narrator katmanını, `executor` ise sandbox'lı tool çalıştırmayı ve kapı koşucusunu içerir. Testleri kaynak dosyanın yanında `*.test.ts` adıyla tutun. Mimari kararlar ve yol haritası `docs/` altındadır; önce `docs/00-genel-bakis.md` ve `docs/01-mimari.md` dosyalarını okuyun.

## Derleme, Test ve Geliştirme Komutları

- `pnpm install`: Tüm çalışma alanlarının bağımlılıklarını kurar. Node.js 22+ ve manifestte belirtilen pnpm `11.1.3` sürümünü kullanın.
- `docker compose up -d`: Yerel geliştirme ve entegrasyon testleri için ClickHouse'u `8124`, Redis'i `6380` portunda başlatır.
- `pnpm dev`: Kalıcı geliştirme görevlerini çalıştırır; şu anda sunucuyu izleme modunda başlatır.
- `pnpm build`: Çalışma alanlarını bağımlılık sırasına göre `dist/` dizinine derler.
- `pnpm test`: Tüm Vitest projelerini bir kez çalıştırır. Tek paket için `pnpm --filter @ww/providers test` kullanın.
- `pnpm lint`: ESLint kurallarını tüm kaynak dizinlerine uygular.

İnceleme istemeden önce derleme, test ve lint kontrollerini çalıştırın.

- `pnpm db:clean-tests`: Sızan `ww_test_*` veritabanlarını düşürür. Entegrasyon
  testi ORTASINDA düşerse `afterAll` çalışmaz ve veritabanı kalır; birikince
  ClickHouse kaynak baskısı altında İLGİSİZ testleri HTTP hatasıyla kırar.
  Açıklanamayan bağlantı hatalarında önce bunu koşun.
- `pnpm wiring:check`: "yazılmış ama hiç bağlanmamış kod" kapısı. Testte
  kullanılan ama hiçbir üretim kodundan çağrılmayan sembolleri bulur. Mevcut
  durum `wiring-baseline.json` içinde dondurulmuştur; kapı yalnız YENİ
  ihlallerde düşer. Bir sembolü bağladığınızda temel listeden düşürün.
  Yeni istisna eklerken GEREKÇE zorunludur:
  `{"symbol": "path.ts:name", "reason": "neden"}`. Gerekçesiz giriş yok
  sayılır ve kapı yine düşer — çıplak liste sessizce büyür.

## Kod Stili ve Adlandırma

TypeScript yapılandırması strict mod, unchecked-index ve exact-optional kontrollerini etkinleştirir. Mevcut biçimi izleyin: iki boşluk girinti, tek tırnak, noktalı virgül ve çok satırlı yapılarda son virgül. Depo NodeNext ESM kullanır; göreli TypeScript import'larında `.js` uzantısı yazın. Sınıf ve tiplerde `PascalCase`, fonksiyon, değişken ve yardımcı dosyalarda `camelCase`, sabitlerde `SCREAMING_SNAKE_CASE` kullanın. Controller'ları ince tutun, iş mantığını servislerde, veri erişimini `packages/db` içinde konumlandırın. Paketlerin herkese açık API'lerini `src/index.ts` üzerinden dışa aktarın. Kod sembolleri ve API adları İngilizce olmalıdır.

## Test İlkeleri

Vitest'in `describe`, `it` ve `expect` API'lerini kullanın; test adları gözlemlenebilir davranışı açıklamalıdır. Her davranış değişikliğine colocated bir `*.test.ts` ekleyin veya mevcut testi güncelleyin. Test açıklamaları mevcut pratikle uyumlu biçimde Türkçe olabilir. ClickHouse veya Redis kapalıyken entegrasyon testleri `describe.skipIf` ile atlanabilir; entegrasyon yollarını doğrularken Docker servislerini başlatın ve kapıyı `WW_REQUIRE_INTEGRATION=1 pnpm test` ile koşun (bu bayrak atlamayı hataya çevirir). Executor'ın canlı Docker sandbox testleri ayrıca `WW_DOCKER_LIVE=1` ister ve varsayılan koşuda sessizce atlanır; faz kapatırken `pnpm --filter @ww/executor runtime:build && pnpm --filter @ww/executor test:live` de koşulmalıdır. Yapılandırılmış bir coverage eşiği yoktur; başarı, hata, fallback ve idempotency senaryolarına öncelik verin.

## Commit ve Pull Request Kuralları

Geçmiş, `feat(providers): ...`, `feat(db): ...` ve `chore: ...` gibi scoped Conventional Commit biçimini izler. Commit özetleri mevcut geçmişte olduğu gibi Türkçe olabilir; her commit tek bir amaca odaklanmalıdır. Pull request açıklamasında amacı, doğrulama komutlarını, ilgili issue veya planları ve migration/yapılandırma etkilerini belirtin. Kullanıcıya görünen UI değişikliklerine ekran görüntüsü ekleyin. API anahtarlarını, kimlik bilgilerini veya yerel veri volume'lerini commit etmeyin.
