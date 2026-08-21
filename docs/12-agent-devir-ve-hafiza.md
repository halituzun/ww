# 12 — Agent Devir ve Hafıza Protokolü

> Codex, Claude ve sonraki geliştirme ajanlarının aynı kararları, test standardını ve
> Git geçmişini koruyarak çalışması için oturum protokolü.

## Kaynakların Önceliği

Çelişki halinde sıralama şöyledir: güncel kullanıcı talebi → `AGENTS.md` ve
`CLAUDE.md` → Git geçmişi ve çalışan testler → mimari belgeler → yerel hafıza notları.
Hafıza bir hızlandırıcıdır; kod veya Git geçmişinin yerine geçmez.

## Oturum Başlangıcı

1. `git status -sb`, `git log --oneline -10` ve remote durumunu kontrol et.
2. Çalışma ağacı temizse `git pull --ff-only` çalıştır.
3. Yol haritasındaki aktif fazı ve kabul senaryosunu oku.
4. `docker compose up -d` ile ClickHouse ve Redis'i başlat.
5. claude-mem worker kapalıysa `npx claude-mem@latest start` çalıştır.
6. İlk Claude oturumunda `/learn-codebase`; sonraki oturumlarda enjekte edilen hafıza
   ve `/context-restore` çıktısını Git ile karşılaştır.

## Çalışma ve Git Akışı

- Büyük işleri kabul kriteri olan küçük, dikey parçalara ayır.
- Her parçada test yaz; `pnpm build`, ilgili testler ve `pnpm lint` yeşil olmadan
  commit oluşturma.
- Scoped Conventional Commit kullan: `feat(agents): ...`, `fix(db): ...`,
  `test(scheduler): ...`, `docs: ...`.
- `pnpm wiring:check` koş: bu depoda tekrar eden en pahalı hata deseni
  "yazılmış, testli, ama hiçbir üretim kodu çağırmıyor"dur (bir gecede beş
  ayrı yerde bulundu). Kapı yeni ihlalleri engeller.
- Her doğrulanmış mantıksal parçayı ayrı commit et. Faz sonunda tam canlı kapıyı
  `WW_REQUIRE_INTEGRATION=1 pnpm test` ile çalıştır; skip varsa faz kapanmaz.
- Tamamlanan ve yeşil kilometre taşını push et. `main` üzerinde force-push, geçmiş
  yeniden yazımı veya doğrulanmamış roadmap işareti yasaktır.

## Hafıza Senaryosu

claude-mem Claude'un Read/Edit/Bash işlemlerini yerel gözlemlere sıkıştırır; ilgili
gözlemler ikinci proje oturumundan başlayarak otomatik gelir. Veriler
`~/.claude-mem` altında kalır. Bu depoda iki tamamlayıcı katman kullanılır:

- **Otomatik hafıza:** keşifler, uygulama ayrıntıları ve geçmiş çalışma bağlamı.
- **Açık checkpoint:** `/context-save faz-1-<konu>` ile kararlar, kalan işler ve Git
  durumu; sonraki ajan `/context-restore` ile yükler.

Oturum sonunda çalışma ağacını doğrula, kararları ilgili mimari belgeye geçir, kısa
checkpoint oluştur ve push edilmemiş commit bırakma nedenini açıkça yaz.

## Mevcut Devir Noktası

> Bu bölüm her oturum sonunda güncellenmelidir. Güncellenmezse sonraki ajan yanlış
> yerden başlar — 2026-08-12 → 2026-08-16 arasında tam olarak bu oldu: Codex 72
> commit ekledi, bu bölüm "sıradaki iş Faz 1" demeye devam etti.

**Son doğrulama: 2026-08-21, dal `agent/agent-communication-contract`
(remote ile senkron).**

- **Kapı durumu:** `pnpm gate` (temizlik + build + entegrasyonlu test + lint +
  wiring-check + öz-denetim) yeşil (2047+3 yeni test). Çalışma ağacı temiz,
  uzak dal güncel.
- **Sağlayıcılar (2026-08-21):** `mistral` bakiyeli ve **çalışıyor** (sağlık
  `ok`); `openai` ve `deepseek` anahtarları geçerli ama bakiyesiz (429/402).
  Roller mistral'e yönlendirildi; mistral için fiyat satırı eklendi.
  Mistral ile canlı görev koşusu başarılı (`mistral-entegrasyon-2` projesi,
  commit `85dd01e`). Konsey ≥3 sağlayıcı gereği hâlâ açık: bakiye yüklenince
  ya da yeni sağlayıcı gelince Faz 4 kapanış koşusu yapılabilir.
