# devsess

## 0.6.0

### Minor Changes

- 9727233: Add `devsess list` to show project presets without starting the daemon, and shell completion for `start` presets.
- 9727233: Describe commands and options in `--help` and add `devsess docs`, with the CLI reference split into topics readable through `devsess docs read <id>`.
- 9727233: Add the `devsess` CLI, which starts project presets as detached per-worktree service groups under a per-user daemon and lets you attach to, tail (the last 10 lines by default, optionally following), and stop them.
- 9727233: Select runs and services with interactive pickers (type-to-filter, `Ctrl-N`/`Ctrl-P`, and recent presets first in the start picker) or by run ID and qualified selectors; `-s` is short for `--service`.
- 9727233: Add `devsess status` to inspect active runs without starting the daemon, showing service URLs, ports, in-process services, and memory, with `-a` for every run in full and, when nothing is running, a summary of the last finished run.
- 9727233: Add `devsess daemon start`, `stop`, `status`, `restart`, `install`, and `uninstall`; on macOS the daemon runs as a launchd job.
- 9727233: Store service logs in ~/Library/Logs/devsess on macOS unless XDG_STATE_HOME is set, and show the logs directory in daemon status.
- 9727233: Show `publishRunning` readiness and URLs in `devsess status`, and let presets wait for it with `awaitPublish`.
- 9727233: Add `devsess restart` and `devsess stop --service` to restart or stop individual services without ending the run.

### Patch Changes

- 9727233: A daemon that finds another one already serving the socket now exits 0 instead of being relaunched by launchd forever, no longer deletes that daemon's socket, and its `ps` calls get 3 s instead of 500 ms before failing.
- 9727233: `daemon stop` and `restart` wait for the daemon process to exit before reporting it stopped, a freshly launched daemon gets 15 s to answer, and connect errors other than a missing daemon are reported with their errno.
- 9727233: Daemon re-binds its socket if the file is removed, exits cleanly if another process takes the path, and timestamps and explains its startup failures.
- 9727233: Recover from a live daemon whose socket file was unlinked: the CLI waits for it to re-bind, otherwise terminates and relaunches it, and `daemon stop` / `restart` now reach it.

## 0.5.0

### Minor Changes

- fc74014: Add schema-backed shared services with automatic definition lookup, detached hosts, and cross-process leases in a fixed worktree-root session.

### Patch Changes

- 3d6afed: Report scoped services and their ports to the daemon on startup and retract them on scope close.

## 0.4.0

### Minor Changes

- 8827ca8: Require drizzle-orm ^1.0.0-rc.5-5935859 for the optional PGlite adapter.
- 1c7bda1: Add custom handler and Docker-backed services with per-session ports, persistent data directories, scoped cleanup, and layer-based composition.
- 8827ca8: Require stable Effect ^4.0.0; update caller imports from effect/unstable/cli and effect/unstable/process to effect/cli and effect/process.
- f6fcc4c: Upgrade the PGlite adapter to Drizzle v1 RC; consumers must use `drizzle-orm@^1.0.0-rc.4` and upgrade existing migrations folders with v1 RC `drizzle-kit up`.

### Patch Changes

- 3c975ab: Publish PGlite dumps atomically so parallel test workers can safely share a dump path.
- bb61a8b: Avoid reporting a stop failure when a managed subprocess has already exited.

## 0.3.4

### Patch Changes

- 12780a3: `prepareSessionPglite` now closes its PGlite connection and returns only `dataDir` and `dumpPath`; use `openLitePglite` for an in-process client.

## 0.3.3

### Patch Changes

- 32a1553: `publishRunning` now waits up to 5 s for the devsess daemon to acknowledge readiness, instead of silently dropping it after 200 ms when the daemon is busy.

## 0.3.2

### Patch Changes

- bb584ac: Keep managed subprocesses in the caller's process group so supervisors can stop them together.

## 0.3.1

### Patch Changes

