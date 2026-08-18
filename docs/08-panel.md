# 08 — Panel

> Türkçe web paneli: ekranlar, canlı tuval, fihristli dosya gezgini,
> API/kontör yönetimi, sohbet-müdahale ve WebSocket olay sözleşmesi.
> İlgili: [Agent Sistemi](03-agent-sistemi.md) · [Model Katmanı](04-model-katmani.md) · [Test Ortamları](10-test-ortamlari.md)

## İçindekiler

1. [Genel Yerleşim](#genel-yerleşim)
2. [Projeler](#projeler)
3. [Canlı Tuval](#canlı-tuval)
4. [Dosya Gezgini ve Fihrist](#dosya-gezgini-ve-fihrist)
5. [API Yönetimi ve Kontör](#api-yönetimi-ve-kontör)
6. [Sohbet ve Müdahale](#sohbet-ve-müdahale)
7. [Denetim Ekranı](#denetim-ekranı)
8. [Bildirimler](#bildirimler)
9. [WebSocket Olay Sözleşmesi](#websocket-olay-sözleşmesi)

---

## Genel Yerleşim

*(Karar K6 — panel dili Türkçe. 2026-08-18: görev durumları panelde HAM
İNGİLİZCE kimlik olarak basılıyordu (`queued`, `waiting_user`); iç
tanımlayıcının kullanıcı yüzeyine sızması, anlatıcının ham olay adı
basmasıyla aynı kusurdur. `taskStatusLabel` eklendi ve kapsamı bir TESTLE
sabitlendi: yeni bir durum eklenip etiketi yazılmazsa test düşer. Bilinmeyen
durumda ad KORUNUR — anlamadığı bir durumu Türkçeleştirmek kullanıcıya
olmayan bir anlam verir.)*

React + Vite + zustand + React Flow + Monaco. Sol dikey menü, üstte proje
seçici + kontör rozeti + bildirim zili.

```
┌──┬────────────────────────────────────────────────┐
│P │  [Proje: e-ticaret ▾]   Kontör: $12.4/$50  🔔3 │
│r ├────────────────────────────────────────────────┤
│o │                                                │
│j │                                                │
│e │              Aktif sayfa içeriği               │
│l │   (Tuval / Dosyalar / API / Sohbet / Denetim   │
│e │              / Test / Ayarlar)                 │
│r │                                                │
└──┴────────────────────────────────────────────────┘
```

Menü: **Projeler · Tuval · Dosyalar · Sohbet · API'ler · Denetim · Test · Ayarlar**

## Projeler

- **Liste**: kart görünümü — ad, tür rozeti (Web/Mobil/API), durum, ilerleme
  (done/tüm görev), harcanan kontör, son etkinlik.
- **İşlemler**: Aç · Duraklat/Devam · Arşivle. Duraklat = zamanlayıcı yeni atama
  yapmaz, süren görevler biter.
- **Yeni proje sihirbazı**: ad + tür seçimi → `interviewer` agent'la gereksinim
  sohbeti (Türkçe) → gereksinim özeti onayı → konsey planlaması başlar →
  plan Türkçe özetle kullanıcı onayına gelir → onayla → üretim başlar.
- **Proje detayı**: plan (aktif sürüm + geçmiş sürümler diff'li), görev listesi
  (durum filtreli), faz ilerlemesi.

## Canlı Tuval

React Flow tabanlı canlı organizasyon şeması:

- **Düğümler**: agent'lar — rol ikonu, ad, model rozeti, durum rengi
  (yeşil idle, mavi busy, sarı waiting, kırmızı escalated, gri stopped).
  Gruplar renkli kümeler halinde; klonlar kaynağının yanında yarı saydam.
- **Kenarlar**:
  - Kalıcı ince çizgi: hiyerarşi (PM → grup liderleri → üyeler).
  - **Hareketli ok** (animasyonlu dash): aktif iş ilişkisi — görev atandığında
    issuer→worker oku belirir, mesajlaşmada ok üzerinde nabız animasyonu,
    verifier denetimdeyken worker⇄verifier çift yönlü ok.
- **Etkileşim**: düğüme tık → yan panelde agent geçmişi (görevleri, mesajları,
  harcadığı token); oka tık → taşıdığı görev/mesaj detayı.
- **Zaman çizelgesi modu**: alttaki kaydırıcıyla geçmişe git — tuval `events`
  akışından o anki durumu yeniden oynatır (kim kime ne zaman iş verdi).
- Besleme: `agent.updated`, `task.updated`, `message.created` olayları
  (aşağıdaki sözleşme); ilk yük REST `GET /projects/:id/canvas`.

## Dosya Gezgini ve Fihrist

- Sol: dosya ağacı (workspace kökü); değişen dosyalarda renk rozeti
  (son commit'te değişti = mavi nokta).
- Orta: Monaco editör, **salt-okunur** (v1) — düzenleme istekleri sohbetten emirle.
- Üst şerit: **fihrist paneli** (`file_index` + bağlı kayıtlar):
  ```
  ┌─────────────────────────────────────────────────────────┐
  │ src/viewmodels/CartViewModel.ts        katman: viewmodel │
  │ "Sepet durumunu yönetir; CartService'e delege eder."     │
  │ İlişkili işler: #T-142 (sepet indirimi) · #T-98 (kurulum)│
  │ Kararlar: [K-12 fiyat yuvarlama] · Değişim: 7 · ⎇ a1b2c3 │
  │ [Geçmişi gör] [Bu dosyayı kim neden değiştirdi?]         │
  └─────────────────────────────────────────────────────────┘
  ```
- "Kim neden değiştirdi?" → narrator akışını çağırır
  ([06 — Nasıl Yaptın](06-hafiza-ve-baglam.md#nasıl-yaptın-akışı)), cevap yan panelde.
- Commit geçmişi sekmesi: dosyanın commit'leri + görev bağlantıları + diff görünümü.

## API Yönetimi ve Kontör

- **Sağlayıcı listesi**: kart başına — ad, sağlık ışığı (yeşil/sarı/kırmızı),
  aktif/pasif anahtarı, model listesi, maskeli anahtar (`sk-…abc4`), fallback sırası
  (sürükle-bırak).
- **Anahtar ekleme**: modal → anahtar girilir → sunucu şifreli depoya yazar →
  test çağrısı → sonuç rozeti.
- Uygulamadaki sağlayıcı yönetimi REST yüzeyi `GET /providers`,
  `PATCH /providers/:providerId` ve `POST /providers/:providerId/key` uçlarını
  kullanır. Panel yalnız maskeli anahtarı gösterir; ham anahtar tarayıcı
  durumuna veya ClickHouse'a yazılmaz.
- **Rol→model eşleme**: tablo — rol, birincil model, yedekler; açılır listeler
  `api_providers.models`'tan. "Model başarı raporu" bağlantısı
  ([Şema → örnek sorgular](02-clickhouse-semasi.md#örnek-sorgular)) karar desteği verir.
- **Kontör panosu**: proje ve global görünüm — günlük maliyet çizgisi, sağlayıcı/model
  kırılımı (pasta), görev başına en pahalı 10 iş, bütçe çubuğu (%80 uyarı çizgisi),
  bütçe düzenleme.

## Sohbet ve Müdahale

- **PM sohbeti**: proje başına Türkçe sohbet; PM cevap verir; "nasıl yaptın?"
  soruları narrator'a yönlenir. Mesajlar `messages(kind='user_command'/'answer')`.
- **Emir yollama**: sohbetten doğal dille; PM yorumlar → küçükse ilgili göreve
  `order`, büyükse yeniden planlama önerisi kullanıcıya sunulur.
- **Plana müdahale**: plan ekranında "değişiklik iste" → gerekçe yazılır →
  konsey revizyon turu → yeni plan sürümü Türkçe özetle onaya gelir.
- **Soru kutusu**: `waiting_user` görevlerin soruları listelenir; kullanıcı
  PM'i beklemeden herhangi bir agent sorusunu görüp doğrudan cevaplayabilir.
  Cevap ilgili `session_id`'ye `answer` olarak düşer ve zorunlu
  `replyToMessageId` ile tam olarak bir pending soruya bağlanır; görev devam eder.

## Denetim Ekranı

- Standart denetçilerinin bulguları: tablo — denetçi grubu (mvvm/ui/db-yazım),
  bulgu, ilgili dosya/görev, durum (açık → düzeltme görevi #id → kapandı).
- Tırmandırma geçmişi: zincir görünümü (worker→lider→profesör→PM→kullanıcı),
  her adımın mesajı.
- Fren olayları: bütçe/ping-pong/kaçak döngü tetikleri.

## Bildirimler

Zil menüsü + istenirse tarayıcı bildirimi. Kaynaklar: kullanıcı sorusu bekleyen
görev, plan onayı bekliyor, bütçe %80/%100, sağlayıcı düştü/fallback kullanıldı,
proje fazı tamamlandı, tırmandırma kullanıcıya ulaştı. Tümü `events` kaynaklı;
görüldü işareti panelde lokal tutulur.

## WebSocket Olay Sözleşmesi

Tek soket, zarf formatı (`packages/shared` tipleri — panel ve server aynı tipi
derler). Aşağıdaki opaque cursor hedefi Faz 3 uygulama planında kesinleştirilir;
Faz 0 `events.seq` alanı public istemci sözleşmesi değildir:

```ts
interface WsEnvelope<T = unknown> {
  event: WsEventName;
  projectId: string;
  cursor: string;       // opaque: (created_at, event_id). İstemci AYRIŞTIRMAZ,
                        // yalnız düz metin olarak karşılaştırır — sözlük sırası
                        // zaman sırasıdır. `events.seq` KULLANILMAZ: her yazıcı
                        // onu farklı ölçekte üretiyor (kilitler 0-3, çoğu olay
                        // epoch-ms, kurtarma/commit hash ~1e18) ve tek bir büyük
                        // değer imleci fırlatıp sonraki her olayı kalıcı olarak
                        // atlatıyordu (ölçüldü ve düzeltildi 2026-08-18).
  ts: string;           // ISO
  data: T;
}

type WsEventName =
  | 'project.updated'     // durum/ilerleme değişti
  | 'plan.updated'        // yeni sürüm / onay durumu
  | 'task.updated'        // durum makinesi geçişi (tuval + listeler)
  | 'agent.updated'       // durum/klon (tuval düğümleri)
  | 'message.created'     // sohbet + tuval ok nabzı
  | 'event.created'       // ham olay (denetim + zaman çizelgesi; filtreli abone)
  | 'usage.updated'       // kontör rozeti/panosu
  | 'provider.health'     // sağlık ışıkları
  | 'question.pending'    // soru kutusu + bildirim
  | 'notification';       // genel bildirimler
```

- Abonelik: `{ subscribe: { projectId, events: [...] } }` — tuval yalnız
  ihtiyacını dinler; `event.created` yüksek hacimlidir, yalnız denetim/zaman
  çizelgesi açıkken abone olunur.
- Kaynak: server, ClickHouse yazımından sonra Redis pub/sub'a basar; gateway
  soketlere dağıtır ([Mimari → Tutarlılık](01-mimari.md#tutarlılık-kuralları)).
- İstemci global/ardışık sayı boşluğu yorumlamaz; snapshot high-water'ı ve son
  opaque cursor'u saklayıp reconnect sırasında dedupe/replay yapar.
- REST tamamlama ucu: `GET /projects/:id/events?after_cursor=<opaque>`.
