# test

Vitest + `@effect/vitest` suite for `packages/devsess`. Mirrors `src/` layout (`test/dev/`, `test/pglite/`, `test/async/`), plus `test/support/` for shared fixtures (`makeTempDir`, `makeTestDevSessionsLayer`, `runTest`, `writeMigrationsFixture`).

## Common gotchas
- A failed `expect()` inside an `Effect.gen` body surfaces as a **defect**, not a typed failure — only `Effect.catchCause` intercepts it; `Effect.catch`/`catchAll` won't. See `invokeCli` in `test/dev/run-dev-cli.test.ts` for the pattern this forces.
- `it.effect` installs a `TestClock` that never auto-advances on its own. Anything doing real timers, `fs.watch`, or process I/O needs `it.live` (the real Clock) instead — see `test/dev/running-signal.test.ts`, `test/dev/subprocess.test.ts`.
- Wrap the whole test effect in `test/support/run-test.ts`'s `runTest` to make `FileSystem`/`Path` ambient over the entire body — providing `NodeServices.layer` narrowly around a single `yield*` only satisfies that sub-expression, not the rest of the `Effect.gen`.
