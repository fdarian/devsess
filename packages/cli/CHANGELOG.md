# @devsess/cli

## 0.7.0

### Minor Changes

- 18a6a31: The `devsess` binary moved to `@devsess/cli`, so the library no longer installs `node-pty`; existing CLI users must `npm install -g @devsess/cli` and run `devsess daemon restart`, since the launchd job points at the old install path.

### Patch Changes

- 87517ab: Status requests no longer wait on a slow `ps`, so the menu bar and `devsess stop` stay responsive under machine load.
- 87517ab: Stopping a run now always replies within the client's timeout when `ps` is slow.

Releases up to 0.6.0 shipped inside the `devsess` package; see its [changelog](/changelog).
