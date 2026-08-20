# Provider and Model Execution

## Current State

Normalized messages/tool calls, adapters, timeout, fallback, pricing, usage writes,
mock execution, and encrypted key storage are implemented. Role-model resolution,
prompt construction, tool loops, durable protocol messages, health-aware routing,
budget enforcement, and failure requeue are not wired.

## Flow

```mermaid
flowchart TD
    A["[PLANNED] Select role model and independent verifier<br/>docs/03-agent-sistemi.md:89"] --> B["[PLANNED] Assemble prompt, task, rules, memory<br/>docs/06-hafiza-ve-baglam.md:73"]
    B --> C["[IMPLEMENTED TYPES] Submit normalized messages and tools<br/>packages/providers/src/types.ts:9"]
    C --> D["[IMPLEMENTED] Build primary and fallback chain<br/>packages/providers/src/router.ts:57"]
    D --> E{"[IMPLEMENTED] Provider registered?<br/>packages/providers/src/router.ts:62"}
    E -->|no| N["[IMPLEMENTED] Skip to next reference<br/>packages/providers/src/router.ts:61"]
    E -->|yes| F["[IMPLEMENTED] Invoke under timeout<br/>packages/providers/src/router.ts:66"]
    F --> G["[IMPLEMENTED] Translate and call provider SDK<br/>packages/providers/src/adapters/openai.ts:38"]
    G --> H["[IMPLEMENTED] Normalize text, tools, usage<br/>packages/providers/src/adapters/openai.ts:47"]
    H --> I["[IMPLEMENTED] Calculate cost and append api_usage<br/>packages/providers/src/router.ts:91"]
    I --> J["[IMPLEMENTED] Return result and actual model ref<br/>packages/providers/src/router.ts:72"]
    J --> K{"[IMPLEMENTED SHAPE] Tool calls returned?<br/>packages/providers/src/types.ts:38"}
    K -->|yes| L["[PLANNED] Validate capability and execute tool<br/>docs/05-executor.md:28"]
    L --> C
    K -->|no| M["[PLANNED] Persist report/verdict and transition task<br/>docs/03-agent-sistemi.md:94"]
    F -->|error| O["[IMPLEMENTED] Normalize provider error<br/>packages/providers/src/adapters/errors.ts:10"]
    O --> P["[IMPLEMENTED] Append failed usage attempt<br/>packages/providers/src/router.ts:74"]
    P --> Q{"[IMPLEMENTED] Retryable?<br/>packages/providers/src/types.ts:59"}
    Q -->|no| R["[IMPLEMENTED] Throw permanent error<br/>packages/providers/src/router.ts:84"]
    Q -->|yes| N
    N --> S{"[IMPLEMENTED] Fallback remains?<br/>packages/providers/src/router.ts:61"}
    S -->|yes| E
    S -->|no| T["[IMPLEMENTED] Throw last error<br/>packages/providers/src/router.ts:87"]
    T --> U["[PLANNED] Requeue or pause task<br/>docs/05-executor.md:117"]
```

## Gaps and Risks

- In-memory `ChatMessage` and durable agent `messages` are separate domains with no
  mapper. Completion metadata lacks message/correlation/rule-snapshot identity.
- `role_models` is stored but never resolved; verifier/provider diversity is not
  enforced.
- `Promise.race` timeout does not cancel the paid SDK request.
- Usage persistence is on the success critical path; a DB error can hide a paid
  completion and cause duplicate execution.
- Arbitrary tool names/arguments need deterministic schema and role authorization;
  malformed OpenAI arguments currently normalize to `{}`.
- Prompt-injection protection is verifier-specific, and key redaction is not wired
  to future trace/event persistence.

## Dependencies and Confidence

The path depends on external provider APIs, ClickHouse usage storage, key storage,
and the future agents/executor/memory/scheduler packages. Confidence is **high** on
the implementation boundary and missing wiring.
