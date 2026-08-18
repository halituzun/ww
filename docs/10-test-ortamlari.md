# 10 — Test Ortamları

> Üretilen projeleri panelden canlı görme: web önizleme, Android emülatör,
> API test konsolu.
> İlgili: [Executor → Dev-Server](05-executor.md#dev-server-yaşam-döngüsü) · [Panel](08-panel.md)

## İçindekiler

1. [Genel Yaklaşım](#genel-yaklaşım)
2. [Web Önizleme](#web-önizleme)
3. [API Test Konsolu](#api-test-konsolu)
4. [Android Emülatör](#android-emülatör)
5. [Ortak Davranışlar](#ortak-davranışlar)

---

## Genel Yaklaşım

Test ortamları panelin **Test** sayfasında yaşar; hepsi executor'ın
`ProcessManager`'ına dayanır ([05](05-executor.md#dev-server-yaşam-döngüsü)).
Kullanıcı "çalışırken gör" der; sistem ilgili süreci başlatır, panel bağlanır.
Süreç durumu ve logları her ortamda ortaktır.

Sıralama bilinçlidir: **web önizleme → API konsolu → emülatör** —
kolay olandan zora ([11 — Yol Haritası, Faz 6](11-yol-haritasi.md#faz-6)).

## Web Önizleme

- "Önizlemeyi başlat" → `ProcessManager` `dev` sürecini başlatır (`vite` vb.),
  port havuzundan port alır (42000-42999).
- Panel içinde `iframe` ile `http://localhost:<port>` gösterilir; üst şeritte:
  - cihaz çerçeveleri (masaüstü / tablet / telefon genişlikleri),
  - yenile, yeni sekmede aç,
  - süreç durumu + "son 200 satır log" çekmecesi.
- HMR sayesinde agent'ların onaylanan değişiklikleri anında yansır — kullanıcı
  tasarımı canlı izleyip sohbetten emir verebilir ("başlığı büyüt" → PM → görev).
- Not: iframe engeli çıkarsa (`X-Frame-Options`) dev sunucusu şablonda
  `frame-ancestors localhost` ile açık gelir (starter template ayarı).

## API Test Konsolu

- Kaynak: üretilen API projesinin `artifacts(artifact_type='api_endpoint')`
  kayıtları — her uç için yöntem, yol, örnek istek gövdesi.
- Ekran: sol uç listesi (Controller'a göre gruplu) → orta panelde istek
  düzenleyici (yöntem, yol parametreleri, header, JSON gövde) → "Gönder" →
  yanıt görüntüleyici (durum kodu, süre, JSON ağacı).
- İstekler panelden server üzerinden proxy'lenir (CORS derdi olmaz);
  her deneme `events`'e yazılır (kullanıcı testi de izdir).
- "Bu ucu kim yazdı?" bağlantısı → fihrist/narrator akışı.

## Android Emülatör

Emülatör **host'ta** çalışır (Docker'a girmez); gereksinimler ve akış:

- **Gereksinimler** (kurulum dokümanı üretilecek): Android Studio veya
  command-line tools, en az bir AVD imajı, `ANDROID_HOME` tanımlı,
  Flutter SDK. Server açılışta `flutter doctor` / `emulator -list-avds`
  ile durumu tespit eder; eksikler Test sayfasında yönergeyle gösterilir.
- **Akış**:
  1. Panel "Emülatörü başlat" → `emulator -avd <ad>` süreci.
  2. `adb wait-for-device` → cihaz hazır.
  3. "Uygulamayı çalıştır" → `flutter run -d emulator-5554` (hot reload açık).
  4. Görüntü: v1'de **scrcpy yok**; ekran akışı `adb exec-out screencap` ile
     saniyede ~2 kare PNG olarak panele basılır (yeterli ve bağımlılıksız).
     v2'de ws-scrcpy entegrasyonu değerlendirilir (akıcı görüntü + dokunma).
  5. Panelden temel etkileşim: geri/ana ekran tuşları, metin gönderme
    (`adb shell input`), koordinatla dokunma (görüntü üzerine tık → `input tap`).
- Flutter web fallback: emülatör kurulamayan ortamda mobil proje
  `flutter run -d chrome` ile web önizlemeye düşer (uyarıyla).

## Ortak Davranışlar

- Her ortam başlat/durdur olayları `events`'e yazılır; süreç çökerse panelde
  rozet + tek tık yeniden başlatma. *(Olay yazımı 2026-08-18'de eklendi:
  `process_started`/`process_stopped` türleri şemada tanımlıydı ama hiçbir
  üretim kodu yazmıyordu — canlı veritabanında sıfır satır. Önizleme açılıp
  kapanıyor, zaman çizelgesinde hiç iz kalmıyordu. Emülatör tarafı ve "çöktü"
  rozeti hâlâ eksik.)*
- Aynı anda proje başına en çok 1 önizleme + 1 emülatör süreci (kaynak koruması).
- Proje duraklatılırsa/arşivlenirse süreçler kapatılır. *(2026-08-18'de
  uygulandı: hiçbir yer proje DURUMUNA bakmıyordu, duraklatılmış projenin dev
  sunucusu çalışmaya devam edip port tutuyor ve bayat içerik sunuyordu. Kural
  durum yoklamasına bağlandı — ayrı zamanlayıcı kurmak, kuralı bir bileşenin
  ömrüne bağlamak olurdu. `completed` de kapatılır; `draft`/`gathering`/
  `planning` KAPATILMAZ, çünkü proje henüz başlamamıştır, durdurulmuş
  değildir.)*
- Test ortamındayken kullanıcının verdiği emirler normal akışla PM'e gider;
  "gördüğüm şu ekranda X'i değiştir" türü emirler için aktif ekran bağlamı
  (hangi route/ekran açık) emre iliştirilir.
