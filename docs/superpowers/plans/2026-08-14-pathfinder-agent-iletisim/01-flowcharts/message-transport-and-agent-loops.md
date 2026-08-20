# Message Transport and Agent Loops

## Current State

Shared message kinds, sentinel identities, the append-only `messages` table,
generic Redis pub/sub, and role prompts exist. No `packages/agents`, message
service, durable inbox consumer, reply resolver, or PM/worker/verifier runtime
exists.

## Flow

```mermaid
flowchart TD
    A["[PLANNED] Scheduler assigns worker and verifier<br/>docs/03-agent-sistemi.md:89"] --> B["[PLANNED] Context Builder creates worker prompt<br/>docs/03-agent-sistemi.md:92"]
    B --> C["[PLANNED] Worker runs executor tool loop<br/>docs/03-agent-sistemi.md:94"]
    C --> D["[PLANNED] report_result moves task to verifying<br/>docs/05-executor.md:50"]
    D --> E["[PLANNED] Verifier inspects untrusted evidence<br/>docs/03-agent-sistemi.md:96"]
    E --> F{"[PLANNED] Verdict<br/>docs/03-agent-sistemi.md:98"}
    F -->|approve| G["[PLANNED] Run gate and close task<br/>docs/03-agent-sistemi.md:102"]
    F -->|reject| H["[PLANNED] Return reason to worker<br/>docs/03-agent-sistemi.md:100"]
    H --> C
    F -->|attempt limit| I["[PLANNED] Escalate through phase-specific role chain<br/>docs/03-agent-sistemi.md:171"]
    C --> Q["[PLANNED] Worker asks a question<br/>docs/05-executor.md:49"]
    Q --> M["[IMPLEMENTED SCHEMA] Append message row<br/>packages/db/migrations/0001_init.sql:86"]
    M --> N["[IMPLEMENTED PRIMITIVE] Publish ww:events notification<br/>packages/db/src/redis.ts:152"]
    N --> O["[PLANNED] Recipient reloads message from ClickHouse<br/>docs/03-agent-sistemi.md:155"]
    O --> P["[PLANNED] Correlate answer to one question<br/>docs/03-agent-sistemi.md:164"]
    P --> C
    U["[PLANNED] Panel submits user_command<br/>docs/03-agent-sistemi.md:166"] --> M
```

## Gaps and Failure Paths

- `session_id` cannot unambiguously pair multiple concurrent questions and
  answers; `reply_to`, correlation, and causation identifiers are absent.
- There is no inbox cursor, delivery receipt, ACK/replay policy, dedupe key,
  deadline, or role-based authorization matrix.
- At-least-once task recovery can duplicate agent messages or side effects because
  message idempotency is undefined.
- `content` and verifier verdicts have no discriminated runtime schema. Redis
  subscribers parse JSON without protocol validation.
- Language, routing, and sender/recipient rules exist only in prompts.
- Documentation mentions `message.created`, but `EVENT_TYPES` has no matching
  vocabulary (`packages/shared/src/constants.ts:24-28`).

## Dependencies and Confidence

The planned path depends on ClickHouse, Redis, scheduler, Context Builder,
provider router, executor, server, and panel. Confidence is **high** about the
missing runtime and **medium-high** about intended semantics.
