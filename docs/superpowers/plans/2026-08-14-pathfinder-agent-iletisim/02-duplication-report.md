# Duplication and Ownership Report

## Executive Finding

The project repeats sound principles across documents, but no runtime owner binds
them into one enforceable path. The largest risk is not duplicated code—it is
duplicated **authority**. Multiple planned packages can publish, change task state,
assemble rules, or reconstruct history differently.

## High-Impact Findings

### 1. Durable write and live publication

ClickHouse-first/Redis-second is repeated in architecture, agent, and panel flows
(`docs/01-mimari.md:171-180`; `docs/03-agent-sistemi.md:155-156`;
`docs/08-panel.md:164-165`), while `publishEvent()` has no durable-write precondition
(`packages/db/src/redis.ts:152-163`). Independent writers would drift on retry,
sequence, and crash behavior.

**Unify:** `packages/db` owns durable repositories/journal mechanics;
`packages/agents` exposes the only public communication send/read path. Redis is a
best-effort wake-up, never the record.

### 2. Task state transitions

The FSM is defined in the agent document, but scheduler, executor, and agent tools
all plan to mutate it (`docs/03-agent-sistemi.md:61-84`;
`docs/07-zamanlayici.md:32-43`; `docs/05-executor.md:48-51,87-104`). This risks illegal
transitions, duplicate attempts, and incomplete side effects.

**Unify:** a scheduler-owned `TaskTransitionService` applies a single transition
table. Agents and tools request semantic transitions; they never write status.

### 3. Mutable task context and rules

Context Builder selects task sources, standards version forward, and prompts
expect criteria not persisted on tasks (`docs/06-hafiza-ve-baglam.md:73-102`;
`docs/09-kod-standartlari.md:19-25`;
`packages/db/migrations/0001_init.sql:58-84`). Worker and verifier could receive
different rules or future knowledge.

**Unify:** memory builds one immutable `TaskBriefV1`/context snapshot at assignment.
All retries, provider calls, and verification reference its ID and version hashes.

### 4. Rule interpretation and findings

Prompt rules, executor permissions, scheduler rules, verifier checks, and periodic
auditors overlap (`packages/db/migrations/0002_prompt_seed.sql:21-75`;
`docs/05-executor.md:28-70`; `docs/09-kod-standartlari.md:105-164`). The panel expects
durable findings without a model (`docs/08-panel.md:118-124`).

**Unify:** three small deterministic guards—communication authorization, task
transition authorization, and tool capability authorization—share a typed
`PolicyDecision`. Verifier/auditor own semantic judgment and emit typed findings.

### 5. Message, event, and live vocabularies

Shared constants, DB strings, and WebSocket event names are separate contracts
(`packages/shared/src/constants.ts:19-28`;
`packages/db/migrations/0001_init.sql:86-114`; `docs/08-panel.md:148-158`). The real
`WsEnvelope.event` is only `string` (`packages/shared/src/types.ts:1-8`).

**Unify:** `@ww/shared` owns runtime-validated, versioned discriminated envelopes.
Live events are projections of durable records, not an independent vocabulary.

### 6. Questions, answers, and at-least-once delivery

The Phase 0 schema correlates answers only by session, while Redis task delivery is
at least once (`packages/db/migrations/0001_init.sql:86-99`;
`packages/db/src/redis.ts:104-137`). Concurrent questions and restart replay were
therefore ambiguous; synthesis adds `replyToMessageId` and durable receipts.

**Unify:** communication envelopes carry reply, correlation, causation,
idempotency, deadline, and protocol version. Durable per-recipient receipts/cursors
separate “stored” from “processed.”

### 7. Replay and temporal truth

Panel, narrator, and recovery each reconstruct history independently
(`docs/08-panel.md:67-70,133-168`; `docs/06-hafiza-ve-baglam.md:115-135`;
`docs/07-zamanlayici.md:92-107`). Discovery found that a global event sequence
conflicted with project-filtered replay; synthesis removed the global guarantee and
assigned the cursor/high-water decision to Phase 3.

**Unify:** a DB-owned project journal reader defines per-project cursor, high-water
mark, pagination, dedupe, and as-of semantics. Consumers project the same history
for UI, narration, and recovery.

### 8. Provider attribution

Provider metadata lacks communication and rule-snapshot identity, even though the
router can change models during fallback (`packages/providers/src/types.ts:22-35`;
`packages/providers/src/router.ts:57-83`; `0001_init.sql:86-99`).

**Unify:** one `invocation_id` links task brief, source message, actual model,
`api_usage`, result message, and events.

## Ownership Map

| Owner | Single responsibility |
|---|---|
| `packages/shared` | Versioned runtime schemas and stable vocabulary |
| `packages/db` | Durable repositories, receipts, journal, replay queries |
| `packages/agents` | Communication validation, routing, inbox, role loops |
| `packages/scheduler` | Assignment, FSM, retry, recovery, ownership |
| `packages/memory` | Assignment-time temporal snapshot and as-of retrieval |
| `packages/executor` | Tool capability/path/command enforcement |
| `packages/providers` | Model execution and actual-route attribution |
| server/panel | Validated commands and read-only projections |

This structure needs no universal registry or policy framework. It uses explicit
services and small pure guards at the boundaries where authority already belongs.
