# Rule Enforcement and Auditing

## Current State

Versioned role prompts teach workspace, scope, test, question, reporting,
independence, and trust-boundary rules. Migration tests protect those prompt
markers. Runtime permission checks, transition guards, task-pinned rules, and
standards-auditor findings are not implemented.

## Flow

```mermaid
flowchart TD
    A["[PLANNED] Store versioned standards in knowledge<br/>docs/09-kod-standartlari.md:21"] --> B["[PLANNED] Load task, criteria, and standards<br/>docs/06-hafiza-ve-baglam.md:84"]
    B --> C["[PLANNED] Select worker and independent verifier<br/>docs/07-zamanlayici.md:30"]
    C --> D["[PLANNED] Expose only role-authorized tools<br/>docs/05-executor.md:28"]
    D --> E{"[PLANNED] Validate path, command, lock, schema<br/>docs/05-executor.md:53"}
    E -->|reject| F["[PLANNED] Return typed denial and record event<br/>docs/07-zamanlayici.md:61"]
    E -->|allow| G["[PLANNED] Execute tool and append call/result events<br/>docs/05-executor.md:19"]
    G --> H["[PLANNED] Worker reports result<br/>docs/03-agent-sistemi.md:94"]
    H --> I["[PLANNED] Give verifier criteria, rules, diff, summary only<br/>docs/03-agent-sistemi.md:96"]
    I --> J["[IMPLEMENTED PROMPT] Treat diff and summary as untrusted<br/>packages/db/migrations/0002_prompt_seed.sql:45"]
    J --> K{"[IMPLEMENTED TEMPLATE] APPROVE or REJECT<br/>packages/db/migrations/0002_prompt_seed.sql:53"}
    K -->|reject| L["[PLANNED] Retry or escalate<br/>docs/03-agent-sistemi.md:100"]
    K -->|approve| N["[PLANNED] Run build, lint, test gate<br/>docs/05-executor.md:87"]
    N --> O{"[PLANNED] Gate passed?<br/>docs/03-agent-sistemi.md:102"}
    O -->|no| L
    O -->|yes| P["[PLANNED] Close task with durable evidence<br/>docs/03-agent-sistemi.md:104"]
    P --> Q["[PLANNED] Trigger periodic standards audit<br/>docs/09-kod-standartlari.md:107"]
    Q --> R{"[PLANNED] Finding exists?<br/>docs/09-kod-standartlari.md:111"}
    R -->|yes| S["[PLANNED] Link finding to corrective task<br/>docs/08-panel.md:118"]
```

## Enforcement Gaps

- Prompt teaching is not a behavior guarantee. No deterministic role/tool/file
  permission matrix or central task-transition guard exists.
- Tasks do not pin acceptance criteria, prompt/rule/standard versions, or their
  hashes; retries and reassignments are not reproducible.
- Trust classification covers verifier diff/summary only, not inter-agent content,
  memory, tool results, task text, or standards.
- Verdicts and policy findings are untyped. No rule ID/version, severity, evidence,
  corrective task, resolution, or violation event is modeled.
- “Every task gets a verifier” and the verifier-free summarizer exception have no
  centralized precedence rule.
- Tests validate prompt text, not authorization, injection resistance, model
  independence, rule pinning, or finding-to-correction behavior.

## Dependencies and Confidence

Enforcement must be layered: Context Builder teaches the pinned rules; executor and
scheduler apply deterministic guards; verifier/auditor judge semantic compliance.
Confidence is **high**; runtime files for these planned components do not yet exist.
