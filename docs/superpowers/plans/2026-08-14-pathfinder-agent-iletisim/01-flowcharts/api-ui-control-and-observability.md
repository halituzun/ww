# API/UI Control and Observability

## Current State

Only `/health` and a health panel exist. Commands, direct answers, task/message
views, audit findings, WebSocket delivery, and replay are planned. The intended
durable-write → Redis notification → WebSocket → REST gap-fill path is coherent
but underspecified.

## Flow

```mermaid
flowchart TD
    I0["[IMPLEMENTED] Mount health shell<br/>apps/panel/src/App.tsx:3"] --> I1["[IMPLEMENTED] Start abortable health request<br/>apps/panel/src/viewmodels/useHealth.ts:13"]
    I1 --> I2["[IMPLEMENTED] GET /health with retry and timeout<br/>apps/panel/src/services/health.ts:32"]
    I2 --> I3["[IMPLEMENTED] Probe ClickHouse and Redis<br/>apps/server/src/health.service.ts:75"]
    I3 --> I4["[IMPLEMENTED] Render ready/degraded/unreachable<br/>apps/panel/src/viewmodels/useHealth.ts:32"]
    P0["[PLANNED] Submit PM command or direct answer<br/>docs/08-panel.md:105"] --> P1["[PLANNED] Append user_command or answer<br/>docs/03-agent-sistemi.md:155"]
    P1 --> P2["[PLANNED] Notify via Redis; agent rereads DB<br/>docs/03-agent-sistemi.md:155"]
    P2 --> P3{"[PLANNED] Small order or large replan?<br/>docs/03-agent-sistemi.md:166"}
    P3 --> P4["[PLANNED] Append task/plan version and event<br/>docs/03-agent-sistemi.md:84"]
    P4 --> P5["[PLANNED] Publish after durable write<br/>docs/01-mimari.md:171"]
    P5 --> P6["[PLANNED] Emit project event with opaque cursor<br/>docs/08-panel.md:137"]
    P6 --> P7{"[PLANNED] Reconnect/high-water mismatch?<br/>docs/08-panel.md:166"}
    P7 -->|no| P8["[PLANNED] Update chat, canvas, audit, notification<br/>docs/08-panel.md:53"]
    P7 -->|yes| P9["[PLANNED] Fetch events after opaque cursor<br/>docs/08-panel.md:168"]
    P9 --> P8
    P8 --> P10["[PLANNED] Replay task/message/escalation timeline<br/>docs/08-panel.md:65"]
    P10 --> P11["[PLANNED] Link audit finding to correction task<br/>docs/08-panel.md:118"]
```

## Contract Gaps

- Discovery found a global-sequence/project-filter conflict. Synthesis now defers
  the project-scoped replay cursor decision explicitly to Phase 3.
- WebSocket event names do not map one-to-one to persisted `EVENT_TYPES`, so raw
  REST replay may not reproduce live delivery.
- `publishEvent()` can publish without proving the durable append occurred first.
- Multiple questions in one session cannot be paired reliably without `reply_to`.
- No reconnect high-water mark, pagination, dedupe, out-of-order policy, or
  race-free subscribe/snapshot sequence is specified.
- Planned audit findings have no durable schema or correction-task linkage.
- Shared `WsEnvelope.event` is an unrestricted string and Redis JSON is cast
  without runtime validation (`packages/shared/src/types.ts:1-8`;
  `packages/db/src/redis.ts:152-180`).

## Required Decisions

Use an opaque per-project cursor, persist one canonical envelope for REST and WebSocket,
route publication through a single durable-first service, validate all boundaries,
and define snapshot + high-water mark + ordered replay semantics.

Confidence is **high** for current status and **medium** for planned runtime
behavior because the control-plane modules do not exist yet.
