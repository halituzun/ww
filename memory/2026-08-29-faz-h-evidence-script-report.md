# Faz H Kanıt Script'i Raporu

Tarih: 2026-08-29

## Symptom

Faz H kanıtı önce elle yazılmış inline Node komutlarıyla alınıyordu. Bu hem tekrarlanabilir değildi hem de sorgu hatasına açıktı: bir denemede rastgele `projectId` için proje kaydı olmadığı için `proje bulunamadi`, başka bir denemede `decisions.plan_id` gibi var olmayan kolon sorgulandığı için ClickHouse hatası oluştu.

## Root Cause

`scripts/run_council_contradiction.mjs` doğrudan `ch.insert` ile eski/eksik kolon seti yazıyordu. Bu yol repository katmanındaki `version`, `row_hash`, zorunlu alan ve şema doğrulamalarını atlıyordu. Script ayrıca paket dışından `@ww/db` çıplak import'u yaptığı için kökten `node scripts/...` çalıştırıldığında workspace dependency çözümlemesi kırılıyordu.

## Fix

- Script repository API'lerine geçirildi: `createProject`, `createAgent`, `listMessagesBySession`, `listDecisions`.
- Script kök dışı dependency çözümlemesine bağlı kalmamak için derlenmiş relative `dist` import'larını kullanıyor.
- Varsayılan mod deterministik cevap üreticiyle çalışıyor; `--live` verilirse aynı proje/agent/DB/Redis yolu gerçek modelle denenebiliyor.
- Kanıt çıktısı otomatik olarak `kanit/faz_h_contradiction_<mode>_<timestamp>.json` dosyasına yazılıyor.

## Evidence

Komut:

```text
node scripts/run_council_contradiction.mjs
```

Üretilen kanıt:

```text
kanit/faz_h_contradiction_deterministic_2026-08-29T04-41-58-307Z.json
```

Sonuç özeti:

- `projectId=281f45e5-e267-454b-bf0c-bee8fe893378`
- `planId=591fb518-14b2-4d05-8355-c0437e0ad5f2`
- `sessionId=4c4a8bfe-dabb-4ae7-b398-11a2c0f155f5`
- `status=uncoordinated`
- `totalRounds=9`
- `turnCount=13`
- Tur 5: `sourceVersion=research`
- Tur 7 ve Tur 9: `sourceVersion=debate_round`
- Karar defteri:
  - Çevrimdışı çalışma ile canlı küresel skor tablosu çelişkisi → `rejected`, Tur 8
  - Kütüphane desteği belirsizliği → `accepted`, Tur 8
  - Kapsam şişmesi → `accepted`, Tur 8

H1 logları:

```text
[H1] tur=4 açık_itiraz=0 çözümsüz=1 çelişki=0 araştırma=true → DEVAM
[H1] tur=6 açık_itiraz=0 çözümsüz=1 çelişki=1 araştırma=false → DEVAM
[H1] tur=8 açık_itiraz=0 çözümsüz=1 çelişki=1 araştırma=false → DEVAM
```

## Regression Test

Script seviyesi regression, üretilen JSON kanıt dosyasının kendisidir. Kod tarafındaki endpoint/payload projection testleri ayrıca şurada:

- `apps/server/src/council.controller.test.ts`
- `packages/agents/src/council-service.test.ts`

## Related

Çıktıda `konsey 1 sağlayıcıya düştü` uyarısı beklenir; kanıt projesindeki modeller yerel Ollama sağlayıcısındadır. Bu, Faz H dinamik tur mantığını geçersiz kılmaz ama gerçek çapraz sağlayıcı kalite kanıtı değildir.

## Status

DONE_WITH_CONCERNS

Faz H mantığı, DB/Redis yazımı ve kanıt üretimi tekrarlanabilir hale getirildi. Kalan endişe, gerçek yerel Ollama koşusunun süre açısından halen ağır olmasıdır; `--live` modu bunun için hazırdır.
