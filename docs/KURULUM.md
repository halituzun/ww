# ww yerel kurulum

Gereksinimler: Node.js 22+, pnpm 11.1.3 ve Docker.

```bash
pnpm install
docker compose up -d
pnpm build
pnpm lint
WW_REQUIRE_INTEGRATION=1 pnpm test
pnpm --filter @ww/executor runtime:build
```

Sunucu `http://localhost:4000`, panel geliştirme sunucusu ise Vite varsayılan
portunda çalışır. `WW_CH_URL`, `WW_REDIS_URL` ve `WW_LOCAL_SESSION_TOKEN`
ortam değişkenleri ile bağlantılar ve yerel oturum belirlenir. Üretim executor
komutları Docker sandbox içinde çalışır; host çalışma alanı container'a canlı
olarak bağlanmaz.

Sağlayıcı anahtar yönetimi için `WW_MASTER_KEY` 64 karakterlik hex (32 bayt)
olarak verilebilir; anahtarlar `WW_KEYSTORE_FILE` ile belirtilen şifreli dosyada
AES-256-GCM olarak tutulur. Panel sağlayıcı anahtarını yalnız yetkili yerel
oturumla gönderir ve yalnız maskeli değer döner.

## Küçük uçtan uca denemeler

- Web: `packages/executor/templates/web` ile panelde proje oluşturup görev
  hedeflerini izleyin.
- API: `packages/executor/templates/api` minimal health endpoint'i içerir.
- Mobil: `packages/executor/templates/mobile` Flutter başlangıç sözleşmesini ve
  test kapısını içerir; gerçek AVD bağlantısı injected adapter üzerinden yapılır.
