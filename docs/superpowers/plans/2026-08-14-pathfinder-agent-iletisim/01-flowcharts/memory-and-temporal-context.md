# Memory and Temporal Context

## Current State

Append-only history and versioned plans, tasks, knowledge, and prompts exist. The
Context Builder, summarization, embeddings, and narrator are planned for Phase 2.
There is no enforceable assignment-time snapshot, so later plans, rules, summaries,
or knowledge can contaminate a resumed or replayed earlier task.

## Flow

```mermaid
flowchart TD
    A["[IMPLEMENTED] Persist task plan, dependencies, parent, files<br/>packages/db/migrations/0001_init.sql:58"] --> B["[PLANNED] Scheduler assigns task<br/>docs/03-agent-sistemi.md:89"]
    B --> C["[PLANNED] Context Builder receives role, task, budget<br/>docs/06-hafiza-ve-baglam.md:75"]
    C --> D["[PLANNED] Load pinned plan, requirements, standards<br/>docs/06-hafiza-ve-baglam.md:84"]
    D --> E["[PLANNED] Load file index, dependencies, parent chain<br/>docs/06-hafiza-ve-baglam.md:87"]
    E --> F["[PLANNED] Retrieve prior summaries and decisions<br/>docs/06-hafiza-ve-baglam.md:90"]
    F --> G{"[PLANNED] Token budget remains?<br/>docs/06-hafiza-ve-baglam.md:82"}
    G -->|yes| H["[PLANNED] Add whole, source-labelled chunk<br/>docs/06-hafiza-ve-baglam.md:96"]
    H --> G
    G -->|no| I["[PLANNED] Log included/excluded sources<br/>docs/06-hafiza-ve-baglam.md:99"]
    I --> J["[IMPLEMENTED TEMPLATE] Inject task, criteria, context_pack<br/>packages/db/migrations/0002_prompt_seed.sql:21"]
    J --> K{"[IMPLEMENTED PROMPT RULE] Context sufficient?<br/>packages/db/migrations/0002_prompt_seed.sql:31"}
    K -->|no| L["[IMPLEMENTED PROMPT RULE] Ask; do not guess<br/>packages/db/migrations/0002_prompt_seed.sql:31"]
    K -->|yes| M["[PLANNED] Worker executes task<br/>docs/03-agent-sistemi.md:94"]
    M --> N["[PLANNED] Write summary and file index<br/>docs/06-hafiza-ve-baglam.md:47"]
    N --> O["[PLANNED] Embed durable memory sources<br/>docs/06-hafiza-ve-baglam.md:62"]
    O --> P["[PLANNED] Future task retrieves prior decision<br/>docs/11-yol-haritasi.md:111"]
    D -. risk .-> Q["[GAP] Active plan/rules not frozen per task<br/>packages/db/migrations/0001_init.sql:40"]
    F -. risk .-> R["[GAP] Summaries lack as-of validity metadata<br/>packages/db/migrations/0001_init.sql:160"]
```

## Temporal Gaps

- Tasks lack `context_snapshot_id`, `assigned_at`, a knowledge cutoff, acceptance
  criteria, and rule/prompt/standard versions (`0001_init.sql:58-84`).
- Knowledge has current `active/superseded` state but no `known_at`, `valid_from`,
  or `valid_to`, so historical truth cannot be reconstructed (`0001_init.sql:145-158`).
- Context Builder is told to load the active plan even though a task is bound to a
  specific `plan_id`; replanning can leak into old work.
- Summaries lack covered time range/source versions; embeddings lack source revision
  validity. “Latest N” can therefore expose future facts to a replayed task.
- `agents.prompt_version` is mutable agent state, not an immutable task assignment
  record.

## Dependencies and Confidence

The planned flow writes decision events, summaries, file-index revisions,
embeddings, and knowledge. It depends on ClickHouse, scheduler, agents, executor,
and embedding providers. Confidence is **high** on schema gaps and **medium-high**
on planned behavior.
