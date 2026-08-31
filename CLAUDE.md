# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Read First

`AGENTS.md` is the full repo guide (Turkish): stack, directory layout, dependency
direction, code style, env vars, commit rules. Read it before touching code — this
file only adds what it does not cover: the cross-file architecture, the traps this
repo has repeatedly fallen into, and the current live state.

Then, as the task demands: `docs/00-genel-bakis.md` (vision), `docs/01-mimari.md`
(architecture), `docs/11-yol-haritasi.md` (phases + acceptance evidence),
`docs/12-agent-devir-ve-hafiza.md` (cross-session handoff protocol).
Product-agent work must also read `docs/13-agent-iletisim-sozlesmesi.md`
(normative communication contract).

**Documentation and code comments are written in Turkish.** Code identifiers are
English. Panel UI strings are Turkish.

## Commands

```bash
pnpm install
docker compose up -d               # ClickHouse :8124, Redis :6380 (deliberately non-standard ports)
pnpm dev                           # all packages in watch mode; API :4000, panel :5173
pnpm gate                          # THE gate — see below
```

Targeted work:

```bash
pnpm --filter @ww/providers test                    # one package
pnpm --filter @ww/shared test src/json.test.ts      # one file (args pass through to vitest)
pnpm --filter @ww/db test -t "prunes primary key"   # one case
pnpm --filter @ww/panel build                       # tsc + vite build
WW_REQUIRE_INTEGRATION=1 pnpm test                  # turn silent integration skips into failures
pnpm --filter @ww/executor runtime:build            # build the sandbox image, then:
pnpm --filter @ww/executor test:live                # 4 live Docker sandbox tests (skipped by plain `pnpm test`)
pnpm db:clean-tests                                 # drop leaked ww_test_* DBs and Redis keys
```

**Always run the gate as ONE command chained to the commit:**
`pnpm gate && git commit ... && git push`. `scripts/gate.sh` runs clean → build →
integration tests → lint → `wiring:check` → öz-denetim, and exits non-zero on any
failure. Running the steps separately once let a push happen on a red gate; the
shell, not intent, enforces the rule.

Running the live task loop (the engine only picks up `status=running` projects):

```bash
set -a; source .env; set +a          # keystore path and keys resolve relative to cwd/env
WW_PHASE8_RUNTIME_ENABLED=1 WW_RUNTIME_PROJECT_ID=<uuid> node apps/server/dist/main.js
```

## Architecture: the parts you cannot see from one file

**Everything flows through ClickHouse.** Plans, tasks, messages, every tool call,
every decision is a row. Redis is only a speed buffer (queue, lease, heartbeat,
wakeup) — losing Redis is not data loss, and `RecoveryService` rebuilds queue state
from the durable tables at boot. Write order is **always ClickHouse first, then Redis.**

**Tables are append-only and versioned.** There is no UPDATE. A change appends a
row with a higher `version`; reads go through `latest()` in `packages/db/src/latest.ts`
(`ORDER BY version DESC LIMIT 1 BY <id>`), never `FINAL`. Schema lives in
`packages/db/migrations/*.sql` (checksummed, applied at server boot by `migrate.ts`)
— ~37 tables including `projects`, `plans`, `tasks`, `agents`, `messages`,
`api_usage`, `artifacts`, `file_index`, `events`, `audit_findings`, `knowledge`.

**The task loop**, end to end, spans four packages and is easy to misread from any
one of them:

1. A project is created → interview/wizard → **council**: 3-4 models debate and
   produce a plan (`packages/agents` council-service, `apps/server/council.*`).
   With fewer than 3 providers the council writes a warning into every plan.
2. The plan approval produces tasks (`packages/scheduler` plan-approval,
   assignment-service) which land in a Redis stream queue.
3. `TaskPumpService` (`apps/server/src/task-pump.service.ts`) is the **only**
   production consumer of that queue — it polls every 3s, reclaims stuck messages,
   and calls `orchestrate`. Registering an engine is not the same as consuming its
   queue; that gap once left tasks `queued` forever.
4. `orchestrate` runs the **worker + verifier pair** (`packages/agents`
   worker-loop/verifier-loop), which never write files themselves — they emit tool
   calls executed by `packages/executor` inside a Docker sandbox scoped to
   `workspace/<slug>`, which is an auto-initialized git repo.
5. Results are committed, and `artifacts` + `file_index` rows are written back.
   The panel reads them over REST and live `events` over WebSocket.

**Package boundaries are enforced, not conventional.** `apps/server` holds no
business logic (it wires packages); `packages/scheduler` never calls an LLM and has
no dependency on `packages/agents` (it drives agents through the DB/queue);
`packages/agents` never writes files; `packages/db` holds no business rules.
`shared` is the base; nothing depends on `apps`.

**Panel MVVM is machine-checked.** `components/` render JSX only, state and actions
live in `viewmodels/useXxxViewModel.ts`, and all IO goes through `services/`.
`scripts/audit-self.mjs` runs ww's own `docs/09` standard against ww's own panel on
every gate. If it fails, move the state into a ViewModel — do not narrow the rule.

**`pnpm wiring:check`** guards this repo's most expensive recurring defect: code
that is written, tested, and never called by any production path. It scans class
methods too. Deliberate exceptions go in `wiring-baseline.json` **with a reason** —
an entry without a reason is a hidden defect, and most current entries say plainly
that they are real gaps awaiting their own turn.

