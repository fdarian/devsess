# @devsess/cli

The `devsess` command: run named groups of dev services (servers, workers, watchers) in a detached daemon shared across your projects and worktrees, then tail, attach to, restart, and stop them from any terminal.

## Install

```bash
brew install fdarian/tap/devsess
```

macOS or Linux. Services themselves can run under any runtime, including Bun.

## Use

In a checkout with a devsess config:

```bash
devsess start      # start a preset
devsess status     # see what's running
devsess tail       # read output
devsess stop
```

The full reference — configuration, project matching, selecting runs, logs, attach, shell completion, the daemon, troubleshooting — ships with the CLI and is also on the [docs site](https://devsess.fdarian.com):

```bash
devsess docs
```

<details>
<summary>Upgrading from the CLI bundled in `devsess` 0.6</summary>

The CLI now ships as its own binary, so the `devsess` library no longer installs it (or `node-pty`). Install it with Homebrew and run `devsess daemon restart`: on macOS the launchd job still points at the old install path.

</details>

This package is the CLI only; for the dev-session library used from your `scripts/dev.ts`, see [`devsess`](https://www.npmjs.com/package/devsess).

## License

Apache-2.0
