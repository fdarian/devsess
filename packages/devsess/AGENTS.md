# devsess

Scaffold dev scripts with reusable dev sessions + a per-session PGlite/Drizzle adapter. Built on Effect; platform-agnostic (Node or Bun) — the caller supplies the platform.

## Stack
- effect (v4 beta) — CLI (`effect/unstable/cli`) and process-spawn (`effect/unstable/process`) live in core `effect` now, no more `@effect/cli`/`@effect/platform`
- The Effect entrypoint (`.`) doesn't wrap `effect/unstable/cli` — it exports `DevSessions`/`CurrentSession` (services + layers) and free functions (`getStickyPort`, `runManagedSubprocess`, `publishRunning`, `awaitRunning`); callers build a stock `Command.make(...)` themselves and provide `NodeServices.layer`/`BunServices.layer` for the `FileSystem | Path` (and friends) it needs. `@effect/platform-node` stays a devDependency, for tests only.
- Only `devsess/async` still owns a `platform` config object (`DevPlatform` = `{ services, runMain }`, `DevServices` = `ChildProcessSpawner | FileSystem | Path | Stdio | Terminal`) — see `src/async/platform.ts`. It's the one facade that legitimately owns `main`.
- @electric-sql/pglite + drizzle-orm — optional peers, only for the `devsess/pglite` entrypoint

## Build
- `tsup` bundles JS, `tsc -p tsconfig.build.json` emits `.d.ts` → `dist/`
- Three entrypoints: `.` (Effect API), `./pglite` (Effect PGlite/Drizzle adapter), `./async` (plain-async facade). Peers are externalized — never bundled.
- `publishConfig` is OIDC trusted publishing (`access: public`, `provenance: true`).

## Layout
- src/dev-sessions.ts — `DevSessions` service (`.layer` auto-detects the project root by walking up to the nearest `package.json`, `.layerAt(rootDir)` overrides), slug-named session dirs under `<root>/.data/sessions`
- src/current-session.ts — `CurrentSession` service holding the resolved `DevSession` for a run (`.layer` resolves via `DevSessions#getLatestOrCreate`, `.layerOf(session)` pins one for tests). Deliberately not bundled into `DevSessions.layer` — see the doc comment on `CurrentSession.layer` for the eager-session reasoning; a regression test in `test/current-session.test.ts` drives a real `cli.Command` with `--help` to prove it doesn't touch the session store.
- src/dev/{session-state,sticky-port,subprocess,running-signal}.ts — the free functions (`getStickyPort`, `runManagedSubprocess`, `publishRunning`, `awaitRunning`) and `SessionState`. Only `getStickyPort` (and `prepareSessionPglite`) take a `DevSession`; the others take no session at all, or pull the project root from `DevSessions` in context
- src/pglite/index.ts — pglite adapter + `prepareSessionPglite` session bridge
- src/async/ — the `devsess/async` facade: Promise-based mirror of `defineDevCli`/`DevSessions`/`SessionState`, built on top of the Effect core (see `src/async/session.ts` for how it wraps/unwraps the Effect `DevSession`, `src/async/run-dev-cli.ts` for the shared CLI scaffolding, `src/async/platform.ts` for `DevPlatform`/`DevServices`). `createDevSessions(rootDir, services)` takes a bare project root, same convention as `DevSessions.layerAt`
