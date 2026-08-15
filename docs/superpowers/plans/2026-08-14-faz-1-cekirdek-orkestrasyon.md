# Faz 1 — Çekirdek Orkestrasyon Implementation Plan

> **Execution:** Run this plan with `claude-mem:do`. Each phase is a standalone,
> reviewable unit. Commit and push only after its targeted build/test/lint gate is
> green. Do not mark Faz 1 complete until Phase 9 passes with integrations required.

**Goal:** Implement the complete Faz 1 roadmap slice: versioned and authenticated
agent communication, immutable task context, durable at-least-once delivery,
scheduler-owned task transitions and causal ordering, guarded executor/Git/gates,
worker-verifier-PM loops, minimal REST, and one deterministic MockProvider scenario.

**Authoritative scope:** `docs/11-yol-haritasi.md#faz-1`,
`docs/13-agent-iletisim-sozlesmesi.md`, GitHub #1 and #2. Later-phase memory search,
project journal/WebSocket replay, group leads, council, cloning, and periodic audit
remain out of scope.

**Architecture:** Keep dependencies acyclic:

```text
shared
  └── db
        ├── providers ─┐
        ├── memory ───┤
        └── executor ──┤
                       ├── agents
                       └── scheduler
all packages ── server composition root
```

This matches `docs/01-mimari.md`: scheduler imports only the narrow public
`AgentRunnerPort` from `agents`; `agents` never imports `scheduler` and submits shared
transition requests through an injected port. ClickHouse is durable truth; Redis
supplies leases, task-stream wakeups, and best-effort communication wakeups.

**Tech stack:** Node 22, TypeScript strict/NodeNext, pnpm 11, Vitest, ClickHouse JS
client, node-redis 5, Zod 4 for shared runtime contracts, Ajv 8 for executor-owned
JSON Schema, NestJS 11, MockProvider.

---

## Phase 0 — Documentation Discovery and Allowed APIs

### Sources read

- Repository rules: `AGENTS.md`, `CLAUDE.md`.
- Normative product docs: `docs/01-mimari.md`, `docs/02-clickhouse-semasi.md`,
  `docs/03-agent-sistemi.md`, `docs/04-model-katmani.md`, `docs/05-executor.md`,
  `docs/06-hafiza-ve-baglam.md`, `docs/07-zamanlayici.md`,
  `docs/09-kod-standartlari.md`, `docs/11-yol-haritasi.md`,
  `docs/13-agent-iletisim-sozlesmesi.md`.
- Pathfinder inventory, seven flowcharts, duplication report, unified proposal,
  and master handoff under `PATHFINDER-2026-08-14/`.
- Every current source/test in `packages/shared`, `packages/db`,
  `packages/providers`, and the Nest server composition files.
