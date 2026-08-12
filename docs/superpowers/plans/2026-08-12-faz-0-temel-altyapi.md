# Faz 0 — Temel Altyapı Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ww monoreposunun iskeleti + Docker (ClickHouse+Redis) + tam DB şeması ve migration çalıştırıcı + Redis yardımcıları + provider katmanı (Mock + OpenAI/Anthropic/DeepSeek adaptörleri, router+fallback, fiyat/kontör, anahtar deposu) + prompt seed — hepsi test edilmiş, `pnpm test` yeşil.

**Architecture:** pnpm+Turborepo monorepo; `packages/shared → db → providers` bağımlılık zinciri; ClickHouse tek gerçek kaynak, Redis tampon; provider katmanı tek `LlmProvider` arayüzü arkasında, `ModelRouter` fallback ve `api_usage` yazımını üstlenir. Spec: `docs/01-mimari.md`, `docs/02-clickhouse-semasi.md`, `docs/04-model-katmani.md`, `docs/11-yol-haritasi.md#faz-0`.

**Tech Stack:** Node 22, TypeScript 5 strict, pnpm, Turborepo, Vitest, @clickhouse/client, redis (node-redis v4), NestJS 11 (minimal), Vite+React (kabuk), openai + @anthropic-ai/sdk SDK'ları, node:crypto (AES-256-GCM anahtar deposu).

**Test stratejisi:** Saf birim testler her yerde koşar. ClickHouse/Redis gerektiren entegrasyon testleri servis ayakta değilse `describe.skipIf` ile atlanır (CI/lokal: önce `docker compose up -d`). Gerçek LLM API'lerine Faz 0'da hiç çıkılmaz (adaptörler birim testte sahte HTTP ile doğrulanır, uçtan uca Mock ile).

---

### Task 0: Git deposu ve kök iskelet

**Files:**
- Create: `.gitignore`, `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `.nvmrc`, `vitest.workspace.ts`, `eslint.config.mjs`

- [ ] **Step 1: git init + mevcut docs'u commit'le**

```bash
cd /Users/halituzun/Projects/ww && git init -b main && git add README.md docs && git commit -m "docs: mimari doküman seti (00-11)"
```

- [ ] **Step 2: Kök dosyaları yaz**

`.gitignore`:
```
node_modules/
dist/
.turbo/
coverage/
workspace/
secrets/
*.log
.DS_Store
```

`package.json`:
```json
{
  "name": "ww",
  "private": true,
  "packageManager": "pnpm@9.15.0",
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "turbo build",
    "test": "turbo test",
    "lint": "turbo lint",
    "dev": "turbo dev"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "eslint": "^9.17.0",
    "typescript": "^5.7.0",
    "typescript-eslint": "^8.19.0",
    "turbo": "^2.3.0",
    "vitest": "^2.1.8"
  }
}
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - "apps/*"
  - "packages/*"
```

`turbo.json`:
```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**"] },
    "test": { "dependsOn": ["^build"] },
    "lint": {},
    "dev": { "cache": false, "persistent": true }
  }
}
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "declaration": true,
    "sourceMap": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

`.nvmrc`: `22`

`vitest.workspace.ts`:
```ts
export default ['packages/*/vitest.config.ts', 'apps/*/vitest.config.ts'];
```

`eslint.config.mjs` (kök, flat config):
```js
import tseslint from 'typescript-eslint';
export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'workspace/**'] },
  ...tseslint.configs.recommended,
);
```

- [ ] **Step 3: pnpm install + commit**

```bash
pnpm install
git add -A && git commit -m "chore: monorepo kök iskeleti (pnpm+turbo+ts+vitest+eslint)"
```

### Task 1: docker-compose (ClickHouse + Redis)

**Files:**
- Create: `docker-compose.yml`

- [ ] **Step 1: Dosyayı yaz**

