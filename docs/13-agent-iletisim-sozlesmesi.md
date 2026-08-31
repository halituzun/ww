# 13 — Agent İletişim Sözleşmesi

> Agent'lar arası mesaj, görev devri, zaman bağlamı, kural yaptırımı, teslimat ve
> denetimin normatif sözleşmesi.
> İlgili: [Agent Sistemi](03-agent-sistemi.md) · [Hafıza](06-hafiza-ve-baglam.md) ·
> [Zamanlayıcı](07-zamanlayici.md) · [Yol Haritası](11-yol-haritasi.md)

## Amaç ve Durum

Phase 0 kalıcı tabloları, Redis yardımcılarını ve rol promptlarını kurdu. Runtime
agent iletişimi Faz 1'de bu sözleşmeye göre uygulanacaktır. Bu belge, diğer
dokümanlardaki iletişim kuralları çatıştığında otoritedir.

Temel ayrım:

- **Mesaj** niyet veya konuşmadır.
- **Task** işin güncel durumudur; durumunu yalnız zamanlayıcı değiştirir.
- **Event** gerçekleşmiş sonucun değişmez denetim kaydıdır.
- **Redis** yalnız uyarır; teslimatın kanıtı ClickHouse kaydıdır.

## Sürümlemeli Mesaj Zarfı

`@ww/shared`, runtime'da doğrulanan `AgentMessageEnvelopeV1` şemasının tek sahibidir.
Her zarf şunları taşır:

- `protocolVersion`, `messageId`, `projectId`, `sessionId`;
- gönderen principal ve alıcı kimliği, `kind`, ayrık `payload`;
- isteğe bağlı `taskId`, `taskBriefId`, `assignmentAttemptId`, `invocationId` ve
  `promptInputSnapshotId`;
- `replyToMessageId`, `correlationId`, `causationId`, `idempotencyKey`;
- provenance, öncelik, oluşturulma zamanı ve isteğe bağlı son tarih.

Payload; `question`, `answer`, `order`, `proposal`, `objection`, `synthesis`,
`report`, `escalation`, `user_command` ve `verdict` türlerinden biridir. Broadcast
bir mesaj türü değil, özel alıcıdır. Serbest metin, görev durumu değiştiremez veya
yetki veremez.

Zarftaki gönderen rolü otorite değildir. `CommunicationService`, authenticated
agent principal kimliğini runtime capability + `agents` son-durum kaydıyla;
kullanıcıyı authenticated server oturumu + `USER_SENTINEL` ile; allowlist'teki iç
servisleri yeni `SYSTEM_SENTINEL` ile çözer. `BROADCAST_SENTINEL` yalnız alıcıdır.
Servis doğruladığı principal türü/rol/sürüm snapshot'ını kayda ekler. Faz 1
migration'ı ayrık payload'ı canonical
`payload_json` + `payload_version` olarak saklar; `content` yalnız okunabilir insan
projeksiyonu/legacy alandır. Hem yazarken hem okurken zarf parse edilir ve
`kind === payload.type` eşleşmesi fail-closed doğrulanır.

Provider `CompletionMeta` ve `api_usage`; `invocationId`, `taskBriefId`,
`assignmentAttemptId`, `promptInputSnapshotId` ve fallback attempt sırasını taşır.
Sonuç mesajındaki `model_ref`, istenen modeli değil router'ın gerçek `usedRef`
değerini kaydeder.

## Değişmez Görev Brifi ve Zaman

Zamanlayıcı ilk atamada `TaskBriefV1` mühürler: task/plan sürümü, amaç, kabul
kriterleri, bağımlılıklar, hedef dosyalar, izinli araçlar, bütçe,
prompt/kural/standart sürüm-hash'leri, `contextSnapshotId` ve
`baseContextCutoffAt`.

- Retry aynı brief'i kullanır; her çalıştırma veya yeniden atama ayrı immutable
  `AssignmentAttemptV1` üretir. Bu kayıt worker/verifier çifti, attempt numarası,
  lease, başlangıç nedeni ve önceki attempt kimliğini taşır.
- Plan veya kural değişirse eski brief güncellenmez; yeni sürüm ve `rebase` olayı
  üretilir.
- Context Builder aktif planı değil, task'a sabitlenmiş planı yükler.
- Geçmiş görev, base cutoff'tan sonra oluşmuş global plan, bilgi, prompt, standart
  veya özeti göremez. Buna karşılık yalnız aynı brief/attempt nedensel zincirine
  bağlı verifier reddi, gate çıktısı, soru cevabı ve escalation mesajları
  `taskCausalCursor` üzerinden eklenir.
