# Claude Project Handoff

Read `AGENTS.md` first, then `docs/00-genel-bakis.md`, `docs/01-mimari.md`, and
`docs/11-yol-haritasi.md`. The detailed cross-session protocol is in
`docs/12-agent-devir-ve-hafiza.md`.

## Current State

- Phase 0 is complete and verified as of 2026-08-14.
- The public upstream is `https://github.com/halituzun/ww`; `main` must remain
  buildable and reviewable.
- The next product milestone is Phase 1, “Çekirdek Orkestrasyon,” exactly as
  scoped in `docs/11-yol-haritasi.md`. Do not silently pull work from later phases.
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
