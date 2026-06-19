# devsess

Scaffold dev scripts with reusable dev sessions + a per-session PGlite/Drizzle adapter. Built on Effect, targets Node (`@effect/platform-node`).

## Stack
- effect, @effect/cli, @effect/platform, @effect/platform-node
- @electric-sql/pglite + drizzle-orm — optional peers, only for the `devsess/pglite` entrypoint

## Build
- `tsup` bundles JS, `tsc -p tsconfig.build.json` emits `.d.ts` → `dist/`
- Two entrypoints: `.` and `./pglite`. Peers are externalized — never bundled.
- `publishConfig` is OIDC trusted publishing (`access: public`, `provenance: true`).

## Layout
- src/dev-sessions.ts — DevSessions service (slug-named session dirs under `.data/sessions`)
- src/dev/define-cli.ts — `defineDevCli`, the scaffolding entrypoint
- src/dev/{session-state,sticky-port,subprocess,running-signal}.ts — RunContext helpers
- src/pglite/index.ts — pglite adapter + `prepareSessionPglite` session bridge
