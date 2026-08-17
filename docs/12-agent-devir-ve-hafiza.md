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

**Son doğrulama: 2026-08-17, dal `agent/agent-communication-contract`
(remote ile senkron).**

- **Kapı durumu:** `WW_REQUIRE_INTEGRATION=1 pnpm test` → **912 test**, 10 paket,
  hata yok. `pnpm --filter @ww/executor test:live` → 4/4 (opt-in canlı Docker
  sandbox; varsayılan koşuda atlanır). `pnpm build`, `pnpm lint` ve
  `pnpm wiring:check` yeşil. Çalışma ağacı temiz.
- **Faz durumu:** Faz 0, 1 ve 2 tamamlandı ✅. Faz 3-6 kod tamam, kabul
  senaryoları açık — ayrıntı `docs/11-yol-haritasi.md` "Durum Özeti".
- **En kritik gerçek:** Platform hâlâ **hiç gerçek LLM API'sine bağlanmadı**;
  `api_usage`'da gerçek çağrı yok. Sebebi yalnız anahtar eksikliği değil:
  orkestrasyon runtime'ı çalışan sunucuda hiç başlamıyor (aşağı bakın).
- **En kritik açık:** Orkestrasyon runtime'ı başlamıyor
  (`WW_PHASE8_RUNTIME_ENABLED` ayarlanmıyor, `registerPhase9RuntimeConfig`
  çağrılmıyor, `SchedulerWorker` kurulmuyor). Artık açılış logunda ve
  `GET /runtime` ucunda görünür. Bağlamak için gereken parçalardan ikisi
  2026-08-17 gecesinde tamamlandı: sağlayıcı adaptör kaydı
  (`buildProviderRegistry`) ve rol→model yönlendirme indeksi
  (`buildRoutingIndex` + `loadRoutingIndex`). Kalan: `schedulerOperations`
  (gate/commit/transition/escalate/reassign üretim karşılıkları) ve executor
  kompozisyonu.

### 2026-08-17 gecesinde yapılanlar (21 commit)

Tekrar eden hata deseni: **yazılmış, testli, ama hiçbir üretim kodu çağırmıyor.**
Bir gecede beş ayrı yerde bulundu ve artık `pnpm wiring:check` kapısıyla
korunuyor (`wiring-baseline.json` mevcut 43 ihlali dondurur, yenileri düşer).

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
