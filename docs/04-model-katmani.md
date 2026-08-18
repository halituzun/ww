# 04 — Model Katmanı

> LLM sağlayıcı soyutlaması, tool-use normalizasyonu, fallback + sağlık kontrolü,
> rol→model eşleme, kontör ölçümü ve anahtar güvenliği.
> İlgili: [Şema](02-clickhouse-semasi.md) · [Agent Sistemi](03-agent-sistemi.md) · [Panel](08-panel.md)

## İçindekiler

1. [Provider Arayüzü](#provider-arayüzü)
2. [Adaptörler ve Tool-Use Normalizasyonu](#adaptörler-ve-tool-use-normalizasyonu)
3. [Fallback](#fallback)
4. [Sağlık Kontrolü](#sağlık-kontrolü)
5. [Rol→Model Eşleme](#rolmodel-eşleme)
6. [Kontör: Maliyet Ölçümü ve Frenler](#kontör-maliyet-ölçümü-ve-frenler)
7. [Anahtar Güvenliği](#anahtar-güvenliği)
8. [Embedding Sağlayıcısı](#embedding-sağlayıcısı)

---

## Provider Arayüzü

`packages/providers` — tüm sağlayıcılar tek arayüz arkasında:

```ts
interface LlmProvider {
  readonly id: string;                       // 'openai' | 'anthropic' | 'deepseek' | ...
  complete(req: CompletionRequest): Promise<CompletionResult>;
  embed(texts: string[], model?: string): Promise<number[][]>;
  healthCheck(): Promise<HealthResult>;
  listModels(): string[];
}

interface CompletionRequest {
  model: string;
  messages: ChatMessage[];                   // normalize iç format
  tools?: ToolDef[];                         // normalize tool tanımları
  maxTokens?: number;
  temperature?: number;
  meta: { projectId: string; agentId: string; taskId?: string; purpose: string };
}

interface CompletionResult {
  content: string | null;
  toolCalls: NormalizedToolCall[];           // { id, name, args }
  usage: { promptTokens: number; completionTokens: number };
  raw?: unknown;                             // hata ayıklama için
}
```

Üstünde **`ModelRouter`**: `model_ref` (`provider:model`) alır, doğru adaptörü
seçer, rate-limit kuyruğundan geçirir, fallback'i uygular, `api_usage`'a yazar.
Agent kodu hiçbir zaman adaptörü doğrudan çağırmaz — daima router.

## Adaptörler ve Tool-Use Normalizasyonu

| Sağlayıcı | SDK | Tool formatı | Not |
|---|---|---|---|
| OpenAI | `openai` | `tools[].function` + `tool_calls` | Codex-tarzı kod modelleri dahil |
| Anthropic | `@anthropic-ai/sdk` | `tools[]` + `tool_use`/`tool_result` blokları | System prompt ayrı parametre |
| DeepSeek | `openai` (uyumlu uç) | OpenAI biçimi | `base_url` değişir |
| (yeni) | — | — | Adaptör ekle + `api_providers` satırı; başka değişiklik gerekmez |

Normalizasyon kuralları:

- İç format OpenAI-benzeri `messages` dizisidir; Anthropic adaptörü system'i ayırır,
  `tool_result`'u kendi bloklarına çevirir.
- Tool şemaları JSON Schema olarak tek yerde tanımlıdır
  ([05 — Executor](05-executor.md#araçlar)); adaptör kendi biçimine çevirir.
- Paralel tool çağrıları desteklenir; sonuçlar `tool_call_id` ile eşlenir.
- Token sayımı: sağlayıcının döndürdüğü `usage` esas alınır; dönmezse
  yaklaşık sayaç (karakter/4) ile tahmin ve `events`'e `estimated:true` notu.

## Fallback

- Zincir: istenen `model_ref` → `role_models.fallback_refs` sırası →
  `api_providers.is_default` sağlayıcının varsayılan modeli.
- Tetikleyiciler: bağlantı hatası, 5xx, 429 (rate limit, 2 denemeden sonra),
  zaman aşımı, `health_status='down'`.
- `health_status` kapısının iki emniyet kuralı (uygulama kararı):
  `degraded` ELENMEZ (yavaş ama cevap veriyor), ve zincirin TAMAMI `down` ise
  eleme yapılmaz — son çare olarak yine denenir. Sağlık kaydı yanılabilir
  (1 token'lık ping'in düşmesi gerçek isteğin de düşeceğini kanıtlamaz) ve
  hiç denemeden pes etmek, kendi kaydımız yüzünden ayakta olan bir sağlayıcıyı
  kapatmak olurdu. Aynı nedenle sağlık görüntüsü bayatlarsa (>5 dk) `unknown`
  sayılır: ölmüş bir tarayıcı hiçbir sağlayıcıyı kalıcı kara listeye alamaz.
- Fallback kullanımı gizlenmez: `api_usage.status='fallback_used'` + `events` kaydı +
  panelde uyarı rozeti. Konsey üyeleri için istisna: üye çeşitliliği bozulmasın diye
  aynı sağlayıcı içinde model düşümü tercih edilir; sağlayıcı tamamen düştüyse üye
  o turda "yok" sayılır (en az 2 üyeyle konsey devam eder, panel uyarır).
- Hiçbir sağlayıcı yoksa: görevler `queued`'da bekler, proje `paused` görünümüne
  düşer, panelde kırmızı banner.

## Sağlık Kontrolü

- Periyodik (60 sn) hafif ping: 1-token'lık ucuz istek `purpose='health_check'`.
- TAKLİT sağlayıcı (`base_url` boş) pinglenmez; durumu `unknown` yazılır.
  Anahtarsız GERÇEK sağlayıcı atlanmaz, `down` yazılır — yapılandırma eksikliği
  gerçek bir sağlık sorunudur. (Ölçüm 2026-08-18: taklide 1352 ping atılmış,
  hepsi hata; bunlar `api_usage`'ın %45'iydi, hata oranını şişiriyordu ve
  panelde kalıcı sahte kırmızı üretiyordu.)
- Pasif sinyal: `mv_provider_errors` — son 5 dk hata oranı > %50 → `degraded`,
  art arda 3 ping hatası → `down`; ilk başarılı ping → `ok`.
- Durum `api_providers.health_status`'a yazılır + pub/sub ile panele düşer
  (API yönetim ekranında yeşil/sarı/kırmızı).

## Rol→Model Eşleme

`role_models` tablosu panelden düzenlenir. Varsayılan strateji:

| Rol | Varsayılan | Gerekçe |
|---|---|---|
| `pm`, `council_member`, `professor`, `creator`, `interviewer` | Güçlü modeller (ör. `anthropic:claude-opus-5`, `openai:gpt-5`) | Karar/muhakeme kalitesi kritik |
| `worker` | Orta (ör. `anthropic:claude-sonnet-5`) | Hacimli iş, maliyet dengesi |
| `verifier` | Orta, **worker'dan farklı sağlayıcı** (ör. `deepseek:deepseek-chat`) | Çapraz kontrol önyargıyı kırar |
| `standards_auditor`, `researcher`, `narrator` | Orta | |
| `summarizer` | Ucuz (ör. `openai:gpt-5-mini`) | Yüksek hacim, basit iş |

- Konsey kadrosu özel kural: üyeler `role_models`'tan değil, **sağlayıcı çeşitliliği
  zorunluluğuyla** seçilir (en az 3 farklı sağlayıcı hedefi).
- Panel raporu "hangi model nerede iyi" sorgusunu gösterir
  ([Şema → örnek sorgular](02-clickhouse-semasi.md#örnek-sorgular)); eşlemeyi
  kullanıcı bu veriyle elle günceller (v1'de otomatik öğrenme yok — YAGNI).

## Kontör: Maliyet Ölçümü ve Frenler

- Fiyat tablosu `packages/providers/src/pricing.ts` — model başına $/1M girdi-çıktı token;
  sürüm kontrollü, elle güncellenir.
- Her çağrı → `api_usage` satırı (maliyet burada hesaplanır) → `mv_usage_daily`
  panoyu besler.
- Frenler (uygulama noktası router + zamanlayıcı):
  1. **Görev tavanı**: `tasks.token_budget` (varsayılan `settings.task_token_cap`,
     ör. 500k token) aşılırsa görev duraklar → tırmandırma.
  2. **Proje tavanı**: `projects.budget_usd_limit` aşılırsa proje `paused`,
     PM kullanıcıya bildirir; kullanıcı limiti artırıp devam ettirebilir.
  3. **Uyarı eşiği**: tavanın %80'inde panel bildirimi.
- Kontör ekranı: [08 — Panel → API Yönetimi](08-panel.md#api-yönetimi-ve-kontör).

## Anahtar Güvenliği

- Anahtarlar **asla** ClickHouse'a yazılmaz; `api_providers.key_ref` yalnızca
  referanstır.
- Depo: `WW_KEYSTORE_FILE` ile belirlenen şifreli dosya; varsayılan
  `<cwd>/.ww/keys.json` — `node:crypto` AES-256-GCM (nonce + authTag), dosya izni
  `0600`. Ana anahtar `WW_MASTER_KEY` (64 karakter hex) ortam değişkeninden gelir;
  verilmezse macOS Keychain'den okunur, orada da yoksa üretilip
  `security add-generic-password` ile `ww-master` servisine yazılır.
- Anahtar dosyasının ve `.env`'in **gitignore'da olması zorunludur** (`.ww/`, `.env`,
  `.env.*`). Depo public upstream'e bağlıdır; bu kural gevşetilemez.
- Panelden anahtar girişi: HTTPS-localhost üzerinden POST → server bellekte çözer,
  şifreli dosyaya yazar; API yanıtlarında anahtar asla geri dönmez (yalnız
  `sk-...son4` maskesi).
- Loglara sızma koruması: provider katmanında hata nesneleri `events`'e yazılmadan
  anahtar deseni regex'iyle temizlenir.

## Embedding Sağlayıcısı

- Aynı `LlmProvider.embed` arayüzünden; varsayılan `openai:text-embedding-3-small`
  (1536 boyut), panelden değiştirilebilir (`role_models`'a `embedding` sanal rolü).
- Embedding modeli değişirse boyut uyuşmazlığı riskine karşı: `embeddings.embedding_model`
  filtrelenir; yeni model eski kayıtları **yeniden gömmez**, arama yalnız aktif model
  kayıtlarında yapılır; istenirse arka planda yeniden gömme görevi başlatılır
  ([06 — Hafıza](06-hafiza-ve-baglam.md#embedding-boru-hattı)).
