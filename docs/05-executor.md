# 05 — Executor (Tool-Use Katmanı)

> Agent'ların dünyaya dokunduğu tek kapı: araç tanımları, sandbox sınırları,
> git entegrasyonu, çalıştırma/test kapısı ve dev-server yaşam döngüsü.
> İlgili: [Model Katmanı](04-model-katmani.md) · [Agent Sistemi](03-agent-sistemi.md) · [Test Ortamları](10-test-ortamlari.md)

## İçindekiler

1. [İlkeler](#ilkeler)
2. [Araçlar](#araçlar)
3. [Sandbox ve Güvenlik Sınırları](#sandbox-ve-güvenlik-sınırları)
4. [Git Entegrasyonu](#git-entegrasyonu)
5. [Çalıştırma/Test Kapısı](#çalıştırmatest-kapısı)
6. [Dev-Server Yaşam Döngüsü](#dev-server-yaşam-döngüsü)
7. [Hata ve Retry Politikaları](#hata-ve-retry-politikaları)

---

## İlkeler

- Agent'lar dosya sistemine, komutlara, git'e ve web'e **yalnızca** executor
  araçlarıyla dokunur. Araç dışı yol yoktur.
- Her araç çağrısı ve sonucu `events`'e yazılır (`tool_call` + `tool_result`);
  büyük çıktılar kırpılır, tam hali gerekiyorsa diskteki log dosyasına referans konur.
- Araçlar **idempotent-dostu** tasarlanır: yarım kalan görev güvenle yeniden
  başlatılabilir (working tree temizlenir, commit'ler kalır).

## Araçlar

JSON Schema tanımları `packages/executor/tools/` altında tek kaynaktır; adaptörler
sağlayıcı biçimine çevirir. Roller yalnızca kendine tanınan araçları görür.

| Araç | Parametreler (özet) | Kim kullanır | Not |
|---|---|---|---|
| `read_file` | path, offset?, limit? | herkes | Workspace-göreli yol |
| `write_file` | path, content | worker | Dosya kilidi gerektirir |
| `edit_file` | path, old, new | worker | Birebir eşleşme; kilit gerekir |
| `move_file` / `delete_file` | from,to / path | worker | Silme çöp klasörüne taşır (`.ww-trash/`) |
| `list_dir` | path, depth? | herkes | |
| `search_code` | pattern, glob? | herkes | ripgrep sarmalayıcı |
| `run_command` | cmd, args[], timeoutSec? | worker | Beyaz liste ([aşağıda](#sandbox-ve-güvenlik-sınırları)) |
| `git_diff` / `git_log` | — | verifier, herkes | Verifier'ın ana görüş kaynağı |
| `web_search` | query | researcher | Sağlayıcı ayarlanabilir (Tavily/Brave) |
| `fetch_page` | url | researcher | Metin çıkarımıyla döner |
| `memory_query` | question, scope? | herkes | Hafızaya soru: Context Builder'ın sorgu modu ([06](06-hafiza-ve-baglam.md)) |
| `record_knowledge` | kind, title, content, tags | pm, group_lead, researcher | `knowledge` kaydı açar |
| `record_artifact` | type, name, path, summary | worker | `artifacts` kaydı |
| `create_subtask` | title, description, group, files[], criteria | pm, group_lead, worker | Delegasyon ([03](03-agent-sistemi.md#delegasyon)) |
| `ask_question` | to (`pm`; Faz 4: `group_lead`), content | herkes | Faz 1 doğrudan PM; Faz 4 tam soru akışı |
| `report_result` | summary | worker | Görevi `verifying`'e taşır |
| `run_gate` | — | sistem/worker | Derleme+lint+test kapısını koşar |

## Sandbox ve Güvenlik Sınırları

1. **Yol hapsi**: Tüm dosya araçları yolu `workspace/<slug>/` köküne çözer;
   `..`, mutlak yol ve symlink kaçışı reddedilir (realpath kontrolü).
   `.git/` içine doğrudan yazım yasak (git işlemleri yalnız `git_*` araçlarıyla).
2. **Komut beyaz listesi** (`run_command`): proje türüne göre tanımlı —
   `node, npm, pnpm, npx, yarn, vite, tsc, eslint, prettier, vitest, jest,
   flutter, dart, adb, gradle, python3, pip` … Liste `settings`'te genişletilebilir;
   liste dışı komut → hata + `events` kaydı. Shell yorumlayıcı kullanılmaz
   (`spawn`, arg dizisi; `;`, `&&`, backtick etkisiz).
3. **Kaynak limitleri**: komut başına zaman aşımı (varsayılan 300 sn),
   çıktı limiti (1 MB, ötesi kırpılır), eşzamanlı komut sayısı proje başına 4.
4. **Ağ**: `web_search`/`fetch_page` yalnız researcher'da; `run_command` ağı
   kısıtlanmaz (paket kurulumu gerekir) ama panelde her komut görünürdür.
   İleride (sunucu kipi) ağ ad-alanı kısıtı eklenir — v1'de YAGNI.
5. **Gizli bilgi**: Üretilen projelerin `.env` dosyaları fihriste içerikleriyle
   değil "var" bilgisiyle işlenir; `events` payload'larında anahtar deseni maskesi
   ([04 — Anahtar Güvenliği](04-model-katmani.md#anahtar-güvenliği)).

## Git Entegrasyonu

- Proje açılışında `git init` + starter template ilk commit
  ([09 — Kod Standartları](09-kod-standartlari.md#starter-templateler)).
- **Görev = commit** disiplini:
  - Worker çalışırken değişiklikler working tree'de birikir (commit yok).
  - Test kapısı geçince executor commit atar:
    `task(<task_id kısa>): <title>` + gövdede görev özeti ve agent adları.
  - Hash `tasks.commit_hash`'e ve `artifacts.commit_hash`'e yazılır.
- Ret/iptal/kurtarma → `git checkout . && git clean -fd` (yarım iş kuralı;
  `.ww-trash/` hariç).
- Panel diff görünümü `git_diff` çıktısından beslenir; geri alma =
  PM'e "şu görevi geri al" emri → revert görevi açılır (`git revert <hash>`,
  yine worker+verifier çiftiyle).

## Çalıştırma/Test Kapısı

Görev `verifying → testing` geçtiğinde proje türüne göre kapı komutları koşar
(tanımlar starter template'in `ww.gate.json` dosyasında; DB'de `knowledge`
`standard` kaydı olarak da tutulur):

| Proje türü | Kapı adımları (sıralı) |
|---|---|
| Web (React) | `pnpm install` (lock değiştiyse) → `tsc --noEmit` → `eslint .` → `vitest run` → `vite build` |
| Backend API | `pnpm install` → `tsc --noEmit` → `eslint .` → `vitest run` |
| Flutter | `flutter pub get` → `dart analyze` → `flutter test` |

- Her adımın çıktısı `events`'e `test_run` olayı olarak yazılır.
- Hata → tam çıktı worker'a döner (`testing → working`), `attempt++`.
- Kapı tanımına adım eklemek/çıkarmak plan kararıdır (konsey/PM belirler,
  `knowledge`'a yazılır).
- Test *yazmak* da işin parçasıdır: kod görevlerinin kabul kriterlerine
  "yeni davranış için test içerir" maddesini standartlar zorlar.

## Dev-Server Yaşam Döngüsü

Test ortamlarının ([10](10-test-ortamlari.md)) temeli — `ProcessManager`:

- Proje başına adlandırılmış süreçler: `dev` (vite/flutter run/nest start),
  `emulator`, vb. Kayıtları bellekte + `events`'te (`process_started/stopped`).
- Port havuzu: 42000-42999 arasından atanır, `projects.settings.dev_port`'a yazılır.
- Sağlık: süreç çıktısı halka tamponda tutulur (panelden "son 200 satır log");
  çökerse panelde rozet, istenirse otomatik yeniden başlatma.
- Duraklat/arşivle → süreçler kapatılır.

## Hata ve Retry Politikaları

| Hata | Davranış |
|---|---|
| Araç argüman hatası (şema uyumsuz) | Modele hata mesajı döner, aynı turda düzeltmesi beklenir (retry maliyeti düşük) |
| Dosya kilidi alınamadı | Araç `LOCKED` döner; worker beklemek yerine kilit sahibini ve tahmini süreyi görür; zamanlayıcı görevi kısa erteleyebilir |
| Komut zaman aşımı | Süreç öldürülür, çıktı + `TIMEOUT` worker'a döner |
| LLM çağrısı hatası | Router fallback'i dener ([04](04-model-katmani.md#fallback)); tükendiyse görev `queued`'a döner |
| Executor iç hatası | `events`'e `error`, görev `queued`'a döner, `attempt++` |
| Aynı hatanın tekrarı (kaçak döngü) | Zamanlayıcı benzerlik freni → tırmandırma ([07](07-zamanlayici.md#frenler)) |
