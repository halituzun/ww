# Web Application

This React and TypeScript project starts with a tested MVVM vertical slice.

## Commands

- `pnpm install --frozen-lockfile` installs the exact dependency graph.
- `pnpm dev` starts the Vite development server.
- `pnpm typecheck` validates strict TypeScript rules.
- `pnpm lint` checks source and configuration files.
- `pnpm test` runs the Vitest suite once.
- `pnpm build` creates the production bundle in `dist/`.

Keep rendering in `src/views`, state and actions in `src/viewmodels`, domain
types in `src/models`, and browser or API access in `src/services`.
