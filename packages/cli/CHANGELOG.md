# @devsess/cli

## 0.1.0

### Minor Changes

- 781f5b7: The CLI now installs with `brew install fdarian/tap/devsess` as a standalone binary (no Node required) instead of from npm.

  **Upgrading from the CLI bundled in `devsess` 0.6:** install with Homebrew, then run `devsess daemon restart`, since on macOS the launchd job points at the old install path.

### Patch Changes

- 781f5b7: Status requests no longer wait on a slow `ps`, so the menu bar and `devsess stop` stay responsive under machine load.
- 781f5b7: Stopping a run now always replies within the client's timeout when `ps` is slow.

Releases up to 0.6.0 shipped inside the `devsess` package; see its [changelog](/changelog).
