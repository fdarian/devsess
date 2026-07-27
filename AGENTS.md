# devsess

Monorepo for the `devsess` library — Effect-based dev-session scaffolding plus a per-session PGlite/Drizzle adapter.

## Workspaces
- `packages/config` — shared tsconfig presets (`@devsess/config`, private)
- `packages/devsess` — the published library (`devsess` on npm)
- `apps/docs` — vocs documentation site

## Commands
- `bun run build` — build the library (tsup JS + tsc declarations)
- `bun run check` — typecheck + lint across workspaces (turbo)
- `bun run format` — biome format
- `bun run docs` — run the docs site locally
- `bun changeset` — record a release bump

## Releasing
Push to `main` drives Changesets; publishing is OIDC trusted publishing (no npm token). See `.github/workflows/release.yml`.

A changeset body is a changelog entry, not a PR description — one line by default, expanded only when a consumer must act to upgrade (breaking change, migration, new install requirement). Rationale goes in the PR. Never use `##` headings: the default `@changesets/cli/changelog` formatter renders the whole body as one list item, so headings end up nested inside a bullet. One changeset per logical change, not per PR.
