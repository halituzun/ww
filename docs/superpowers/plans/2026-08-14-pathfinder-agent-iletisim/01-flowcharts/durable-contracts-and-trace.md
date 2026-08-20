# Durable Contracts and Trace

## Current State

Phase 0 implements startup migrations, checksums, ClickHouse state/trace tables,
prompt seeds, latest-version reads, Redis primitives, and the API-usage sink. It does
not implement task, message, event, or artifact repositories; an event-sequence
allocator; or the ClickHouse-first/Redis-second runtime path.

## Flow

```mermaid
flowchart TD
    A["[IMPLEMENTED] Run migrations before Nest startup<br/>apps/server/src/main.ts:8"] --> B["[IMPLEMENTED] Validate database identifier<br/>packages/db/src/migrate.ts:32"]
    B --> C["[IMPLEMENTED] Load ordered SQL and compare checksums<br/>packages/db/src/migrate.ts:22"]
    C -->|mismatch| X["[IMPLEMENTED] Abort startup<br/>packages/db/src/migrate.ts:81"]
    C -->|new| D["[IMPLEMENTED] Create state and trace tables<br/>packages/db/migrations/0001_init.sql:4"]
    D --> E["[IMPLEMENTED] Seed versioned role prompts<br/>packages/db/migrations/0002_prompt_seed.sql:4"]
    E --> F["[IMPLEMENTED] Start Nest server<br/>apps/server/src/main.ts:13"]
    F --> G["[PLANNED] Accept task, message, or tool action<br/>docs/03-agent-sistemi.md:89"]
    G --> H["[PLANNED] Append state version and status event<br/>docs/03-agent-sistemi.md:84"]
    H --> I["[PLANNED] Persist message/event in ClickHouse first<br/>docs/01-mimari.md:177"]
    I --> J["[PLANNED] Publish Redis notification<br/>docs/03-agent-sistemi.md:155"]
    J --> K["[PLANNED] Recipient reloads durable record<br/>docs/03-agent-sistemi.md:155"]
    K --> L["[PLANNED] Append artifacts, index, summary, commit<br/>docs/03-agent-sistemi.md:104"]
    L --> M["[PLANNED] Replay trace to panel or narrator<br/>docs/06-hafiza-ve-baglam.md:123"]
    I -->|Redis unavailable| R["[PLANNED] Rebuild acceleration state from DB<br/>docs/01-mimari.md:198"]
    I -->|ClickHouse unavailable| S["[PLANNED] Stop new work; buffer active events<br/>docs/01-mimari.md:199"]
```

## Gaps and Failure Paths

- Migration statements are not transactional; the ledger is appended only after
  all statements complete (`packages/db/src/migrate.ts:83-86`).
- There is no outbox/retry contract for a crash after the ClickHouse append but
  before the Redis notification.
- `messages.content` and `events.payload` are unversioned free-form strings. They
  lack correlation, causation, idempotency, delivery, deadline, and provenance
  fields (`packages/db/migrations/0001_init.sql:86-114`).
- `events.seq` has no implemented monotonic allocator (`0001_init.sql:101-114`).
- Tasks do not persist acceptance criteria or the assignment-time prompt/rule
  snapshot required by the worker and verifier prompts (`0001_init.sql:58-84`;
  `0002_prompt_seed.sql:36-65`).

## Dependencies and Confidence

The flow depends on ClickHouse, Redis, future repositories, Context Builder, and
panel/narrator replay. Confidence is **high** for implemented status and **medium**
for delivery/recovery semantics because those contracts are not yet specified.