```yaml
services:
  clickhouse:
    image: clickhouse/clickhouse-server:24.8
    ports: ["8123:8123", "9000:9000"]
    environment:
      CLICKHOUSE_DB: ww
    ulimits: { nofile: { soft: 262144, hard: 262144 } }
    volumes: ["ch-data:/var/lib/clickhouse"]
    healthcheck:
      test: ["CMD", "clickhouse-client", "--query", "SELECT 1"]
      interval: 5s
      retries: 20
  redis:
    image: redis:7-alpine
    command: ["redis-server", "--appendonly", "yes"]
    ports: ["6379:6379"]
    volumes: ["redis-data:/data"]
volumes:
  ch-data:
  redis-data:
```

- [ ] **Step 2: Ayağa kaldır ve doğrula**

```bash
docker compose up -d
docker compose ps                       # ikisi de healthy/running
curl -s 'http://localhost:8123/?query=SELECT%201'   # → 1
```

- [ ] **Step 3: Commit**

```bash
git add docker-compose.yml && git commit -m "feat: docker-compose (clickhouse 24.8 + redis 7)"
```

### Task 2: packages/shared — sabitler ve tipler

**Files:**
- Create: `packages/shared/package.json`, `tsconfig.json`, `vitest.config.ts`, `src/index.ts`, `src/constants.ts`, `src/types.ts`
- Test: `packages/shared/src/constants.test.ts`

- [ ] **Step 1: Paket iskeleti**

`packages/shared/package.json`:
```json
{
  "name": "@ww/shared",
  "version": "0.0.1",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": { "build": "tsc -p tsconfig.json", "test": "vitest run", "lint": "eslint src" },
  "devDependencies": { "typescript": "^5.7.0", "vitest": "^2.1.8" }
}
```

