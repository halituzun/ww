# ww — Depo Kılavuzu (AI Agent'ları için)

> Bu dosya, depoda çalışan kodlama agent'ları içindir ve depo hakkında hiçbir
> şey bilmediği varsayılarak yazılmıştır. Mimarinin tamamı için önce
> `docs/00-genel-bakis.md` ve `docs/01-mimari.md` dosyalarını okuyun;
> `docs/` altındaki dokümanlar (00–13 + KURULUM) tek tek her alt sistemi
> anlatır. Proje dokümantasyonu ve kod yorumları **Türkçe**'dir.

## Proje Özeti

**ww**, birden çok LLM API'sini (OpenAI, Anthropic/Claude, DeepSeek, …)
orkestre ederek kendi kendine yazılım projeleri üreten, **ClickHouse merkezli**
çok-agent'lı bir platformdur. Temel ilke: **her şey veritabanı üzerinden
yürür** — planlar, görevler, her tool çağrısı ve her karar ClickHouse'a
işlenir; agent'lar işlerini oradan alır, bağlamlarını oradan kurar, sonuçlarını
oraya yazar. Redis yalnızca hız tamponudur (kuyruk, kilit, heartbeat); Redis
kaybı veri kaybı değildir.

Agent modeli: her iş için *yapan* (worker) + *denetleyen* (verifier) çifti;
en üstte PM agent; planlar 3-4 modelin konsey tartışmasıyla oluşur.
Üretilen projeler `workspace/` altında tutulur ve her biri otomatik git
deposudur. Çalışma ortamı lokal, tek kullanıcılıdır.

## Teknoloji Yığını

