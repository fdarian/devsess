# @devsess/cli

The `devsess` binary: a detached per-user daemon that runs named groups of dev services in PTYs, plus the client commands that drive it. Released separately from the `devsess` library (as Homebrew/GitHub Release binaries, not on npm) so library consumers don't install `node-pty` (a native dependency). Shares no code with the library — the library's `src/dev/daemon-client.ts` talks to the daemon over its socket using its own copy of the protocol schema, so a protocol change needs both sides updated.

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
- On macOS the launchd plist, the daemon's reported `executable`, and the stale-binary check all use `stableExecPath()` (`src/cli/self-invocation.ts`): `process.execPath` is the realpath, a versioned Homebrew Cellar path, which maps to the stable `<prefix>/opt/devsess/bin/devsess` symlink. `brew upgrade` therefore doesn't break launching, but a running daemon keeps the old binary until `devsess daemon restart` (the formula's caveats say so). Because both sides compare the opt path, only the package-version warning flags an upgraded-but-not-restarted daemon.
- Releases: `.github/workflows/release.yml` builds the SEA per platform on native runners (a SEA bundles the host's node-pty prebuild, so it can't cross-compile), then `scripts/update-homebrew.ts` (Bun, outside the tsconfig) writes the formula to `fdarian/homebrew-tap`. Changesets only versions and tags this private package. The CLI release is idempotent: it runs whenever the `@devsess/cli@<version>` tag exists and the tap formula is older, so a failed run is retried with `workflow_dispatch` rather than depending on changesets' `published-packages`.
- `apps/menubar` (Swift) speaks the same socket protocol; its stop timeout must stay above `STOP_REQUEST_TIMEOUT_MS` (stop deadline + settle + margin) in `src/cli/termination.ts`.
