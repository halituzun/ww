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

- Faz 0, 2026-08-14 tarihinde canlı ClickHouse/Redis koşusunda tamamlandı.
- Tam kapı 87/87 test ile, sıfır skip olarak geçti; build ve lint tüm workspace'lerde yeşil.
- Redis istemcisi `5.12.1`; health ve pub/sub istemcileri timeout sonrası koşulsuz
  `destroy()` ile kapanır. Bu cleanup davranışını geriye götürme.
- Sıradaki iş Faz 1'dir: executor, temel agent döngüleri, scheduler çekirdeği ve minimal REST.
- Faz 1 planlanırken `docs/05-executor.md`, `docs/03-agent-sistemi.md` ve
  `docs/07-zamanlayici.md` kaynak alınmalıdır.
