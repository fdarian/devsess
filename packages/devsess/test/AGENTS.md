# test

Vitest + `@effect/vitest` suite for `packages/devsess`. Mirrors `src/` layout (`test/dev/`, `test/pglite/`, `test/async/`), plus `test/support/` for shared fixtures (`makeTempDir`, `makeTestDevSessionsLayer`, `sessionsStorageDir`, `runTest`, `writeMigrationsFixture`).

## Common gotchas
- A failed `expect()` inside an `Effect.gen` body surfaces as a **defect**, not a typed failure — only `Effect.catchCause` intercepts it; `Effect.catch`/`catchAll` won't. See `test/current-session.test.ts`'s `--help` regression test for a case that drives a real `cli.Command.runWith` and asserts on the result instead.
- `it.effect` installs a `TestClock` that never auto-advances on its own. Anything doing real timers, `fs.watch`, or process I/O needs `it.live` (the real Clock) instead — see `test/dev/running-signal.test.ts`, `test/dev/subprocess.test.ts`.
- Wrap the whole test effect in `test/support/run-test.ts`'s `runTest` to make `FileSystem`/`Path` ambient over the entire body — providing `NodeServices.layer` narrowly around a single `yield*` only satisfies that sub-expression, not the rest of the `Effect.gen`.
- `test/support/dev-sessions-layer.ts`'s `makeTestDevSessionsLayer(dir)` builds `DevSessions.layerAt(dir)` merged with `NodeServices.layer` — most tests want exactly this pair. `sessionsStorageDir(rootDir)` gives the actual on-disk sessions path (`<rootDir>/.data/sessions`) for fixtures that poke the filesystem directly instead of going through `getSessions`/`createSession`.
