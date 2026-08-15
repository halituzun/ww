# 11 — Yol Haritası

> Fazlar, her fazın "bitti" tanımı ve doğrulama senaryosu.
> İlgili: [Mimari](01-mimari.md) · [Şema](02-clickhouse-semasi.md) ·
> [Agent Sistemi](03-agent-sistemi.md) · [İletişim Sözleşmesi](13-agent-iletisim-sozlesmesi.md)

## İçindekiler

1. [İlkeler](#ilkeler)
2. [Faz 0 — Temel Altyapı](#faz-0)
3. [Faz 1 — Çekirdek Orkestrasyon](#faz-1)
4. [Faz 2 — Hafıza ve Dayanıklılık](#faz-2)
5. [Faz 3 — Panel Temeli](#faz-3)
6. [Faz 4 — Tam Agent Sistemi](#faz-4)
7. [Faz 5 — Tuval ve Dosya Gezgini](#faz-5)
8. [Faz 6 — Test Ortamları ve Cila](#faz-6)

---

## İlkeler

- Her faz **çalışan, doğrulanabilir bir dilim** bitirir; sonraki faz öncekinin
  üzerine kurulur.
- Gerçek API maliyetine girmeden ilerlemek için Faz 0'da **mock provider** yazılır;
  Faz 1-2'nin tüm entegrasyon testleri mock ile deterministiktir. Gerçek API'ler
  Faz 3'ten itibaren (kontör paneliyle birlikte) devreye girer.
- Her fazın sonunda ilgili dokümanlar gerçeklikle senkronlanır (doküman ↔ kod
  sapması bırakılmaz).

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

**İlerleme (2026-08-15):** ContextPack/`memory_query`, bütün-chunk token
bütçesi, özet/embedding/file-index yazma portları, startup `RecoveryService` ve scheduler
token/maliyet/döngü/duvar-saati frenleri uygulandı. Server açılışında migration
sonrası bounded proje recovery çalışır; kalan gerçek sağlayıcı embedding ve
öldürülmüş süreç e2e senaryosu entegrasyon kapısında ayrıca izlenir.

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

**İlerleme (2026-08-15):** Proje listesi REST ucu, görev/mesaj REST akışları,
`/events` WebSocket gateway'i ve project-scoped cursor replay'i çalışır. Panel
canlı görev/zaman çizelgesi, proje seçici ve altyapı sağlık görünümünü sunar.

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

**İlerleme (2026-08-15):** Panelde canlı event timeline yanında React Flow görev
tuvali, salt-okunur Monaco fihrist editörü, API test/maliyet konsolu ve sandbox
önizleme yüzeyi eklendi. Narrator kanıt çekirdeği `packages/memory` içinde.

**Kapsam:**

- Canlı tuval: React Flow, hiyerarşi + hareketli iş/mesaj okları, düğüm/kenar
  detay panelleri, zaman çizelgesi modu (`events` yeniden oynatma).
- Dosya gezgini: ağaç + Monaco (salt-okunur) + fihrist paneli + commit geçmişi +
  "kim neden değiştirdi" (narrator entegrasyonu).
- Bildirim sistemi (zil + tarayıcı bildirimi).

**Bitti tanımı / doğrulama:**

- Faz 4 senaryosu koşarken tuvalde atamalar/oklar canlı izlenir; geçmişe
  kaydırıcıyla dönülür; bir dosyanın fihristinden ilgili göreve ve narrator
  anlatısına gidilir.

## Faz 6 — Test Ortamları ve Cila {#faz-6}

**İlerleme (2026-08-15):** Docker sandbox executor, starter paketleme kapıları,
kurulum dokümanı ve API/mobile starter şablonları hazırlandı. Web/API/mobile
örnek kapıları executor'ın izole pipeline'ında çalıştırılır. Android AVD için
güvenli injected `MobilePreviewPort`/frame/tap sözleşmesi ve preview iframe
yüzeyi hazırdır; makineye özgü gerçek AVD adapter'ı deployment konfigürasyonudur.

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