- Faz 1'de görev başına yalnız bir aktif attempt vardır.
  `TaskCausalCursorV1 { assignmentAttemptId, handoffId?, ordinal }` içindeki
  `ordinal`, attempt bazında monoton artar. Tüm verifier/gate/answer/escalation
  ekleri scheduler'ın tek mantıksal yazarı `TaskCausalLog.append` üzerinden geçer;
  yazar current attempt + task lease'i doğrular, restart'ta son kalıcı ordinal'den
  devam eder ve deterministik causal-entry/message kimliğiyle retry'ı aynı kayda
  eşler. Handoff ancestor cursor'u mühürler, yeni attempt ordinal'i `0`dan başlar.
  Faz 1 paralel attempt/branch merge'ünü reddeder; ileride frontier/vector gerekir
  ise protokol sürümü artırılır. Bu cursor, Faz 3 panel cursor'undan ayrıdır.
- Kalıcı kaynak append-only `task_causal_entries(taskId, taskBriefId,
  assignmentAttemptId, handoffId?, ordinal, entryId, sourceType, sourceId,
  causationId?, createdAt)` tablosudur. Latest task fold'u current brief/attempt'i
  gösterir. Repository task lease'i altında önce deterministik `entryId`'yi arar;
  varsa aynı ordinal'i döndürür, yoksa current attempt'in folded `max(ordinal)+1`
  değerini synchronous append eder. Belirsiz insert sonucu reconcile edilmeden yeni
  ordinal ayrılmaz; okuyucu `entryId` tekrarını katlar ve aynı ordinal'de farklı
  entry görürse fail-closed olur.
- Her LLM çağrısı, kullandığı `inputTaskCausalCursor`, brief/attempt kimliği,
  source-version manifesti ve prompt hash'ini kalıcı, immutable
  `PromptInputSnapshotV1` olarak mühürler. Replay aynı snapshot'ı kullanır; daha
  sonra gelen feedback eski invocation'a sızmaz.
- Sahip değişiminde `TaskHandoffV1`; önceki attempt, üretilmiş artefakt/kanıtlar,
  causal cursor, açık soru/receipt'ler, workspace/commit noktası ve lease/kilit
  bırakma sonucunu taşır. Yeni worker kilitleri yeniden alır; eski kilit devredilmez.
  Yeni attempt yalnız handoff'ta mühürlenen ancestor cursor'a kadar önceki attempt
  zincirini ve kendi sonrasındaki causal kayıtları görebilir; paralel/future attempt
  kayıtlarını göremez.
- Faz 2'de knowledge için `knownAt/validFrom/validTo`, summary için kapsanan zaman
  ve kaynak sürümleri eklenir.

## Gönderim, Teslim ve Kurtarma

Tek public yol `packages/agents` içindeki `CommunicationService` olacaktır:

1. Zarf şemasını ve protokol sürümünü doğrula.
2. Principal'dan türetilen gönderen rolü, alıcı, mesaj türü, brief ve task durumunu
   saf guard ile yetkilendir.
3. Canonical zarfı deterministik kimlik/idempotency anahtarıyla ClickHouse'a ekle;
   broadcast alıcı kümesini bu anda snapshot'la ve her alıcı için `enqueued` receipt yaz.
4. Redis'e best-effort uyanma bildirimi gönder.
5. Alıcı, işlenmemiş inbox kayıtlarını ClickHouse'tan okur; claim lease alıp
   append-only receipt FSM'ini ilerletir.

Teslimat **at-least-once**'dur. Handler'lar `messageId/causationId` ile idempotent
olmalıdır. Redis bildirimi kaybolursa poll/recovery aynı mesajı bulur. ClickHouse ve
Redis arasında exactly-once veya atomiklik iddiası yoktur.

Receipt fold'u `enqueued → claimed → processed` yolunu izler. Geçici hata
`retry_scheduled` + artan backoff; süresi geçen claim reclaim; limit aşımı
`failed` + escalation üretir. `processed`, ancak task transition/effect ledger gibi
tüm kalıcı ve idempotent yan etkiler yazıldıktan sonra eklenir. Pub/sub için ACK
yoktur; receipt kalıcı ACK'tir. Task Stream `XACK` zamanlaması ise scheduler'ın task
claim'i ve durable atama kaydı tamamlandıktan sonradır.

Mesaj handler'ı doğrudan keyfi dış yan etki çalıştırmaz. Scheduler/executor her
yan etkiyi `causationId + stableEffectId` (veya deterministik operation ordinal)
anahtarlı kalıcı effect ledger ile korur; `effectKind` yalnız metadata'dır.
Idempotency sunmayan dış işlem otomatik replay edilmez, escalation'a gider.

Soru cevabı yalnız aynı session ile değil, `replyToMessageId` ile tek soruya
bağlanır. Broadcast her alıcı için ayrı receipt üretir. Süresi geçmiş veya yanlış
brief'e bağlı mesaj yan etki oluşturmadan reddedilir.

### Faz 1 Routing Matrisi