`tsconfig.json`: `{ "extends": "../../tsconfig.base.json", "compilerOptions": { "outDir": "dist", "rootDir": "src" }, "include": ["src"] }`
`vitest.config.ts`: `export default {};`
(Bu üçlü kalıp diğer tüm paketlerde aynen tekrarlanır; sonraki task'larda "standart paket iskeleti" diye anılır.)

- [ ] **Step 2: Sabitler — docs/02 ve docs/03 ile birebir**

`src/constants.ts`:
```ts
export const TASK_STATUSES = ['queued','assigned','working','verifying','testing','approved','rejected','done','failed','cancelled','escalated','waiting_user'] as const;
export const AGENT_STATUSES = ['idle','busy','waiting_verify','waiting_answer','stopped'] as const;
export const AGENT_ROLES = ['pm','council_member','group_lead','interviewer','worker','verifier','standards_auditor','researcher','professor','creator','summarizer','narrator'] as const;
export const AGENT_GROUPS = ['management','analysis','design','db','coding','research','reasoning','ui_audit','mvvm_audit','db_write_audit'] as const;
export const MESSAGE_KINDS = ['question','answer','order','proposal','objection','synthesis','report','escalation','user_command','verdict'] as const;
export const EVENT_TYPES = ['tool_call','tool_result','api_call','decision','status_change','error','commit','lock_acquired','lock_released','escalation','clone_spawned','test_run','process_started','process_stopped','recovery_completed'] as const;
export const PROJECT_TYPES = ['web','mobile','api','fullstack'] as const;
export const PROJECT_STATUSES = ['draft','gathering','planning','running','paused','completed','archived'] as const;
export const PLAN_STATUSES = ['debating','proposed','approved','superseded','rejected'] as const;
export const USER_SENTINEL = '00000000-0000-0000-0000-000000000001';
export const BROADCAST_SENTINEL = '00000000-0000-0000-0000-000000000002';
export type TaskStatus = typeof TASK_STATUSES[number];
export type AgentRole = typeof AGENT_ROLES[number];
export type AgentGroup = typeof AGENT_GROUPS[number];
export type MessageKind = typeof MESSAGE_KINDS[number];
export type EventType = typeof EVENT_TYPES[number];
```

`src/types.ts` (WsEnvelope docs/08'den; satır tipleri Faz 0'da gerekenler):
```ts
export interface WsEnvelope<T = unknown> { event: string; projectId: string; seq: number; ts: string; data: T; }
export interface ApiUsageRow {
  usage_id: string; project_id: string; agent_id: string; task_id: string;
  provider_id: string; model: string; purpose: 'completion'|'embedding'|'health_check';
  prompt_tokens: number; completion_tokens: number; cost_usd: number;
  latency_ms: number; status: 'ok'|'error'|'timeout'|'rate_limited'|'fallback_used'; error_kind: string;
}
```

`src/index.ts`: `export * from './constants.js'; export * from './types.js';`

- [ ] **Step 3: Test yaz, koştur, commit**

`src/constants.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { TASK_STATUSES, AGENT_ROLES } from './constants.js';
it('durum ve rol listeleri tekil', () => {
  expect(new Set(TASK_STATUSES).size).toBe(TASK_STATUSES.length);
  expect(new Set(AGENT_ROLES).size).toBe(AGENT_ROLES.length);
});
```

```bash
pnpm --filter @ww/shared test    # PASS
git add packages/shared && git commit -m "feat(shared): durum/rol sabitleri ve ortak tipler"
```

### Task 3: packages/db — ClickHouse client + migration çalıştırıcı

**Files:**
- Create: `packages/db/package.json` (+standart iskelet), `src/client.ts`, `src/migrate.ts`, `src/index.ts`, `migrations/0001_init.sql`
- Test: `packages/db/src/migrate.test.ts`

Bağımlılıklar: `@clickhouse/client@^1`, `@ww/shared` (workspace).

- [ ] **Step 1: Client**

`src/client.ts`:
```ts
import { createClient, type ClickHouseClient } from '@clickhouse/client';
export interface ChConfig { url?: string; database?: string }
export function createCh(cfg: ChConfig = {}): ClickHouseClient {
  return createClient({
    url: cfg.url ?? process.env['WW_CH_URL'] ?? 'http://localhost:8123',
    database: cfg.database ?? process.env['WW_CH_DB'] ?? 'ww',
    clickhouse_settings: { date_time_input_format: 'best_effort' },
  });
}
```

- [ ] **Step 2: Başarısız test — migration idempotency**

`src/migrate.test.ts` (entegrasyon; CH yoksa atla):
```ts
import { beforeAll, describe, expect, it } from 'vitest';
import { createCh } from './client.js';
import { runMigrations } from './migrate.js';

const ch = createCh({ database: 'default' });
let up = true;
try { await ch.query({ query: 'SELECT 1' }); } catch { up = false; }

describe.skipIf(!up)('migrations', () => {
  const db = `ww_test_${Date.now()}`;
  beforeAll(async () => { await ch.command({ query: `CREATE DATABASE ${db}` }); });

  it('uygular, ikinci koşu no-op, checksum bozulunca hata', async () => {
    const a = await runMigrations({ database: db });
    expect(a.applied.length).toBeGreaterThan(0);
    const b = await runMigrations({ database: db });
    expect(b.applied).toHaveLength(0);                 // idempotent
    await expect(
      runMigrations({ database: db, files: [{ name: a.applied[0]!, sql: 'SELECT 2;' }] }),
    ).rejects.toThrow(/checksum/i);
  });
});
```

Koştur: `pnpm --filter @ww/db test` → FAIL (`runMigrations` yok).

- [ ] **Step 3: Migration çalıştırıcı**

`src/migrate.ts`:
```ts
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCh } from './client.js';

export interface MigrationFile { name: string; sql: string }
const MIG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

async function loadFiles(): Promise<MigrationFile[]> {
  const names = (await readdir(MIG_DIR)).filter((n) => n.endsWith('.sql')).sort();
  return Promise.all(names.map(async (name) => ({ name, sql: await readFile(join(MIG_DIR, name), 'utf8') })));
}
const checksum = (sql: string) => createHash('sha256').update(sql).digest('hex');
const statements = (sql: string) => sql.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean);

export async function runMigrations(opts: { url?: string; database?: string; files?: MigrationFile[] } = {}) {
  const database = opts.database ?? process.env['WW_CH_DB'] ?? 'ww';
  const admin = createCh({ url: opts.url, database: 'default' });
  await admin.command({ query: `CREATE DATABASE IF NOT EXISTS ${database}` });
  const ch = createCh({ url: opts.url, database });
  await ch.command({ query: `CREATE TABLE IF NOT EXISTS _migrations
    (name String, checksum String, applied_at DateTime64(3, 'UTC') DEFAULT now64(3))
    ENGINE = MergeTree ORDER BY name` });
  const doneRows = await (await ch.query({ query: 'SELECT name, checksum FROM _migrations', format: 'JSONEachRow' })).json<{ name: string; checksum: string }>();
  const done = new Map(doneRows.map((r) => [r.name, r.checksum]));
  const applied: string[] = [];
  for (const f of opts.files ?? (await loadFiles())) {
    const sum = checksum(f.sql);
    const prev = done.get(f.name);
    if (prev === sum) continue;
    if (prev !== undefined) throw new Error(`migration checksum mismatch: ${f.name}`);
    for (const st of statements(f.sql)) await ch.command({ query: st });
    await ch.insert({ table: '_migrations', values: [{ name: f.name, checksum: sum }], format: 'JSONEachRow' });
    applied.push(f.name);
  }
  return { applied };
}
```

- [ ] **Step 4: `migrations/0001_init.sql` — docs/02'deki 15 tablo + 2 MV**

Tam DDL (özet biçim — her tablo docs/02'deki kolonlarla birebir; ReplacingMergeTree
tabloları `version UInt64`, append tabloları partition'lı):

```sql
CREATE TABLE IF NOT EXISTS projects (
  project_id UUID, name String, slug String, type LowCardinality(String),
  status LowCardinality(String), description String, workspace_path String,
  budget_usd_limit Float64 DEFAULT 0, settings String DEFAULT '{}',
  active_plan_id UUID DEFAULT toUUID('00000000-0000-0000-0000-000000000000'),
  created_at DateTime64(3,'UTC'), updated_at DateTime64(3,'UTC'), version UInt64
) ENGINE = ReplacingMergeTree(version) ORDER BY project_id;

CREATE TABLE IF NOT EXISTS agents (
  agent_id UUID, project_id UUID, role LowCardinality(String), group LowCardinality(String),
  name String, model_ref String, parent_agent_id UUID, clone_of UUID,
  status LowCardinality(String), current_task_id UUID,
  prompt_name String, prompt_version UInt32,
  tasks_done UInt32 DEFAULT 0, tasks_rejected UInt32 DEFAULT 0,
  created_at DateTime64(3,'UTC'), updated_at DateTime64(3,'UTC'), version UInt64
) ENGINE = ReplacingMergeTree(version) ORDER BY (project_id, agent_id);
```

… (plans, tasks, messages, events, artifacts, file_index, knowledge, summaries,
embeddings, prompts, api_providers, role_models, api_usage — docs/02'deki kolon
listeleriyle; `group` gibi ayrılmış kelimeler backtick'lenir) ve MV'ler:

```sql
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_usage_daily
ENGINE = SummingMergeTree ORDER BY (project_id, provider_id, model, day)
AS SELECT project_id, provider_id, model, toDate(created_at) AS day,
  sum(cost_usd) AS cost, sum(prompt_tokens + completion_tokens) AS tokens, count() AS calls
FROM api_usage GROUP BY project_id, provider_id, model, day;

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_provider_errors
ENGINE = SummingMergeTree ORDER BY (provider_id, minute)
AS SELECT provider_id, toStartOfMinute(created_at) AS minute,
  countIf(status != 'ok') AS errors, count() AS total
FROM api_usage GROUP BY provider_id, minute;
```

- [ ] **Step 5: Test koştur (PASS) + commit**

```bash
pnpm --filter @ww/db test   # migrations describe PASS
git add packages/db && git commit -m "feat(db): clickhouse client + migration calistirici + 0001_init semasi"
```

### Task 4: packages/db — latest() son-durum yardımcısı

**Files:**
- Create: `packages/db/src/latest.ts`
- Test: `packages/db/src/latest.test.ts`

- [ ] **Step 1: Başarısız test**

```ts
// latest.test.ts (entegrasyon, aynı skipIf kalıbı; kendi test DB'sinde migration koşar)
it('iki sürümden yenisini döndürür', async () => {
  await insertRow(ch, 'projects', { project_id: id, name: 'eski', version: 1 });
  await insertRow(ch, 'projects', { project_id: id, name: 'yeni', version: 2 });
  const rows = await latest<{ name: string }>(ch, 'projects', 'project_id', { project_id: id });
  expect(rows).toHaveLength(1);
  expect(rows[0]!.name).toBe('yeni');
});
```

- [ ] **Step 2: Implementasyon**

```ts
// latest.ts
import type { ClickHouseClient } from '@clickhouse/client';
export async function latest<T>(ch: ClickHouseClient, table: string, idCol: string,
  where: Record<string, string | number> = {}): Promise<T[]> {
  const conds = Object.keys(where).map((k, i) => `${k} = {w${i}:String}`).join(' AND ') || '1';
  const params = Object.fromEntries(Object.values(where).map((v, i) => [`w${i}`, String(v)]));
  const rs = await ch.query({
    query: `SELECT * FROM ${table} WHERE ${conds} ORDER BY version DESC LIMIT 1 BY ${idCol}`,
    query_params: params, format: 'JSONEachRow',
  });
  return rs.json<T>();
}
```

- [ ] **Step 3: PASS + commit** (`feat(db): latest() son-durum sorgu yardimcisi`)

### Task 5: packages/db — Redis yardımcıları (stream, kilit, pub/sub)

**Files:**
- Create: `packages/db/src/redis.ts`
- Test: `packages/db/src/redis.test.ts`

Bağımlılık: `redis@^4`.

- [ ] **Step 1: Başarısız testler** (entegrasyon; Redis yoksa atla)

```ts
it('kuyruk: xadd + grup okuma + ack', async () => {
  await ensureGroup(r, q, 'scheduler');
  await enqueueTask(r, q, 'task-1');
  const msgs = await readQueue(r, q, 'scheduler', 'c1');
  expect(msgs[0]!.taskId).toBe('task-1');
  await ackQueue(r, q, 'scheduler', msgs[0]!.msgId);
});
it('kilit: NX alma, sahibi olmayan bırakamaz', async () => {
  expect(await acquireLock(r, 'ww:lock:test', 'owner-a', 10)).toBe(true);
  expect(await acquireLock(r, 'ww:lock:test', 'owner-b', 10)).toBe(false);
  expect(await releaseLock(r, 'ww:lock:test', 'owner-b')).toBe(false);
  expect(await releaseLock(r, 'ww:lock:test', 'owner-a')).toBe(true);
});
it('pub/sub: yayınlanan zarf aboneye ulaşır', async () => { /* subscribeEvents + publishEvent roundtrip */ });
```

- [ ] **Step 2: Implementasyon**

```ts
// redis.ts — createRedis(url?), ensureGroup (BUSYGROUP yut), enqueueTask (XADD {task_id}),
// readQueue (XREADGROUP COUNT 10 BLOCK 0/param) → {msgId,taskId}[], ackQueue (XACK),
// acquireLock (SET NX EX), releaseLock (Lua: GET==val ise DEL),
// publishEvent(env: WsEnvelope) → PUBLISH 'ww:events' JSON, subscribeEvents(cb) → duplicate().subscribe
```

(Tam kod implementasyonda; Lua compare-and-del şablonu:
`if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end`)

- [ ] **Step 3: PASS + commit** (`feat(db): redis stream/kilit/pubsub yardimcilari`)

### Task 6: packages/providers — tipler, fiyat tablosu, MockProvider

**Files:**
- Create: `packages/providers/package.json` (+standart iskelet), `src/types.ts`, `src/pricing.ts`, `src/mock.ts`, `src/index.ts`
- Test: `src/pricing.test.ts`, `src/mock.test.ts`

- [ ] **Step 1: Tipler — docs/04 arayüzü birebir**

```ts
// types.ts
export interface ChatMessage { role: 'system'|'user'|'assistant'|'tool'; content: string; toolCallId?: string; toolCalls?: NormalizedToolCall[] }
export interface ToolDef { name: string; description: string; parameters: Record<string, unknown> }
export interface NormalizedToolCall { id: string; name: string; args: Record<string, unknown> }
export interface CompletionRequest {
  model: string; messages: ChatMessage[]; tools?: ToolDef[]; maxTokens?: number; temperature?: number;
  meta: { projectId: string; agentId: string; taskId?: string; purpose: 'completion'|'embedding'|'health_check' };
}
export interface CompletionResult {
  content: string | null; toolCalls: NormalizedToolCall[];
  usage: { promptTokens: number; completionTokens: number }; raw?: unknown;
}
export interface HealthResult { ok: boolean; latencyMs: number; error?: string }
export interface LlmProvider {
  readonly id: string;
  complete(req: CompletionRequest): Promise<CompletionResult>;
  embed(texts: string[], model?: string): Promise<number[][]>;
  healthCheck(): Promise<HealthResult>;
  listModels(): string[];
}
export class ProviderError extends Error {
  constructor(msg: string, readonly kind: 'connection'|'server'|'rate_limited'|'timeout'|'bad_request'|'auth') { super(msg); }
  get retryable() { return this.kind !== 'bad_request' && this.kind !== 'auth'; }
}
```

- [ ] **Step 2: Fiyat tablosu + test (TDD)**

Test: bilinen model doğru maliyet, bilinmeyen model 0 + `known:false`.
```ts
// pricing.ts
export interface Price { inPerMTok: number; outPerMTok: number }
export const PRICING: Record<string, Price> = {
  'openai:gpt-5': { inPerMTok: 1.25, outPerMTok: 10 },
  'openai:gpt-5-mini': { inPerMTok: 0.25, outPerMTok: 2 },
  'openai:text-embedding-3-small': { inPerMTok: 0.02, outPerMTok: 0 },
  'anthropic:claude-opus-5': { inPerMTok: 15, outPerMTok: 75 },
  'anthropic:claude-sonnet-5': { inPerMTok: 3, outPerMTok: 15 },
  'deepseek:deepseek-chat': { inPerMTok: 0.27, outPerMTok: 1.1 },
};
export function costUsd(modelRef: string, u: { promptTokens: number; completionTokens: number }) {
  const p = PRICING[modelRef];
  if (!p) return { cost: 0, known: false };
  return { cost: (u.promptTokens * p.inPerMTok + u.completionTokens * p.outPerMTok) / 1_000_000, known: true };
}
```
(Fiyatlar implementasyon günü güncel listeyle doğrulanır; tablo elle bakımlıdır — docs/04.)

- [ ] **Step 3: MockProvider + test (TDD)**

Davranış: kurucuya verilen senaryo sırayla döner (`respond` fonksiyonu veya sabit
liste); `failFirst: n` ilk n çağrıda ProviderError fırlatır (fallback testi için);
`calls` dizisi istekleri kaydeder; `embed` deterministik sahte vektör (metin
hash'inden) döner.

- [ ] **Step 4: PASS + commit** (`feat(providers): tipler, fiyat tablosu, MockProvider`)

### Task 7: packages/providers — usage kaydı + ModelRouter (fallback)

**Files:**
- Create: `src/usage.ts`, `src/router.ts`
- Test: `src/router.test.ts`

- [ ] **Step 1: Başarısız testler**

```ts
it('birincil başarılıysa fallback denenmez, usage ok yazılır', ...);
it('birincil retryable hata verirse yedek model kullanılır; usage: error + fallback_used', ...);
it('bad_request fallback tetiklemez, hata fırlar', ...);
it('tüm zincir düşerse ProviderError fırlar, her deneme usage’a yazılır', ...);
it('maliyet costUsd ile hesaplanıp satıra konur', ...);
```

- [ ] **Step 2: Implementasyon**

```ts
// usage.ts
export type UsageSink = (row: ApiUsageRow) => Promise<void>;
export function chUsageSink(ch: ClickHouseClient): UsageSink {
  return (row) => ch.insert({ table: 'api_usage', values: [{ ...row, created_at: new Date().toISOString() }], format: 'JSONEachRow' });
}
// router.ts
export class ModelRouter {
  constructor(private providers: Map<string, LlmProvider>,
              private opts: { fallbacks(modelRef: string): string[]; usageSink: UsageSink; timeoutMs?: number }) {}
  async complete(modelRef: string, req: Omit<CompletionRequest,'model'>):
    Promise<{ result: CompletionResult; usedRef: string; fallbackUsed: boolean }> {
    const chain = [modelRef, ...this.opts.fallbacks(modelRef)];
    let lastErr: unknown;
    for (const [i, ref] of chain.entries()) {
      const [providerId, model] = splitRef(ref);           // 'openai:gpt-5' → ['openai','gpt-5']
      const p = this.providers.get(providerId);
      if (!p) continue;
      const t0 = Date.now();
      try {
        const result = await withTimeout(p.complete({ ...req, model }), this.opts.timeoutMs ?? 120_000);
        await this.record(ref, req, result.usage, Date.now()-t0, i > 0 ? 'fallback_used' : 'ok', '');
        return { result, usedRef: ref, fallbackUsed: i > 0 };
      } catch (e) {
        lastErr = e;
        await this.record(ref, req, { promptTokens: 0, completionTokens: 0 }, Date.now()-t0, errStatus(e), errKind(e));
        if (e instanceof ProviderError && !e.retryable) throw e;
      }
    }
    throw lastErr;
  }
}
```
(`record` costUsd + meta alanlarıyla `ApiUsageRow` kurar; testlerde `usageSink` bellek dizisidir.)

- [ ] **Step 3: PASS + commit** (`feat(providers): ModelRouter fallback zinciri + api_usage kaydi`)

### Task 8: packages/providers — OpenAI / Anthropic / DeepSeek adaptörleri

**Files:**
- Create: `src/adapters/openai.ts`, `src/adapters/anthropic.ts`, `src/adapters/deepseek.ts`
- Test: `src/adapters/normalize.test.ts`

Bağımlılıklar: `openai@^4`, `@anthropic-ai/sdk@^0.39`.

- [ ] **Step 1: Normalizasyon birim testleri** (SDK'ya değil saf çevirici fonksiyonlara):
  iç `ChatMessage[]`→OpenAI/Anthropic biçimi; yanıtın `tool_calls`/`tool_use`→`NormalizedToolCall[]`;
  Anthropic'te system mesajının ayrılması; `tool` rolü→`tool_result` bloğu.

- [ ] **Step 2: Adaptörler** — her biri `LlmProvider` uygular; anahtar kurucudan gelir
  (keystore Task 9); hata eşlemesi: 401→`auth`, 429→`rate_limited`, 5xx→`server`,
  ağ→`connection`, `AbortError`→`timeout`. DeepSeek = OpenAI adaptörü + `baseURL`.
  `healthCheck` = 1 token'lık `complete` (`purpose:'health_check'`).

- [ ] **Step 3: PASS + commit** (`feat(providers): openai/anthropic/deepseek adaptorleri`)

### Task 9: packages/providers — anahtar deposu (şifreli dosya)

**Files:**
- Create: `src/keystore.ts`
- Test: `src/keystore.test.ts`

- [ ] **Step 1: Başarısız testler**: set→get roundtrip; dosya içeriği düz metin anahtar
  içermez; yanlış master key ile açma hatası; `maskKey('sk-abcdef1234')==='sk-…1234'`.

- [ ] **Step 2: Implementasyon** — `node:crypto` AES-256-GCM:

```ts
// keystore.ts — dosya biçimi: { v:1, nonce: b64, data: b64(cipher+tag) }; içerik: JSON Record<providerId, apiKey>
export class Keystore {
  constructor(private file: string, private masterKey: Buffer) {}   // 32 bayt
  static async open(file: string): Promise<Keystore>;               // masterKey çözümü: env WW_MASTER_KEY (hex)
                                                                    // → yoksa macOS Keychain (`security find-generic-password -s ww-master -w`,
                                                                    // yoksa üretip `add-generic-password` ile kaydet)
  async get(providerId: string): Promise<string | undefined>;
  async set(providerId: string, apiKey: string): Promise<void>;     // oku-değiştir-yaz, 0600 izin
}
export const maskKey = (k: string) => (k.length <= 4 ? '…' : `${k.slice(0, 3)}…${k.slice(-4)}`);
```
Testler masterKey'i doğrudan enjekte eder (Keychain'e dokunmaz).
Not: docs/04 "libsodium" der; Node yerleşik AES-256-GCM ile bağımlılıksız eşdeğer —
doküman Task 11'de güncellenir.

- [ ] **Step 3: PASS + commit** (`feat(providers): AES-256-GCM sifreli anahtar deposu`)

### Task 10: Prompt seed migration + apps kabukları

**Files:**
- Create: `packages/db/migrations/0002_prompt_seed.sql`
- Create: `apps/server/*` (NestJS minimal), `apps/panel/*` (Vite kabuk)

- [ ] **Step 1: `0002_prompt_seed.sql`** — docs/03'teki çekirdek şablonlar:
  `role.pm`, `role.worker.coding`, `role.verifier`, `role.summarizer`, `role.narrator`
  için `INSERT INTO prompts (prompt_name, prompt_version, content, variables, changelog, is_active, created_at, version) VALUES …`
  (içerikler docs/03'teki metinlerin tam halleri; `{{task_description}}`, `{{context_pack}}` vb. değişkenlerle).
  Migration testinin idempotency'si bozulmasın diye INSERT'ler
  `SELECT … WHERE NOT EXISTS` kalıbıyla korunmaz — dosya bir kez uygulanır, `_migrations` zaten tekrar koşmaz.

- [ ] **Step 2: `apps/server`** — NestJS minimal:
  `main.ts` açılışta `runMigrations()` çağırır; `GET /health` → `{ ok, clickhouse, redis }`
  (CH `SELECT 1`, Redis `PING`); port 4000. Test: health endpoint e2e (supertest,
  servisler ayaktayken).

- [ ] **Step 3: `apps/panel`** — Vite React TS şablonu; tek sayfa: "ww paneli — Faz 3'te
  gelecek" + sağlık durumunu `GET /health`ten gösteren kutu. Test yok (kabuk).

- [ ] **Step 4: Commit** (`feat(apps): server kabugu (migration+health) ve panel kabugu`)

### Task 11: Kapanış — tam koşu ve doküman senkronu

- [ ] **Step 1:** `docker compose up -d && pnpm build && pnpm test && pnpm lint` — hepsi yeşil.
- [ ] **Step 2:** `docs/04-model-katmani.md` anahtar deposu satırını gerçekle senkronla
  (libsodium → node:crypto AES-256-GGM ifadesi) ve `docs/11-yol-haritasi.md` Faz 0'ı
  "tamamlandı ✅ (tarih)" işaretle.
- [ ] **Step 3:** `README.md`'ye "Geliştirme" bölümü: gereksinimler (Node 22, pnpm, Docker),
  `docker compose up -d`, `pnpm install`, `pnpm test`, `pnpm dev`.
- [ ] **Step 4:** Commit (`docs: faz 0 kapanisi — kurulum bolumu + dokuman senkronu`).

---

## Self-Review Notları

- **Spec kapsaması**: Faz 0 kapsam listesindeki her madde bir task'ta: monorepo (T0),
  docker (T1), şema+migration+latest+redis (T3-T5), provider arayüzü+router+adaptörler+
  mock+fiyat+usage (T6-T8), keystore (T9), prompt seed (T10), "bitti" doğrulaması (T11).
- **Tip tutarlılığı**: `LlmProvider`/`CompletionRequest` docs/04 ile, tablo/kolon adları
  docs/02 ile, sabitler docs/02-03 ile birebir; `ApiUsageRow` shared'da tek tanım.
- **Bilinçli sapmalar**: (1) libsodium yerine node:crypto — T11'de doküman güncellenir.
  (2) Fiyat tablosu değerleri implementasyon günü güncel fiyatlarla doğrulanacak.
```
