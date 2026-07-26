---
'devsess': minor
---

Breaking: `devsess` no longer depends on `@effect/platform-node` — it depends on no platform package at all. `defineDevCli` (`devsess` and `devsess/async`), `createDevSessions`, and the async `SessionState.slot` now take a required platform argument so you supply your own runtime.

Migrate by passing `platform: { services: NodeServices.layer, runMain: NodeRuntime.runMain }` to `defineDevCli` (swap in `@effect/platform-bun`'s `BunServices`/`BunRuntime` on Bun), and the same `services` layer as the extra argument to `createDevSessions(rootDir, services)` / `SessionState.slot(schema, services)`.
