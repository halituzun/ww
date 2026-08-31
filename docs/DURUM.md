# ww — Güncel Durum

> **Bu dosya deponun TEK durum kaydıdır.** `CLAUDE.md`, `docs/11-yol-haritasi.md`
> ve `docs/12-agent-devir-ve-hafiza.md` buraya işaret eder; kendi kopyalarını
> tutmazlar.
>
> **NEDEN tek dosya:** durum üç ayrı yerde elle tutuluyordu ve üçü de saptı.
> 2026-08-31 ölçümünde `docs/12` on gün, `docs/11` on üç gün bayattı; en güncel
> kayıt (`memory/*.md`) ise Git'te bile değildi. `docs/12` bu tuzağı bizzat
> yazıyor: *"Güncellenmezse sonraki ajan yanlış yerden başlar."*
>
> Aşağıdaki **ÜRETİLEN** blok elle düzenlenmez: `node scripts/durum.mjs`.
> Dal konumu ve commit sayısı bilerek ölçülmez (her commit'te değişir); onları
> her oturumun ilk adımı olan `git status -sb` verir.

## Ölçümler

<!-- ÜRETİLEN:BAŞLANGIÇ — elle düzenlemeyin, `node scripts/durum.mjs` çalıştırın -->

| Ölçüm | Değer |
|---|---|
| Paket sayısı | 8 paket + 2 uygulama |
| Üretim kaynağı | 413 dosya, 58.060 satır |
| Test dosyası | 299 |
| Test durumu (`it(` sayımı) | 2068 |
| Servis gerektirdiği için atlanabilen test dosyası | 49 (`skipIf`) |
| Colocation ile testsiz kaynak dosya | 142 / 413 |
| ClickHouse migration | 12 |
| wiring-baseline girdisi | 40 |

<!-- ÜRETİLEN:SON -->

## Faz Durumu

Ayrıntı ve kanıt tabloları: [docs/11-yol-haritasi.md](11-yol-haritasi.md).

| Faz | Durum |
|---|---|
| 0 — Temel Altyapı | Tamamlandı ✅ |
| 1 — Çekirdek Orkestrasyon | Tamamlandı ✅ |
| 2 — Hafıza ve Dayanıklılık | Tamamlandı ✅ |
| 3 — Panel Temeli | Tamamlandı ✅ (2026-08-17, gerçek API ile) |
| 4 — Tam Agent Sistemi | Zincir bağlandı ⏳ — sihirbaz→konsey→onay→kadro+görev uçtan uca çalışıyor; kalan: gelen kutusu ve konsey için bakiyeli 3. sağlayıcı |
| 5 — Tuval ve Dosya Gezgini | Kriterler karşılandı ⏳ — tarayıcıda gözle izleme kaldı |
| 6 — Test Ortamları ve Cila | Kod tamam ⏳ — üç gerçek proje koşusu + Android SDK kaldı |

**Faz G / H / I:** yol haritasında numaralı fazların dışında yürüyen iş kolları.
Faz H (konsey çelişki protokolü) ve Faz I (proje bilgi haritası) 2026-08-29'da
kapandı; kanıtları `kanit/` ve `memory/*.md` altında.

## Sağlayıcı Durumu

| Sağlayıcı | Durum |
|---|---|
| mistral | Bakiyeli ve çalışıyor; worker/verifier/summarizer buraya yönlendirildi |
| openai | Anahtar geçerli, **bakiyesiz** (`429 credit_balance_exhausted`) |
| deepseek | Anahtar geçerli, **bakiyesiz** (`402`) |
| ollama | Yerel; anahtarsız çalışır |

Konsey docs/03 gereği **3 farklı sağlayıcı** ister. Şu an bakiyeli tek sağlayıcı
olduğu için konsey çapraz kontrolü tam değildir.

## Bilinen Kopukluklar

2026-08-31 taramasında bulunan boşluklar ve bugünkü durumları. Kapananlar
listeden SİLİNMEZ: neyin ne zaman düzeldiği, düzelmemiş olanlar kadar
önemlidir.

### Kapandı

| Kopukluk | Nasıl kapandı |
|---|---|
| Plan onayı görev üretmiyordu | Onay artık görev grafiğini açıp kuyruğa basıyor; grafik yoksa REDDEDİYOR (B2) |
| `buildAgentsFromOrgPlan` bağlı değildi | Onay org planından kadro kuruyor; `group_lead` artık doğuyor (B3) |
| Sihirbaz ile konsey arasında bağ yoktu | Gereksinim yazılınca konsey kendiliğinden koşuyor (B1) |
| Org planı proje ADINDAKİ kelimeden türüyordu | Nihai sentezdeki `## DEPARTMANLAR` bölümünden türüyor (B4) |
| Çapraz kontrol eksikliği yalnız metindi | `plans.provider_diversity` verisi + panelde rozet + bilinçli onay (B5) |
| Konsey promptları sabit stringdi | Sürümlü `prompts` tablosunda (B6) |
| Yeniden planlama sözleşmesi uygulanmıyordu | Plan `superseded`, açık görevler `cancelled`, konsey turu koşuyor (B7) |
| `handleExecutionError` durumu yanlış bildiriyordu | Geçişin GERÇEK sonucu dönüyor; görev artık sessizce asılı kalmıyor (C2) |
| Atama hatası hiçbir yere yazılmıyordu | `recordAssignmentFailure` sebebi `events`'e yazıyor (C3) |
| Sekiz okuma ucu oturum doğrulamıyordu | Hepsi `parseLocalSession` çağırıyor (C6) |
| Bağlam bütçesi üretimde 500 token'a çöküyordu | Rol başına varsayılan; 0 artık "belirtilmedi" (D1) |
| Hedef dosyalar yanlış pencereden çekiliyordu | Yollarıyla sorgulanıyor (D2) |
| Sabit çekirdek bütçede rezerve edilmiyordu | Çekirdek önce alıyor; sığmazsa `droppedRequired` ile görünür (D3) |
| Doğrulayıcı worker'ın promptuyla koşuyordu | Mühürlenen `promptRefs[1]` gerçekten yükleniyor (D4) |
| Bağlamsız koşu sessizdi | `events`'e `phase: 'context'` olayı düşüyor (D5) |
| `memory_query` cutoff'suzdu | Mühürlü kesitle sorguluyor (D6) |

### Açık

| Kopukluk | Etki | Not |
|---|---|---|
| Gelen kutusu üretimde tüketilmiyor | `message_receipts` sonsuza dek `enqueued` kalır | **Karar bekliyor:** kutuyu bağlamak, FSM geçişlerinin sahibinin orkestratör mü kutu mu olduğuna karar vermeden yapılamaz; bugün ikisi de aynı olayı farklı kimliklerle üretiyor |
| PM döngüsü ölü kod | `user_command` regex ile görev açıyor; PM yorumlamıyor | C4 |
| Konsey turu yetkilendirmesi taklit edilebilir | Çağıranın doldurduğu `provenance.sourceId` yeterli | C5 — konsey üyesi seçimi rol filtresiz olduğu için tek başına yamanamaz |
| Embedding katmanı yok | docs/06'nın semantik geri getirmesi fiilen yoktur | D9 |
| Anlatıcı LLM'e bağlı değil, bağlama enjekte edilmiyor | docs/06'nın "nasıl yaptın?" akışı yok | D10 |
| Özet yazımı idempotent değil, dört tetiği ölü | Aynı görev için ikinci özet satırı yazılabilir | D7 |
| Hafıza okumaları 200 satırlık pencere | Eski bağımlılık özetleri görünmez | D8 |
| `assignment-service` 2817 satır, dört sorumluluk iç içe | Değiştirmesi ve doğrulaması pahalı | C7 |

## Çalıştırma

```bash
docker compose up -d          # ClickHouse :8124, Redis :6380
pnpm dev                      # API :4000, panel :5173
pnpm gate                     # build + öz-denetim + wiring + lint + test
```

Canlı görev döngüsü (motor yalnız `status=running` projeleri alır):

```bash
set -a; source .env; set +a
WW_PHASE8_RUNTIME_ENABLED=1 WW_RUNTIME_PROJECT_ID=<uuid> node apps/server/dist/main.js
```
