# @devsess/cli

The `devsess` binary: a detached per-user daemon that runs named groups of dev services in PTYs, plus the client commands that drive it. Published separately from the `devsess` library so library consumers don't install `node-pty` (a native dependency). Shares no code with the library — the library's `src/dev/daemon-client.ts` talks to the daemon over its socket using its own copy of the protocol schema, so a protocol change needs both sides updated.

## Stack
- effect (v4) — `effect/cli` for commands, services/layers for the daemon internals
- node-pty — the only reason this package is separate; PTYs for services
- `tsup` builds `dist/cli.js` (the `bin`); `pnpm run build:exe` bundles a Node SEA binary into `build/` via `tsdown.exe.config.ts` (`src/cli/sea/` shims node-pty's native loading there)
- Tests: vitest + `@effect/vitest`; `test/cli/` mirrors `src/cli/`, `test/support/` holds fixtures (`run-test.ts` and `temp-dir.ts` are copies of the library's helpers)

## Layout
- src/cli.ts — command tree and entry point
- src/cli/ — daemon, client, registry, PTY/process handling, launchd integration, log segments
- docs/cli/ — offline CLI topics read by `src/cli.ts` from beside `dist/` (or from SEA assets keyed `docs/cli/<file>`); the docs site copies the same files into its reference pages, so keep the relative layout.
- CLI output is persisted as rotating JSONL segments. Replay snapshots both segments before reading to avoid rotation gaps; live writers have independent bounded buffers, so a slow tail client disconnects on overflow without throttling the service.

## Common gotchas
- On macOS the launchd plist embeds the absolute path of `dist/cli.js` and the Node binary, so moving or reinstalling the package leaves the job stale until `devsess daemon restart`.
- `apps/menubar` (Swift) speaks the same socket protocol; its stop timeout must stay above `STOP_REQUEST_TIMEOUT_MS` (stop deadline + settle + margin) in `src/cli/termination.ts`.