- **Faz durumu:** Faz 0-3 tamamlandı ✅. Faz 4-6 kod tamam; kapanış dış girdi
  bekliyor: konsey için bakiyeli 2. ve 3. sağlayıcı (Faz 4), Chrome
  eklentisiyle gözle izleme (Faz 5), üç gerçek proje koşusu + Android SDK
  (Faz 6). Ayrıntı ve kanıt tabloları `docs/11-yol-haritasi.md`.
- **Gerçek API:** Platform 2026-08-17 akşamından beri gerçek LLM API'siyle
  çalışıyor; orkestrasyon runtime'ı açılışta başlıyor, görevler gerçek
  commit'ler üretti (`api_usage`'da 1000+ `ok` çağrı). DeepSeek bakiyesi
  2026-08-18'de bitti (`402`); o zamandan beri canlı koşu yok.
- **`no_key` olayı (2026-08-19/20, çözüldü):** Sağlık ping'leri `no_key`'e
  dönmüştü; kök neden anahtar kaybı değil, server'ın `.env` yüklü olmayan
  shell'den `apps/server` cwd'siyle başlaması ve `keystore.readAll()`'ın her
  okuma hatasını sessizce "boş depo" saymasıydı. Sertleştirme: yalnız
  `ENOENT` boş sayılıyor, Keychain geçici hatasında ana anahtarın üstüne
  yazılmıyor, keystore yolu `resolveKeystoreFile()` ile workspace kökünden
  çözülüyor (cwd bağımsız), `no_key`'de tam yol log'lanıyor ve açılışta
  keystore öz-denetimi çalışıyor. Ayrıntı: `docs/04-model-katmani.md` →
  Anahtar Güvenliği.
- **Bu oturumda ayrıca:** Mühürlü brief bağlamının ve nedensel mesajların
  prompt snapshot'ına bağlanması tamamlandı (önceden Context Builder
  çalışıyor ama çıktısı modele ulaşmıyordu); brief politikası standart ve
  gereksinim bilgi kimliklerini taşıyor; standart bilgi tohumlama
  optimistic concurrency ile yazıyor. Hepsi scoped commit'lerle push'landı.
- **Sıradaki iş:** Sağlayıcı anahtarları geldiğinde Faz 4 kapanış koşusu
  (sıralama `docs/11-yol-haritasi.md` Durum Özeti'nde). Anahtar girerken
  dikkat: `.env`'deki `WW_MASTER_KEY` ile Keychain'deki `ww-master` anahtarı
  FARKLI — server'ı `WW_MASTER_KEY` yüklü başlatın ya da tek kaynağa karar
  verin; aksi halde mevcut `keys.json` çözülemez (artık sessiz değil,
  açılışta görünür).

### 2026-08-17 gecesinde yapılanlar (21 commit)

Tekrar eden hata deseni: **yazılmış, testli, ama hiçbir üretim kodu çağırmıyor.**
Bir gecede beş ayrı yerde bulundu ve artık `pnpm wiring:check` kapısıyla
korunuyor (o gece `wiring-baseline.json` 43 ihlali dondurdu; güncel sayı —
2026-08-20'de 30 — için kapı çıktısına bakın).

- Güvenlik frenleri (token/maliyet/duvar-saati/kaçak döngü) hiç çağrılmıyordu;
  mekanizma, ClickHouse portları ve üretim yolu bağlandı. Varsayılan AÇIK,
  kapatmak için `WW_DISABLE_BRAKES=1` gerekir.
- Periyodik sağlayıcı sağlık kontrolü yoktu; kuruldu ve gerçek 1 token'lık
  ping'e bağlandı. Anahtarsız sağlayıcı `unknown` değil `down` yazar.
- `role_models` tablosu ölüydü; repository, REST ucu, panel tablosu ve
  yönlendirme indeksi eklendi.
- Panel: ayrı API sayfası, kontör panosu, denetim ekranı, bildirim merkezi.
- Panel MVVM'e taşındı (15 ham fetch → 1; saf mantık ViewModel katmanında).

**Sessiz hata sınıfı (en tehlikelisi):** "bağlı görünen ama ölü sistem".
İki örnek bulunup düzeltildi — `listEvents` en eski N olayı döndürdüğü için
canlı besleme 200 olaydan sonra kalıcı susuyordu; panel WebSocket'i kopunca
hiç yeniden bağlanmıyordu. İkisi de hata vermeden çalışıyor görünüyordu.

- Redis istemcisi `5.12.1`; health ve pub/sub istemcileri timeout sonrası koşulsuz
  `destroy()` ile kapanır. Bu cleanup davranışını geriye götürme.
- Yerel servis portları: ClickHouse `8124`, Redis `6380`, API `4000`, panel `5173`.
