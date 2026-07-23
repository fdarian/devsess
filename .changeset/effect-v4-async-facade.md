---
'devsess': minor
---

Migrate to Effect v4 beta: `effect` and `@effect/platform-node` are bumped to `^4.0.0-beta.101`, and `@effect/cli`/`@effect/platform` are dropped as peer dependencies — both are now part of core `effect` (`effect/unstable/*`). The `cli` namespace re-exported from `devsess` now exposes `Flag`/`Argument` instead of `Options`.

Add a plain-async API at `devsess/async` alongside the existing Effect API — a Promise-based `defineDevCli`, `createDevSessions`, and `SessionState` for dev scripts that don't want to deal with Effect directly.