- bfa9886: Publish and clear scoped readiness in a local devsess daemon when service identity is available.

## 0.3.0

### Minor Changes

- 24b3950: `getStickyPort` now accepts an optional `{ name }` to remember multiple ports per session, keyed by name (defaulting to `default`).

## 0.2.0

### Minor Changes

- 33ac04e: **Breaking.** The Effect API no longer wraps `effect/unstable/cli`. `devsess` exports services, layers, and free functions; you write a stock `Command.make(...)` yourself. `defineDevCli` and the `cli` re-export are gone from `devsess` — `devsess/async` keeps both.

  **Install a platform package yourself.** `@effect/platform-node` is no longer a peer dependency. Add `@effect/platform-node` or `@effect/platform-bun` and provide its `NodeServices.layer` / `BunServices.layer`.

  Before:

  ```ts
  import { join } from "node:path";
  import { NodeRuntime, NodeServices } from "@effect/platform-node";
  import { defineDevCli } from "devsess";
  import { Effect } from "effect";

  const main = defineDevCli({
    name: "web",
    dir: join(import.meta.dirname, ".."),
    platform: { services: NodeServices.layer, runMain: NodeRuntime.runMain },
    run: (ctx) =>
      Effect.gen(function* () {
        const session = yield* ctx.session;
        const port = yield* ctx.getStickyPort();
        yield* ctx.runManagedSubprocess("bunx", ["vite"], {
          env: { PORT: String(port) },
        });
      }),
  });

  main(process.argv);
  ```

  After:

  ```ts
  import { NodeRuntime, NodeServices } from "@effect/platform-node";
  import {
    CurrentSession,
    DevSessions,
    getStickyPort,
    runManagedSubprocess,
  } from "devsess";
  import { Effect } from "effect";
  import { Command } from "effect/unstable/cli";

  const web = Command.make("web", {}, () =>
    Effect.gen(function* () {
      const session = yield* CurrentSession;
      const port = yield* getStickyPort(session);
      yield* runManagedSubprocess("bunx", ["vite"], {
        env: { PORT: String(port) },
      });
    }).pipe(Effect.provide(CurrentSession.layer))
  );

  Command.run(web, { version: "0.1.0" }).pipe(
    Effect.provide(DevSessions.layer),
    Effect.provide(NodeServices.layer),
    Effect.scoped,
    NodeRuntime.runMain
  );
  ```

  Migration notes:

  - **`dir` is gone.** `DevSessions.layer` auto-detects the project root — the nearest ancestor of `process.cwd()` with a `package.json` — or fails with `ProjectRootNotFoundError`. Use `DevSessions.layerAt(rootDir)` to pass one explicitly.
  - **Provide `CurrentSession.layer` around the handler, not around `Command.run`.** A layer's build effect runs the moment it's provided, so wrapping the whole CLI would create a session for `--help` and `--version` too.
  - **The `ctx` members are free functions** on `devsess`: `getStickyPort`, `runManagedSubprocess`, `publishRunning`, `awaitRunning`. Only `getStickyPort` (and `prepareSessionPglite`) take a `DevSession`.
  - **`Effect.scoped` is yours now.** It used to be internal to `defineDevCli`, and it's what lets managed subprocesses and running-signal files clean up on exit.
  - **`--version` is real**, rather than the hardcoded `0.0.0` the old scaffolding reported.
  - **`createDevSessions(rootDir, services)` takes a bare project root**, matching `DevSessions.layerAt`; both resolve to `<rootDir>/.data/sessions`. Stop pre-joining `.data/sessions` — passing the old path doubles it up and orphans existing sessions.

## 0.1.0

### Minor Changes

- d7282b1: Initial release: Effect-based dev-session scaffolding (`defineDevCli`) with persistent sessions, sticky ports, managed subprocesses, and cross-service running signals; a per-session PGlite + Drizzle adapter at `devsess/pglite`; and a plain-async facade at `devsess/async` for scripts that prefer Promises over Effect.
