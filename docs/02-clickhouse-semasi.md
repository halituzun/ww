# 02 — ClickHouse Şeması

> Tüm tabloların kolon kolon tanımı, engine/ORDER BY/partition kararları,
> örnek sorgular ve migration yaklaşımı.
> İlgili: [Mimari](01-mimari.md) · [Hafıza](06-hafiza-ve-baglam.md) · [Agent Sistemi](03-agent-sistemi.md)

## İçindekiler

1. [Genel Kararlar](#genel-kararlar)
2. [Tablolar](#tablolar)
3. [Materialized View'lar](#materialized-viewlar)
4. [Örnek Sorgular](#örnek-sorgular)
5. [Migration Yaklaşımı](#migration-yaklaşımı)

---

## Genel Kararlar

- Tek veritabanı: `ww`. Projeler **satır düzeyinde** `project_id` ile ayrılır
  (proje başına ayrı DB değil — sorgular arası birleşim ve tek migration için).
- İki tablo ailesi:
  - **Append-only** (MergeTree): `events`, `messages`, `api_usage`, `summaries`,
    `artifacts`, `embeddings` — güncelleme yok, yalnızca ekleme.
  - **Son-durum** (ReplacingMergeTree(`version`)): `projects`, `agents`, `tasks`,
    `plans`, `file_index`, `knowledge`, `prompts`, `api_providers`, `role_models` —
    güncelleme = artan `version` ile yeni satır.
- `version` üretimi: server'da `toUnixTimestamp64Milli(now64())` + aynı ms'de çakışmaya
  karşı süreç içi monoton sayaç.
- **Son-durum okuma deseni** (sorgu katmanı `latest()` yardımıcısı kapsüller):
  ```sql
  SELECT * FROM tasks WHERE project_id = {p} ORDER BY version DESC LIMIT 1 BY task_id
  ```
- Tüm ID'ler `UUID`; tüm zamanlar `DateTime64(3, 'UTC')`.
- Büyük hacimli tablolarda partition: `toYYYYMM(created_at)`.
- Enum yerine `LowCardinality(String)` tercih edilir (şema evrimi kolaylığı);
  geçerli değerler uygulama katmanında `shared` paketindeki sabitlerle sınırlanır.

## Tablolar

### `projects` — proje kayıtları (son-durum)

| Kolon | Tip | Açıklama |
|---|---|---|
| `project_id` | UUID | Birincil kimlik |
| `name` | String | Görünen ad |
| `slug` | String | Klasör adı (`workspace/<slug>`) |
| `type` | LowCardinality(String) | `web` \| `mobile` \| `api` \| `fullstack` |
| `status` | LowCardinality(String) | `draft` \| `gathering` \| `planning` \| `running` \| `paused` \| `completed` \| `archived` |
| `description` | String | Kullanıcının ilk tanımı |
| `workspace_path` | String | Mutlak yol |
| `budget_usd_limit` | Float64 | Kontör tavanı (0 = sınırsız) |
| `settings` | String (JSON) | `max_parallel_agents`, `max_clones_per_agent`, `max_attempts`, `max_delegation_depth`, `task_token_cap` … |
| `active_plan_id` | UUID | Yürürlükteki plan |
| `created_at`, `updated_at` | DateTime64(3) | |
| `version` | UInt64 | ReplacingMergeTree sürümü |

Engine: `ReplacingMergeTree(version) ORDER BY project_id`

### `agents` — agent kayıtları (son-durum)

| Kolon | Tip | Açıklama |
|---|---|---|
| `agent_id` | UUID | |
| `project_id` | UUID | |
| `role` | LowCardinality(String) | `pm` \| `council_member` \| `group_lead` \| `interviewer` \| `worker` \| `verifier` \| `standards_auditor` \| `researcher` \| `professor` \| `creator` \| `summarizer` \| `narrator` |
| `group` | LowCardinality(String) | `design` \| `analysis` \| `db` \| `coding` \| `research` \| `reasoning` \| `ui_audit` \| `mvvm_audit` \| `db_write_audit` \| `management` |
| `name` | String | Panelde görünen ad (ör. "Worker-Coding-3") |
| `model_ref` | String | `provider:model` (ör. `anthropic:claude-sonnet-5`) |
| `parent_agent_id` | UUID | Hiyerarşik üst (PM'in üstü boş) |
| `clone_of` | UUID | Klonsa kaynak agent |
| `status` | LowCardinality(String) | `idle` \| `busy` \| `waiting_verify` \| `waiting_answer` \| `stopped` |
| `current_task_id` | UUID | Meşgulse hangi görev |
| `prompt_name`, `prompt_version` | String, UInt32 | Kullandığı sistem promptu (bkz. `prompts`) |
| `tasks_done`, `tasks_rejected` | UInt32 | Performans sayaçları — **TÜRETİLMİŞ**: bu kolonlara üretimde hiç yazılmaz (ölçüldü 2026-08-18: 426 agent, hepsi 0). Gerçek değerler `readAgentActivity` içinde `tasks` ve ret olaylarından hesaplanır; karar ya da gösterim için kolonlar okunmaz. |
| `created_at`, `updated_at`, `version` | | |

Engine: `ReplacingMergeTree(version) ORDER BY (project_id, agent_id)`

### `plans` — plan sürümleri (son-durum)

| Kolon | Tip | Açıklama |
|---|---|---|
| `plan_id` | UUID | Her sürüm ayrı `plan_id` alır |
| `project_id` | UUID | |
| `plan_version` | UInt32 | 1, 2, 3… (yeniden planlamada artar) |
| `status` | LowCardinality(String) | `debating` \| `proposed` \| `approved` \| `superseded` \| `rejected` |
| `title` | String | |
| `content_md` | String | Planın tam metni (markdown) |
| `council_session_id` | UUID | Tartışma turlarının `messages.session_id`'si |
| `team_json` | String (JSON) | Önerilen kadro: roller, gruplar, sayılar, model eşlemeleri |
| `scenarios_json` | String (JSON) | Senaryolar + kabul kriterleri |
| `replan_reason` | String | v2+ için: neden yeniden planlandı |
| `supersedes_plan_id` | UUID | Önceki sürüm |
| `created_by_agent_id`, `approved_by` | UUID, String | `approved_by`: agent_id veya `user` |
| `created_at`, `version` | | |

Engine: `ReplacingMergeTree(version) ORDER BY (project_id, plan_id)`

### `tasks` — görevler (son-durum)

| Kolon | Tip | Açıklama |
|---|---|---|
| `task_id` | UUID | |
| `project_id`, `plan_id` | UUID | |
| `parent_task_id` | UUID | Delegasyonla açıldıysa üst görev |
| `title`, `description` | String | Görev tanımı (İngilizce — agent içi dil) |
| `status` | LowCardinality(String) | `queued` \| `assigned` \| `working` \| `verifying` \| `testing` \| `approved` \| `rejected` \| `done` \| `failed` \| `cancelled` \| `escalated` \| `waiting_user` |
| `priority` | UInt8 | 0 (düşük) – 9 (kritik) |
| `issuer_agent_id` | UUID | Görevi açan (PM veya delege eden herhangi bir agent) |
| `worker_agent_id`, `verifier_agent_id` | UUID | Çift kuralı |
| `group` | LowCardinality(String) | Hangi grubun işi |
| `depends_on` | Array(UUID) | Bağımlı görevler |
| `target_files` | Array(String) | Dokunulması beklenen dosyalar (kilit planlaması için) |
| `attempt`, `max_attempts` | UInt8 | Ping-pong freni sayacı (varsayılan max 3) |
| `delegation_depth` | UInt8 | Kök görevden uzaklık (limit `settings.max_delegation_depth`, varsayılan 3) |
| `token_budget`, `tokens_spent` | UInt32, UInt64 | Görev başına tavan ve harcama |
| `commit_hash` | String | Onaylanan işin commit'i |
| `result_summary` | String | Worker'ın bitiş özeti |
| `reject_reason` | String | Son ret gerekçesi |
| `created_at`, `updated_at`, `version` | | |

Engine: `ReplacingMergeTree(version) ORDER BY (project_id, task_id)`
Durum geçiş *tarihçesi* ayrıca `events`'e `status_change` olayı olarak yazılır.

### `messages` — tüm konuşmalar (append-only)

| Kolon | Tip | Açıklama |
|---|---|---|
| `message_id` | UUID | |
| `project_id` | UUID | |
| `session_id` | UUID | Konu/oturum: konsey oturumu, görev tartışması, kullanıcı sohbeti |
| `task_id` | UUID | İlgiliyse görev |
| `from_agent_id` | UUID | Gönderen (kullanıcıysa sabit `USER_SENTINEL` UUID) |
| `to_agent_id` | UUID | Alıcı (`broadcast` için sabit UUID) |
| `kind` | LowCardinality(String) | `question` \| `answer` \| `order` \| `proposal` \| `objection` \| `synthesis` \| `report` \| `escalation` \| `user_command` \| `verdict` |
| `content` | String | |
| `model_ref` | String | Mesajı üreten model (varsa) |
| `created_at` | DateTime64(3) | |

Engine: `MergeTree ORDER BY (project_id, session_id, created_at)`
Partition: `toYYYYMM(created_at)`

Faz 1 iletişim migration'ı latest task state'i current `task_brief_id` ve
`assignment_attempt_id` ile; bu çekirdek tabloyu protokol ve payload sürümü,
canonical `payload_json`,
`reply_to_message_id`, correlation/causation, idempotency, `task_brief_id`,
`assignment_attempt_id`, `invocation_id`, deadline, priority ve provenance ile
genişletir; ayrıca immutable `task_briefs`/`assignment_attempts`/
`prompt_input_snapshots`, typed handoff ve append-only `task_causal_entries`,
alıcı bazlı append-only `message_receipts`, effect ledger ve sürümlü
`audit_findings` ekler. `content` yalnız okunabilir insan projeksiyonu/legacy
alandır. Normatif davranış:
[13 — Agent İletişim Sözleşmesi](13-agent-iletisim-sozlesmesi.md).

`task_causal_entries`; task/brief/attempt/handoff kimlikleri, attempt-bazlı
`ordinal`, deterministik `entry_id`, `source_type`, `source_id`, `causation_id` ve
`created_at` taşır; `MergeTree ORDER BY (task_id, assignment_attempt_id, ordinal,
entry_id)` kullanır. Scheduler-owned repository current attempt'i latest task
fold'undan doğrular, retry'da existing `entry_id` ordinal'ini döndürür, restart'ta
folded `max(ordinal)+1` ile sürer. Aynı ordinal'de farklı entry fail-closed'dur.

### `events` — ham olay akışı (append-only)

| Kolon | Tip | Açıklama |
|---|---|---|
| `event_id` | UUID | |
| `seq` | UInt64 | Faz 0 ham sırası; proje bazlı replay cursor'u Faz 3 gateway tasarımında kesinleştirilir |
| `project_id`, `task_id`, `agent_id` | UUID | |
| `event_type` | LowCardinality(String) | `tool_call` \| `tool_result` \| `api_call` \| `decision` \| `status_change` \| `error` \| `commit` \| `lock_acquired` \| `lock_released` \| `escalation` \| `clone_spawned` \| `test_run` \| `process_started` \| `process_stopped` \| `recovery_completed`; Faz 1 iletişim timeline türlerini ekler |
| `tool_name` | LowCardinality(String) | `read_file`, `write_file`, `run_command`, `git`, `web_search`, `memory_query` … |
| `payload` | String (JSON) | Olaya özgü ayrıntı (argümanlar, sonuç özeti, exit code…) |

> **`payload` NESNE yazılır, JSON metni olarak DEĞİL.** Alan zaten `JsonValue`
> ve depo onu serileştirir; yazarken bir kez daha `JSON.stringify` yapmak yükü
> çift kodlar ve `JSONExtract*` sorgularının hepsini sessizce boş döndürür.
> Kural artık `appendEvent` içinde ZORLANIR: JSON'a benzeyen bir string yük
> açık hatayla reddedilir (düz metin yük meşrudur).
> (2026-08-18: 69 `error` olayının 46'sı böyleydi; sebep yazılıydı ama denetim
> ekranı, anlatıcı ve analitik sorgular okuyamıyordu.)
| `duration_ms` | UInt32 | |
| `created_at` | DateTime64(3) | |

Engine: `MergeTree ORDER BY (project_id, created_at, seq)`
Partition: `toYYYYMM(created_at)` — en yüksek hacimli tablo; TTL yok (asla unutma).

### `artifacts` — üretilen çıktılar (append-only)

| Kolon | Tip | Açıklama |
|---|---|---|
| `artifact_id` | UUID | |
| `project_id`, `task_id`, `agent_id` | UUID | |
| `artifact_type` | LowCardinality(String) | `controller` \| `service` \| `repository` \| `model` \| `view` \| `viewmodel` \| `component` \| `schema` \| `api_endpoint` \| `design_decision` \| `test` \| `config` \| `doc` |
| `name` | String | Ör. `UserController` |
| `path` | String | Workspace içi yol (dosyaysa) |
| `summary` | String | Ne yapar, neden var |
| `commit_hash` | String | Hangi commit'te doğdu/değişti |
| `created_at` | DateTime64(3) | |

Engine: `MergeTree ORDER BY (project_id, artifact_type, created_at)`

### `file_index` — fihrist (son-durum)

| Kolon | Tip | Açıklama |
|---|---|---|
| `project_id` | UUID | |
| `file_path` | String | Workspace göreli yol |
| `summary` | String | Dosyanın amacı, 2-3 cümle |
| `layer` | LowCardinality(String) | `view` \| `viewmodel` \| `model` \| `service` \| `repository` \| `controller` \| `config` \| `test` \| `other` |
| `exports` | Array(String) | Dışa açılan semboller |
| `related_task_ids` | Array(UUID) | Bu dosyaya dokunan görevler |
| `related_artifact_ids` | Array(UUID) | |
| `related_knowledge_ids` | Array(UUID) | İlgili kararlar/kısıtlar |
| `last_commit_hash` | String | |
| `change_count` | UInt32 | Toplam değişim sayısı |
| `updated_at`, `version` | | |

Engine: `ReplacingMergeTree(version) ORDER BY (project_id, file_path)`

### `knowledge` — proje bilgisi (son-durum, sürümlü)

| Kolon | Tip | Açıklama |
|---|---|---|
| `knowledge_id` | UUID | |
| `project_id` | UUID | |
| `kind` | LowCardinality(String) | `requirement` \| `decision` \| `constraint` \| `concept` \| `standard` \| `glossary` |
| `title` | String | |
| `content` | String | Markdown |
| `tags` | Array(String) | Serbest etiketler (`auth`, `ui`, `db`…) |
| `source_task_id`, `source_message_id` | UUID | Nereden doğdu |
| `status` | LowCardinality(String) | `active` \| `superseded` |
| `superseded_by` | UUID | Yeni kayıt |
| `created_at`, `version` | | |

Engine: `ReplacingMergeTree(version) ORDER BY (project_id, knowledge_id)`

### `summaries` — özet katmanı (append-only)

| Kolon | Tip | Açıklama |
|---|---|---|
| `summary_id` | UUID | |
| `project_id` | UUID | |
| `scope` | LowCardinality(String) | `task` \| `phase` \| `day` \| `council` \| `agent_session` |
| `ref_id` | UUID | Kapsamın kimliği (task_id, plan_id…) |
| `content` | String | Özet metni |
| `created_by_agent_id` | UUID | Özetleyici |
| `created_at` | DateTime64(3) | |

Engine: `MergeTree ORDER BY (project_id, scope, created_at)`

### `embeddings` — vektörler (append-only)

| Kolon | Tip | Açıklama |
|---|---|---|
| `embedding_id` | UUID | |
| `project_id` | UUID | |
| `source_table` | LowCardinality(String) | `messages` \| `summaries` \| `knowledge` \| `file_index` \| `artifacts` |
| `source_id` | UUID | Kaynak satır |
| `chunk_index` | UInt16 | Uzun metin parçalandıysa |
| `text` | String | Gömülen metin parçası |
| `vector` | Array(Float32) | Boyut embedding modeline göre (varsayılan 1536) |
| `embedding_model` | LowCardinality(String) | |
| `created_at` | DateTime64(3) | |

Engine: `MergeTree ORDER BY (project_id, source_table, source_id, chunk_index)`
Arama: `cosineDistance(vector, {q})` — bu ölçekte brute-force yeterli;
hacim büyürse `vector_similarity` index'i eklenir (bkz. migration notu).

### `prompts` — sistem promptu şablonları (son-durum, sürümlü)

| Kolon | Tip | Açıklama |
|---|---|---|
| `prompt_name` | LowCardinality(String) | Rol/grup anahtarı: `role.worker.coding`, `role.verifier`, `group.design.standards`… |
| `prompt_version` | UInt32 | |
| `content` | String | Şablon (İngilizce; `{{variable}}` yer tutucuları) |
| `variables` | Array(String) | Beklenen değişkenler |
| `changelog` | String | Bu sürümde ne değişti |
| `is_active` | UInt8 | Aktif sürüm işareti |
| `created_at`, `version` | | |

Engine: `ReplacingMergeTree(version) ORDER BY (prompt_name, prompt_version)`
Görev hangi promptla çalıştı → `agents.prompt_name/prompt_version` + `events`.

### `api_providers` — sağlayıcılar (son-durum)

| Kolon | Tip | Açıklama |
|---|---|---|
| `provider_id` | LowCardinality(String) | `openai` \| `anthropic` \| `deepseek` \| … |
| `display_name` | String | |
| `base_url` | String | Özel uçlar için |
| `enabled` | UInt8 | Panelden aktif/pasif |
| `is_default` | UInt8 | Varsayılan sağlayıcı (fallback son durağı) |
| `fallback_order` | UInt8 | Zincirdeki sıra |
| `models` | Array(String) | Kullanılabilir modeller |
| `key_ref` | String | Şifreli anahtar deposundaki referans (anahtarın kendisi ASLA burada değil) |
| `health_status` | LowCardinality(String) | `ok` \| `degraded` \| `down` \| `unknown` |
| `last_health_check` | DateTime64(3) | |
| `updated_at`, `version` | | |

Engine: `ReplacingMergeTree(version) ORDER BY provider_id`

### `role_models` — rol→model eşleme (son-durum)

| Kolon | Tip | Açıklama |
|---|---|---|
| `role` | LowCardinality(String) | `agents.role` değerleri |
| `model_ref` | String | Birincil `provider:model` |
| `fallback_refs` | Array(String) | Sıralı yedekler |
| `updated_at`, `version` | | |

Engine: `ReplacingMergeTree(version) ORDER BY role`

### `api_usage` — kontör/kullanım (append-only)

| Kolon | Tip | Açıklama |
|---|---|---|
| `usage_id` | UUID | |
| `project_id`, `agent_id`, `task_id` | UUID | |
| `provider_id`, `model` | LowCardinality(String), String | |
| `purpose` | LowCardinality(String) | `completion` \| `embedding` \| `health_check` |
| `prompt_tokens`, `completion_tokens` | UInt32 | |
| `cost_usd` | Float64 | Fiyat tablosundan hesaplanır |
| `latency_ms` | UInt32 | |
| `status` | LowCardinality(String) | `ok` \| `error` \| `timeout` \| `rate_limited` \| `fallback_used` |
| `error_kind` | String | |
| `created_at` | DateTime64(3) | |

Engine: `MergeTree ORDER BY (project_id, created_at)` · Partition: `toYYYYMM(created_at)`

Faz 1 migration'ı ve provider `CompletionMeta`; `invocation_id`, `task_brief_id`,
`assignment_attempt_id`, `prompt_input_snapshot_id` ve `fallback_attempt` alanlarını
ekler. Böylece source mesaj, kullanılan prompt high-water'ı, gerçek fallback modeli,
kullanım satırı ve sonuç mesajı aynı invocation üzerinden izlenir.

## Materialized View'lar

```sql
-- Günlük maliyet özeti (kontör panosu)
CREATE MATERIALIZED VIEW mv_usage_daily
ENGINE = SummingMergeTree ORDER BY (project_id, provider_id, model, day)
AS SELECT project_id, provider_id, model, toDate(created_at) AS day,
          sum(cost_usd) AS cost, sum(prompt_tokens+completion_tokens) AS tokens,
          count() AS calls
   FROM api_usage GROUP BY project_id, provider_id, model, day;

-- Sağlayıcı hata oranı (sağlık kontrolü beslemesi)
CREATE MATERIALIZED VIEW mv_provider_errors
ENGINE = SummingMergeTree ORDER BY (provider_id, minute)
AS SELECT provider_id, toStartOfMinute(created_at) AS minute,
          countIf(status != 'ok') AS errors, count() AS total
   FROM api_usage GROUP BY provider_id, minute;
```

## Örnek Sorgular

**"Bu işi nasıl yaptın?" — iz zinciri** (Anlatıcı agent'ın veri kaynağı;
akış için [06 — Hafıza](06-hafiza-ve-baglam.md#nasıl-yaptın-akışı)):

```sql
-- 1) Konuyla ilgili görevleri bul (semantik + metin)
WITH ilgili AS (
  SELECT source_id FROM embeddings
  WHERE project_id = {p} AND source_table = 'summaries'
  ORDER BY cosineDistance(vector, {soru_vektörü}) ASC LIMIT 10
)
SELECT t.* FROM tasks t
WHERE t.project_id = {p}
  AND (t.task_id IN (SELECT ref_id FROM summaries WHERE summary_id IN ilgili)
       OR positionCaseInsensitive(t.title, {anahtar_kelime}) > 0)
ORDER BY t.version DESC LIMIT 1 BY t.task_id;

-- 2) Görev zincirinin tüm konuşmaları ve adımları
SELECT 'message' src, created_at, kind AS type, content AS detail
  FROM messages WHERE project_id={p} AND task_id IN {task_ids}
UNION ALL
SELECT 'event', created_at, event_type, payload
  FROM events WHERE project_id={p} AND task_id IN {task_ids}
ORDER BY created_at;
```

**Fihrist paneli** (dosya gezgini üst şeridi):

```sql
SELECT fi.*, t.title AS last_task_title, t.result_summary
FROM file_index fi
LEFT JOIN (SELECT task_id, title, result_summary FROM tasks
           WHERE project_id={p} ORDER BY version DESC LIMIT 1 BY task_id) t
       ON t.task_id = fi.related_task_ids[-1]
WHERE fi.project_id={p} AND fi.file_path={path}
ORDER BY fi.version DESC LIMIT 1;
```

**Kontör durumu**:

```sql
SELECT sum(cost) AS harcanan,
       any(p.budget_usd_limit) AS limit
FROM mv_usage_daily u
INNER JOIN (SELECT project_id, budget_usd_limit FROM projects
            ORDER BY version DESC LIMIT 1 BY project_id) p USING (project_id)
WHERE u.project_id = {p};
```

**Hangi model hangi işte iyi** (rol→model eşleme raporu):

```sql
SELECT a.model_ref, t.group,
       countIf(t.status='done') AS basarili,
       countIf(t.status IN ('failed','escalated')) AS sorunlu,
       avg(t.attempt) AS ort_deneme
FROM (SELECT * FROM tasks ORDER BY version DESC LIMIT 1 BY task_id) t
JOIN (SELECT * FROM agents ORDER BY version DESC LIMIT 1 BY agent_id) a
  ON a.agent_id = t.worker_agent_id
GROUP BY a.model_ref, t.group ORDER BY t.group, basarili DESC;
```

## Migration Yaklaşımı

- `packages/db/migrations/NNNN_ad.sql` — sıralı, yalnız-ileri SQL dosyaları.
- Uygulananlar `ww._migrations` tablosunda tutulur (`name`, `checksum`, `applied_at`);
  server açılışta eksikleri sırayla uygular, checksum uyuşmazlığında durur.
- ClickHouse'ta `ALTER TABLE ... ADD COLUMN` ucuzdur; kolon eklemek serbest,
  kolon anlamı değiştirmek yasak (yeni kolon + uygulama katmanında geçiş).
- Vektör index'i (hacim büyüyünce): `ALTER TABLE embeddings ADD INDEX idx_vec vector
  TYPE vector_similarity('hnsw', 'cosineDistance') GRANULARITY 1` — ayrı migration.
- Test: her migration boş DB'ye ve örnek verili DB'ye CI'da uygulanır
  ([Yol Haritası → Faz 0](11-yol-haritasi.md#faz-0)).
