# Claude Project Handoff

Read `AGENTS.md` first, then `docs/00-genel-bakis.md`, `docs/01-mimari.md`, and
`docs/11-yol-haritasi.md`. The detailed cross-session protocol is in
`docs/12-agent-devir-ve-hafiza.md`.
Product-agent work must also read the normative communication contract in
`docs/13-agent-iletisim-sozlesmesi.md`.

## Current State

Verified 2026-08-18 on branch `agent/agent-communication-contract`
(186 commits ahead of `main`, in sync with its remote). Keep this section current:
when it goes stale, the next session starts from the wrong place.

- **Faz 0-3 are complete ✅.** Faz 3's acceptance scenario ran against the real
  DeepSeek API on 2026-08-17 (real key → real task → real cost in the kontör
  panel → broken second key → health red → fallback engaged); the evidence table
  is in `docs/11-yol-haritasi.md`. Faz 4-6 have most of their code-side work
  done and evidence tables of their own, but their acceptance scenarios cannot
  close without external inputs (below).
- **HARD BLOCKER: the DeepSeek account ran out of balance** on 2026-08-18
  (`402 Insufficient Balance`, ~$6.20 spent). No real task can run until it is
  topped up. A task failing with 402 is NOT a code defect — check
  `SELECT status, error_kind, count() FROM ww.api_usage WHERE created_at > now() - INTERVAL 20 MINUTE GROUP BY status, error_kind`
  before hunting for one.
- **What each remaining phase still needs — none of it is code:**
  Faz 4 needs a 2nd and 3rd provider key (the council writes
  "konsey 1 sağlayıcıya düştü … çapraz kontrol bu koşuda tam değildir" into
  every plan until then); Faz 5 needs the surfaces watched in a browser (the
  Chrome extension was not connected in this session); Faz 6 needs an Android
  SDK + AVD (`emulator` is not installed here).
- **The full task loop closes.** Tasks run uninterrupted from queue to commit:
  `c8a8f3e6` → `done`, commit `b849854`, `src/colors.ts` on disk, `artifacts`
  and `file_index` both written. The standards-audit loop also closes: a
  violating file produced a finding, the corrective task rewrote it, and the
  re-audit returned zero findings.
- **Always pass `files` (target files) when creating a task.** The executor
  treats an empty target list as "no file may be written" and rejects
  `write_file`; a task without targets can produce nothing.
- **Run the live loop this way**: `WW_PHASE8_RUNTIME_ENABLED=1
  WW_RUNTIME_PROJECT_ID=<uuid> node apps/server/dist/main.js`, and the project
  must be `status=running` (the engine only picks up running projects).
- **Read the live run through the logs, not the task status alone.** The pump
  reports each rejection as `görev <id> işlenemedi: <reason>`; a task sitting in
  `queued`/`working` with no progress almost always has one of those lines behind
  it. `ANSWERED_TASK_RESUMED` confirms a user answer reached the engine.
- Gate as of 2026-08-18: **1575 tests across 10 packages**, plus 4 opt-in live
  Docker sandbox tests via `pnpm --filter @ww/executor test:live` (skipped by a
  plain `pnpm test`). Build, lint and `pnpm wiring:check` green.
- Tests that flake **only under full-gate load** and pass in isolation:
  `packages/db effects.test.ts` (primary-key pruning), `packages/db plans.test.ts`
  (12-way concurrent append race), `packages/agents communication.integration.test.ts`,
  occasionally `apps/server rest.integration.test.ts`, and (seen 2026-08-18)
  `packages/db migrate.test.ts` plus
  `packages/scheduler phase4.integration.test.ts` (heartbeat/lease timing).
  A different file failing on each run is the signature of load flake, not of
  your change. Re-run the gate before treating any of them as a real failure —
  and never push on a red gate.
- `pnpm wiring:check` guards this repo's most expensive recurring defect:
  code that is written and tested but never called by any production path.
  As of 2026-08-18 it also scans **class methods** — the blind spot that hid
  `MemoryService.appendSummary` (no caller, and therefore never noticed that it
  mapped its columns wrong). That expansion surfaced **17 genuine gaps** at
  once, including the embedding provider docs/04 defines but nothing ever
  builds. `wiring-baseline.json` is now **28 entries and every one carries a
  reason**; the 17 new ones say plainly that they are real gaps awaiting
  individual turns — the baseline makes them visible, it does not excuse them — if you add an entry without a reason, you are hiding a defect.
- "Faz" and "Phase" are different scales: the roadmap has **Faz 0-6** (product
  milestones), while `docs/superpowers/plans/2026-08-14-faz-1-*` has its own
  internal **Phase 0-9** (implementation steps). Code names like
  `phase9.runtime.integration.test.ts` refer to the latter.
- The public upstream is `https://github.com/halituzun/ww`; `main` must remain
  buildable and reviewable.
- Local services use ClickHouse `8124`, Redis `6380`, API `4000`, and panel `5173`.

## Start Every Session

1. Run `git status -sb`, `git log --oneline -10`, and `git pull --ff-only` when clean.
2. Review injected claude-mem context and the latest `/context-restore` checkpoint;
   resolve either against Git history when they disagree.
3. Start services with `docker compose up -d` and confirm their health before live tests.
4. Work from the roadmap and written architecture; record deliberate deviations in docs.

## Verification and Git Discipline

- Run the full gate as ONE command: `pnpm gate` (build + integration tests +
  lint + wiring-check). It exits non-zero on any failure, so always chain the
  commit behind it: `pnpm gate && git commit ... && git push`. Running the
  steps separately once let a push happen while a test was red — the shell,
  not intent, must enforce "never push broken code". A skipped integration
  test is not a completed phase gate.
- Add tests for new behavior, including failure and cleanup paths. Keep TypeScript strict.
- Commit every verified logical unit with scoped Conventional Commits. Keep commits small,
  ordered, and reversible; never bundle unrelated user changes.
- Push each completed, green milestone. Never force-push `main`, rewrite shared history,
  or mark a roadmap phase complete before its documented end-to-end scenario passes.

## Memory Discipline

- claude-mem is the local automatic observation layer. Start it with
  `npx claude-mem@latest start`; its UI is `http://127.0.0.1:38000`.
- On the first Claude session run `/learn-codebase` to seed this repository. Memory is
  auto-injected from the second session onward and remains under `~/.claude-mem`.
- End material sessions with `/context-save <short-title>`; begin resumed work with
  `/context-restore`. Checkpoints are handoff aids, while Git and repository docs remain
  the source of truth.
- Update this file only for durable workflow or architecture changes, never transient notes.