- Official APIs: [Zod schemas/discriminated unions](https://zod.dev/api),
  [ClickHouse JavaScript insert/query](https://clickhouse.com/docs/integrations/language-clients/js),
  [Redis XAUTOCLAIM](https://redis.io/docs/latest/commands/xautoclaim/),
  [Nest custom providers](https://docs.nestjs.com/fundamentals/custom-providers),
  and [Ajv 8 validation](https://ajv.js.org/guide/getting-started.html).

Three documentation-discovery agents independently inspected shared/agents,
DB/Redis, and providers/server/executor/scheduler boundaries. Reports agreed on
the API inventory and gaps below.

### Allowed existing APIs

- `@ww/db`: `createCh`, `latest`, `runMigrations`, `createRedis`, `queueKey`,
  `ensureGroup`, `enqueueTask`, `readQueue`, `ackQueue`, `acquireLock`,
  `releaseLock`, `publishEvent`, `subscribeEvents`.
- ClickHouse repository code may use `client.query(...)`, `client.insert(...)`, and
  `client.command(...)`; values use `query_params`, identifiers are code constants,
  inserts use `JSONEachRow` and are awaited.
- node-redis 5 provides `xAutoClaim(key, group, consumer, minIdleTime, start,
  { COUNT })`; the wrapper must expose a typed local API before scheduler use.
- `@ww/providers`: `ModelRouter.complete(modelRef, request)`, `MockProvider`,
  `chUsageSink`; the actual route is `RouteResult.usedRef`.
- Nest composition copies the symbol-token/`useValue` pattern from
  `apps/server/src/health.service.ts:18-34` and `app.module.ts:9-15`; controllers
  stay thin as in `health.controller.ts:5-12`.
- Tests copy temporary DB setup from `packages/db/src/latest.test.ts:8-23`,
  migration checks from `migrate.test.ts:27-107`, Redis fixtures from
  `redis.test.ts`, router sinks from `router.test.ts:9-18`, and Nest E2E setup from
  `apps/server/src/health.e2e.test.ts:17-38`.

### Locked implementation decisions

1. Add Zod as a direct `@ww/shared` dependency. Use strict objects,
   discriminated unions, `safeParse`, UUID and ISO datetime schemas. Never rely on
   the transitive SDK copy.
2. Add Ajv as a direct `@ww/executor` dependency. JSON files under
   `packages/executor/tools/` are the only tool-argument schema source; compile
   once and reuse validators.
3. Create only forward migration `0003_agent_communication.sql`. Every DDL statement
   is partial-retry-safe. Do not edit `0001` or `0002`.
4. Add current brief/attempt IDs to latest task rows. All mutable-state queries fold
   by version first and filter state second.
5. Serialize task/receipt allocation with fenced Redis leases. ClickHouse
   stores fence tokens and still validates deterministic IDs/collisions; Redis is
   never treated as durable truth.
6. An uncertain ClickHouse insert result enters reconcile mode. No new ordinal,
   task transition, model invocation, or external effect starts until the existing
   deterministic ID is observed or the operation escalates.
7. The local single-user server authenticates mutating requests with a bearer token
   from `WW_LOCAL_SESSION_TOKEN`; request bodies cannot choose sender identity.
   Scheduler agent calls use server-created opaque capabilities checked against the
   latest agent row.
8. Provider completion and usage attribution are separate durable effects. A usage
   sink failure after model success never triggers another model call; it creates a
   reconciliation finding for the same invocation.
9. `events.seq` remains a raw internal Phase 0 field with no global-order guarantee.
   Phase 1 does not add an event lease or expose a client cursor contract.
10. `communication_audit` remains an `AuditFinding` profile, not a new agent role.

### Global anti-pattern guard

Never use `FINAL`, mutable migrations, user-controlled SQL identifiers,
`JSON.parse(...) as Contract`, direct provider-adapter calls, shell command strings,
direct `.git` writes, destructive shared-worktree cleanup, free-form task-status
writes, session-only answer matching, unvalidated tool JSON, raw `publishEvent()`
from domain code, Redis delivery claims, or exactly-once language.

---

## Phase 1 — Shared Runtime Contracts and Package Scaffolds

### Files

- Modify: `packages/shared/package.json`, `packages/shared/src/constants.ts`,
  `packages/shared/src/types.ts`, `packages/shared/src/index.ts`, `pnpm-lock.yaml`
- Create: `packages/shared/src/communication.ts`, `task-contracts.ts`,
  `policy.ts`, `transitions.ts`
- Test: colocated `*.test.ts` for every new module
- Create package scaffolds: `packages/executor`, `packages/memory`, `packages/agents`,
  `packages/scheduler` (`package.json`, `tsconfig.json`, `vitest.config.ts`,
  `src/index.ts`)
- Modify: `turbo.json`

### Implement

- [x] Add `SYSTEM_SENTINEL`, receipt states, communication event types, stable rule
  IDs, payload provenance classes, and typed enums without duplicating string unions.
- [x] Define strict Zod schemas and inferred types for `PartyRefV1`, all ten
  `MessagePayloadV1` variants, `AgentMessageEnvelopeV1`, authenticated principal
  snapshot, and `SendMessageInputV1` (which has no sender role field).
- [x] Enforce envelope invariants in one `parseAgentMessageEnvelopeV1(unknown)`:
  protocol 1 only, `kind === payload.type`, reply requirement for `answer`, task
  references for report/verdict, deadlines after creation, and broadcast limits.
- [x] Define immutable schemas for `TaskBriefV1`, `AssignmentAttemptV1`,
  `TaskCausalCursorV1`, `PromptInputSnapshotV1`, and `TaskHandoffV1`.
- [x] Define `PolicyDecision`, `AuditFinding`, `TaskTransitionRequestV1`,
  `ToolCapabilityV1`, and structured verdict contracts.
- [x] Extend `ApiUsageRow` and provider metadata contract fields with invocation,
  brief, attempt, prompt snapshot, and fallback attempt.
- [x] Scaffold new packages by copying the package/TS/Vitest/barrel pattern from
  `packages/shared`; add explicit Turbo integration env passthrough and keep tests
  uncached where DB/Redis is used.

### Verification

- [x] Unknown protocol, unknown key, malformed UUID/time, kind mismatch, forged
  sender fields, missing reply target, and malformed verdict all fail closed.
- [x] Valid payload variants round-trip through canonical JSON with stable hashes.
- [x] `pnpm --filter @ww/shared build && pnpm --filter @ww/shared test &&
  pnpm --filter @ww/shared lint`.
- [x] Grep confirms no `as AgentMessageEnvelopeV1` boundary cast.

Evidence: shared 139 tests, providers 28 tests, root 234 tests total, integration-required zero skips, and three independent final reviews clean.

### Anti-patterns

Do not repurpose `WsEnvelope`, allow `.passthrough()`, infer authorization from
payload text, or add generic registries/policy DSLs.

---

## Phase 2 — Forward Migration and Durable Repositories

### Files

- Create: `packages/db/migrations/0003_agent_communication.sql`
- Create: `packages/db/src/repositories/{projects,plans,agents,messages,receipts,
  effects,tasks,briefs,causal-entries,events,artifacts,knowledge,audit-findings,
  prompts}.ts`
- Create: `packages/db/src/repositories/types.ts`, `identifiers.ts`
- Modify: `packages/db/src/index.ts`, `packages/db/src/migrate.test.ts`,
  `packages/db/src/testutil.ts`, `turbo.json`
- Test: colocated unit/integration tests for each repository family

### Persistence contract

- [x] Extend `tasks` with current `task_brief_id` and `assignment_attempt_id`.
- [x] Extend `messages` with protocol/payload versions, canonical payload/hash,
  reply/correlation/causation/idempotency, brief/attempt/invocation/snapshot,
  deadline/priority, authenticated principal snapshot, provenance, and actual model.
- [x] Create immutable `task_briefs`, `assignment_attempts`,
  `prompt_input_snapshots` (including exact `prompt_messages_json`), and
  `task_handoffs`.
- [x] Create `task_causal_entries` ordered by task/attempt/ordinal/entry ID with
  source type/ID, handoff, causation, and lease fence.
- [x] Create append-only `message_receipts` with recipient, monotonic receipt
  version, state, claim owner/fence/expiry, retry count, next attempt and error.
- [x] Create append-only `effect_ledger` keyed by causation + stable effect ID with
  request hash, replay safety, state, result/error and version.
- [x] Create versioned `audit_findings`; extend `api_usage` provenance fields.
- [x] Seed PM-direct `role.pm` v2 and `role.worker.coding` v2. Insert replacement
  rows that deactivate v1, then select active prompt only after folding versions.
- [x] Add explicit repositories. Every read parses persisted JSON with shared Zod
  schemas; an invalid stored record creates an error/finding rather than leaking.
- [x] Give project/plan/agent/task latest-state repositories explicit
  `create/getLatest/appendVersion` operations; artifacts/events are append-only and
  knowledge/prompt reads expose versioned as-of source manifests for brief sealing.
- [x] Message idempotency collisions compare the canonical envelope hash. Same key
  plus same hash returns the stored row; same key plus different hash fails closed.
- [x] Implement fold-then-filter inbox/receipt/finding queries. Do not pass external
  table/column names into generic `latest()`.
- [x] Make DB-package integration-required behavior fail when
  `WW_REQUIRE_INTEGRATION=1` and ClickHouse/Redis is unavailable.

### Verification

- [x] Empty DB migration, second-run no-op, checksum mismatch, and partially applied
  DDL retry pass.
- [x] Existing populated Phase 0 rows remain readable with legacy defaults.
- [x] All new tables/columns exist; prompt v1 folds inactive and exactly one v2 is
  active for PM/worker; marker text enforces direct PM routing.
- [x] Duplicate/collision, fold-then-filter, invalid stored payload, and exact prompt
  snapshot tests pass against ClickHouse.
- [x] `WW_REQUIRE_INTEGRATION=1 pnpm --filter @ww/db test` has zero skips.

Evidence: DB 20 files/108 tests/0 skip, root 325/0 skip, build/lint/diff clean, final verifier/anti/quality clean.

### Anti-patterns

No `UPDATE` for append-only history, no unique-constraint assumption, no mutable
status filter before latest fold, no migration transaction assumption, and no
semicolon-newline inside prompt SQL strings unless the migration splitter is first
made string-aware with regression tests.

---

## Phase 3 — Redis Recovery, Fenced Leases, and Durable-First Wakeups

### Files

- Modify: `packages/db/src/redis.ts`, `packages/db/src/redis.test.ts`
- Create: `packages/db/src/redis-leases.ts`, `redis-wakeup.ts`
- Modify: `packages/db/src/index.ts`

### Implement

- [x] Add `reclaimQueue(...)` over node-redis `xAutoClaim`, returning next cursor,
  claimed task IDs, delivery count inputs, and deleted IDs; never use `JUSTID` when
  retry count/evidence is required.
- [x] Add fenced lease helpers with atomic Lua acquire/renew/release. Owner + fence
  must match; stale owners cannot renew or release.
- [x] Add heartbeat set/check helpers and task/message/receipt lock-key builders.
- [x] Add `CommunicationWakeupPublisher` that publishes only message ID, recipient,
  and project after repository success. Consumers always reload canonical DB data.
- [x] Preserve unconditional `destroy()` cleanup for ephemeral/pub-sub clients.

### Verification

- [x] Live Redis tests cover new delivery, pending reclaim after idle threshold,
  cursor continuation, deleted stream IDs, bounded retries, lease fencing/renewal,
  stale release, heartbeat expiry, and wakeup loss.
- [x] Test crash point: durable row exists, publish is skipped, poll still finds it.
- [x] `WW_REQUIRE_INTEGRATION=1 pnpm --filter @ww/db test`.

Evidence: focused Redis 62 tests; DB 22 files/160 tests/0 skip; root build/lint 9/9, required 46 files/377 tests/0 skip; verifier/anti/quality clean.

### Anti-patterns

Do not ACK the task stream before durable assignment, do not treat pub/sub as ACK,
do not use `quit()` for ephemeral cleanup, and do not add an outbox/exactly-once claim.

---

## Phase 4 — Scheduler State, Brief Sealing, Causal Log, and Recovery

### Files

- Create: `packages/scheduler/src/task-transition-service.ts`,
  `task-causal-log.ts`, `task-brief-service.ts`, `assignment-service.ts`,
  `scheduler-worker.ts`, `ports.ts`, `errors.ts`
- Create: `packages/memory/src/task-context-snapshot-builder.ts`, `ports.ts`
- Modify: `packages/scheduler/src/index.ts`, package manifest
- Test: unit plus ClickHouse/Redis integration tests

### Public APIs

```ts
TaskTransitionService.apply(
  principal: AuthenticatedPrincipalV1,
  request: TaskTransitionRequestV1,
): Promise<TaskStateV1>

TaskCausalLog.append(input: AppendTaskCausalEntryInput): Promise<TaskCausalCursorV1>
TaskBriefService.seal(input: SealTaskBriefInput): Promise<TaskBriefV1>
AssignmentService.assign(taskId: string): Promise<AssignmentAttemptV1>
SchedulerWorker.runOnce(projectId: string, consumerId: string): Promise<RunOnceResult>
```

### Implement

- [x] Encode the exact FSM from `docs/03-agent-sistemi.md:62-85` as one pure
  transition table. `user_answered` returns `waiting_user` to non-executable
  `escalated`; only a fresh attempt with reacquired agents/file locks may reach
  `working` through `escalation_resolved`. Stable `TASK-*` rules return
  `PolicyDecision` on allow/deny.
- [x] Transition under a fenced task lease: read latest task, validate principal,
  brief, attempt and from-state, append next task version and durable outcome event,
  then release. Messages only submit requests.
- [x] Derive a deterministic transition ID and request hash from causation. A replay
  with the same hash returns its stored result; an ID/hash collision fails closed.
- [x] Seal `TaskBriefV1` from task-bound plan/prompt/rule/standard sources and
  `baseContextCutoffAt`; `@ww/memory` owns as-of source selection and returns a
  manifest through `TaskContextSnapshotPort`. Retry reuses it; explicit rebase
  creates a new version.
- [x] Assign one active attempt only, select an idle worker and independent verifier,
  acquire all target-file locks in sorted order, persist attempt/current task state,
  then ACK queue. Roll back acquired locks on partial failure.
- [x] Implement `TaskCausalLog.append`: under current task fence, first find
  deterministic entry ID; otherwise reconcile uncertain prior insert, fold
  `max(ordinal)+1`, append synchronously, reread, and reject ordinal collision.
- [x] Handoff seals ancestor cursor, records evidence/checkpoints and released locks;
  the new attempt begins ordinal zero and reacquires locks.
- [x] Scheduler `runOnce` consumes new entries then `XAUTOCLAIM`s expired pending
  entries. Restart never invents another active attempt.
- [x] Every rejection/correction run creates a new immutable assignment attempt with
  `previousAttemptId`; same-owner retry does not require a handoff but does seal the
  prior cursor and restart ordinal at zero.

### Verification

- [x] Pure tests cover every allowed edge and all illegal FSM edges; integration
  covers `waiting_user → user_answered → escalated → fresh attempt/resources → working`
  with crash/replay and rejects reuse of the released old attempt.
- [x] Integration tests cover ACK timing, dependency blocking, deterministic agent
  selection, file-lock rollback, one-active-attempt, restart/reclaim, stale fence,
  transition replay/hash collision, rebase, same-owner retry, handoff, ordinal
  restart/dedupe/collision and uncertain insert.
- [x] `pnpm --filter @ww/scheduler build && WW_REQUIRE_INTEGRATION=1
  pnpm --filter @ww/scheduler test && pnpm --filter @ww/scheduler lint`.

**Evidence:** DB 23 files / 194 tests / 0 skipped; scheduler 6 files / 55 tests /
0 skipped (39 live); memory 2 files / 4 tests / 0 skipped; uncached root build
9/9 tasks, required test 12/12 tasks / 468 tests / 0 skipped, lint 9/9 tasks;
independent verifier, anti-pattern, and quality reviews: CLEAN.

### Anti-patterns

No `agents` import, no direct model calls, no status writes outside the transition
service, no parallel Phase 1 attempt merge, and no destructive workspace recovery.

---

## Phase 5 — Communication Service, Routing, Receipts, and Effect Ledger

### Files

- Create: `packages/agents/src/communication-service.ts`, `communication-policy.ts`,
  `principal-resolver.ts`, `inbox-worker.ts`, `effect-runner.ts`, `ports.ts`,
  `errors.ts`
- Modify: `packages/agents/src/index.ts`, package manifest
- Test: pure authorization tests plus DB/Redis integration tests

### Public APIs

```ts
CommunicationService.send(
  auth: PrincipalAuthentication,
  input: SendMessageInputV1,
): Promise<AgentMessageEnvelopeV1>

CommunicationService.pollInbox(recipient: PartyRefV1, limit?: number): Promise<InboxItemV1[]>
InboxWorker.processNext(recipient: PartyRefV1, consumerId: string): Promise<ProcessResult>
InboxWorker.drainOnce(consumerId: string): Promise<DrainResult>
EffectRunner.run<T>(input: DurableEffectInput<T>): Promise<T>
```

### Implement

- [ ] Resolve user from local authenticated session, agent from opaque capability +
  latest agent record, and allowlisted internal service from code-owned token.
  `BROADCAST_SENTINEL` is recipient-only.
- [ ] Implement the exact Phase 1 route matrix from `docs/13:133-149`; group-lead
  and council routes fail closed until Phase 4.
- [ ] `send`: validate input, derive principal snapshot, authorize route/deadline/
  current brief and task state, assign deterministic IDs, insert canonical message
  and recipient-snapshot receipts, then attempt Redis wakeup. Persist rejection
  policy/event without storing an authorized message.
- [ ] `pollInbox` folds receipts before filtering; `claim` writes lease/fence;
  temporary failure appends retry/backoff; expired claims reclaim; max retries append
  failed + typed escalation.
- [ ] Processed is appended only after all transition/effect records are durable.
- [ ] Match answers by `replyToMessageId` to exactly one pending question with the
  same session/task/brief; session ID alone never resumes work.
- [ ] `EffectRunner` folds by causation + stable effect ID. Completed returns stored
  result; replay-safe uncertain work retries with the same external idempotency key;
  non-replay-safe uncertain work escalates.
- [ ] Handlers parse stored envelopes again and map report/verdict/answer to the
  injected `TaskTransitionPort`; they never import scheduler implementation.
- [ ] `drainOnce` scans durable due receipts even without a Redis wakeup. The server
  owns a bounded poll loop with abort-aware start/stop; wakeups only accelerate it.

### Verification

- [ ] Matrix tests cover every sender/recipient/kind row plus forged principals,
  stale brief, deadline, broadcast snapshot, user-answer mismatch, worker verdict,
  and Phase 4 routes.
- [ ] Integration tests cover duplicate send, idempotency hash collision, lost
  wakeup, concurrent claim, claim expiry, backoff, terminal escalation, crash
  between effect and receipt, and non-idempotent escalation.
- [ ] Prompt injection strings in every provenance class remain data and gain no
  route, transition, or tool authority.

### Anti-patterns

No public repository bypass, sender role in request body, session-only correlation,
direct task mutation, arbitrary effect callback without ledger metadata, or model
output as authorization.

---

## Phase 6 — Guarded Executor, Gate, and Git

### Files

- Create JSON schemas: `packages/executor/tools/{read_file,write_file,edit_file,
  run_command,git_diff,ask_question,report_result,submit_verdict}.json`
- Create: `packages/executor/src/tool-registry.ts`, `tool-executor.ts`,
  `workspace-paths.ts`, `command-runner.ts`, `gate-runner.ts`, `git-workspace.ts`,
  `capability-policy.ts`, `ports.ts`, `errors.ts`
- Create: `packages/executor/templates/web/ww.gate.json`
- Create a complete web starter under `packages/executor/templates/web/` with
  `package.json`, lockfile, TS/ESLint/Vitest/Vite configs, and initial source/test
- Modify: package manifest/index
- Test: colocated unit/integration tests using temporary directories and Git repos

### Implement

- [ ] Load schemas once, compile Ajv validators once, and expose the same schema
  objects as provider `ToolDef.parameters`.
- [ ] Resolve paths relative to the task workspace. Reject absolute paths, `..`,
  `.git`, null bytes, symlink escapes, undeclared targets, and missing lock/fence.
- [ ] Implement atomic writes via sibling temporary file + rename; preserve unrelated
  user changes and never run broad cleanup.
- [ ] Execute allowlisted binaries with argument arrays and `shell: false`; enforce
  deadline, output cap, process-tree termination, concurrency and brief capability.
- [ ] Parse `ww.gate.json`, run gates in declared order, and return typed evidence.
- [ ] Git diff/commit use the same command runner; commit only after successful gate
  with `task(<short-id>): <title>`, then return the actual hash.
- [ ] `ask_question`, `report_result`, and `submit_verdict` call narrow communication
  ports; they do not write DB/task state themselves.
- [ ] Materialize the packaged starter into an empty workspace, install with frozen
  lockfile, initialize Git, and prove its declared gate passes before agent edits.

### Verification

- [ ] Tests cover path traversal, symlink escape, `.git`, scope/lock failures,
  injection-shaped args, timeout, output truncation, process cleanup, gate order,
  gate failure, dirty unrelated file preservation, no commit before gate, and hash.
- [ ] `pnpm --filter @ww/executor build && pnpm --filter @ww/executor test &&
  pnpm --filter @ww/executor lint`.

### Anti-patterns

No shell interpolation, command string, direct `exec`, direct filesystem tools from
agents, duplicate TypeScript tool schema, `git checkout .`, or `git clean -fd`.

---

## Phase 7 — Provider Attribution and Minimal Temporal Context

### Files

- Modify: `packages/providers/src/types.ts`, `router.ts`, `router.test.ts`,
  `usage.ts`
- Modify: `packages/shared/src/types.ts`
- Create: `packages/agents/src/prompt-input-service.ts`
- Test: provider, existing memory-context builder, and agent prompt-input tests

### Implement

- [ ] Require invocation, brief, attempt and prompt-snapshot IDs for agent completion;
  preserve optional fields only for health checks.
- [ ] Record fallback index on every attempt and the same invocation ID throughout;
  return/store actual `usedRef` in result messages.
- [ ] Separate provider result from usage-write reconciliation so a successful paid
  call is never automatically repeated after a sink error.
- [ ] Run each provider invocation through the durable effect ledger with
  `started/completed/uncertain` states. A completed replay returns the stored result;
  an uncertain non-idempotent provider call escalates instead of calling again.
- [ ] Build Phase 1 context from the brief-pinned plan/prompt/rules/standards at
  `baseContextCutoffAt`, plus only ancestor-bounded task causal entries at the input
  cursor. Keep this builder in `@ww/memory`; no semantic similarity search.
- [ ] Seal exact provider messages, source-version manifest, causal high-water and
  prompt hash before each call. Replay loads that immutable snapshot exactly.

### Verification

- [ ] Primary/fallback/error tests assert invocation identity, fallback order,
  `usedRef`, and usage rows.
- [ ] Usage-sink-after-success failure produces one model call and a reconciliation
  finding.
- [ ] Temporal tests exclude future plan/prompt/rule/summary/knowledge rows, include
  allowed rejection/gate/answer/escalation, and prove replay ignores later feedback.

### Anti-patterns

No adapter calls from agents, mutable active-plan lookup, semantic Phase 2 memory,
prompt reconstruction on replay, or new model call after attribution-only failure.

---

## Phase 8 — Worker, Verifier, PM Loops and Phase 1 Orchestrator

### Files

- Create: `packages/agents/src/worker-loop.ts`, `verifier-loop.ts`, `pm-loop.ts`,
  `agent-runtime.ts`, `prompt-loader.ts`
- Create: `packages/scheduler/src/phase1-orchestrator.ts`
- Modify: agents/scheduler manifests and indexes
- Test: deterministic MockProvider unit/integration scenarios

### Implement

- [ ] Worker loop receives immutable brief/snapshot, calls only `ModelRouter`, and
  calls it only through the invocation effect boundary, then executes only validated
  executor tool calls. It exits only on question/report,
  deadline/budget, or bounded loop failure.
- [ ] Verifier receives task/criteria/standards/diff/summary, never worker reasoning;
  it must call `submit_verdict` with the strict schema. Free text cannot transition.
- [ ] PM handles user commands and direct worker questions only. No council, group
  lead, professor, clone or replan protocol in Phase 1.
- [ ] Orchestrator connects scheduler ports to agent runtime without a package import
  cycle and follows assign → work/question → answer → report → verify/reject →
  correction → gate → approve → commit/artifact → done.
- [ ] Enforce max attempts: third persistent rejection becomes `escalated`.

### Verification

- [ ] Mock tests cover question/resume, one rejection/correction, verifier
  independence, malformed/forged verdict, tool injection, gate failure, attempt
  limit, provider fallback and clean terminal state.
- [ ] Agents and scheduler targeted build/test/lint pass with live DB/Redis.

### Anti-patterns

No worker self-approval, verifier access to hidden reasoning, unlimited tool loop,
free-form verdict parser, Phase 4 hierarchy, or direct repository/task writes.

---

## Phase 9 — Minimal REST, End-to-End Gate, Docs, and Release Hygiene

### Files

- Create: `apps/server/src/auth/local-session.ts`, `orchestration.module.ts`,
  `projects.controller.ts`, `tasks.controller.ts`, `messages.controller.ts`,
  application services, inbox lifecycle provider, and E2E tests
- Modify: `apps/server/src/app.module.ts`, `main.ts`, `package.json`, `turbo.json`
- Modify: `apps/server/.env.example` and Turbo server test/dev env passthrough for
  `WW_LOCAL_SESSION_TOKEN`; tests inject a non-secret fixture token
- Create/update: `ww.gate.json`, relevant `docs/*.md`, README command examples
- Test: full server/MockProvider E2E and restart scenario

### REST contract

- [ ] `POST /projects` creates a project.
- [ ] `POST /projects/:projectId/tasks` creates/enqueues a task with criteria,
  dependencies, files and budget.
- [ ] `GET /projects/:projectId` and `GET /projects/:projectId/tasks/:taskId` return
  latest projections.
- [ ] `POST /projects/:projectId/messages` accepts user command/answer input but
  derives the user principal from the bearer session.
- [ ] Mutating endpoints reject absent/invalid local session; DTOs use shared runtime
  parsers. Controllers call application services only.

### End-to-end scenario

- [ ] Start from a fresh temporary DB and Git workspace.
- [ ] Seed an approved plan plus PM, worker, and independent verifier records with
  deterministic model refs; bind all three tasks to that plan before enqueue.
- [ ] Create project and three tasks, one dependency-gated.
- [ ] Mock worker asks a question; authenticated user answers exact message.
- [ ] Worker writes a file and reports; independent verifier rejects once.
- [ ] Worker corrects; verifier approves; tsc/eslint/vitest gate passes.
- [ ] Commit is created and hash persists with artifacts/task/event records.
- [ ] Stop after a durable completed effect but before receipt, restart services, and
  prove no duplicate effect/commit/invocation; separately stop after an uncertain
  provider call and prove typed escalation without replay. Lost Redis wakeup is
  recovered from the bounded DB poll loop. This is service
  re-instantiation recovery only; the Phase 2 process sweeper/working-tree recovery
  remains out of scope.
- [ ] Separate always-reject scenario escalates on attempt 3.

### Final verification

- [ ] `docker compose up -d` and both services healthy.
- [ ] `pnpm build` — every workspace passes.
- [ ] `WW_REQUIRE_INTEGRATION=1 pnpm test` — zero skips.
- [ ] `pnpm lint` — every workspace passes.
- [ ] `git diff --check`; secret scan; no forbidden deep imports/boundary casts/
  direct publish/provider/status writes.
- [ ] From a non-destructive temporary `git worktree`, run `pnpm install
  --frozen-lockfile`, clear generated outputs, and repeat the full gate to prove the
  clean-checkout claim.
- [ ] Update roadmap/docs only to reflect behavior actually delivered. Keep Faz 1
  incomplete if any documented scenario is absent.
- [ ] Independent review reports no P0-P2 findings.
- [ ] Commit each green phase with scoped Conventional Commits, push the branch,
  update PR #3 and issues #1/#2 with exact test evidence, then save `/context-save`.

### Anti-patterns

No public cursor/WebSocket implementation, no UI feature pull-in, no skipped live
integration test, no screenshot claim without UI change, no force-push, and no issue
closure before the full acceptance scenario passes.

---

## Faz 1 Definition of Done

Faz 1 is complete only when every Phase 9 scenario passes from a clean checkout
with ClickHouse and Redis running, all runtime boundaries fail closed, the commit/
receipt/effect/audit trail is queryable, the branch is pushed, and documentation
matches the delivered behavior. A green unit suite without the integration-enabled
MockProvider scenario is not completion.

## What already exists

- `@ww/db` already owns ClickHouse creation/migrations, latest-row reads, Redis
  queue primitives, bounded client cleanup, and integration fixtures. Faz 1 extends
  these APIs through explicit repositories and recovery helpers instead of creating
  a parallel persistence layer.
- `@ww/providers` already owns provider adapters, `ModelRouter`, deterministic
  `MockProvider`, fallback routing, and the ClickHouse usage sink. Agent loops reuse
  only `ModelRouter` and its actual `usedRef`.
- `@ww/shared` already owns stable vocabulary and public package exports. Versioned
  runtime contracts extend this package; `WsEnvelope` remains a separate panel event
  shape.
- The Nest server already demonstrates symbol-token injection, thin controllers,
  migration-first startup, Supertest E2E setup, and strict env parsers.

## NOT in scope

- Semantic retrieval, embeddings, summarization, `memory_query`, and full Context
  Builder token budgeting remain Faz 2; Faz 1 adds only the minimum immutable
  temporal snapshot builder under `@ww/memory`.
- Startup sweepers, abandoned working-tree cleanup, and full process-crash recovery
  remain Faz 2. Faz 1 proves service re-instantiation and durable effect replay.
- Public event cursors, WebSocket replay, and panel orchestration UI remain Faz 3.
- Group leads, council, professors, cloning, parallel attempts, delegation, and
  communication-auditor scheduling remain Faz 4.
- Package publication is not required: all new packages are private workspace
  libraries built and consumed by the monorepo.

## Test Coverage Map

```text
HTTP mutation [->E2E]
  |-- missing/invalid bearer -> 401, no durable write
  `-- valid DTO -> shared parser -> application service
        |-- create project/task -> CH durable row -> Redis wakeup
        `-- send answer -> principal resolver -> route guard
              |-- forged/stale/deadline mismatch -> finding, no effect
              `-- canonical message -> recipient receipt -> best-effort wakeup

Scheduler run [->E2E]
  |-- new stream item / reclaimed pending item
  |-- dependency/lease/file-lock denial -> durable defer, no ACK
  `-- assignment durable -> ACK -> agent runtime
        |-- question -> exact replyTo -> resume
        `-- report -> verifier reject/correct/approve
              `-- ordered gate -> commit -> artifact -> done

Crash boundaries [->E2E]
  |-- CH write succeeded / response unknown -> reconcile same deterministic ID
  |-- durable row / Redis publish lost -> DB poll recovers
  |-- effect completed / receipt not processed -> ledger returns stored result
  `-- usage sink failed / model succeeded -> finding, never repeat model call

Pure contracts [unit]
  |-- every message/payload variant and unknown-key rejection
  |-- every route/FSM edge, receipt/effect transition, and capability rule
  `-- canonical JSON/hash, cursor/ordinal, handoff, and temporal cutoff boundaries
```

Every branch above needs happy, invalid, timeout/retry, duplicate, and terminal-error
coverage. Prompt/tool changes also get deterministic MockProvider eval cases for
question routing, strict verdicts, injection resistance, and fallback attribution.

## Production Failure Matrix

| Path | Realistic failure | Required behavior and evidence |
|------|-------------------|--------------------------------|
| Contract boundary | Unknown key/version or forged sender | Fail closed; parser/policy unit test; 4xx or typed rejection |
| ClickHouse append | Timeout after server accepted insert | Reconcile deterministic ID/hash before any new ordinal/effect; integration test |
| Redis wakeup | Publish lost or Redis restarted | Canonical DB poll/reclaim continues; integration test; no silent loss |
| Receipt worker | Process dies after effect | Ledger returns stored result, receipt advances once; restart E2E |
| Scheduler lease | TTL expires and stale owner resumes | Fence rejects stale write/release; live Redis race test |
| Provider usage | Paid call succeeds but sink fails | One model call, reconciliation finding, explicit degraded result |
| Executor | Path escape, hung process, oversized output | Reject/kill/truncate with durable evidence and actionable tool error |
| Git/gate | Gate fails or unrelated files are dirty | No commit; unrelated changes preserved; integration test |

No listed failure may be both silent and untested.

## Parallelization Strategy

| Lane | Modules | Depends on |
|------|---------|------------|
| A | `packages/shared`, package scaffolds | - |
| B | `packages/db` migration/repositories/Redis | A |
| C | `packages/executor` | A, fenced DB/Redis ports from B |
| D | `packages/memory`, `packages/providers` | A, snapshot repository from B |
| E | `packages/scheduler` | A, B, executor ports |
| F | `packages/agents` | A-D, scheduler transition port contract |
| G | `apps/server`, docs, E2E | B-F |

After A, independent package work may run in parallel only when agents have exclusive
directory ownership. B's public repository/lease contracts land before C-F compile;
E and F may then proceed in parallel because neither imports the other's
implementation. G is sequential integration. Root manifests, lockfile, Turbo config,
and shared barrel exports have a single owner to avoid merge conflicts.

## Implementation Tasks

- [ ] **T1 (P1, human: ~1d / CC: ~45min)** - shared - Implement strict versioned
  contracts and package scaffolds.
  - Surfaced by: Architecture - runtime input currently has no trusted parser.
  - Files: `packages/shared`, new package manifests, `turbo.json`
  - Verify: shared build/test/lint and boundary-cast grep.
- [ ] **T2 (P1, human: ~3d / CC: ~2h)** - db - Add forward migration, explicit
  repositories, deterministic reconciliation, receipts/effects, and fenced leases.
  - Surfaced by: Architecture/Performance - Redis cannot be truth and ClickHouse has
    no cross-system transaction or uniqueness guarantee.
  - Files: `packages/db`
  - Verify: integration-required DB suite with zero skips.
- [ ] **T3 (P1, human: ~2d / CC: ~90min)** - scheduler/executor - Implement the
  single-writer FSM, causal ordering, guarded tools, gates, and Git.
  - Surfaced by: Code quality - status/effects need one explicit authority boundary.
  - Files: `packages/scheduler`, `packages/executor`
  - Verify: targeted unit/integration suites and temporary-repo tests.
- [ ] **T4 (P1, human: ~2d / CC: ~90min)** - agents/memory/providers - Implement
  authenticated communication, temporal snapshots, attribution, and bounded loops.
  - Surfaced by: Architecture - context ownership and provider-success reconciliation.
  - Files: `packages/agents`, `packages/memory`, `packages/providers`
  - Verify: policy matrix, prompt evals, fallback, replay, and injection tests.
- [ ] **T5 (P1, human: ~2d / CC: ~60min)** - server/E2E - Compose REST and execute
  the complete deterministic acceptance/restart scenarios.
  - Surfaced by: Test review - package tests alone cannot prove cross-service behavior.
  - Files: `apps/server`, `ww.gate.json`, docs
  - Verify: full build, integration-required test, lint, diff/secret/boundary scans.

## Engineering Review Summary

- Step 0: full Faz 1 scope accepted as-is; execution split into reversible vertical
  slices rather than reducing the documented outcome.
- Architecture review: 8 issues found and folded, including repository completeness,
  package direction, memory ownership, replay identity, and inbox lifecycle.
- Code quality review: 1 issue found and folded: same-owner rejection retry now creates
  an explicit immutable attempt instead of mutating the current attempt.
- Test review: coverage diagram produced; 2 gaps folded: complete starter fixture and
  non-destructive clean-checkout verification.
- Performance review: no unresolved issue; DB scans are bounded/folded, schemas compile
  once, inbox processing is batch-bounded, and event ordering adds no Redis dependency.
- Failure modes: 0 critical gaps remain after the provider-uncertainty, transition
  replay, lost-wakeup, and stale-fence cases were added.
- Outside voice: Codex CLI returned no final message; the required fallback reviewer
  found 11 issues. All were verified against repository docs and absorbed.
- Parallelization: 7 dependency lanes; C/D can run after B, then E/F can run in
  parallel with exclusive module ownership; G is sequential integration.
- Lake score: 11/11 recommendations chose the complete option.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | not run | Full scope already fixed by roadmap and user direction |
| Codex Review | `/codex review` | Independent 2nd opinion | 1 | absorbed | Fallback outside voice found 11 issues; 11/11 folded |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | 11 issues, 0 critical gaps, 0 unresolved |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | not required | Backend/contract phase; no new UI |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | not run | Clean-checkout and env gates included here |

**CROSS-MODEL:** Both reviews agreed on explicit package ownership, durable replay
identities, complete repository surfaces, lifecycle wiring, and clean-checkout proof.

**VERDICT:** ENG CLEARED - ready to implement with `claude-mem:do`.

NO UNRESOLVED DECISIONS