- **Dil/derleme**: TypeScript 5.7 (strict, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes` — `tsconfig.base.json`), Node.js 22+,
  ESM (`"type": "module"`), NodeNext modül çözümü — göreli import'larda
  `.js` uzantısı **zorunlu** (ör. `import { x } from './client.js'`).
- **Monorepo**: pnpm 11.1.3 workspace + Turborepo 2 (`apps/*`, `packages/*`).
- **Server**: NestJS 11 (Express + WebSocket, `@nestjs/platform-ws`),
  `apps/server`.
- **Panel**: React 18 + Vite 5, `apps/panel` (Türkçe UI). Monaco editor
  (`@monaco-editor/react`) ve `@xyflow/react` (tuval) kullanır.
- **Veri**: ClickHouse 24.8 (tek gerçek kaynak, `@clickhouse/client`) +
  Redis 7 (kuyruk/kilit/pub-sub, `redis` istemcisi).
- **Test**: Vitest 2; kökte `vitest.workspace.ts` ile paket config'leri
  birleşir (`packages/*/vitest.config.ts`, `apps/*/vitest.config.ts`).
- **Diğer**: `zod` 4 (şema doğrulama), `openai` + `@anthropic-ai/sdk`
  (LLM adaptörleri), `ajv` (executor'da JSON şema), `tsx` (server dev
  modunda izleyici).

## Dizin Düzeni ve Modüller

```
apps/
├── server/        # NestJS API (varsayılan localhost:4000, WW_PORT) — HTTP/WS
│                  #   uçları (controller'lar, gateway, servis kablolaması)
└── panel/         # React+Vite paneli (localhost:5173) — components/ (view),
                   #   viewmodels/ (useXxxViewModel hook'ları), services/ (API/IO)
packages/
├── shared/        # Ortak tipler ve sabitler (Task, WsEvent, enum'lar — tek kaynak)
├── db/            # ClickHouse client + migration'lar + sorgu katmanı
│                  #   (repositories/); Redis yardımcıları (lease, wakeup, cleanup)
├── providers/     # LLM adaptörleri, yönlendirme/fallback, fiyatlandırma, keystore
├── agents/        # Agent döngüleri: PM, konsey, worker/verifier, mesaj protokolü
├── scheduler/     # Kuyruk tüketimi, eşzamanlılık, kilitler, frenler, tırmandırma
├── memory/        # Context Builder, özetleyici, anlatıcı (narrator), kurtarma
├── executor/      # Tool-use araçları, sandbox (Docker), git, çalıştırma/test kapısı
└── wiring-check/  # "Bağlantısız kod" denetçisi (aşağıya bakın)
workspace/         # Platformun ürettiği projeler (gitignore'lu; elle dokunmayın)
docs/              # Mimari dokümanlar (00–13) + KURULUM.md
scripts/           # gate.sh (tam kapı), audit-self.mjs (öz-denetim),
                   #   durum.mjs (docs/DURUM.md ölçümlerini üretir)
```

**Bağımlılık yönü (döngü yasak; package.json'lardan doğrulanmış):**

- `shared` tabandadır; `db` yalnızca `shared`'e bağlıdır.
- `providers`, `memory` ve `executor`, `db` (+`shared`) üzerine kuruludur.
- `agents`; `db`, `memory` ve `providers`'ı kullanır.
- `scheduler`; `db` ve `memory`'yi kullanır (LLM çağırmaz, `agents`'a
  paket bağımlılığı yoktur — agent işlerini DB/kuyruk üzerinden yürütür).
- `apps/server` tüm paketleri kablolar; `apps/panel` yalnızca `shared`'i
  kullanır.

Sorumluluk sınırları kesindir: `apps/server` iş mantığı barındırmaz (paketlere
delege eder); `packages/scheduler` LLM çağırmaz; `packages/agents` doğrudan
dosya yazmaz (executor kullanır); `packages/db` iş kuralı içermez.

## Derleme, Test ve Geliştirme Komutları

- `pnpm install` — bağımlılıkları kurar.
- `docker compose up -d` — yerel ClickHouse (`localhost:8124`) ve Redis
  (`localhost:6380`) servislerini başlatır. **Portlar bilinçli olarak standart
  dışıdır** (8123/6379 değil; makinede başka projelerin container'ları var);
  `WW_CH_URL` ve `WW_REDIS_URL` ile değiştirilebilir.
- `pnpm dev` — tüm paketleri ve uygulamaları izleme modunda çalıştırır.
- `pnpm build` — tüm workspace paketlerini derler (`tsc`).
- `pnpm test` — Vitest testlerini seri çalıştırır (`turbo test
  --concurrency=1`). Tek paket için: `pnpm --filter @ww/providers test`.
  Paralel koşu: `pnpm test:parallel`.
- `pnpm lint` — ESLint (`typescript-eslint` recommended).
- `pnpm gate` (`./scripts/gate.sh`) — **tam kapı**: sızmış test verisi
  temizliği + build + öz-denetim + wiring-check + durum kaydı + lint +
  entegrasyonlu test (`WW_REQUIRE_INTEGRATION=1`). Ucuz denetimler ÖNCE
  koşar: eskiden en sondaydılar ve operatör hatayı görmek için tüm test
  bedelini ödüyordu. Commit/push öncesi tek komut olarak
  çalıştırın: `pnpm gate && git commit ... && git push`. Kapı adımlarını
  ayrı ayrı koşturmayın — bu depoda kapı düşerken push atılmışlığı vardır.
- `pnpm wiring:check` — testi olan ama hiçbir üretim kodunun çağırmadığı
  ("bağlantısız") sembolleri yakalar; yeni bulgular kapıyı düşürür. Bilinçli
  istisnalar **gerekçeli** olarak `wiring-baseline.json`'a eklenir — gerekçesiz
  girdi eklemek kusuru gizlemektir.
- `pnpm db:clean-tests` — sızmış test veritabanlarını ve Redis anahtarlarını
  temizler (testler `ww_test_*` adlı ayrı veritabanları kullanır).

### Entegrasyon ve canlı testler

- Entegrasyon testleri (`*.integration.test.ts`, `apps/server`'daki e2e),
  servisler kapalıysa `describe.skipIf` ile **sessizce atlanır**. Atlamayı
  hataya çevirmek için: `WW_REQUIRE_INTEGRATION=1 pnpm test` (Docker
  servisleri çalışıyor olmalı). Atlanan test kapı sayılmaz.
- Executor'ın canlı Docker sandbox testleri (`src/sandbox.live.test.ts`,
  `src/durable-audit.live.test.ts`) varsayılan koşuda atlanır; ayrıca
  çalıştırın:
  `pnpm --filter @ww/executor runtime:build` (imajı kurar) ve
  `pnpm --filter @ww/executor test:live`.
- Bazı entegrasyon testleri yalnız tam kapı yükü altında dalgalanır (flake);
  tek başına geçiyorsa değişikliğinizden şüphelenmeden önce kapıyı yeniden
  koşturun.

## Kod Stili ve Adlandırma

- İki boşluk girinti, tek tırnak, noktalı virgül, çok satırlı yapılarda son
  virgül.
- TypeScript strict ayarlarına uyun; `any` yerine `unknown`/zod doğrulaması.
- Tipler/sınıflar `PascalCase`, fonksiyon/değişkenler `camelCase`, sabitler
  `SCREAMING_SNAKE_CASE`. Dosyalar genellikle `kebab-case.ts`.
- Testler kaynak dosyanın yanında colocated `*.test.ts` (veya
  `*.integration.test.ts`, `*.live.test.ts`) olarak yazılır.
- İş mantığı servislerde, veri erişimi `packages/db`'de durur; public API'ler
  her pakette `src/index.ts` üzerinden dışa aktarılır.
- Panelde MVVM: `components/` yalnız görsel JSX çizer; durum ve kullanıcı
  eylemleri `viewmodels/` içindeki hook'larda; tüm API/IO `services/` üzerinden
  geçer. `scripts/audit-self.mjs` her kapıda ww'nin kendi panelini bu
  standarda karşı denetler — ihlalde kapı kırmızıya düşer.
- Dokümantasyon ve kod yorumları Türkçe yazılır; ayrıntılı kod standartları ve
  üretilen projelerin şablonları `docs/09-kod-standartlari.md`'dedir.

## Test İlkeleri

- Vitest'in `describe`, `it`, `expect` API'lerini kullanın.
- Davranış değişikliklerinde başarı, hata, fallback ve idempotency
  senaryolarını kapsayan test ekleyin.
- Dikkat: bazı mevcut testler bug'ı doğruluyor olabilir — bir düzeltme testi
  kırdığında önce testin hatayı mı doğruladığına bakın.
- Entegrasyon testleri gerçek ClickHouse/Redis'e bağlanır;
  `packages/db/src/testutil.ts` yardımcıları servis yoksa atlar,
  `WW_REQUIRE_INTEGRATION=1` ile hata verir.

## Ortam Değişkenleri ve Güvenlik

- `.env`, `.env.*` ve `.ww/` gitignore kapsamındadır; **API anahtarları, token
  ve yerel veri volume'leri asla commit'lenmez**. Tam kurulum adımları:
  `docs/KURULUM.md`.
- `WW_LOCAL_SESSION_TOKEN` (server) ile `VITE_SESSION_TOKEN` (panel) aynı
  olmalıdır; aksi hâlde panelin yazma uçları çalışmaz.
- `WW_MASTER_KEY` — anahtar deposunun 32 baytlık hex şifreleme anahtarı
  (container kipinde zorunlu; verilmezse keystore macOS Keychain'e düşer).
- `WW_CH_URL`, `WW_CH_USER`, `WW_CH_PASS`, `WW_CH_DB`, `WW_REDIS_URL`,
  `WW_PORT`, `WW_PANEL_ORIGINS`, `VITE_API_PROXY_TARGET`, `VITE_API_BASE_URL` —
  ilgili paketler için `turbo.json` içinde `passThroughEnv`/`env` ile
  tanımlıdır.
- Sağlayıcı API anahtarları koda/değişkene gömülmez; panelden girilir ve
  şifreli keystore'da tutulur (`packages/providers/src/keystore.ts`).
- Sandbox: agent'lar yalnızca kendi proje workspace'inde çalışır
  (`packages/executor`); boş hedef-dosya listesiyle görev açmak `write_file`'ı
  reddettirir — görev oluştururken her zaman `files` verin.
- Çökme kurtarma: server açılışta `RecoverySweeperService`
  (`apps/server/src/recovery-sweeper.service.ts`) yarım görevleri kuyruğa geri
  alır; yazım sırası her zaman önce ClickHouse sonra Redis'tir.

## Commit ve Pull Request Kuralları

- Scoped Conventional Commit: `feat(providers): ...`, `feat(db): ...`,
  `chore: ...`. Her commit tek amaca odaklansın; küçük, sıralı ve geri
  alınabilir tutun.
- Yalnızca yeşil kapı sonrası commit/push: `pnpm gate && git commit ...
  && git push`. `main`'e asla force-push yok.
- PR açıklamasında amacı, doğrulama komutlarını ve ilgili issue/planı belirtin;
  migration veya yapılandırma etkilerini yazın. UI değişikliklerinde ekran
  görüntüsü ekleyin.
- `docs/11-yol-haritasi.md`'deki bir fazı, belgelenen uçtan uca senaryosu
  geçmeden "bitti" olarak işaretlemeyin.
