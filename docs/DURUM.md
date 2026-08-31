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
| Üretim kaynağı | 407 dosya, 56.405 satır |
| Test dosyası | 290 |
| Test durumu (`it(` sayımı) | 1993 |
| Servis gerektirdiği için atlanabilen test dosyası | 45 (`skipIf`) |
| Colocation ile testsiz kaynak dosya | 141 / 407 |
| ClickHouse migration | 9 |
| wiring-baseline girdisi | 41 |

<!-- ÜRETİLEN:SON -->

## Faz Durumu

Ayrıntı ve kanıt tabloları: [docs/11-yol-haritasi.md](11-yol-haritasi.md).

| Faz | Durum |
|---|---|
| 0 — Temel Altyapı | Tamamlandı ✅ |
| 1 — Çekirdek Orkestrasyon | Tamamlandı ✅ |
| 2 — Hafıza ve Dayanıklılık | Tamamlandı ✅ |
| 3 — Panel Temeli | Tamamlandı ✅ (2026-08-17, gerçek API ile) |
| 4 — Tam Agent Sistemi | Kod eksik ⏳ — aşağıdaki "Bilinen kopukluklar" |
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

2026-08-31 taramasında doğrulanan, ürün akışını kesen boşluklar. Tam liste ve
kanıtlar yeniden yapılandırma planındadır.

| Kopukluk | Etki |
|---|---|
| Plan onayı görev üretmiyor | Panel "Görevler yürütmeye alındı" der, kuyruk boş kalır |
| `buildAgentsFromOrgPlan` bağlı değil | Konseyin departmanları ve `group_lead`'leri hiç doğmaz |
| Sihirbaz ile konsey arasında bağ yok | Konsey yalnız `curl` ile başlatılabilir |
| Gelen kutusu üretimde tüketilmiyor | `message_receipts` sonsuza dek `enqueued` kalır |
| `handleExecutionError` durumu yanlış bildiriyor | Altyapı hatasında görev `working`'de asılı kalır |
| Bağlam bütçesi üretimde 500 token'a çöküyor | Worker'a docs/06'nın vaat ettiği bağlamın çok altı ulaşır |
| Embedding katmanı yok | docs/06'nın semantik geri getirmesi fiilen yoktur |

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
