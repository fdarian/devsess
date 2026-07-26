# devsess

Scaffold dev scripts with reusable dev sessions + a per-session PGlite/Drizzle adapter. Built on Effect, targets Node (`@effect/platform-node`).

## Stack
- effect (v4 beta) + @effect/platform-node — CLI (`effect/unstable/cli`) and process-spawn (`effect/unstable/process`) live in core `effect` now, no more `@effect/cli`/`@effect/platform`
- @electric-sql/pglite + drizzle-orm — optional peers, only for the `devsess/pglite` entrypoint

## Build
- `tsup` bundles JS, `tsc -p tsconfig.build.json` emits `.d.ts` → `dist/`
- Three entrypoints: `.` (Effect API), `./pglite` (Effect PGlite/Drizzle adapter), `./async` (plain-async facade). Peers are externalized — never bundled.
- `publishConfig` is OIDC trusted publishing (`access: public`, `provenance: true`).

## Layout
- src/dev-sessions.ts — DevSessions service (slug-named session dirs under `.data/sessions`)
- src/dev/define-cli.ts — `defineDevCli`, the Effect scaffolding entrypoint
- src/dev/run-dev-cli.ts — shared CLI scaffolding (builds the `cli.Command`, wires layers) used by both the Effect and async `defineDevCli`
- src/dev/{session-state,sticky-port,subprocess,running-signal}.ts — RunContext helpers
- src/pglite/index.ts — pglite adapter + `prepareSessionPglite` session bridge
- src/async/ — the `devsess/async` facade: Promise-based mirror of `defineDevCli`/`DevSessions`/`SessionState`, built on top of the Effect core (see `src/async/session.ts` for how it wraps/unwraps the Effect `DevSession`)
