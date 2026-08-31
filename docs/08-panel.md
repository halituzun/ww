# 08 — Panel

> Türkçe web paneli: ekranlar, genel bakış, canlı tuval, fihristli dosya gezgini,
> API/kontör yönetimi, sohbet-müdahale, komut paleti (⌘K) ve WebSocket olay sözleşmesi.
> İlgili: [Agent Sistemi](03-agent-sistemi.md) · [Model Katmanı](04-model-katmani.md) · [Test Ortamları](10-test-ortamlari.md)

## İçindekiler

1. [Genel Yerleşim ve Kabuk](#genel-yerleşim-ve-kabuk)
2. [Genel Bakış](#genel-bakış)
3. [Projeler ve Proje Seçici](#projeler-ve-proje-seçici)
4. [Canlı Tuval](#canlı-tuval)
5. [Görevler ve Plan](#görevler-ve-plan)
6. [Dosya Gezgini ve Fihrist](#dosya-gezgini-ve-fihrist)
7. [API Yönetimi ve Kontör](#api-yönetimi-ve-kontör)
8. [Sohbet ve Müdahale](#sohbet-ve-müdahale)
9. [Test Ortamları ve Önizleme](#test-ortamları-ve-önizleme)
10. [Denetim Ekranı](#denetim-ekranı)
11. [Sistem Ayarları](#sistem-ayarları)
12. [Komut Paleti (⌘K)](#komut-paleti-k)
13. [Bildirimler](#bildirimler)
14. [WebSocket Olay Sözleşmesi](#websocket-olay-sözleşmesi)

---

## Genel Yerleşim ve Kabuk

*(Karar K6 — panel dili Türkçe. 2026-08-18: görev durumları panelde HAM
İNGİLİZCE kimlik olarak basılıyordu (`queued`, `waiting_user`); iç
tanımlayıcının kullanıcı yüzeyine sızması, anlatıcının ham olay adı
basmasıyla aynı kusurdur. `taskStatusLabel` eklendi ve kapsamı bir TESTLE
sabitlendi: yeni bir durum eklenip etiketi yazılmazsa test düşer. Bilinmeyen
durumda ad KORUNUR — anlamadığı bir durumu Türkçeleştirmek kullanıcıya
olmayan bir anlam verir.)*

*(2026-08-26: Panel docs/08'in sol menü yerleşimini hiç uygulamamıştı, 8 panel
tek sütunda yığılıydı; proje seçimi elle UUID yazmayı gerektiriyordu; sekme
çubuğu karmaşık bir monolit halinde App.tsx içinde yaşıyordu. 2026-08-26
yeniden yapılandırmasıyla 248px sol menü (PROJE / SİSTEM grupları), 58px üst
şerit (ada göre arama popover'lı proje seçici, canlılık göstergesi, bütçe rozeti,
bildirim zili), bağımsız MVVM sayfaları, ⌘K komut paleti ve standart durum
primitifleri (EmptyState, Skeleton, Alert) kuruldu; uydurma değerler ve sabit
etiketler tamamen temizlendi.)*

React + Vite + React Flow + Monaco. 248px sol dikey menü, 58px üst şerit ve
bağımsız sayfa yönlendirme altyapısı:

```
┌──────────────────┬────────────────────────────────────────────────────────┐
│ [WW LOGO]        │ [Proje: e-ticaret ▾]  🟢 Canlı  Kontör: $12.4/$50  🔔3 │
├──────────────────┼────────────────────────────────────────────────────────┤
│ PROJE            │                                                        │
│ • Genel bakış    │                                                        │
│ • Canlı tuval    │                                                        │
│ • Görevler       │                  Aktif Sayfa İçeriği                   │
│ • Dosyalar       │         (Genel Bakış / Canlı Tuval / Görevler          │
│ • PM sohbeti     │           / Dosyalar / PM Sohbeti / Önizleme           │
│ • Test ortamları │          / Projeler / API'ler / Kontör / Denetim        │
│                  │                      / Ayarlar)                        │
│ SİSTEM           │                                                        │
│ • Projeler       │                                                        │
│ • API'ler & model │                                                        │
│ • Kontör panosu  │                                                        │
│ • Denetim        │                                                        │
│ • Ayarlar        │                                                        │
├──────────────────┤                                                        │
│ [ALTYAPI KARTI]  │                                                        │
│ [Komut Paleti ⌘K]│                                                        │
└──────────────────┴────────────────────────────────────────────────────────┘
```

## Genel Bakış

Projenin anlık sağlık ve yürütme kokpitidir:
- **4 KPI Kartı**:
  - *İlerleme*: Tamamlanan görev / toplam görev oranı ve yüzdesi.
  - *Aktif Ajanlar*: Yürütülen görev sayısı ve ajan çalışma durumu.
  - *Bekleyen Kararlar*: Kullanıcı yanıtı bekleyen soru sayısı ve uyarı durumu.
  - *Harcanan Bütçe*: Gerçekleşen maliyet ve varsa bütçe limiti. Veri gelmediğinde `$0.00` uydurmaz, `Bilinmiyor` yazar.
- **Plan Onay Kartı**: Konsey tarafından hazırlanmış bekleyen plan sürümü varsa Türkçe özetle sunulur; tek tıkla onaylanır veya revizyon istenir.
- **Yürütülen Görevler**: Canlıda koşan işçi ve denetçi adımları.
- **Son Olaylar Akışı**: Canlı sistem bildirimleri ve geçişler.
- **Sağ Ray (Varyant B, 340px)**: Hızlı PM emir girişi ve bekleyen sorular kutusu. 1280px altındaki ekranlarda ana panonun altına katlanır (Varyant A).

## Projeler ve Proje Seçici

- **Proje Seçici Popover'ı (`ProjectSwitcher`)**: Üst şeritte yer alır. Elle UUID yazmayı gerektirmez; ada veya türe göre gerçek zamanlı arama yapar, son projeleri listeler ve yeni proje oluşturma bağlantısı sunar.
- **Projeler Sayfası (`ProjectsPage` / `ProjectPicker`)**:
  - *Hızlı Başlat (Express Modu)*: Tek cümlelik uygulama tanımıyla anında gereksinim ve plan başlatır.
  - *Standart Proje Sihirbazı*: Ad, tür (Web/Mobil/API) ve bütçe limiti seçimi.
  - *Proje Kartları Izgarası*: Ad, tür rozeti (W/M/A), Türkçe durum rozeti (`projectStatusLabel`), UUID ve durum geçişleri (Aç / Duraklat / Arşivle). Veri katmanında olmayan hiçbir uydurma yüzde veya sahte harcama basılmaz.

## Canlı Tuval

*(T4 kabul kriteri — hiyerarşik yerleşim ve gerçek ilişkiler).*
- **Hiyerarşik Düğüm Yerleşimi**: Düğümler `canvas-edges.ts` hiyerarşisine göre konumlandırılır:
  - *Seviye 0 (Üst, Y: 40)*: PM düğümü.
  - *Seviye 1 (Orta, Y: 200)*: Grup liderleri, konsey üyeleri ve görüşmeci.
  - *Seviye 2 (Alt, Y: 360)*: İşçiler, denetçiler ve araştırmacılar.
  - *Klonlar*: Klonlandığı kaynak düğümün hemen yanında (+60px X, +35px Y) ve yarı saydam (`opacity: 0.75`) çizilir.
- **Gerçek Oklar**: Oklar ardışık diziden değil, `depends_on` (bağımlılık) ve `parent_task_id` (delegasyon) ilişkilerinden türetilir.
- **Zaman Çizelgesi Modu**: `TimelineScrubber` ile geçmişteki olay anına dönülür; tuval o andaki agent ve görev durumlarını yansıtır.

## Görevler ve Plan

- **Durum Filtreleme**: Tümü, Çalışıyor, Bekliyor, Bitti, Düştü filtre sekmeleri ve anlık arama.
- **Görev Tablosu (`TaskTable`)**:
  - *GÖREV & ID*: Görev başlığı ve kısa UUID'si.
  - *DURUM*: Türkçe durum rozeti (`taskStatusLabel`).
  - *ÖNCELİK*: ClickHouse `tasks.priority` alanından gelen gerçek sayısal öncelik (1-9).
  - *Not*: DB şemasında karşılığı olmayan hiçbir uydurma ajan kolonu basılmaz.
- **Görev Detayı ve Bağımlılıklar**: Görevin girdi dosyaları, beklediği görevler ve çıktıları.

## Dosya Gezgini ve Fihrist

3 Kolonlu mimari:
- **Sol Kolon (280px)**: Proje dosya ağacı ve arama alanı.
- **Orta Kolon (Esnek)**: Salt-okunur Monaco editör önizlemesi ve sözdizimi vurgulama.
- **Sağ Kolon (340px)**:
  - *Fihrist Paneli (`FileFihrist`)*: Dosyanın katmanı, ürettiği çıktılar, ilgili görev bağlantıları ve karar kayıtları.
  - *Narrator ("Nasıl Yapıldı?")*: Dosyaya özel anlatıcı sorusu sorulur; hafıza ve karar kayıtlarına dayalı kanıtlı Türkçe yanıt döner.

## API Yönetimi ve Kontör

- **AI Gateway (CLIProxyAPI)**: Durum kartı — bağlı, bağlanmadı, ulaşılamıyor ve yönetim anahtarı gerekli durumları canlı probe edilir.
- **Sağlayıcı Kartları**: Sağlayıcı adı, sağlık ışığı (`sağlıklı`, `zayıf`, `düştü`), maskeli anahtar ve model listesi. Sağlık rozeti asla gizlenmez; düşen sağlayıcı açık kırmızıyla gösterilir.
- **Rol→Model Eşleme Tablosu**: Rol bazında birincil ve yedek model konfigürasyonu.
- **Kontör Panosu (`BudgetPanel`)**:
  - Stat tile'ları: Toplam maliyet, çağrı sayısı, toplam token, hatalı çağrı.
  - %80 uyarı çizgili bütçe ölçeri ve harcama oranı.
  - Sağlayıcı / model maliyet kırılım çubukları ve en pahalı görevler listesi.
  - Bütçe limiti güncelleme formu.

## Sohbet ve Müdahale

- **PM Sohbeti (`ChatPage`)**: Ham WebSocket olay adı basmaz. `GET /projects/:id/messages` kaynağından gelen gerçek mesajları listeler.
- **Türkçe Tür Rozetleri**: `messageKindLabel` ile türler Türkçe basılır (`kullanıcı emri`, `soru`, `cevap`, `rapor`, `tırmandırma` vb.).
- **Hızlı Emir Girişi (`ChatComposer`)**: Doğal dille PM agent'a emir veya soru gönderme.
- **Bekleyen Sorular Rayı (`PendingQuestions`)**: Agent'ların kullanıcıdan onay veya bilgi bekleyen sorularını listeler; doğrudan yanıtlanır ve görevin kilidi açılır.

## Test Ortamları ve Önizleme

- **Web Önizleme (`PreviewPanel`)**: Canlı iframe önizleme alanı, test sunucusu başlat/durdur kontrolleri, URL göstergesi ve süreç çıktı günlüğü.
- **Mobil Önizleme (`MobilePreviewPanel`)**: Android / Flutter ekran akışı ve koordinat dokunma desteği.
- **API Test Konsolu (`ApiConsole`)**: `api_endpoint` artefaktlarından otomatik üretilen uç noktaların testi ve yanıt süresi/maliyet ölçümü.

## Denetim Ekranı

- **Bulgular Tablosu**: Standart denetçilerinin (MVVM, UI audit, DB yazım kuralları, iletişim denetimi) tespit ettiği ihlaller.
- **Tırmandırma Geçmişi**: İşçi → Lider → Profesör → PM → Kullanıcı tırmandırma zinciri.
- **Fren Olayları**: Bütçe aşımı, kaçak döngü veya ping-pong tetikleyicileri.

## Sistem Ayarları

- **Altyapı Servisleri Bağlantı Durumu**: ClickHouse veritabanı, Redis önbellek, WW API sunucusu ve CLIProxyAPI Gateway bağlantı durumları canlı gösterilir.
- **Oturum Token'ı Doğrulama**: Yönetim erişimi ve API anahtarı oturum geçerlilik testi.
- **Bildirim & Ses Tercihleri**: Masaüstü bildirimleri ve sesli hata uyarıları açma/kapama anahtarları.
- **Klavye Kısayolları**: ⌘K, Enter, Esc vb. sistem kısayolları referansı.

## Komut Paleti (⌘K)

- Klavyeden `⌘K` / `Ctrl+K` ile veya sol menünün altından açılır.
- **Sayfa Geçişleri**: Genel bakış, Tuval, Görevler, Dosyalar, PM sohbeti, Test ortamları, Projeler, API'ler, Kontör, Denetim, Ayarlar arasında anında arama ve geçiş.
- **Hızlı Eylemler**: Yeni proje başlat, plan onayla, bekleyen soruları cevapla.

## Bildirimler

Zil menüsü + tarayıcı bildirimi. Kaynaklar: kullanıcı sorusu bekleyen
görev, plan onayı bekliyor, bütçe %80/%100, sağlayıcı düştü/fallback kullanıldı,
proje fazı tamamlandı, tırmandırma kullanıcıya ulaştı. Tümü `events` kaynaklı;
görüldü işareti panelde lokal tutulur.

## WebSocket Olay Sözleşmesi

Tek soket, zarf formatı (`packages/shared` tipleri — panel ve server aynı tipi
derler). Opaque cursor sözleşmesi:

```ts
interface WsEnvelope<T = unknown> {
  event: WsEventName;
  projectId: string;
  cursor: string;       // opaque: (created_at, event_id)
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
