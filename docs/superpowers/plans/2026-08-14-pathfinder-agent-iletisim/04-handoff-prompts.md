# Handoff Prompts

These prompts are ready for `/make-plan`. Run the master prompt first; use the
follow-ups only if the resulting plan deliberately splits the work.

## 1. Phase 1 Agent Communication Contract (Recommended)

```text
/make-plan Create a decision-complete Phase 1 implementation plan for ww's Agent
Communication Contract. Read PATHFINDER-2026-08-14/00-features.md,
PATHFINDER-2026-08-14/01-flowcharts/message-transport-and-agent-loops.md,
PATHFINDER-2026-08-14/01-flowcharts/task-orchestration-and-scheduling.md,
PATHFINDER-2026-08-14/01-flowcharts/memory-and-temporal-context.md,
PATHFINDER-2026-08-14/01-flowcharts/rule-enforcement-and-auditing.md,
PATHFINDER-2026-08-14/02-duplication-report.md, and
PATHFINDER-2026-08-14/03-unified-proposal.md first.

The plan must add runtime-validated AgentMessageEnvelopeV1, immutable TaskBriefV1,
AssignmentAttemptV1/TaskHandoffV1, PolicyDecision/AuditFinding contracts, a
forward-only migration, durable receipt/effect ledgers, CommunicationService,
scheduler-owned TaskTransitionService, minimal base-context pinning plus task causal
cursor sealed per `PromptInputSnapshotV1`, and deterministic
communication/transition/tool guards. It must
wire the current Redis helpers at packages/db/src/redis.ts:94-180, current provider
router at packages/providers/src/router.ts:57-117, schemas at
packages/db/migrations/0001_init.sql:20-193, and prompt seeds at
packages/db/migrations/0002_prompt_seed.sql:4-75.

Lock explicit decisions for receipt FSM/ACK timing, lease reclaim/backoff,
effect idempotency keyed by stable effect ID/operation ordinal, user/agent/system
principal resolution, broadcast recipient snapshot/receipts, crash between ClickHouse
append and Redis publish, rule-version pinning, question/answer correlation,
reassignment handoff, and recovery. Define Phase 1 `TaskCausalCursorV1` as an
attempt-scoped monotonically increasing ordinal allocated only by scheduler-owned
`TaskCausalLog.append`; specify current-attempt/lease serialization, deterministic
entry IDs, restart restoration, ancestor sealing, ordinal-zero handoff, and rejection
of parallel attempts/branch merge. Persist this in append-only `task_causal_entries`,
bind current attempt to the latest task fold, and specify uncertain-insert
reconciliation before allocating another ordinal. Keep this separate from the Phase 3 project
journal cursor. Add a forward migration—not edits to `0002_prompt_seed.sql`—that
seeds active PM-direct `role.worker.coding` v2 and direct-worker-aware `role.pm` v2
plus route marker tests. Include unit, integration, restart, prompt-injection,
stale/future-context, and MockProvider end-to-end tests. Preserve Phase 0
migrations; add new migrations only.

Avoid exactly-once claims, mutable task briefs, free-form verdicts, direct task
status writes outside scheduler, Redis as truth, direct publishEvent calls from
domain code, a universal policy engine, registries/factories added for hypothetical
flexibility, and pulling the full Phase 2 memory or Phase 3 UI into Phase 1.
```

## 2. Temporal Task Brief and Context Snapshot

```text
/make-plan Plan the minimal Phase 1 TaskBriefV1 and the Phase 2 bitemporal Context
Builder for ww. Start from
PATHFINDER-2026-08-14/01-flowcharts/memory-and-temporal-context.md and
PATHFINDER-2026-08-14/03-unified-proposal.md. Reconcile the task-bound plan at
packages/db/migrations/0001_init.sql:58-84 with the active-plan retrieval described
at docs/06-hafiza-ve-baglam.md:73-102 and standards versioning at
docs/09-kod-standartlari.md:19-25.

Specify immutable acceptance criteria, plan/task/prompt/rule/standard versions and
hashes, baseContextCutoffAt + per-invocation inputTaskCausalCursor snapshot,
assignment attempts and ancestor-bounded typed handoff, dependency snapshot,
provenance, knowledge
knownAt/validFrom/validTo, summary coverage, source-versioned embeddings, explicit
rebase semantics, and as-of query tests. Old/replayed tasks must never observe
future global plan, prompt, standard, summary, or knowledge state, but must see its
own later verifier/gate/answer/escalation chain. Keep semantic retrieval in Phase 2;
Phase 1 only freezes the sources needed for deterministic agent loops.
```

## 3. Communication Policy and Audit

```text
/make-plan Plan ww's rule teaching, deterministic enforcement, and semantic audit
pipeline. Read PATHFINDER-2026-08-14/01-flowcharts/rule-enforcement-and-auditing.md,
PATHFINDER-2026-08-14/02-duplication-report.md, and
PATHFINDER-2026-08-14/03-unified-proposal.md. Use the current worker/verifier
prompt boundary at packages/db/migrations/0002_prompt_seed.sql:21-75, executor rules
at docs/05-executor.md:28-70, scheduler rules at docs/07-zamanlayici.md:30-69, and
auditor expectations at docs/09-kod-standartlari.md:105-164.

Plan exactly three small pure guards: communication authorization, task transition
authorization, and tool capability authorization. Give rules stable IDs/versions;
pin them in TaskBriefV1; make every guard return a typed PolicyDecision; model typed
verdicts and AuditFindings with evidence, severity, correction task, and resolution.
Cover forged roles/verdicts, scope escape, prompt injection in every provenance
class, verifier independence, summarizer exemption, and finding-to-fix lifecycle.
Do not introduce a generic policy DSL or trust model output as authorization.
```

## 4. Durable Replay and UI Projection

```text
/make-plan Plan a later-phase durable journal and projection path for ww's REST,
WebSocket, narrator, and recovery consumers. Read
PATHFINDER-2026-08-14/01-flowcharts/api-ui-control-and-observability.md,
PATHFINDER-2026-08-14/01-flowcharts/durable-contracts-and-trace.md, and
PATHFINDER-2026-08-14/02-duplication-report.md. Resolve
the Phase 0 raw `events.seq` field at docs/02-clickhouse-semasi.md:162-176 against
the provisional opaque project cursor/subscription target at docs/08-panel.md:133-168.

Choose one project-scoped cursor/high-water contract and one validated durable event
vocabulary shared by DB, REST, Redis, WebSocket, and panel. Specify subscribe/snapshot/
replay ordering, pagination, dedupe, out-of-order handling, projection rebuild, and
Redis-loss recovery. UI and narrator must project the same durable records; neither
defines new truth. Do not make Redis durable and do not infer missing messages from
global sequence holes caused by other projects.
```
