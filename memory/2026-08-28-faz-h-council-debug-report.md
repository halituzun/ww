# Faz H Konsey Debug Raporu

Tarih: 2026-08-28

## Symptom

Çelişkili web oyunu brief'i 5 turda konsensüs ilan ediyordu. Nihai karar metni hesap makinesi projesinden kalma eval/AST/float bulgularını içeriyordu. Araştırma turu ayrı tur olarak açılmıyor, H1 yakınsama sayaçları kanıt tablosu olarak saklanmıyor, panel karar defteri canlı veri yokken aynı örnek bulguları fallback olarak gösteriyordu.

## Root Cause

Ana kök neden prompt kirliliğiydi: `apps/server/src/council.service.ts` içindeki `draft_synthesis` yönergesi eval/regex, özel parser/AST ve float kontrolünü proje bağımsız örnek olarak dayatıyordu. Model bu örneği oyun projesinde de gerçek bulgu gibi kopyalıyordu.

İkinci kök neden protokol/panel biçim uyumsuzluğuydu: `packages/agents/src/council-service.ts` dinamik tur döngüsü içeriyordu ancak araştırma ihtiyacını ilk nihai sentezden sonra ele alıyordu; plan markdown'u ve panel parser'ı ise fiilen Tur 1-5 statik bölümlerine yaslanıyordu.

Üçüncü kök neden konfigürasyon drift'iydi: `apps/panel/.env.local` içindeki `VITE_SESSION_TOKEN`, kök `.env` içindeki `WW_LOCAL_SESSION_TOKEN` ile uyuşmuyordu. HTTP fallback'i bazı yerlerde sorunu gizlerken WebSocket fail-closed kırmızı görünüyordu.

Dördüncü kök neden okuma projection boşluğuydu: `apps/server/src/council.controller.ts` içindeki `GET /projects/:projectId/council/:sessionId` ucu yalnız `payload.text` okuyordu. Konseyin `proposal`, `objection` ve `synthesis` mesajları ise `payload.markdown` taşıdığı için tartışma metni boş dönebiliyor; ayrıca `provenance.sourceVersion` dışarı verilmediği için `research` ve `debate_round` turları API tüketicisinde sıradan `proposal` gibi görünüyordu.

## Fix

- Proje dışı eval/AST/float örnekleri Tur 3/Tur 5 promptlarından kaldırıldı.
- `buildCouncilTurnPrompt` export edildi ve promptlar test edilebilir hale getirildi.
- H1 `checkConvergence` çıktısına `openObjectionCount` eklendi; çevrimdışı + canlı skor çelişkisi açıkça ele alınmadığında çözümsüz sayılıyor.
- H2 araştırma turu final sentezinden önce açılıyor: Tur 4 ölçümü `araştırma=true` ise Tur 5 araştırma, Tur 6 nihai sentez oluyor.
- Boş üye cevabı bir kez tekrar deneniyor; yine boşsa `[KATILMADI]` olarak kayda giriyor.
- Plan markdown'u tüm dinamik turları ve H1 yakınsama tablosunu saklıyor.
- Panel dinamik `## Tur N · ...` bölümlerini okuyabiliyor; fallback karar defteri örnek eval/float satırları kaldırıldı.
- Panel Vite config kök `.env` ile panel token'ını karşılaştırıyor ve uyuşmazsa başlangıçta hata veriyor.
- Konsey tartışma endpoint'i `markdown`, `summary`, `text`, `instruction`, `reason` alanlarından metin çıkarıyor; `sourceId`, `sourceVersion` ve `councilKind` alanlarını döndürüyor. Böylece task raporu invariantı bozulmadan `research`/`debate_round` turları API'de görülebiliyor.

## Evidence

Odak testler geçti:

