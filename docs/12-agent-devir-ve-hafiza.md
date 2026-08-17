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

**Son doğrulama: 2026-08-16, dal `agent/agent-communication-contract`
(main'in 72 commit önünde, remote ile senkron).**

- **Kapı durumu:** `WW_REQUIRE_INTEGRATION=1 pnpm test` → 709 test, 9 paket, hata yok.
  `pnpm --filter @ww/executor test:live` → 4/4 (opt-in canlı Docker sandbox; varsayılan
  koşuda atlanır, faz kapatırken ayrıca koşulmalı). `pnpm build` ve `pnpm lint` yeşil.
  Çalışma ağacı temiz.
- **Faz durumu:** Faz 0, 1 ve 2 tamamlandı ✅. Faz 3-6'nın kodu yazıldı ve testleri
  yeşil, ancak kabul senaryoları **açık** — ayrıntı ve kanıt eşlemesi için
  `docs/11-yol-haritasi.md` içindeki "Durum Özeti" tablosu.
- **En kritik gerçek:** Platform bugüne dek **hiç gerçek LLM API'sine bağlanmadı.**
  `secrets/` yok, `api_providers`'ta yalnız `mock` kayıtlı, `api_usage`'da sıfır
  gerçek çağrı. Her doğrulama `MockProvider` üzerinden yapıldı. Yani ww henüz bir kez
  bile asıl işini (gerçek modellerle uygulama üretmek) yapmadı.
- **En kritik açık:** Orkestrasyon runtime'ı çalışan sunucuda hiç başlamıyor
  (`WW_PHASE8_RUNTIME_ENABLED` ayarlanmıyor, `registerPhase9RuntimeConfig`
  çağrılmıyor, `SchedulerWorker` kurulmuyor). `GET /runtime` bunu raporlar.
  Gerçek uçtan uca koşu için önce bu bağlanmalıdır.
- **Sıradaki iş:** Faz 3'ün kabul senaryosu — panelden gerçek sağlayıcı anahtarı
  girip küçük bir gerçek senaryo koşturmak, kontör panosunda gerçek maliyeti görmek,
  bozuk anahtarla fallback/sağlık rozetini doğrulamak. Faz 4, 5 ve 6 bu koşuya
  zincirleme bağlıdır; sırayı atlamak faz kapatmaz.
- **Terminoloji uyarısı:** "Faz" ile "Phase" aynı şey değildir. Yol haritasında
  **Faz 0-6** (ürün kilometre taşları) vardır; `docs/superpowers/plans/2026-08-14-faz-1-*`
  planının kendi içinde **Phase 0-9** (uygulama adımları) vardır. Koddaki
  `phase9.runtime.integration.test.ts` gibi adlar bu ikinci numaralandırmadandır.
- Redis istemcisi `5.12.1`; health ve pub/sub istemcileri timeout sonrası koşulsuz
  `destroy()` ile kapanır. Bu cleanup davranışını geriye götürme.
- Yerel servis portları: ClickHouse `8124`, Redis `6380`, API `4000`, panel `5173`.
