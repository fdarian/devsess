# devsess

Monorepo for the `devsess` library — Effect-based dev-session scaffolding plus a per-session PGlite/Drizzle adapter.

## Workspaces
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
