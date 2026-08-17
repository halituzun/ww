# 11 — Yol Haritası

> Fazlar, her fazın "bitti" tanımı ve doğrulama senaryosu.
> İlgili: [Mimari](01-mimari.md) · [Şema](02-clickhouse-semasi.md) ·
> [Agent Sistemi](03-agent-sistemi.md) · [İletişim Sözleşmesi](13-agent-iletisim-sozlesmesi.md)

## İçindekiler

1. [İlkeler](#ilkeler)
2. [Durum Özeti](#durum-özeti-2026-08-16-doğrulaması)
3. [Faz 0 — Temel Altyapı](#faz-0)
4. [Faz 1 — Çekirdek Orkestrasyon](#faz-1)
5. [Faz 2 — Hafıza ve Dayanıklılık](#faz-2)
6. [Faz 3 — Panel Temeli](#faz-3)
7. [Faz 4 — Tam Agent Sistemi](#faz-4)
8. [Faz 5 — Tuval ve Dosya Gezgini](#faz-5)
9. [Faz 6 — Test Ortamları ve Cila](#faz-6)

---

## İlkeler

- Her faz **çalışan, doğrulanabilir bir dilim** bitirir; sonraki faz öncekinin
  üzerine kurulur.
- Gerçek API maliyetine girmeden ilerlemek için Faz 0'da **mock provider** yazılır;
  Faz 1-2'nin tüm entegrasyon testleri mock ile deterministiktir. Gerçek API'ler
  Faz 3'ten itibaren (kontör paneliyle birlikte) devreye girer.
- Her fazın sonunda ilgili dokümanlar gerçeklikle senkronlanır (doküman ↔ kod
  sapması bırakılmaz).
- Bir faz, **belgelenmiş kabul senaryosu geçmeden** "tamamlandı" işaretlenmez.
  Atlanan entegrasyon testi kapı sayılmaz.

## Durum Özeti (2026-08-16 doğrulaması)

| Faz | Durum | Dayanak |
|---|---|---|
| 0 — Temel Altyapı | **Tamamlandı ✅** | Migration/latest/router/kontör testleri |
| 1 — Çekirdek Orkestrasyon | **Tamamlandı ✅** | Kabul senaryoları deterministik mock testlerle karşılanıyor |
| 2 — Hafıza ve Dayanıklılık | **Tamamlandı ✅** | Recovery, bağlam bütçesi, frenler testli |
| 3 — Panel Temeli | **Kod tamam ⏳** | Kabul senaryosu **gerçek API** ister; hiç çalıştırılmadı |
| 4 — Tam Agent Sistemi | **Kod tamam ⏳** | Kabul senaryosu Faz 3'ün gerçek koşusuna bağlı |
| 5 — Tuval ve Dosya Gezgini | **Kod tamam ⏳** | Kabul senaryosu Faz 4'ün canlı koşusuna bağlı |
| 6 — Test Ortamları ve Cila | **Kod tamam ⏳** | Canlı sandbox kapısı geçti; üç gerçek proje koşusu eksik |

**EN KRİTİK AÇIK (2026-08-17 keşfi):** Agent orkestrasyon runtime'ı **hiç
başlatılmıyor.** `registerPhase9RuntimeConfig` hiçbir üretim kodundan
çağrılmıyor ve `WW_PHASE8_RUNTIME_ENABLED` hiçbir yerde ayarlanmıyor; ayrıca
`SchedulerWorker` hiç kurulmuyor. Server REST, WebSocket, migration, recovery
ve sağlayıcı sağlık taramasını koşar — ama görev kuyruğunu tüketen kimse
yoktur, yani panelden açılan bir projenin görevleri sonsuza dek `queued`
kalır. Durum artık açılış logunda ve `GET /runtime` ucunda görünür.
Faz 1'in kabul senaryosu testlerde geçer (orkestratör doğrudan çağrılır);
eksik olan, çalışan sunucunun bu döngüyü başlatmasıdır.

**Bu özeti okuyan ajan için tek kritik gerçek:** Platform bugüne kadar **hiç gerçek
LLM API'sine bağlanmadı.** `secrets/` dizini yok, `api_providers`'ta kayıtlı tek
sağlayıcı `mock`, `api_usage` tablosunda sıfır gerçek çağrı var. Tüm doğrulama
`MockProvider` üzerinden yapıldı. Faz 0-2 zaten mock ile tanımlı olduğu için
tamamdır; Faz 3-6'nın kabul senaryoları ise açıkça gerçek API ve insanlı panel
koşusu istediğinden **kod bitmiş olsa da faz kapanmamıştır**.

**Doğrulama komutları:**

```bash
docker compose up -d
WW_REQUIRE_INTEGRATION=1 pnpm test          # 912 test, 10 paket
pnpm --filter @ww/executor test:live        # +4 canlı Docker sandbox testi (opt-in)
pnpm build && pnpm lint
```

Varsayılan `pnpm test` koşusunda executor'ın 4 canlı Docker testi atlanır
(`WW_DOCKER_LIVE=1` ister). Depo kuralı gereği atlanan test kapı sayılmadığından
faz kapatırken `test:live` ayrıca koşulmalıdır. Toplam kapı: **916 test**
(2026-08-17 ölçümü). Ayrıca `pnpm wiring:check` — bağlanmamış kod kapısı.

## Faz 0 — Temel Altyapı {#faz-0}

**Durum:** Tamamlandı ✅ (2026-08-14)

**Kapsam:**

- Monorepo iskeleti: pnpm + Turborepo; `apps/server`, `apps/panel` (boş kabuk),
  tüm `packages/*` iskeletleri; TS strict, ESLint, Vitest.
- `docker-compose.yml`: ClickHouse 24.8 + Redis 7 ayakta.
- `packages/db`: migration çalıştırıcı + `_migrations` tablosu +
  [02 — Şema](02-clickhouse-semasi.md)'daki tüm tabloların `0001_init.sql`'i +
  `latest()` son-durum sorgu yardımcıları + Redis yardımcıları (stream, lock, pubsub).
- `packages/providers`: `LlmProvider` arayüzü, `ModelRouter`, OpenAI + Anthropic +
  DeepSeek adaptörleri, **MockProvider** (senaryo dosyasından deterministik cevap +
  tool çağrıları üretir), fiyat tablosu, `api_usage` yazımı, anahtar deposu
  (şifreli dosya + Keychain).
- Prompt seed migration'ı: çekirdek rol promptları `prompts` tablosuna.

**Bitti tanımı / doğrulama:**

- `docker compose up` + `pnpm dev` ile server ayağa kalkar, migration'lar uygulanır.
- Birim testler: migration idempotency, `latest()` deseni, router fallback'i
  (mock'ta hata → yedek model), maliyet hesabı.
- `pnpm test` yeşil; CI betiği (lokal) tek komut.

## Faz 1 — Çekirdek Orkestrasyon {#faz-1}

**Durum:** Tamamlandı ✅ (2026-08-16 doğrulandı)

Faz 1'in kabul senaryosu tanımı gereği tamamen deterministik ve gerçek API'sizdir;
dolayısıyla otomatik kapı bu fazı kapatmaya yeter. Kanıt eşlemesi:

| Kabul kriteri | Kanıt |
|---|---|
| Senaryo: proje → görev → kuyruk → worker → verifier → kapı → commit | `apps/server/src/phase9.runtime.integration.test.ts`, `apps/server/src/rest.integration.test.ts` |
| Ping-pong freni (3. denemede `escalated`) | `packages/scheduler/src/phase1-orchestrator.test.ts` — "üçüncü kalıcı ret sonrası escalated olur" |
| Ret → düzeltme → temiz terminal; gate hatası → yeni attempt | `packages/scheduler/src/phase1-orchestrator.test.ts` (8 test) |
| İletişim: exact `replyToMessageId`, yinelenen teslim, Redis'siz inbox replay, sahte principal fail-closed | `packages/agents/src/communication.integration.test.ts` (28 test) |
| Restart: durable provider effect'i tekrar çağrılmaz | `communication.integration.test.ts` — "non-replay-safe effect ... tek callback calistirir"; `phase9.runtime.integration.test.ts` |
| Zaman: brief mühürleme, stale brief/attempt reddi, causal high-water | `communication.integration.test.ts`, `packages/shared/src/task-contracts.test.ts` |

**Kapsam:**

- `packages/executor`: dosya araçları, `run_command` beyaz listesi, sandbox yol
  hapsi, git entegrasyonu (init/commit/diff), `ww.gate.json` kapı koşucusu,
  web starter template.
- `packages/agents`: worker döngüsü (tool-use çevrimi), verifier döngüsü,
  basit PM (konsey yok — görevleri elle/senaryodan alır), `report_result`,
  `ask_question` (PM'e), sürümlemeli mesaj zarfı, routing, durable inbox/receipt,
  idempotency ve iletişim yetki guard'ı.
- `packages/scheduler`: kuyruk tüketici, claim kilidi, atama algoritmasının
  çekirdeği (bağımlılık + dosya kilidi + worker/verifier seçimi), heartbeat,
  tek sahipli durum makinesi geçişleri, immutable `TaskBriefV1`, her çalıştırma için
  `AssignmentAttemptV1` ve yeniden atama için typed handoff.
- Faz 1 migration'ı: görev brifleri, mesaj korelasyon/provenance alanları,
  canonical payload, alıcı bazlı receipt/effect ledger, iletişim event türleri ve
  yapılandırılmış audit finding temeli. Mevcut seed'leri değiştirmeden PM-direct
  worker/PM iletişimini öğreten ve marker testleriyle korunan prompt v2'leri.
  Current attempt'i task fold'una bağlayan append-only `task_causal_entries`.
- Provider meta/`api_usage`: invocation, brief, assignment, prompt-input snapshot
  ve fallback attempt provenance'ı.
- Minimal REST: proje aç, görev ekle, durum sorgula ve authenticated user answer'ı
  exact question bağlamıyla scheduler'a resume ettir (panel yok; curl/CLI ile).

**Bitti tanımı / doğrulama (mock ile uçtan uca):**

- Senaryo testi: proje aç → 3 görevlik mini plan yükle (biri diğerine bağımlı) →
  mock worker dosya yazar → mock verifier bir görevi 1 kez reddeder → düzeltme →
  kapı (tsc+eslint+vitest) koşar → commit'ler atılır → `tasks/events/artifacts`
  kayıtları beklenen zincirde. Tamamı deterministik, gerçek API'siz.
- Ping-pong freni testi: mock verifier hep reddeder → 3. denemede `escalated`.
- İletişim testi: soru yalnız `replyToMessageId` ile doğru cevabı alır; yinelenen
  teslim yan etkiyi tekrarlamaz; Redis bildirimi olmadan inbox replay çalışır;
  sahte rol/verdict ve prompt injection fail-closed olur.
- Restart testi: durable provider effect'i ikinci runtime composition yeniden
  oluşturulduğunda tekrar çağrılmaz; belirsiz/kaçırılmış iletişim teslimleri
  bounded DB poll ve typed escalation ile toparlanır.
- Zaman testi: görev, atama sonrasında değişen plan/prompt/kuralı görmez; bilinçli
  rebase yeni `TaskBriefV1` sürümü üretir; retry kendi nedensel ret/gate/cevap
  kayıtlarını görür; her invocation kendi input causal high-water'ını mühürler;
  attempt-bazlı ordinal restart'ta monoton sürer ve stale/paralel writer reddedilir;
  reassignment yeni attempt + ancestor-bounded handoff üretir.

## Faz 2 — Hafıza ve Dayanıklılık {#faz-2}

**Durum:** Tamamlandı ✅ (2026-08-16 doğrulandı)

Faz 2'nin kabul senaryosu da mock tabanlı tanımlıdır; otomatik kapı bu fazı kapatır.

| Kabul kriteri | Kanıt |
|---|---|
| Kurtarma: restart sonrası proje kaldığı yerden, çift üretim yok | `packages/memory/src/recovery.integration.test.ts` — "stale worker/task leaseini queued + idle yapar ve ikinci restart duplicate üretmez" |
| Hafıza: bütün-chunk bütçe, dedupe, deterministik sıra, as-of cutoff | `packages/memory/src/memory-service.test.ts`, `packages/memory/src/task-context-snapshot-builder.test.ts`, `packages/memory/src/narrator-service.test.ts` |
| Frenler: token / maliyet / kaçak döngü / duvar-saati | `packages/scheduler/src/safety-brakes.test.ts` |

**İlerleme (2026-08-15):** ContextPack/`memory_query`, bütün-chunk token
bütçesi, özet/embedding/file-index yazma portları, startup `RecoveryService` ve scheduler
token/maliyet/döngü/duvar-saati frenleri uygulandı. Server açılışında migration
sonrası bounded proje recovery çalışır; ClickHouse/Redis entegrasyon testi stale
agent/task'i kuyruğa alıp ikinci restart'ta duplicate üretmediğini doğrular.

**Kapsam:**

- `packages/memory`: Context Builder (katmanlı doldurma + token bütçesi),
  özetleyici tetikleri (görev/oturum), embedding boru hattı (mock embed dahil),
  `memory_query` aracı, narrator akışının çekirdeği.
- Zamanlayıcı frenleri: token tavanı, kontör tavanı, kaçak döngü benzerliği,
  duvar-saati tavanı.
- `RecoveryService`: açılış kurtarması + süpürücü.
- `file_index` güncelleme akışı (özetleyici → fihrist).

**Bitti tanımı / doğrulama:**

- Kurtarma testi: mock senaryo ortasında server süreci öldürülür → yeniden başlar →
  proje kaldığı yerden biter; working tree temiz; çift commit yok.
- Hafıza testi: 2. görev, 1. görevin kararını Context Builder üzerinden görür
  (mock senaryo bunu doğrular); `memory_query` doğru kaydı döndürür. Eski görevin
  as-of replay'i cutoff sonrası bilgiyi dışarıda bırakır.
- Fren testleri: token tavanı ve kaçak döngü tırmandırması.

## Faz 3 — Panel Temeli {#faz-3}

**Durum:** Kod tamam ⏳ — kabul senaryosu bekliyor (2026-08-16)

**Faz kapanmasını engelleyen tek şey:** Bu fazın kabul senaryosu *"Gerçek API'ler bu
fazda ilk kez uçtan uca kullanılır"* ve *"kontör panosu gerçek maliyeti gösterir"*
diyor. Bugüne kadar hiç gerçek sağlayıcı bağlanmadı: `secrets/` dizini yok,
`api_providers`'ta yalnız `mock` kayıtlı, `api_usage`'da sıfır gerçek çağrı var.

**Kapatmak için gereken:** Panelden en az bir gerçek sağlayıcı anahtarı gir → küçük
bir gerçek senaryo koştur → kontör panosunun gerçek maliyeti gösterdiğini gör →
bilerek bozuk anahtarlı ikinci sağlayıcı ekle → sağlık kırmızıya düşsün, fallback
devreye girsin, panel rozeti görünsün. Bu koşu yapılana dek faz açık kalır.

**İlerleme (2026-08-16):** Proje listesi REST ucu, görev/mesaj REST akışları,
  `/events` WebSocket gateway'i ve project-scoped cursor replay'i çalışır. Panel
  canlı görev/zaman çizelgesi, proje seçici, proje duraklatma/devam/arşivleme ve
  altyapı sağlık görünümünü sunar. Sağlık, maliyet ve API artifact uçları panelde
  kullanılabilir. Sağlayıcı kartları maskeli anahtar kaydı ve güvenli REST
  yönetimiyle tamamlandı; gerçek ClickHouse/Redis REST testi bunu doğrular.

**Kapsam:**

- WebSocket gateway + olay zarfı + REST tamamlama ucu.
- REST ve WebSocket için ortak doğrulanmış olay sözlüğü, proje-scoped cursor,
  snapshot high-water mark, dedupe ve sıralı replay.
- Panel sayfaları: Projeler (liste/detay/sihirbaz kabuğu), Sohbet (PM + soru
  kutusu), API yönetimi (sağlayıcılar, anahtar girişi, sağlık, fallback sırası,
  rol→model eşleme), Kontör panosu, basit görev listesi.
- Gerçek API'ler bu fazda ilk kez uçtan uca kullanılır (küçük gerçek senaryo).
- Sağlık kontrolü + `mv_provider_errors` + fallback'in canlı davranışı.

**Bitti tanımı / doğrulama:**

- Panelden proje açılır, PM ile Türkçe konuşulur, görevler canlı akar
  (WebSocket), kontör panosu gerçek maliyeti gösterir.
- Bir sağlayıcı bilerek bozuk anahtarla eklenir → sağlık kırmızı → fallback
  çalışır → panel rozeti görünür.

## Faz 4 — Tam Agent Sistemi {#faz-4}

**Durum:** Kod tamam ⏳ — kabul senaryosu bekliyor (2026-08-16)

Deterministik dilim geçiyor: `packages/agents/src/phase4-acceptance.test.ts`
("interview → council → audit produces one approved deterministic result") ve
`packages/scheduler/src/phase4.integration.test.ts` (76 testin çoğu; konsey turu,
delegasyon derinliği, klon limiti, tırmandırma). Ancak belgelenmiş kabul senaryosu
**gerçek** bir uçtan uca koşu istiyor: "küçük bir web uygulaması sihirbazdan girilir
→ konsey planlar → kullanıcı onaylar → çoklu worker/verifier üretir → denetçiler en
az bir bulgu üretip düzelttirir → uygulama kapıdan geçer."

**Kapatmak için gereken:** Faz 3'ün gerçek API koşusu önce yapılmalı; bu faz ona
bağlıdır. Konsey en az 3 farklı sağlayıcı istediğinden en az üç anahtar gerekir.

**İlerleme (2026-08-15):** CouncilService (3–4 üye, bounded tur/sentez),
delegation depth/budget guard, clone limit/idle kapatma, StandardsAuditor ve
ReplanningService eklendi; Phase4 policy rotaları fail-closed olarak genişletildi.

**Kapsam:**

- Konsey protokolü (3-4 model, tur yapısı, sentez, plan sürümleme) +
  plan onay akışı (Türkçe özet).
- Gereksinim görüşmesi (`interviewer`) sihirbazın içine.
- Gruplar + grup liderleri + tırmandırma zincirinin tamamı (profesör dahil).
- Delegasyon (`create_subtask` herkese) + derinlik/bütçe sınırları.
- Klonlama + boşta kapatma.
- Standart denetçileri (mvvm/ui/db-yazım) + denetim ekranı + düzeltme görevi akışı.
- `standards_auditor` için `communication_audit` profili: route, receipt,
  brief/rule sürümü, provenance ve zamansal sızıntı denetimi.
- Yeniden planlama (kullanıcı müdahalesi → konsey revizyonu).
- Flutter ve API starter template'leri + kapıları.

**Bitti tanımı / doğrulama:**

- Gerçek senaryo: küçük bir web uygulaması (ör. yapılacaklar listesi) sihirbazdan
  girilir → konsey planlar → kullanıcı onaylar → çoklu worker/verifier üretir →
  denetçiler en az bir bulgu üretip düzelttirir → uygulama kapıdan geçer.
- Mock senaryolarla: konsey tur limiti, delegasyon derinlik reddi, klon limiti.

## Faz 5 — Tuval ve Dosya Gezgini {#faz-5}

**Durum:** Kod tamam ⏳ — kabul senaryosu bekliyor (2026-08-16)

Yüzeyler yerinde (React Flow tuval, salt-okunur Monaco fihrist editörü, narrator
bağlantısı), ancak kabul senaryosu bunların **Faz 4'ün canlı koşusu sırasında**
izlenmesini şart koşuyor: "Faz 4 senaryosu koşarken tuvalde atamalar/oklar canlı
izlenir; geçmişe kaydırıcıyla dönülür; bir dosyanın fihristinden ilgili göreve ve
narrator anlatısına gidilir." Faz 4 gerçek koşusu yapılmadan bu doğrulanamaz.

**İlerleme (2026-08-16):** Panelde canlı event timeline yanında React Flow görev
tuvali, salt-okunur Monaco fihrist editörü, API test/maliyet konsolu ve sandbox
önizleme yüzeyi eklendi. Narrator kanıt çekirdeği `packages/memory` içinde.

**Kapsam:**

- Canlı tuval: React Flow, hiyerarşi + hareketli iş/mesaj okları, düğüm/kenar
  detay panelleri, zaman çizelgesi modu (`events` yeniden oynatma).
- Dosya gezgini: kalıcı `file_index` REST kaynağından ağaç + Monaco (salt-okunur) + fihrist paneli + commit geçmişi +
  "kim neden değiştirdi" (narrator entegrasyonu).
- Bildirim sistemi (zil + tarayıcı bildirimi); panel arka plandayken WebSocket
  olayları için izinli tarayıcı bildirimi üretir.

**Bitti tanımı / doğrulama:**

- Faz 4 senaryosu koşarken tuvalde atamalar/oklar canlı izlenir; geçmişe
  kaydırıcıyla dönülür; bir dosyanın fihristinden ilgili göreve ve narrator
  anlatısına gidilir.

## Faz 6 — Test Ortamları ve Cila {#faz-6}

**Durum:** Kod tamam ⏳ — kabul senaryosu bekliyor (2026-08-16)

**Bugün doğrulanan:** Canlı Docker sandbox kapısı yeniden koşuldu ve geçti —
`pnpm --filter @ww/executor test:live` → 4/4 (non-root, env-clean, cap-drop,
network-none, tmpfs izolasyonu; çıktı/disk/timeout/abort sınırları ve temizlik;
starter'ın atomik materialize edilip donmuş kapı zincirinden geçip temiz Git
commit'i kurması). Bu testler varsayılan `pnpm test` koşusunda atlanır.

**Kapatmak için gereken:** Kabul senaryosu üç gerçek proje koşusu istiyor —
web projesinin panelde canlı önizlenmesi ve sohbetten verilen emrin sonucunun
önizlemede görülmesi, API projesinin konsoldan test edilmesi, Flutter projesinin
emülatörde açılıp ekran akışının panelde görünmesi, ve "bunu nasıl yaptın?"
sorusunun üçünde de referanslı anlatı döndürmesi. Bunlar gerçek API'ye ve
makineye özgü gerçek AVD adapter'ına bağlıdır (şu an güvenli injected
`MobilePreviewPort` sözleşmesi var, gerçek adapter deployment konfigürasyonudur).

**İlerleme (2026-08-16):** Docker sandbox executor, starter paketleme kapıları,
kurulum dokümanı ve API/mobile starter şablonları hazırlandı. Web/API/mobile
örnek kapıları executor'ın izole pipeline'ında çalıştırılır. API artifact listesi
ve panel test konsolu endpoint metadata'sını kullanır. Android AVD için
güvenli injected `MobilePreviewPort`/frame/tap sözleşmesi ve preview iframe
  yüzeyi hazırdır; makineye özgü gerçek AVD adapter'ı deployment konfigürasyonudur.
  Birleşik kapıda 9 paket build/lint ve seri test seti (2026-08-16 ölçümü: 709
  test + 4 opt-in canlı sandbox testi); canlı Docker sandbox izolasyonu, starter
  gate zinciri ve temiz Git commit'i doğrulandı.

**Kapsam:**

- Web önizleme (iframe + cihaz çerçeveleri + log çekmecesi).
- API test konsolu (`api_endpoint` artefaktlarından).
- Android emülatör entegrasyonu (AVD tespiti, başlatma, kare akışı, temel etkileşim).
- Gereksinim sihirbazı ve genel UX cilası; kurulum dokümanı (`docs/KURULUM.md`);
  uçtan uca üç tür projenin (web/mobil/api) örnek koşuları.

**Bitti tanımı / doğrulama:**

- Web projesi panelde canlı önizlenir; kullanıcı sohbetten verdiği emrin
  sonucunu önizlemede görür.
- API projesi konsoldan test edilir.
- Flutter projesi emülatörde açılır, ekran akışı panelde görünür.
- "Bunu nasıl yaptın?" sorusu üç projede de doğru, referanslı anlatı döndürür.
