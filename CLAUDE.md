# Claude Project Handoff

Read `AGENTS.md` first, then `docs/00-genel-bakis.md`, `docs/01-mimari.md`, and
`docs/11-yol-haritasi.md`. The detailed cross-session protocol is in
`docs/12-agent-devir-ve-hafiza.md`.
Product-agent work must also read the normative communication contract in
`docs/13-agent-iletisim-sozlesmesi.md`.

## Current State

Verified 2026-08-17 (evening) on branch `agent/agent-communication-contract`
(155 commits ahead of `main`, in sync with its remote). Keep this section current:
when it goes stale, the next session starts from the wrong place.

- **Faz 0, 1 and 2 are complete ✅.** Faz 3-6 are code-complete with green tests,
  but their acceptance scenarios are still open. The authoritative per-phase status
  and evidence mapping live in the "Durum Özeti" table of `docs/11-yol-haritasi.md`.
- **Real LLM calls now happen.** `deepseek` is registered with a real key,
  `api_usage` holds 180+ non-health calls, periodic health checks write real
  statuses (`deepseek=ok`, `mock=down`), and one task has reached a real commit
  (`affa20b`). What is still NOT verified end-to-end: a task reaching commit and
  writing `artifacts` + `file_index` in one uninterrupted run.
- **Run the live loop this way**: `WW_PHASE8_RUNTIME_ENABLED=1
  WW_RUNTIME_PROJECT_ID=<uuid> node apps/server/dist/main.js`. Without those the
  task pump logs "görev pompası açılmadı" and nothing is consumed.
- **Read the live run through the logs, not the task status alone.** The pump
  reports each rejection as `görev <id> işlenemedi: <reason>`; a task sitting in
  `queued`/`working` with no progress almost always has one of those lines behind
  it. `ANSWERED_TASK_RESUMED` confirms a user answer reached the engine.
- Gate as of 2026-08-17: **1000+ tests across 10 packages**, plus 4 opt-in live
  Docker sandbox tests via `pnpm --filter @ww/executor test:live` (skipped by a
  plain `pnpm test`). Build, lint and `pnpm wiring:check` green.
- Two tests are known to flake **only under full-gate load** and pass in isolation:
  `packages/db effects.test.ts` (primary-key pruning) and
  `packages/agents communication.integration.test.ts`. Re-run the gate before
  treating either as a real failure — and never push on a red gate.
- `pnpm wiring:check` guards this repo's most expensive recurring defect:
  code that is written and tested but never called by any production path. It
  was found in five separate places in one night. `wiring-baseline.json` freezes
  the known cases; the gate fails only on new ones.
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
