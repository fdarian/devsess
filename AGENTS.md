# devsess

Monorepo for the `devsess` library — Effect-based dev-session scaffolding plus a per-session PGlite/Drizzle adapter.

## Workspaces
- `packages/config` — shared tsconfig presets (`@devsess/config`, private)
- `packages/devsess` — the published library (`devsess` on npm)
- `packages/cli` — the published `devsess` binary and daemon (`@devsess/cli` on npm); the only package that depends on `node-pty`
- `apps/docs` — Blume documentation site

## Commands
- `pnpm run build` — build both published packages (library: tsup JS + tsc declarations; CLI: tsup)
- `pnpm run build:exe` — build the CLI as a single-executable binary into `packages/cli/build/`
- `pnpm run check` — typecheck + lint across workspaces (turbo)
- `pnpm run format` — biome format
- `pnpm run docs` — run the docs site locally
- `pnpm changeset` — record a release bump

## Releasing
Push to `main` drives Changesets; publishing is OIDC trusted publishing (no npm token). See `.github/workflows/release.yml`.

A changeset body is a changelog entry, not a PR description — one line by default, expanded only when a consumer must act to upgrade (breaking change, migration, new install requirement). Rationale goes in the PR. Never use `##` headings: the default `@changesets/cli/changelog` formatter renders the whole body as one list item, so headings end up nested inside a bullet. One changeset per logical change, not per PR.
