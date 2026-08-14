# Task Orchestration and Scheduling

## Current State

Task/agent tables, shared status constants, latest-state reads, Redis Stream and
lock primitives, provider fallback, and worker/verifier prompts are implemented.
The scheduler, FSM guard, dependency evaluator, heartbeat/recovery service,
executor, and agent loops are planned.

## Flow

```mermaid
flowchart TD
    A["[IMPLEMENTED SCHEMA] Task and agent state tables<br/>packages/db/migrations/0001_init.sql:20"] --> B["[PLANNED] Persist queued task, then enqueue task_id<br/>docs/07-zamanlayici.md:21"]
    B --> C["[IMPLEMENTED PRIMITIVE] Consumer-group read and ACK<br/>packages/db/src/redis.ts:94"]
    C --> D{"[PLANNED] Acquire task claim<br/>docs/07-zamanlayici.md:27"}
    D -->|no| E["[PLANNED] Avoid duplicate processing<br/>docs/01-mimari.md:184"]
    D -->|yes| F{"[PLANNED] Dependencies, file conflicts, brakes pass?<br/>docs/07-zamanlayici.md:32"}
    F -->|no| G["[PLANNED] Delay or escalate task<br/>docs/07-zamanlayici.md:35"]
    F -->|yes| H["[PLANNED] Select worker and independent verifier<br/>docs/07-zamanlayici.md:38"]
    H --> I["[PLANNED] Acquire all target-file locks<br/>docs/07-zamanlayici.md:59"]
    I --> J["[PLANNED] Assign task and start worker<br/>docs/07-zamanlayici.md:41"]
    J --> K["[PLANNED] Worker tool loop and result summary<br/>docs/03-agent-sistemi.md:94"]
    K --> L{"[PLANNED] Independent verifier verdict<br/>docs/03-agent-sistemi.md:96"}
    L -->|reject| M["[PLANNED] Increment attempt and return reason<br/>docs/03-agent-sistemi.md:100"]
    M --> K
    L -->|limit| N["[PLANNED] Escalation chain<br/>docs/03-agent-sistemi.md:170"]
    L -->|approve| O{"[PLANNED] Build, lint, and test gate<br/>docs/05-executor.md:87"}
    O -->|fail| M
    O -->|pass| P["[PLANNED] Commit, artifacts, index, summary, done<br/>docs/03-agent-sistemi.md:104"]
    J -. active task .-> Q{"[PLANNED] Heartbeat alive?<br/>docs/07-zamanlayici.md:83"}
    Q -->|no| R["[PLANNED] Requeue task and release ownership<br/>docs/07-zamanlayici.md:85"]
    R --> B
```

## Gaps and Failure Paths

- Queue ACK timing and pending-entry reclaim are undefined; `XAUTOCLAIM` is absent.
- Claim renewal, heartbeat helpers, delayed requeue, and all-or-nothing file locks
  are not implemented.
- No central guard enforces allowed FSM transitions; `rejected` exists in constants
  while the lifecycle diagram routes rejection directly back to `working`.
- Recovery assumes destructive working-tree cleanup without a defined per-task
  worktree owner, risking unrelated work (`docs/07-zamanlayici.md:97-104`).
- Discovery found a recovery-phase conflict; synthesis corrected
  `docs/01-mimari.md` to the authoritative Phase 2 scope in
  `docs/11-yol-haritasi.md:95-113`.

## Dependencies and Confidence

Side effects span ClickHouse versions/events/messages, Redis Stream/locks/heartbeat,
provider calls, workspace changes, gates, and Git commits. Confidence is **high**
for current/planned boundaries and **medium** for ACK/recovery semantics.
