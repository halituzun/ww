# 09 — Kod Standartları

> Üretilen projelerin MVVM şablonları, starter template'ler, adlandırma/kod
> standartları ve denetçi agent kontrol listeleri.
> İlgili: [Agent Sistemi](03-agent-sistemi.md) · [Executor](05-executor.md) ·
> [İletişim Sözleşmesi](13-agent-iletisim-sozlesmesi.md)

## İçindekiler

1. [İlkeler](#ilkeler)
2. [MVVM Şablonları](#mvvm-şablonları)
3. [Starter Template'ler](#starter-templateler)
4. [Adlandırma ve Kod Standartları](#adlandırma-ve-kod-standartları)
5. [Denetçi Kontrol Listeleri](#denetçi-kontrol-listeleri)
6. [İletişim Denetimi](#communication_audit--iletişim-denetim-profili)

---

## İlkeler

- Standartlar **yazılıdır ve DB'dedir**: her proje açılışında bu dokümandaki
  standartlar `knowledge(kind='standard')` kayıtları olarak seed'lenir; Context
  Builder her kod görevine ilgili standardı koyar; denetçiler bunlara karşı denetler.
- Standart değişikliği plan kararıdır: konsey/PM önerir, kullanıcı onaylar,
  `knowledge` yeni sürüm alır — sonraki görevler yeni standartla çalışır.
- Linter/formatter otomatiktir (kapıda koşar); denetçi agent'lar linter'ın
  göremediği **mimari** ihlalleri arar.

## MVVM Şablonları

### Web (React + TypeScript)

```
src/
├── views/            # SADECE görsel: JSX + stil; hook'tan gelen veriyi çizer
│   └── cart/CartView.tsx
├── viewmodels/       # useXxxViewModel hook'ları: durum + kullanıcı eylemleri
│   └── cart/useCartViewModel.ts
├── models/           # Tip ve saf iş nesneleri (framework'süz)
│   └── Cart.ts
├── services/         # API/IO: fetch, storage; ViewModel'lerin tek veri kapısı
│   └── CartService.ts
├── stores/           # Paylaşılan durum (zustand) — ViewModel'ler üzerinden erişilir
└── shared/           # ortak yardımcılar, sabitler
```

Kurallar: View'da `fetch`/iş mantığı yasak; ViewModel DOM'a dokunmaz;
Model hiçbir katmanı import etmez; Service React import etmez.

### Mobil (Flutter + Riverpod)

```
lib/
├── views/            # Widget'lar; ref.watch(provider) ile ViewModel'e bağlanır
├── viewmodels/       # Notifier sınıfları (Riverpod) + state sınıfları
├── models/           # veri sınıfları (freezed)
├── services/         # API/IO
└── shared/
```

Kurallar: Widget içinde iş mantığı yasak; ViewModel `BuildContext` almaz;
Service Flutter import etmez.

### Backend API (NestJS)

```
src/
├── controllers/      # HTTP katmanı: doğrulama + yönlendirme, iş mantığı yasak
├── services/         # İş mantığı
├── repositories/     # Veri erişimi (ORM/SQL burada hapsolur)
├── models/           # entity + DTO
└── shared/
```

Kurallar: Controller repository'ye doğrudan erişemez; SQL yalnız repository'de;
DTO'lar `class-validator` ile doğrulanır.

## Starter Template'ler

`packages/executor/templates/<tür>/` — proje açılışında kopyalanır, ilk commit olur:

- Yukarıdaki klasör iskeleti + örnek bir dikey dilim (1 View + ViewModel + Model +
  Service, çalışır ve testli) — agent'lara "böyle yazılır" canlı örneği.
- Hazır yapılandırma: TS strict, ESLint + Prettier (web/api), `analysis_options.yaml`
  (Flutter), Vitest/flutter_test kurulu, `ww.gate.json` kapı tanımı
  ([05 — Kapı](05-executor.md#çalıştırmatest-kapısı)).
- `.gitignore`, `README.md` (üretilen projenin kendi tanıtımı; ww günceller).

## Adlandırma ve Kod Standartları

| Konu | Kural |
|---|---|
| Dosya adları | Web/API: `PascalCase.ts` sınıf/bileşen, `camelCase.ts` yardımcı; Flutter: `snake_case.dart` |
| Sınıf/tip | `PascalCase`; ViewModel'ler `XxxViewModel`/`useXxxViewModel`; servisler `XxxService`; repository `XxxRepository` |
| Değişken/fonksiyon | `camelCase`; boolean'lar `is/has/can` önekli |
| Sabitler | `SCREAMING_SNAKE_CASE` |
| DB nesneleri (üretilen projede) | tablo `snake_case` çoğul; kolon `snake_case`; migration dosyaları sıralı |
| API uçları | REST çoğul isim (`/api/products/:id`); durum kodları doğru kullanılır |
| Hata yönetimi | Boş `catch` yasak; kullanıcıya dönen hatalar tiplidir |
| Test | Her yeni davranışa test; test adı davranışı anlatır |
| Yorumlar | Kod ne yaptığını söyler, yorum *neden*i söyler; ölü kod bırakılmaz |
| Dil | Üretilen kod ve yorumlar İngilizce; kullanıcıya görünen UI metinleri projenin diline göre |
| Boyut | Dosya > 300 satır veya fonksiyon > 50 satır → bölünme değerlendirilir (denetçi işaretler) |

## Denetçi Kontrol Listeleri

Denetçiler (`standards_auditor`) şu tetiklerle çalışır: her N görev tamamlanışında
(varsayılan 5), her faz bitiminde, PM/kullanıcı istediğinde. *(2026-08-18'e kadar
yalnız SONUNCUSU vardı: `auditFiles`'ı çağıran tek yer HTTP denetleyicisiydi,
yani denetim ancak elle tetiklenirse koşuyordu. Commit sonrası tetik eklendi ve
yalnız commit'lenen dosyaları denetler; tüm depoyu taramak her beşinci görevde
pahalı ve gürültülü olurdu. Faz bitişi tetiği hâlâ yok.)* Bulgular denetim
ekranına düşer, her bulgu düzeltme görevine bağlanır ([08 — Denetim](08-panel.md#denetim-ekranı)).

### `mvvm_audit` — katman denetçisi

- [ ] View/Widget içinde servis çağrısı, `fetch`, SQL veya iş mantığı var mı?
- [ ] ViewModel'de UI framework importu (React/Flutter) var mı?
- [ ] Model katmanı başka katmana bağımlı mı?
- [ ] Servis dışında IO yapan yer var mı?
- [ ] Controller'da iş mantığı / repository dışında SQL var mı? (API)
- [ ] Katmanlar arası bağımlılık yönü doğru mu? (View→VM→Service→Model)

*(2026-08-18: denetçinin bir KÖR NOKTASI kapatıldı — `isViewFile` yalnız
`components/views/pages` altına bakıyor, yani KÖK bileşen (`App.tsx`) hiç
denetlenmiyordu. Panelin en çok dokunulan dosyasını atlayan bir kural yarı
yarıya işlevsizdir. Giriş dosyası (`main.tsx`) denetlenmez: bileşen değildir,
yalnız kökü DOM'a bağlar.)*

### `ui_audit` — UI-dostu denetçisi

*(kısmen uygulandı 2026-08-18: STD-004 erişilebilir ad kontrolü. Listenin
görsel maddeleri — kontrast, boşluk tutarlılığı, taşma — statik olarak
güvenilir biçimde karara bağlanamaz; onlar hâlâ insan/model denetimidir.*

*BOŞ DURUM maddesi de denetçiye KONMADI ve nedeni ölçüldü: "listeyi map'leyip
uzunluk kontrolü yapmayan bileşen" sezgisi panelde 2 aday buldu, biri yanlış
pozitifti (sabit sekme listesi — veri değil). %50 yanlış pozitif bir kapıyı
aşındırır ve aşınan kapı susturulur. Kural elle uygulanıyor; bu turlarda
TaskListPanel, FileBrowserPanel, ProjectPicker ve TaskCanvas'a boş durum
eklendi.)*

- [ ] Ekranlar arasında yazı tipi/boşluk/renk tutarlı mı (tasarım sistemine uyum)?
- [ ] Yükleme/boş/hata durumları her ekranda tasarlanmış mı?
- [ ] Formlarda doğrulama mesajları anlaşılır ve yerinde mi?
- [ ] Erişilebilirlik: kontrast, dokunma hedefi boyutu, label'lar?
- [ ] Mobil/dar ekranda taşma-kırılma var mı?
- [ ] Geri/iptal yolları her akışta var mı?

### `db_write_audit` — DB-yazım denetçisi

İki kapsamı vardır:

**a) Üretilen projenin DB kodu:**
- [ ] Şema adlandırma standarda uygun mu? Migration'lar sıralı ve geri alınabilir mi?
- [ ] Sorgular repository katmanında mı? İndeks ihtiyaçları düşünülmüş mü?
- [ ] Kullanıcı girdisi parametreli sorguyla mı geçiyor (injection)?

**b) ww kayıtlarının tamlığı (meta-denetim):** *(uygulandı 2026-08-18 —
`record-audit.ts`; denetim ekranında "Kayıt eksikleri" bölümü. İlk canlı
koşuda gerçek bir bulgu verdi: done + commit'li bir görevin hiç `artifacts`
kaydı yoktu.)*
- [ ] Tamamlanan görevlerin `artifacts` kayıtları açılmış mı?
- [ ] Dokunulan her dosyanın `file_index` kaydı güncel mi (özet ↔ içerik tutarlı)?
- [ ] Önemli kararlar `knowledge`'a yazılmış mı (mesajlarda kalıp kaybolmuş karar var mı)?
- [ ] `tasks.commit_hash` boş kalan done görev var mı?

### `coding` standardı (verifier'ın her görevde baktığı asgari liste)

- [ ] Kabul kriterleri karşılanıyor mu?
- [ ] Yeni davranışın testi var mı, kapı geçiyor mu?
- [ ] Adlandırma/dosya yerleşimi standarda uygun mu?
- [ ] Gereksiz bağımlılık eklenmiş mi?
- [ ] Var olan davranışı bozan değişiklik var mı (diff dışına taşan etki)?

### `communication_audit` — iletişim denetim profili

- [ ] Her mesaj desteklenen protokol/payload sürümüyle doğrulanmış mı?
- [ ] Gönderen rolü, alıcı ve mesaj türü policy kararıyla yetkili mi?
- [ ] Soru/cevap `replyToMessageId`; retry/yan etki idempotency anahtarıyla bağlı mı?
- [ ] Worker, verifier ve provider aynı immutable `taskBriefId`yi kullanmış mı?
- [ ] Geçmiş göreve cutoff sonrası plan, kural, prompt veya hafıza sızmış mı?
- [ ] Redis bildirimi olmasa bile durable inbox ve receipt zinciri tamamlanmış mı?
- [ ] Verdict/finding; kural sürümü, kanıt ve düzeltme göreviyle izlenebilir mi?

Bu kontrollerin şema/yetki/FSM bölümü deterministik guard'larda; anlam ve kanıt
bölümü mevcut `standards_auditor` rolünün bu profilinde çalışır. Ayrıntılar:
[13 — Agent İletişim Sözleşmesi](13-agent-iletisim-sozlesmesi.md).
