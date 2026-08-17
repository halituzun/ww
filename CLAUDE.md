# Claude Project Handoff

Read `AGENTS.md` first, then `docs/00-genel-bakis.md`, `docs/01-mimari.md`, and
`docs/11-yol-haritasi.md`. The detailed cross-session protocol is in
`docs/12-agent-devir-ve-hafiza.md`.
Product-agent work must also read the normative communication contract in
`docs/13-agent-iletisim-sozlesmesi.md`.

## Current State

Verified 2026-08-17 on branch `agent/agent-communication-contract` (97 commits
ahead of `main`, in sync with its remote). Keep this section current: when it goes
stale, the next session starts from the wrong place.

- **Faz 0, 1 and 2 are complete ✅.** Faz 3-6 are code-complete with green tests,
  but their acceptance scenarios are still open. The authoritative per-phase status
  and evidence mapping live in the "Durum Özeti" table of `docs/11-yol-haritasi.md`.
- **The platform has never called a real LLM API.** There is no `secrets/`
  directory, the only registered provider is `mock`, and `api_usage` holds zero
  real calls. Everything has been verified through `MockProvider`, which is exactly
  what Faz 0-2 specify — but Faz 3-6 cannot close without real runs.
- **Next milestone: Faz 3's acceptance scenario** — add a real provider key through
  the panel, run a small real scenario, confirm the kontör panel shows real cost,
  then add a deliberately broken key and confirm health goes red and fallback
  engages. Faz 4, 5 and 6 chain onto that run; do not skip ahead.
- Gate as of 2026-08-17: **912 tests across 10 packages**, plus 4 opt-in live
  Docker sandbox tests via `pnpm --filter @ww/executor test:live` (skipped by a
  plain `pnpm test`). Build, lint and `pnpm wiring:check` green.
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

- For the full gate run `pnpm build`, `WW_REQUIRE_INTEGRATION=1 pnpm test`, and
  `pnpm lint`. A skipped integration test is not a completed phase gate.
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