- `pnpm --filter @ww/agents exec vitest run src/council-service.test.ts`
- `pnpm --filter @ww/server exec vitest run src/council.service.test.ts src/council-plan.test.ts`
- `pnpm --filter @ww/server exec vitest run src/council.controller.test.ts src/council.service.test.ts src/council-plan.test.ts`
- `pnpm --filter @ww/panel exec vitest run src/components/CouncilTranscriptViewer.test.tsx src/services/http.test.ts`
- `pnpm --filter @ww/agents build`
- `pnpm --filter @ww/server build`

H1 test log örnekleri:

```text
[H1] tur=4 açık_itiraz=0 çözümsüz=1 çelişki=0 araştırma=true → DEVAM
[H1] tur=6 açık_itiraz=0 çözümsüz=0 çelişki=0 araştırma=false → KAPANDI
[H1] tur=5 açık_itiraz=0 çözümsüz=1 çelişki=1 araştırma=false → DEVAM
[H1] tur=7 açık_itiraz=0 çözümsüz=1 çelişki=1 araştırma=false → DEVAM
[H1] tur=9 açık_itiraz=0 çözümsüz=1 çelişki=1 araştırma=false → DEVAM
```

Gerçek model canlı denemesi: `c1c7c902-5ad5-4718-944c-28a59dfe536c`.

Bu koşuda eski tek seferlik konsey prosesleri temizlendikten sonra DB'ye üç öneri yazıldı; önerilerde kapsam şişmesi ve araştırma ihtiyacı görüldü. Yerel Ollama ilk itirazı üretirken 10 dakikayı aştığı için koşu kontrollü kesildi. Bu nedenle gerçek model kalitesi ayrıca doğrulanmalıdır.

Deterministik canlı servis kanıtı: `280d000a-9aee-4164-ac49-b526e1043369`.

Bu koşu gerçek ClickHouse, Redis, mesaj yazımı, karar defteri ve plan yazımı yolundan geçti; yalnız LLM çıktıları kontrollü completer ile verildi.

```text
[H1] tur=4 açık_itiraz=0 çözümsüz=1 çelişki=0 araştırma=true → DEVAM
[H1] tur=6 açık_itiraz=0 çözümsüz=1 çelişki=1 araştırma=false → DEVAM
[H1] tur=8 açık_itiraz=0 çözümsüz=1 çelişki=1 araştırma=false → DEVAM
```

Sonuç:

- `status=uncoordinated`
- `totalRounds=9`
- `turns=13`
- Tur 5 `sourceVersion=research`
- Tur 7 ve Tur 9 `sourceVersion=debate_round`
- Karar defteri:
  - Çevrimdışı çalışma ile canlı küresel skor tablosu çelişkisi → `rejected`, `turn_number=8`
  - Kütüphane desteği belirsizliği → `accepted`, `turn_number=8`
  - Kapsam şişmesi → `accepted`, `turn_number=8`

Son tekrar kanıtı:

- `planId=35233bc4-bcec-49be-8ea0-fde30503da1b`
- `council_session_id=f992a725-37d8-453e-b610-d4a8ae5ead35`
- Plan durumu: `uncoordinated`
- Mesaj provenance:
  - Tur 5: `sourceVersion=research`, `kind=proposal`
  - Tur 7: `sourceVersion=debate_round`, `kind=proposal`
  - Tur 9: `sourceVersion=debate_round`, `kind=proposal`
- Bu mapping kasıtlıdır: `report` payload'ı görev/brief/invocation kimliği gerektirdiği için task dışı konsey turlarında kullanılmıyor; gerçek konsey türü `provenance.sourceVersion` ve API'deki `councilKind` ile taşınıyor.

## Status

DONE_WITH_CONCERNS

Kod seviyesinde kök neden düzeltildi, odak testlerle ve deterministic canlı DB/servis koşusuyla kanıtlandı. Gerçek model ile uçtan uca final koşusu yerel model yanıt süresi nedeniyle tamamlanamadı; model kalitesi kanıtı için ayrı, zaman sınırlı sağlayıcı/LLM koşusu alınmalı.