## Traps this repo has actually fallen into

- **"The surface lies."** Panels that swallow a failed fetch and render a calm
  default ("0 findings", "$0 spent", "no projects yet") are the dominant defect
  class here. `getJsonOr` in `apps/panel/src/services/http.ts` is the mechanism;
  it now has exactly one caller (a single-project lookup where `null` is honest).
  When you touch a surface, ask what it shows when the fetch fails, and whether
  that is a lie or merely a gap.
- **Tests encode current behavior, not correct behavior.** When a fix breaks a
  test, first check whether the test was asserting the bug. Real examples: a fake
  DB returning the same row for every query, an assertion using `String(payload)`
  that only passes while the payload is a string, a health fixture with an empty
  `base_url`, a panel fixture using `as never` to silence missing required fields.
- **Always pass `files` (target files) when creating a task.** The executor treats
  an empty target list as "no file may be written" and rejects `write_file`; a task
  without targets can produce nothing.
- **Read a live run through the logs, not the task status.** The pump reports each
  rejection as `görev <id> işlenemedi: <reason>`. A task stuck in `queued`/`working`
  almost always has one of those lines behind it. `ANSWERED_TASK_RESUMED` confirms a
  user answer reached the engine.
- **Before hunting a code defect in a failed run, check whether it was money:**
  `SELECT status, error_kind, count() FROM ww.api_usage WHERE created_at > now() - INTERVAL 20 MINUTE GROUP BY status, error_kind`.
  A `402`/`429` is an empty provider balance, not a bug.
- **Load `.env` into the shell before starting the server.** The keystore path
  resolves relative to cwd/env; a server started from a shell without `.env` reports
  `no_key` even though the keys are intact.
- **Load-only flakes.** These pass in isolation and flake only under full-gate load:
  `packages/db` `effects.test.ts`, `plans.test.ts`, `api-usage.test.ts`,
  `migrate.test.ts`; `packages/agents` `communication.integration.test.ts`;
  `apps/server` `rest.integration.test.ts`; `packages/scheduler`
  `phase4.integration.test.ts`. A *different* file failing on each run is the
  signature of load flake, not of your change. Re-run the gate before treating any
  of them as real — and never push on a red gate.
- **"Faz" ≠ "Phase".** The roadmap has **Faz 0-6** (product milestones); the plan in
  `docs/superpowers/plans/2026-08-14-faz-1-*` has its own internal **Phase 0-9**
  (implementation steps). Names like `phase9.runtime.integration.test.ts` and
  `WW_PHASE8_RUNTIME_ENABLED` refer to the latter.
- `workspace/` and `.ww/` are gitignored generated state — do not hand-edit them.
  `kanit/` holds acceptance-evidence screenshots referenced by `docs/11`.

## Current State

Measured 2026-08-31 on branch `agent/agent-communication-contract`
(341 commits ahead of `main`, 29 ahead of its own remote, dirty working tree).
**Keep this section current — when it goes stale, the next session starts from the
wrong place. Re-measure before trusting any number here.**

- Gate size: **290 test files, ~1987 `it(` cases across 10 packages**, plus 4 opt-in
  live Docker sandbox tests. `wiring-baseline.json` holds **30 entries**.
- **Faz 0-3 complete ✅**, verified against real APIs. **Faz 4-6 are code-complete
  but their acceptance scenarios wait on external inputs, not on code** — Faz 4
  needs ≥3 funded providers for the council, Faz 5 needs the surfaces watched in a
  browser, Faz 6 needs an Android SDK + AVD. See the evidence tables in
  `docs/11-yol-haritasi.md`.
- Provider balances (as of the `docs/11` note dated 2026-08-21): **Mistral is funded
  and working** (worker/verifier/summarizer route to `mistral:mistral-large-latest`);
  **OpenAI (`429 credit_balance_exhausted`) and DeepSeek (`402`) keys are valid but
  empty**. Top either up and the fallback chain picks it up on its own.
- The full loop closes: queue → worker/verifier → sandbox → commit → `artifacts` +
  `file_index`. The standards-audit loop closes too: a violating file produced a
  finding, a corrective task rewrote it, and the re-audit returned zero findings.
- Recent work is on the live canvas (`TaskCanvas`, `AgentCanvas`, hierarchy layout,
  ClickHouse-backed node metrics) — see the last ~7 commits.

## Session Protocol

1. `git status -sb`, `git log --oneline -10`, `git pull --ff-only` when clean.
2. Review injected claude-mem context and the latest `/context-restore` checkpoint;
   when they disagree with Git history, Git wins.
3. `docker compose up -d` and confirm health before any live test.
4. Work from the roadmap and written architecture; record deliberate deviations in
   `docs/`.
5. Scoped Conventional Commits, one purpose each, small and reversible. Never
   force-push `main`. Never mark a roadmap Faz complete before its documented
   end-to-end scenario passes — a skipped integration test is not a passed gate.
6. End material sessions with `/context-save <short-title>`. claude-mem is the local
   observation layer (`npx claude-mem@latest start`, UI at `http://127.0.0.1:38000`);
   on a fresh clone run `/learn-codebase` once.
7. Update this file only for durable workflow/architecture changes and for the
   Current State block — never for transient notes.

The public upstream is `https://github.com/halituzun/ww`; `main` must stay buildable
and reviewable.