| Gönderen | Alıcı | İzinli tür / sonuç |
|---|---|---|
| kullanıcı | PM | `user_command` |
| kullanıcı | soruyu soran agent | Yalnız pending `question`a `answer` |
| worker | PM; Faz 4'te kendi group lead'i | `question` |
| worker | atanmış verifier/scheduler | `report` → `working→verifying` talebi |
| verifier | atanmış worker/scheduler | `verdict` → approve/reject geçiş talebi |
| PM; Faz 4'te kendi group lead'i | kendi kapsamındaki worker | `order` |
| council member | council session | `proposal` veya `objection` (Faz 4) |
| PM | council session | `synthesis` (Faz 4) |

`report`, `verdict` ve `answer` handler'ları typed transition talebi üretir; mesaj
kendisi status yazmaz. Broadcast yalnız policy'nin izin verdiği
PM/`SYSTEM_SENTINEL` akışında
kullanılır ve alıcı snapshot'ı olmadan gönderilemez.

Mevcut `0002_prompt_seed.sql` değiştirilmez. Faz 1 ileri migration'ı
`role.worker.coding` v2'ye soruları doğrudan PM'e yöneltme, `role.pm` v2'ye doğrudan
worker sorularını yanıtlama kuralını ekler ve bu sürümleri aktif eder. Marker testleri
iki promptta da bu Faz 1 rotasını korur. Group lead rotası Faz 4'te yeni bir prompt
sürümü ve protokol değişikliğiyle açılır.

## Kural Öğretimi ve Yaptırım

Kurallar üç katmanda uygulanır:

1. **Deterministik:** iletişim yetkisi, task FSM yetkisi ve tool capability guard'ları.
2. **Öğretici:** brief'e sabitlenmiş kural kimliği/sürümü ve gerekçesi prompta konur.
3. **Semantik:** bağımsız verifier ve `communication_audit` profili kanıtı değerlendirir.

Guard sonucu `PolicyDecision { ruleId, ruleVersion, allowed, reason, evidenceRefs }`
biçimindedir. Worker `verdict` üretemez; mesaj içeriği sistem/brief kuralını geçersiz
kılamaz; kullanıcı, mesaj, diff, hafıza ve tool sonucu provenance etiketiyle
güvenilmeyen veri kabul edilir.

Semantic ihlal `AuditFinding` üretir: rule ref, severity, kanıtlar, durum ve varsa
düzeltme görevi. `communication_audit` yeni bir agent rolü değil, mevcut
`standards_auditor` rolünün profilidir. Faz 1 guard ve verifier bulgularını; Faz 4
bu profilin periyodik çalışmasını uygular.

Faz 1, ortak `EVENT_TYPES` sözlüğünü `message_stored`, `message_rejected`,
`receipt_changed`, `brief_sealed`, `brief_rebased`, `policy_decision` ve
`task_handoff` ile genişletir. Payload'lar sürümlemeli/typed'dır; mesaj ve receipt
tablolarındaki canonical kayıtların yerine geçmez, onların timeline referansıdır.

## Sahiplik Kuralları

| Paket | Yetki |
|---|---|
| `shared` | Sürümlemeli şema, parser ve sözlük |
| `db` | Repository, receipt/effect ledger ve inbox sorguları |
| `agents` | Mesaj gönderme, routing, inbox ve rol döngüleri |
| `scheduler` | Atama, tek FSM sahibi, retry ve recovery |
| `memory` | As-of context snapshot ve zamansal seçim |
| `executor` | Araç/yol/komut yetkisi |
| `providers` | Model çağrısı ve gerçek fallback provenance'ı |
| server/panel | Doğrulanmış giriş ve salt-okunur projeksiyon |

## Zorunlu Testler

- Bilinmeyen sürüm/payload/rol/route ve sahte verdict fail-closed olur.
- Yinelenen gönderim veya restart, effect-ledger korumalı yan etkiyi iki kez üretmez.
- Cevap yalnız `replyToMessageId` ile eşleşen soruyu sürdürür.
- Redis bildirimi olmadan durable inbox mesajı işlenir.
- Eski görev gelecekteki global plan/kural/hafıza kaydını göremez; kendi nedensel
  verifier/gate/answer zincirini görür.
- Task causal ordinal'i restart sonrasında monoton sürer; yinelenen append aynı
  kayda eşlenir, stale/paralel attempt yazımı reddedilir ve handoff yeni attempt'i
  mühürlü ancestor cursor ile başlatır.
- Reassignment yeni attempt ve typed handoff üretir; eski lease/kilit taşınmaz.
- Mesaj, diff, memory ve tool-result içindeki prompt injection yetki kazanamaz.
- Provider fallback gerçek modeli aynı `invocationId` altında kaydeder.
- Invocation, kullandığı `PromptInputSnapshotV1` high-water'ını kalıcı taşır.
- Faz 1 MockProvider senaryosu; soru→cevap, ret→düzeltme, gate, commit, receipt ve
  denetim izini uçtan uca doğrular.

Araştırma ve birleşim gerekçesi:
[`2026-08-14-pathfinder-agent-iletisim`](superpowers/plans/2026-08-14-pathfinder-agent-iletisim/03-unified-proposal.md).
